// SPDX-License-Identifier: MIT
/**
 * Rate limiting and lockout, and the one property that makes them worth having:
 * they survive a restart (03 §3.4, **P0-14**).
 *
 * "Simulated restart" here means throwing the `RateLimiter` away and building a
 * new one against the same database — which is exactly what `docker compose
 * restart` does to the process. An in-memory counter would pass every other test
 * in this file and fail these, and on a box the attacker can already reach,
 * "restart the container" is a trivially available bypass.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAuthError } from '../src/errors.ts';
import {
  LOCKOUT_BASE_SECONDS,
  LOCKOUT_MAX_SECONDS,
  LOCKOUT_THRESHOLD,
  lockoutSecondsForLevel,
  RATE_LIMITS,
  RateLimiter,
} from '../src/rate-limit.ts';
import { ADMIN_URL, createIdentityHarness, type IdentityHarness } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const SUBJECT = 'ip:198.51.100.7';

describeWithDb('rate limiting and lockout', () => {
  let harness: IdentityHarness;

  beforeAll(async () => {
    harness = await createIdentityHarness('personalfi_wp02_ratelimit');
  }, 120_000);

  afterAll(async () => {
    await harness.drop();
  }, 30_000);

  beforeEach(async () => {
    await harness.reset();
  });

  /** A brand-new limiter over the same database: the restart. */
  function restart(): RateLimiter {
    return new RateLimiter({ db: harness.db, clock: harness.clock });
  }

  async function expectRejected(promise: Promise<unknown>, code: string): Promise<number> {
    try {
      await promise;
      expect.unreachable(`expected ${code}`);
    } catch (error) {
      expect(isAuthError(error) && error.code).toBe(code);
      return (isAuthError(error) ? error.retryAfterSeconds : undefined) ?? 0;
    }
  }

  // ------------------------------------------------------------ fixed window

  it('allows exactly the policy limit inside a window', async () => {
    const limiter = restart();
    const policy = RATE_LIMITS['totp'];
    expect(policy).toBeDefined();

    for (let i = 0; i < (policy?.limit ?? 0); i += 1) {
      await expect(limiter.consume('totp', SUBJECT)).resolves.toBeUndefined();
    }
    const retryAfter = await expectRejected(limiter.consume('totp', SUBJECT), 'rate_limited');
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(policy?.windowSeconds ?? 0);
  });

  it('keeps the count when the process restarts (P0-14)', async () => {
    // Five attempts spread over five `RateLimiter` instances. If the counter were
    // in memory, each would start from zero and none would ever be limited.
    for (let i = 0; i < 5; i += 1) {
      await expect(restart().consume('totp', SUBJECT)).resolves.toBeUndefined();
    }
    await expectRejected(restart().consume('totp', SUBJECT), 'rate_limited');

    const stored = await harness.db.query(
      `SELECT sum(attempts)::int AS n FROM auth_attempts WHERE bucket = 'totp' AND subject = $1`,
      [SUBJECT],
    );
    expect(Number(stored.rows[0]?.['n'])).toBe(6);
  });

  it('starts a fresh window once the old one rolls over', async () => {
    const limiter = restart();
    for (let i = 0; i < 5; i += 1) await limiter.consume('totp', SUBJECT);
    await expectRejected(limiter.consume('totp', SUBJECT), 'rate_limited');

    harness.clock.advanceMs(RATE_LIMITS['totp']!.windowSeconds * 1_000);
    await expect(limiter.consume('totp', SUBJECT)).resolves.toBeUndefined();
  });

  it('counts each bucket and each subject separately', async () => {
    const limiter = restart();
    for (let i = 0; i < 5; i += 1) await limiter.consume('totp', SUBJECT);
    await expectRejected(limiter.consume('totp', SUBJECT), 'rate_limited');

    // A different credential type and a different caller are different budgets;
    // otherwise one noisy endpoint would lock out every other.
    await expect(limiter.consume('webauthn', SUBJECT)).resolves.toBeUndefined();
    await expect(limiter.consume('totp', 'ip:203.0.113.9')).resolves.toBeUndefined();
  });

  it('has the tightest budget on the unlock endpoint', async () => {
    // Everything else yields a session; brute-forcing the KEK passphrase yields
    // every provider token ever stored (03 §3.4).
    expect(RATE_LIMITS['unlock']).toEqual({ limit: 5, windowSeconds: 3_600 });
    expect(RATE_LIMITS['unlock']!.limit / RATE_LIMITS['unlock']!.windowSeconds).toBeLessThan(
      RATE_LIMITS['webauthn']!.limit / RATE_LIMITS['webauthn']!.windowSeconds,
    );
  });

  it('does not limit a bucket it has no policy for', async () => {
    // An unknown bucket must not be a silent deny — a typo in a bucket name
    // should fail open on the limiter and still be covered by lockout.
    const limiter = restart();
    for (let i = 0; i < 50; i += 1) {
      await expect(limiter.consume('no_such_bucket', SUBJECT)).resolves.toBeUndefined();
    }
  });

  // ----------------------------------------------------------------- lockout

  it('locks out after ten consecutive failures, for fifteen minutes', async () => {
    const limiter = restart();
    for (let i = 1; i < LOCKOUT_THRESHOLD; i += 1) {
      const outcome = await limiter.recordFailure('webauthn', SUBJECT, harness.userId);
      expect(outcome).toEqual({ consecutiveFailures: i, lockedUntil: null });
    }

    const tenth = await limiter.recordFailure('webauthn', SUBJECT, harness.userId);
    expect(tenth.consecutiveFailures).toBe(LOCKOUT_THRESHOLD);
    expect(tenth.lockedUntil?.getTime()).toBe(harness.clock.nowMs() + LOCKOUT_BASE_SECONDS * 1_000);

    const retryAfter = await expectRejected(
      limiter.assertNotLockedOut('webauthn', SUBJECT),
      'locked_out',
    );
    expect(retryAfter).toBe(LOCKOUT_BASE_SECONDS);
  });

  it('keeps the lockout across a restart', async () => {
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await restart().recordFailure('webauthn', SUBJECT, harness.userId);
    }
    // The whole point of P0-14: bouncing the container is not a way back in.
    await expectRejected(restart().assertNotLockedOut('webauthn', SUBJECT), 'locked_out');
    await expectRejected(restart().consume('webauthn', SUBJECT), 'locked_out');
  });

  it('checks the lockout before the counter, so hammering cannot keep a window warm', async () => {
    const limiter = restart();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await limiter.recordFailure('webauthn', SUBJECT, harness.userId);
    }
    const before = await harness.db.query(
      `SELECT coalesce(sum(attempts), 0)::int AS n FROM auth_attempts WHERE bucket = 'webauthn'`,
    );
    await expectRejected(limiter.consume('webauthn', SUBJECT), 'locked_out');
    const after = await harness.db.query(
      `SELECT coalesce(sum(attempts), 0)::int AS n FROM auth_attempts WHERE bucket = 'webauthn'`,
    );
    expect(Number(after.rows[0]?.['n'])).toBe(Number(before.rows[0]?.['n']));
  });

  it('doubles the backoff on each subsequent lockout and caps it at 24 hours', async () => {
    expect(lockoutSecondsForLevel(1)).toBe(900);
    expect(lockoutSecondsForLevel(2)).toBe(1_800);
    expect(lockoutSecondsForLevel(3)).toBe(3_600);
    expect(lockoutSecondsForLevel(8)).toBe(LOCKOUT_MAX_SECONDS);
    // The cap matters: a permanent lockout on a single-user self-hosted app is a
    // denial of service with no support desk to call.
    expect(lockoutSecondsForLevel(40)).toBe(LOCKOUT_MAX_SECONDS);

    const limiter = restart();
    const durations: number[] = [];
    for (let round = 0; round < 3; round += 1) {
      let lockedUntil: Date | null = null;
      for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
        ({ lockedUntil } = await limiter.recordFailure('recovery_code', SUBJECT, harness.userId));
      }
      expect(lockedUntil).not.toBeNull();
      durations.push((lockedUntil!.getTime() - harness.clock.nowMs()) / 1_000);
      harness.clock.advanceMs((durations.at(-1) ?? 0) * 1_000 + 1_000);
    }
    expect(durations).toEqual([900, 1_800, 3_600]);
  });

  it('resets the failure counter at the threshold so the eleventh try is not an instant re-lock', async () => {
    const limiter = restart();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await limiter.recordFailure('webauthn', SUBJECT, harness.userId);
    }
    const stored = await harness.db.query(
      `SELECT consecutive_failures, lock_level FROM auth_lockouts WHERE bucket = 'webauthn' AND subject = $1`,
      [SUBJECT],
    );
    expect(Number(stored.rows[0]?.['consecutive_failures'])).toBe(0);
    expect(Number(stored.rows[0]?.['lock_level'])).toBe(1);
  });

  it('lets the lockout lapse on its own', async () => {
    const limiter = restart();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await limiter.recordFailure('webauthn', SUBJECT, harness.userId);
    }
    harness.clock.advanceMs(LOCKOUT_BASE_SECONDS * 1_000 + 1_000);
    await expect(limiter.assertNotLockedOut('webauthn', SUBJECT)).resolves.toBeUndefined();
  });

  it('clears the failure count on success but keeps the backoff ladder', async () => {
    const limiter = restart();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await limiter.recordFailure('webauthn', SUBJECT, harness.userId);
    }
    harness.clock.advanceMs(LOCKOUT_BASE_SECONDS * 1_000 + 1_000);
    await limiter.recordSuccess('webauthn', SUBJECT);

    const stored = await harness.db.query(
      `SELECT consecutive_failures, lock_level, locked_until FROM auth_lockouts
       WHERE bucket = 'webauthn' AND subject = $1`,
      [SUBJECT],
    );
    expect(Number(stored.rows[0]?.['consecutive_failures'])).toBe(0);
    expect(stored.rows[0]?.['locked_until']).toBeNull();
    // An attacker who occasionally guesses right must not reset the ladder.
    expect(Number(stored.rows[0]?.['lock_level'])).toBe(1);

    // The next ten failures therefore produce the *second* lockout, not the first.
    let lockedUntil: Date | null = null;
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      ({ lockedUntil } = await limiter.recordFailure('webauthn', SUBJECT, harness.userId));
    }
    expect((lockedUntil!.getTime() - harness.clock.nowMs()) / 1_000).toBe(1_800);
  });

  it('decays the backoff level after a full quiet maximum window', async () => {
    const limiter = restart();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await limiter.recordFailure('webauthn', SUBJECT, harness.userId);
    }
    harness.clock.advanceMs(LOCKOUT_MAX_SECONDS * 1_000 + 1_000);
    await limiter.recordSuccess('webauthn', SUBJECT);

    const stored = await harness.db.query(
      `SELECT lock_level FROM auth_lockouts WHERE bucket = 'webauthn' AND subject = $1`,
      [SUBJECT],
    );
    expect(Number(stored.rows[0]?.['lock_level'])).toBe(0);
  });

  it('gives the operator a way out', async () => {
    const limiter = restart();
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await limiter.recordFailure('webauthn', SUBJECT, harness.userId);
    }
    await limiter.clearLockout('webauthn', SUBJECT);
    await expect(limiter.assertNotLockedOut('webauthn', SUBJECT)).resolves.toBeUndefined();
  });

  it('purges old windows without touching live ones', async () => {
    const limiter = restart();
    await limiter.consume('totp', SUBJECT);
    harness.clock.advanceMs(8 * 24 * 3_600 * 1_000);
    await limiter.consume('totp', SUBJECT);

    await limiter.purgeExpired();
    const left = await harness.db.query(`SELECT count(*)::int AS n FROM auth_attempts`);
    expect(Number(left.rows[0]?.['n'])).toBe(1);
  });
});
