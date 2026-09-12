// SPDX-License-Identifier: MIT
/**
 * Sessions: opaque tokens, sliding idle window, hard absolute cap, refresh
 * rotation with reuse detection (03 §3.4, decision D21, P0-5).
 *
 * The state machine, once, in words — the code below is this paragraph:
 *
 * 1. **Issue.** A successful assertion mints a *family*: a random access token, a
 *    random refresh token, `idle_expires_at = now + 15 min`,
 *    `absolute_expires_at = now + 8 h`, and `family_expires_at` at 8 h — or 14 days
 *    if the user explicitly marked the device trusted (D21).
 * 2. **Use.** Presenting the access token bumps `idle_expires_at`, never
 *    `absolute_expires_at`. A session that is used continuously still dies at the
 *    absolute cap; that is what makes the cap a cap.
 * 3. **Refresh.** Presenting the refresh token stamps the current row
 *    `superseded_by` and inserts a *new* row in the same family with fresh tokens
 *    and a fresh idle window, clamped so it can never outlive `family_expires_at`.
 * 4. **Reuse.** Presenting a refresh token that belongs to a row already superseded
 *    or revoked means two parties hold it, i.e. the cookie was stolen. The entire
 *    family is revoked, a `session.reuse_detected` event is written, and the user
 *    re-authenticates. This is the single highest-value detection in the system and
 *    it is why generations are separate rows.
 * 5. **Step up.** A fresh WebAuthn assertion sets `fresh_until = now + 5 min` on
 *    the current row. Other packages will demand it for credential access, Item
 *    add/remove, export and sidecar acknowledgement (P1-2).
 *
 * Only SHA-256 digests are stored. The raw tokens exist in exactly one place: the
 * cookies in the browser.
 */
import { newId, type Clock } from '@core/kernel';
import { randomBytes, sha256 } from '@core/secretbox';
import { asDate, asOptionalDate, toParam, type IdentityQueryable } from './db.ts';
import { AuthError } from './errors.ts';
import { hashUserAgent, recordSecurityEvent, type RequestContext } from './security-events.ts';

/** 32 bytes of CSPRNG output, base64url. 256 bits: unguessable, and short enough for a cookie. */
const TOKEN_BYTES = 32;

export type AuthMethod = 'webauthn' | 'totp' | 'recovery_code' | 'bootstrap';

export interface SessionTtls {
  readonly idleSeconds: number;
  readonly absoluteSeconds: number;
  readonly trustedSeconds: number;
  readonly stepUpSeconds: number;
}

export const DEFAULT_SESSION_TTLS: SessionTtls = Object.freeze({
  idleSeconds: 900, // 15 min
  absoluteSeconds: 28_800, // 8 h
  trustedSeconds: 1_209_600, // 14 days
  stepUpSeconds: 300, // 5 min
});

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly familyExpiresAt: Date;
  readonly trustedDevice: boolean;
  readonly freshUntil: Date | null;
  readonly authMethod: AuthMethod;
  readonly supersededBy: string | null;
  readonly revokedAt: Date | null;
}

/** What the caller must put in cookies. The only place raw tokens exist server-side. */
export interface IssuedSession {
  readonly session: SessionRecord;
  readonly accessToken: string;
  readonly refreshToken: string;
}

const COLUMNS = `id, user_id, family_id, created_at, last_seen_at, idle_expires_at,
  absolute_expires_at, family_expires_at, trusted_device, fresh_until, auth_method,
  superseded_by, revoked_at`;

function mapRow(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row['id']),
    userId: String(row['user_id']),
    familyId: String(row['family_id']),
    createdAt: asDate(row['created_at']),
    lastSeenAt: asDate(row['last_seen_at']),
    idleExpiresAt: asDate(row['idle_expires_at']),
    absoluteExpiresAt: asDate(row['absolute_expires_at']),
    familyExpiresAt: asDate(row['family_expires_at']),
    trustedDevice: Boolean(row['trusted_device']),
    freshUntil: asOptionalDate(row['fresh_until']),
    authMethod: row['auth_method'] as AuthMethod,
    supersededBy: row['superseded_by'] === null ? null : String(row['superseded_by']),
    revokedAt: asOptionalDate(row['revoked_at']),
  };
}

function mintToken(): string {
  return Buffer.from(randomBytes(TOKEN_BYTES)).toString('base64url');
}

export function hashToken(token: string): Uint8Array {
  return sha256(new TextEncoder().encode(token));
}

