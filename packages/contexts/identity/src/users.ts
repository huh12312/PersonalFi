// SPDX-License-Identifier: MIT
/**
 * The single user, and the one-time token that enrols their first passkey.
 *
 * The bootstrap problem is real and has exactly one good answer. A box with no
 * credentials cannot authenticate anybody, so *something* must be trusted once. The
 * options are a default password (never), an open registration endpoint (an
 * internet-facing account takeover waiting for a misconfigured proxy), or a
 * single-use token minted by someone with shell access on the host. The third is
 * the only one where the trust boundary matches reality: whoever can run
 * `just bootstrap-user` already owns the machine and the database.
 *
 * The token is short-lived, single-use, and stored as a SHA-256 digest, so a
 * leaked database dump does not contain a working enrolment link.
 */
import { newId, type Clock } from '@core/kernel';
import { constantTimeEqual, randomBytes, sha256 } from '@core/secretbox';
import { asDate, toParam, type IdentityQueryable } from './db.ts';
import { AuthError } from './errors.ts';

export const REGISTRATION_TOKEN_TTL_SECONDS = 3_600;

export interface UserRecord {
  readonly id: string;
  readonly displayName: string;
  readonly displayTimezone: string;
  readonly createdAt: Date;
}

export interface RegistrationTokenIssue {
  readonly token: string;
  readonly expiresAt: Date;
}

export interface UserServiceOptions {
  readonly db: IdentityQueryable;
  readonly clock: Clock;
}

export class UserService {
  readonly #db: IdentityQueryable;
  readonly #clock: Clock;

  constructor(options: UserServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
  }

  /**
   * The single user, or null on a fresh install.
   *
   * `ORDER BY created_at, id` rather than "the only row": the schema is multi-user
   * ready by decision D6, and a query that assumes exactly one row would be a
   * landmine the day a second appears.
   */
  async findPrimary(): Promise<UserRecord | null> {
    const result = await this.#db.query(
      `SELECT id, display_name, display_timezone, created_at FROM users ORDER BY created_at, id LIMIT 1`,
    );
    const row = result.rows[0];
    return row === undefined ? null : mapUser(row);
  }

  async findById(userId: string): Promise<UserRecord | null> {
    const result = await this.#db.query(
      `SELECT id, display_name, display_timezone, created_at FROM users WHERE id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapUser(row);
  }

  /** Create the account holder. Refuses if one already exists — this is a single-user app. */
  async createPrimary(input: {
    displayName: string;
    displayTimezone?: string;
  }): Promise<UserRecord> {
    const existing = await this.findPrimary();
    if (existing !== null) {
      throw new AuthError('already_bootstrapped', 'a user already exists');
    }
    const timezone = input.displayTimezone ?? 'UTC';
    assertIanaZone(timezone);

    const result = await this.#db.query(
      `INSERT INTO users (id, display_name, display_timezone, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id, display_name, display_timezone, created_at`,
      [newId(), input.displayName, timezone, this.#clock.now()],
    );
    const row = result.rows[0];
    if (row === undefined) throw new AuthError('not_bootstrapped', 'user insert returned no row');
    return mapUser(row);
  }

  async setTimezone(userId: string, timezone: string): Promise<void> {
    assertIanaZone(timezone);
    await this.#db.query(`UPDATE users SET display_timezone = $2 WHERE id = $1`, [
      userId,
      timezone,
    ]);
  }

  /** Mint a one-time enrolment token. The plaintext is returned once and never stored. */
  async issueRegistrationToken(userId: string): Promise<RegistrationTokenIssue> {
    const token = Buffer.from(randomBytes(32)).toString('base64url');
    const now = this.#clock.now();
    const expiresAt = new Date(now.getTime() + REGISTRATION_TOKEN_TTL_SECONDS * 1_000);
    await this.#db.query(
      `INSERT INTO registration_tokens (id, user_id, token_hash, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [newId(), userId, toParam(sha256(new TextEncoder().encode(token))), now, expiresAt],
    );
    return { token, expiresAt };
  }

  /**
   * Redeem a registration token, returning the user it belongs to.
   *
   * The `UPDATE ... WHERE used_at IS NULL ... RETURNING` is the single-use
   * guarantee. The constant-time compare that follows is belt-and-braces: the
   * lookup is already by digest, so there is no secret left to leak by timing, but
   * a future refactor that turns the digest lookup into a scan would silently
   * introduce one.
   */
  async redeemRegistrationToken(token: string): Promise<UserRecord> {
    const digest = sha256(new TextEncoder().encode(token));
    const now = this.#clock.now();
    const result = await this.#db.query(
      `UPDATE registration_tokens SET used_at = $2
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
       RETURNING user_id, token_hash`,
      [toParam(digest), now],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new AuthError('invalid_credential', 'that enrolment link is not valid');
    }
    if (!constantTimeEqual(digest, new Uint8Array(row['token_hash'] as Buffer))) {
      throw new AuthError('invalid_credential', 'that enrolment link is not valid');
    }
    const user = await this.findById(String(row['user_id']));
    if (user === null) throw new AuthError('not_bootstrapped', 'no such user');
    return user;
  }
}

function mapUser(row: Record<string, unknown>): UserRecord {
  return {
    id: String(row['id']),
    displayName: String(row['display_name']),
    displayTimezone: String(row['display_timezone']),
    createdAt: asDate(row['created_at']),
  };
}

/**
 * Postgres has no IANA type, so the check lives here.
 *
 * Rejecting `|` matters beyond tidiness: it is the AAD separator, and a timezone
 * is the kind of user-controlled string that ends up concatenated into one.
 */
export function assertIanaZone(timezone: string): void {
  if (timezone.includes('|')) {
    throw new AuthError('invalid_credential', 'a time zone may not contain "|"');
  }
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
  } catch {
    throw new AuthError('invalid_credential', `unknown IANA time zone ${JSON.stringify(timezone)}`);
  }
}
