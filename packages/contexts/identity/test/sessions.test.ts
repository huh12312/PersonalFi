// SPDX-License-Identifier: MIT
/**
 * The session state machine (03 §3.4, decision D21, P0-5).
 *
 * Issue → use → refresh → reuse → step up, with a clock the test winds forward so
 * an eight-hour cap can be asserted without waiting eight hours.
 *
 * The reuse case is the one that matters most. It is the only signal this
 * application has that a cookie was stolen, and it only works because a refresh
 * rotation inserts a *new row* rather than updating the old one: an `UPDATE` would
 * destroy the very evidence the detection reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_TTLS, hashToken } from '../src/sessions.ts';
import {
  ADMIN_URL,
  createIdentityHarness,
  EPOCH,
  requestContext,
  type IdentityHarness,
} from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describeWithDb('sessions', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness('personalfi_wp02_sessions');
  }, 120_000);

  afterAll(async () => {
    await harness.drop();
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
  });

  const sessions = () => harness.identity.sessions;

  async function issue(overrides: { trustedDevice?: boolean; fresh?: boolean } = {}) {
    return sessions().issue({
      userId: harness.userId,
      authMethod: 'webauthn',
      context: requestContext(),
      ...overrides,
    });
  }

  async function countEvents(kind: string): Promise<number> {
    const result = await harness.db.query(
      `SELECT count(*)::int AS n FROM security_events WHERE kind = $1`,
      [kind],
    );
    return Number(result.rows[0]?.['n'] ?? 0);
  }

  // ------------------------------------------------------------------ issue

  it('mints a family with a 15 minute idle window and an 8 hour cap', async () => {
    const issued = await issue();
    const start = new Date(EPOCH).getTime();

    expect(issued.session.idleExpiresAt.getTime()).toBe(start + 15 * MINUTE);
    expect(issued.session.absoluteExpiresAt.getTime()).toBe(start + 8 * HOUR);
    expect(issued.session.familyExpiresAt.getTime()).toBe(start + 8 * HOUR);
    expect(issued.session.familyId).toBeTruthy();
    expect(issued.session.trustedDevice).toBe(false);
    expect(issued.session.supersededBy).toBeNull();
    expect(issued.session.revokedAt).toBeNull();
  });

  it('extends only the family window for a trusted device (D21)', async () => {
    const issued = await issue({ trustedDevice: true });
    const start = new Date(EPOCH).getTime();

    // 14 days of *refresh*, still 15 minutes of idle and 8 hours per generation.
    // The convenience is in not re-authenticating, not in a session that never
    // ends: rotation with reuse detection is what pays for it.
    expect(issued.session.familyExpiresAt.getTime()).toBe(start + 14 * DAY);
    expect(issued.session.idleExpiresAt.getTime()).toBe(start + 15 * MINUTE);
    expect(issued.session.absoluteExpiresAt.getTime()).toBe(start + 8 * HOUR);
    expect(issued.session.trustedDevice).toBe(true);
  });

  it('stores only digests — the raw tokens exist solely in the browser', async () => {
    const issued = await issue();
    const stored = await harness.db.query(
      `SELECT access_token_hash, refresh_token_hash, user_agent_hash, ip FROM sessions WHERE id = $1`,
      [issued.session.id],
    );
    const row = stored.rows[0];
    expect(row).toBeDefined();

    const access = Buffer.from(row?.['access_token_hash'] as Uint8Array);
    expect(access).toHaveLength(32);
    expect(access.equals(Buffer.from(hashToken(issued.accessToken)))).toBe(true);
    expect(access.toString('latin1')).not.toContain(issued.accessToken);

    // The user agent is a fingerprint and is hashed, not stored (P1-10).
    expect(Buffer.from(row?.['user_agent_hash'] as Uint8Array)).toHaveLength(32);
    expect(String(row?.['ip'])).toBe('198.51.100.7');
  });

  it('mints unguessable, distinct tokens', async () => {
    const issued = await issue();
    // 32 bytes of CSPRNG as base64url.
    expect(issued.accessToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.accessToken).not.toBe(issued.refreshToken);
  });

  it('starts fresh after a passkey assertion and not after TOTP', async () => {
    // A passkey assertion *is* a step-up, so the user is not challenged twice
    // inside five minutes of signing in. A TOTP code is not.
    const passkey = await issue({ fresh: true });
    expect(sessions().isFresh(passkey.session)).toBe(true);

    const totp = await sessions().issue({
      userId: harness.userId,
      authMethod: 'totp',
      context: requestContext(),
    });
    expect(sessions().isFresh(totp.session)).toBe(false);
  });

  // -------------------------------------------------------------------- use

  it('slides the idle window on use but never the absolute cap', async () => {
    const issued = await issue();
    const absolute = issued.session.absoluteExpiresAt.getTime();

    harness.clock.advanceMs(10 * MINUTE);
    const first = await sessions().authenticate(issued.accessToken);
    expect(first?.idleExpiresAt.getTime()).toBe(new Date(EPOCH).getTime() + 25 * MINUTE);
    expect(first?.absoluteExpiresAt.getTime()).toBe(absolute);

    harness.clock.advanceMs(10 * MINUTE);
    const second = await sessions().authenticate(issued.accessToken);
    expect(second?.idleExpiresAt.getTime()).toBe(new Date(EPOCH).getTime() + 35 * MINUTE);
    expect(second?.absoluteExpiresAt.getTime()).toBe(absolute);
    expect(second?.lastSeenAt.getTime()).toBe(new Date(EPOCH).getTime() + 20 * MINUTE);
  });

  it('expires after 15 minutes of inactivity', async () => {
    const issued = await issue();
    harness.clock.advanceMs(14 * MINUTE);
    expect(await sessions().authenticate(issued.accessToken)).not.toBeNull();

    harness.clock.advanceMs(16 * MINUTE);
    expect(await sessions().authenticate(issued.accessToken)).toBeNull();
  });

  it('dies at the absolute cap even under continuous use — that is what makes it a cap', async () => {
    const issued = await issue();

    // Poll every ten minutes for eight hours. The idle window never lapses.
    for (let elapsed = 0; elapsed < 8 * HOUR; elapsed += 10 * MINUTE) {
      harness.clock.advanceMs(10 * MINUTE);
      const alive = await sessions().authenticate(issued.accessToken);
      if (alive === null) {
        expect(elapsed).toBeGreaterThanOrEqual(8 * HOUR - 10 * MINUTE);
        return;
      }
      // The slide is clamped: the idle window can never reach past the cap.
      expect(alive.idleExpiresAt.getTime()).toBeLessThanOrEqual(alive.absoluteExpiresAt.getTime());
    }
    expect(await sessions().authenticate(issued.accessToken)).toBeNull();
  });

  it('returns null rather than throwing for an unknown token', async () => {
    // An unknown cookie is the ordinary case after a logout, and the caller turns
    // it into a plain 401 with nothing distinguishable in it.
    expect(await sessions().authenticate('not-a-real-token')).toBeNull();
  });

  it('refuses a revoked session', async () => {
    const issued = await issue();
    await sessions().revoke(issued.session.id, 'test');
    expect(await sessions().authenticate(issued.accessToken)).toBeNull();
  });

  // ---------------------------------------------------------------- refresh

  it('rotates into a new generation of the same family', async () => {
    const first = await issue();
    harness.clock.advanceMs(5 * MINUTE);
    const second = await sessions().refresh(first.refreshToken, requestContext());

    expect(second.session.familyId).toBe(first.session.familyId);
    expect(second.session.id).not.toBe(first.session.id);
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // The family's hard stop does not move, so rotation cannot launder a session
    // past its cap.
    expect(second.session.familyExpiresAt.getTime()).toBe(first.session.familyExpiresAt.getTime());
    // A fresh idle window, though: that is the point of rotating.
    expect(second.session.idleExpiresAt.getTime()).toBe(
      new Date(EPOCH).getTime() + 5 * MINUTE + 15 * MINUTE,
    );

    const stored = await harness.db.query(`SELECT superseded_by FROM sessions WHERE id = $1`, [
      first.session.id,
    ]);
    expect(String(stored.rows[0]?.['superseded_by'])).toBe(second.session.id);
    expect(await countEvents('session.refreshed')).toBe(1);
  });

  it('kills the superseded generation`s access token', async () => {
    const first = await issue();
    const second = await sessions().refresh(first.refreshToken, requestContext());

    // Otherwise rotation would leave two live access tokens and the older one
    // would outlive the refresh that replaced it.
    expect(await sessions().authenticate(first.accessToken)).toBeNull();
    expect(await sessions().authenticate(second.accessToken)).not.toBeNull();
  });

  it('clamps a rotated generation to the family window', async () => {
    const issued = await issue();
    harness.clock.advanceMs(8 * HOUR - 5 * MINUTE);
    const rotated = await sessions().refresh(issued.refreshToken, requestContext());

    // Five minutes left in the family, so the new generation gets five minutes,
    // not a fresh fifteen and certainly not a fresh eight hours.
    expect(rotated.session.idleExpiresAt.getTime()).toBe(issued.session.familyExpiresAt.getTime());
    expect(rotated.session.absoluteExpiresAt.getTime()).toBe(
      issued.session.familyExpiresAt.getTime(),
    );
  });

  it('refuses to rotate past the family window', async () => {
    const issued = await issue();
    harness.clock.advanceMs(8 * HOUR + MINUTE);
    await expect(sessions().refresh(issued.refreshToken, requestContext())).rejects.toMatchObject({
      code: 'session_expired',
    });
  });

  it('rotates for fourteen days on a trusted device', async () => {
    let current = await issue({ trustedDevice: true });
    for (let day = 0; day < 13; day += 1) {
      harness.clock.advanceMs(DAY);
      current = await sessions().refresh(current.refreshToken, requestContext());
      expect(current.session.trustedDevice).toBe(true);
    }
    harness.clock.advanceMs(2 * DAY);
    await expect(sessions().refresh(current.refreshToken, requestContext())).rejects.toMatchObject({
      code: 'session_expired',
    });
  });

  it('does not carry step-up freshness across a rotation', async () => {
    const first = await issue({ fresh: true });
    expect(sessions().isFresh(first.session)).toBe(true);

    const second = await sessions().refresh(first.refreshToken, requestContext());
    // A stolen refresh token must not inherit the right to read a Plaid
    // credential; step-up is re-earned with an assertion, not with a cookie.
    expect(second.session.freshUntil).toBeNull();
    expect(sessions().isFresh(second.session)).toBe(false);
  });

  it('reports a refresh token it has never seen as an ordinary expiry', async () => {
    await expect(sessions().refresh('never-issued', requestContext())).rejects.toMatchObject({
      code: 'session_expired',
    });
  });

  // ------------------------------------------------------------------ reuse

  it('kills the whole family when a rotated refresh token is replayed', async () => {
    const first = await issue();
    const second = await sessions().refresh(first.refreshToken, requestContext());
    const third = await sessions().refresh(second.refreshToken, requestContext());

    // Two parties hold `first.refreshToken`: the legitimate browser rotated it
    // away, so whoever is presenting it now is not the browser.
    await expect(sessions().refresh(first.refreshToken, requestContext())).rejects.toMatchObject({
      code: 'session_reuse_detected',
    });

    // Every generation is revoked, including the one the attacker did not touch.
    for (const generation of [first, second, third]) {
      expect(await sessions().authenticate(generation.accessToken)).toBeNull();
    }
    await expect(sessions().refresh(third.refreshToken, requestContext())).rejects.toMatchObject({
      code: 'session_reuse_detected',
    });

    const revoked = await harness.db.query(
      `SELECT DISTINCT revoked_reason FROM sessions WHERE family_id = $1`,
      [first.session.familyId],
    );
    expect(revoked.rows.map((row) => String(row['revoked_reason']))).toEqual([
      'refresh_token_reuse',
    ]);
    // Two replays above, two `session.reuse_detected` rows: the log records
    // attempts, not families, so a repeated replay is still visible.
    expect(await countEvents('session.reuse_detected')).toBe(2);
  });

  it('leaves other families alone when one is burned down', async () => {
    const laptop = await issue();
    const phone = await issue();
    await sessions().refresh(laptop.refreshToken, requestContext());

    await expect(sessions().refresh(laptop.refreshToken, requestContext())).rejects.toMatchObject({
      code: 'session_reuse_detected',
    });

    // Signing out everywhere is a deliberate act (`revokeAll`), not a side effect
    // of one stolen cookie.
    expect(await sessions().authenticate(phone.accessToken)).not.toBeNull();
  });

  it('treats a revoked generation`s refresh token as reuse, not expiry', async () => {
    const issued = await issue();
    await sessions().revokeFamily(issued.session.familyId, 'logout');
    await expect(sessions().refresh(issued.refreshToken, requestContext())).rejects.toMatchObject({
      code: 'session_reuse_detected',
    });
  });

  // ---------------------------------------------------------------- step up

  it('marks a session fresh for five minutes and then lets it lapse', async () => {
    const issued = await issue();
    expect(sessions().isFresh(issued.session)).toBe(false);

    const freshUntil = await sessions().markFresh(issued.session.id);
    expect(freshUntil.getTime()).toBe(
      new Date(EPOCH).getTime() + DEFAULT_SESSION_TTLS.stepUpSeconds * 1_000,
    );

    const reloaded = await sessions().findById(issued.session.id);
    expect(reloaded).not.toBeNull();
    expect(sessions().isFresh(reloaded!)).toBe(true);

    harness.clock.advanceMs(5 * MINUTE + 1_000);
    expect(sessions().isFresh(reloaded!)).toBe(false);
  });

  // ------------------------------------------------------------- revocation

  it('revokes a family on logout and lists only live sessions', async () => {
    const laptop = await issue();
    const phone = await issue();
    expect(await sessions().listLive(harness.userId)).toHaveLength(2);

    await sessions().revokeFamily(laptop.session.familyId, 'logout');

    const live = await sessions().listLive(harness.userId);
    expect(live.map((session) => session.id)).toEqual([phone.session.id]);
  });

  it('excludes superseded generations from the live list', async () => {
    const issued = await issue();
    const rotated = await sessions().refresh(issued.refreshToken, requestContext());
    const live = await sessions().listLive(harness.userId);
    expect(live.map((session) => session.id)).toEqual([rotated.session.id]);
  });

  it('revokes everything at once — the panic button`s session half', async () => {
    await issue();
    await issue();
    await issue();
    expect(await sessions().revokeAll(harness.userId, 'panic')).toBe(3);
    expect(await sessions().listLive(harness.userId)).toHaveLength(0);
    // Idempotent: a second press revokes nothing further.
    expect(await sessions().revokeAll(harness.userId, 'panic')).toBe(0);
  });
});