export interface SessionServiceOptions {
  readonly db: IdentityQueryable;
  readonly clock: Clock;
  readonly ttls?: SessionTtls;
}

export interface IssueOptions {
  readonly userId: string;
  readonly authMethod: AuthMethod;
  readonly trustedDevice?: boolean;
  /** Sessions created by a passkey assertion start step-up fresh; TOTP ones do not. */
  readonly fresh?: boolean;
  readonly context?: RequestContext;
}

export class SessionService {
  readonly #db: IdentityQueryable;
  readonly #clock: Clock;
  readonly #ttls: SessionTtls;

  constructor(options: SessionServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#ttls = options.ttls ?? DEFAULT_SESSION_TTLS;
  }

  get ttls(): SessionTtls {
    return this.#ttls;
  }

  async issue(options: IssueOptions): Promise<IssuedSession> {
    const now = this.#clock.now();
    const familyWindow =
      options.trustedDevice === true ? this.#ttls.trustedSeconds : this.#ttls.absoluteSeconds;
    const familyExpiresAt = new Date(now.getTime() + familyWindow * 1_000);
    const familyId = newId();
    return this.#insertGeneration({
      familyId,
      userId: options.userId,
      authMethod: options.authMethod,
      trustedDevice: options.trustedDevice === true,
      familyExpiresAt,
      fresh: options.fresh === true,
      now,
      context: options.context,
    });
  }

  /**
   * Authenticate an access token and slide the idle window.
   *
   * Returns `null` rather than throwing for an unknown token: an unknown cookie is
   * the ordinary case after a logout, and the caller turns it into a 401 without a
   * distinguishable error.
   */
  async authenticate(accessToken: string): Promise<SessionRecord | null> {
    const result = await this.#db.query(
      `SELECT ${COLUMNS} FROM sessions WHERE access_token_hash = $1`,
      [toParam(hashToken(accessToken))],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const session = mapRow(row);

    if (session.revokedAt !== null) return null;
    const now = this.#clock.now();
    if (session.idleExpiresAt <= now) return null;
    if (session.absoluteExpiresAt <= now) return null;
    if (session.familyExpiresAt <= now) return null;
    // A superseded generation's access token dies with the refresh that replaced
    // it, otherwise rotation would leave two live access tokens.
    if (session.supersededBy !== null) return null;

    const idleExpiresAt = this.#clampToSession(
      new Date(now.getTime() + this.#ttls.idleSeconds * 1_000),
      session,
    );
    await this.#db.query(
      `UPDATE sessions SET last_seen_at = $2, idle_expires_at = $3 WHERE id = $1`,
      [session.id, now, idleExpiresAt],
    );
    return { ...session, lastSeenAt: now, idleExpiresAt };
  }

  /**
   * Rotate. Reuse of an already-rotated refresh token kills the family.
   *
   * Throws `session_reuse_detected` rather than returning null, because the caller
   * must not treat it as an ordinary expiry: the correct response is to clear every
   * cookie, log loudly, and make the user re-authenticate.
   */
  async refresh(refreshToken: string, context?: RequestContext): Promise<IssuedSession> {
    const result = await this.#db.query(
      `SELECT ${COLUMNS} FROM sessions WHERE refresh_token_hash = $1`,
      [toParam(hashToken(refreshToken))],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AuthError('session_expired', 'no such session');
    const session = mapRow(row);
    const now = this.#clock.now();

    if (session.supersededBy !== null || session.revokedAt !== null) {
      // Two parties hold this token. Burn the family down.
      await this.revokeFamily(session.familyId, 'refresh_token_reuse');
      await recordSecurityEvent(this.#db, this.#clock, {
        kind: 'session.reuse_detected',
        outcome: 'blocked',
        userId: session.userId,
        detail: { familyId: session.familyId, generationId: session.id },
        context,
      });
      throw new AuthError(
        'session_reuse_detected',
        'this session has been terminated; sign in again',
      );
    }

    if (session.familyExpiresAt <= now) {
      throw new AuthError('session_expired', 'the session has expired');
    }

    const issued = await this.#insertGeneration({
      familyId: session.familyId,
      userId: session.userId,
      authMethod: session.authMethod,
      trustedDevice: session.trustedDevice,
      familyExpiresAt: session.familyExpiresAt,
      // Step-up freshness deliberately does *not* survive a rotation: a stolen
      // refresh token must not inherit the right to read a Plaid credential.
      fresh: false,
      now,
      ...(context === undefined ? {} : { context }),
    });

    await this.#db.query(`UPDATE sessions SET superseded_by = $2 WHERE id = $1`, [
      session.id,
      issued.session.id,
    ]);

    await recordSecurityEvent(this.#db, this.#clock, {
      kind: 'session.refreshed',
      outcome: 'success',
      userId: session.userId,
      detail: { familyId: session.familyId },
      context,
    });

    return issued;
  }

  /** Mark the session step-up fresh. Called only after a verified WebAuthn assertion. */
  async markFresh(sessionId: string): Promise<Date> {
    const freshUntil = new Date(this.#clock.nowMs() + this.#ttls.stepUpSeconds * 1_000);
    await this.#db.query(`UPDATE sessions SET fresh_until = $2 WHERE id = $1`, [
      sessionId,
      freshUntil,
    ]);
    return freshUntil;
  }

  /** True when the session holds a WebAuthn assertion from within the step-up window. */
  isFresh(session: SessionRecord): boolean {
    return session.freshUntil !== null && session.freshUntil.getTime() > this.#clock.nowMs();
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    await this.#db.query(
      `UPDATE sessions SET revoked_at = $2, revoked_reason = $3 WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId, this.#clock.now(), reason],
    );
  }

  async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.#db.query(
      `UPDATE sessions SET revoked_at = $2, revoked_reason = $3 WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, this.#clock.now(), reason],
    );
  }

  /** The panic button's session half (P2-12). */
  async revokeAll(userId: string, reason: string): Promise<number> {
    const result = await this.#db.query(
      `UPDATE sessions SET revoked_at = $2, revoked_reason = $3
       WHERE user_id = $1 AND revoked_at IS NULL
       RETURNING id`,
      [userId, this.#clock.now(), reason],
    );
    return result.rows.length;
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const result = await this.#db.query(`SELECT ${COLUMNS} FROM sessions WHERE id = $1`, [
      sessionId,
    ]);
    const row = result.rows[0];
    return row === undefined ? null : mapRow(row);
  }

  async listLive(userId: string): Promise<SessionRecord[]> {
    const result = await this.#db.query(
      `SELECT ${COLUMNS} FROM sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND superseded_by IS NULL
         AND family_expires_at > $2
       ORDER BY created_at DESC`,
      [userId, this.#clock.now()],
    );
    return result.rows.map(mapRow);
  }

  async #insertGeneration(input: {
    familyId: string;
    userId: string;
    authMethod: AuthMethod;
    trustedDevice: boolean;
    familyExpiresAt: Date;
    fresh: boolean;
    now: Date;
    context?: RequestContext | undefined;
  }): Promise<IssuedSession> {
    const accessToken = mintToken();
    const refreshToken = mintToken();
    const id = newId();

    const idleExpiresAt = earliest(
      new Date(input.now.getTime() + this.#ttls.idleSeconds * 1_000),
      input.familyExpiresAt,
    );
    const absoluteExpiresAt = earliest(
      new Date(input.now.getTime() + this.#ttls.absoluteSeconds * 1_000),
      input.familyExpiresAt,
    );
    const freshUntil = input.fresh
      ? new Date(input.now.getTime() + this.#ttls.stepUpSeconds * 1_000)
      : null;
    const uaHash = hashUserAgent(input.context?.userAgent);

    const result = await this.#db.query(
      `INSERT INTO sessions (
         id, user_id, family_id, access_token_hash, refresh_token_hash, created_at, last_seen_at,
         idle_expires_at, absolute_expires_at, family_expires_at, trusted_device, fresh_until,
         auth_method, ip, user_agent_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING ${COLUMNS}`,
      [
        id,
        input.userId,
        input.familyId,
        toParam(hashToken(accessToken)),
        toParam(hashToken(refreshToken)),
        input.now,
        idleExpiresAt,
        absoluteExpiresAt,
        input.familyExpiresAt,
        input.trustedDevice,
        freshUntil,
        input.authMethod,
        input.context?.ip ?? null,
        uaHash === null ? null : toParam(uaHash),
      ],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AuthError('session_expired', 'session insert returned no row');
    return { session: mapRow(row), accessToken, refreshToken };
  }

  #clampToSession(candidate: Date, session: SessionRecord): Date {
    return earliest(earliest(candidate, session.absoluteExpiresAt), session.familyExpiresAt);
  }
}

function earliest(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
