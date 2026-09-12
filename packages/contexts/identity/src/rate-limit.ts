// SPDX-License-Identifier: MIT
/**
 * Rate limiting and lockout, persisted in Postgres (03 §3.4, P0-14).
 *
 * The "persisted" is the whole point. An in-memory counter resets when the process
 * restarts, and on a self-hosted box an attacker who can reach `/auth` can often
 * also provoke a restart — so an in-memory limiter is a speed bump with a documented
 * bypass. Every counter and every lockout here survives `docker compose restart`,
 * and there is a test that proves it by throwing the service away and building a
 * new one against the same database.
 */
import type { Clock } from '@core/kernel';
import { AuthError } from './errors.ts';
import type { IdentityQueryable } from './db.ts';

export interface RateLimitPolicy {
  /** Requests allowed per window. */
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * The limits from 03 §3.4, verbatim.
 *
 * `unlock` is the tightest because brute-forcing the KEK passphrase is the
 * highest-value attack against this application: everything else yields a session,
 * that one yields every Plaid token ever stored.
 */
export const RATE_LIMITS: Readonly<Record<string, RateLimitPolicy>> = Object.freeze({
  webauthn: { limit: 10, windowSeconds: 300 },
  totp: { limit: 5, windowSeconds: 900 },
  recovery_code: { limit: 5, windowSeconds: 3_600 },
  refresh: { limit: 60, windowSeconds: 3_600 },
  unlock: { limit: 5, windowSeconds: 3_600 },
  register: { limit: 10, windowSeconds: 3_600 },
});

/** Ten consecutive failures, then 15 minutes doubling to a 24 h ceiling. */
export const LOCKOUT_THRESHOLD = 10;
export const LOCKOUT_BASE_SECONDS = 900;
export const LOCKOUT_MAX_SECONDS = 86_400;

export function lockoutSecondsForLevel(level: number): number {
  const scaled = LOCKOUT_BASE_SECONDS * 2 ** Math.max(0, level - 1);
  return Math.min(scaled, LOCKOUT_MAX_SECONDS);
}

export interface RateLimiterOptions {
  readonly db: IdentityQueryable;
  readonly clock: Clock;
  readonly policies?: Readonly<Record<string, RateLimitPolicy>>;
}

export class RateLimiter {
  readonly #db: IdentityQueryable;
  readonly #clock: Clock;
  readonly #policies: Readonly<Record<string, RateLimitPolicy>>;

  constructor(options: RateLimiterOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#policies = options.policies ?? RATE_LIMITS;
  }

  /**
   * Check the lockout *and* the window counter, and count this attempt.
   *
   * Order matters: the lockout is checked first and short-circuits, so a locked
   * subject cannot keep the rate-limit window warm by hammering it.
   */
  async consume(bucket: string, subject: string, userId?: string | null): Promise<void> {
    await this.assertNotLockedOut(bucket, subject);

    const policy = this.#policies[bucket];
    if (policy === undefined) return;

    const now = this.#clock.now();
    const windowStart = floorToWindow(now, policy.windowSeconds);

    const result = await this.#db.query(
      `INSERT INTO auth_attempts (bucket, subject, window_start, attempts, user_id, updated_at)
       VALUES ($1, $2, $3, 1, $4, $5)
       ON CONFLICT (bucket, subject, window_start)
       DO UPDATE SET attempts = auth_attempts.attempts + 1, updated_at = $5
       RETURNING attempts`,
      [bucket, subject, windowStart, userId ?? null, now],
    );
    const attempts = Number(result.rows[0]?.['attempts'] ?? 0);
    if (attempts > policy.limit) {
      const resetAt = new Date(windowStart.getTime() + policy.windowSeconds * 1_000);
      throw new AuthError(
        'rate_limited',
        'too many attempts; try again later',
        Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1_000)),
      );
    }
  }

  async assertNotLockedOut(bucket: string, subject: string): Promise<void> {
    const result = await this.#db.query(
      `SELECT locked_until FROM auth_lockouts WHERE bucket = $1 AND subject = $2`,
      [bucket, subject],
    );
    const lockedUntil = result.rows[0]?.['locked_until'] as Date | null | undefined;
    if (lockedUntil == null) return;
    const remainingMs = lockedUntil.getTime() - this.#clock.nowMs();
    if (remainingMs <= 0) return;
    throw new AuthError(
      'locked_out',
      'this credential is temporarily locked',
      Math.ceil(remainingMs / 1_000),
    );
  }

  /**
   * Record a failure. Returns the lockout that was just applied, if any, so the
   * caller can write the `auth.locked_out` security event with the real numbers.
   */
  async recordFailure(
    bucket: string,
    subject: string,
    userId?: string | null,
  ): Promise<{ consecutiveFailures: number; lockedUntil: Date | null }> {
    const now = this.#clock.now();
    const result = await this.#db.query(
      `INSERT INTO auth_lockouts (bucket, subject, consecutive_failures, lock_level, user_id, first_failure_at, updated_at)
       VALUES ($1, $2, 1, 0, $3, $4, $4)
       ON CONFLICT (bucket, subject) DO UPDATE SET
         consecutive_failures = auth_lockouts.consecutive_failures + 1,
         first_failure_at = coalesce(auth_lockouts.first_failure_at, $4),
         updated_at = $4
       RETURNING consecutive_failures, lock_level`,
      [bucket, subject, userId ?? null, now],
    );

    const failures = Number(result.rows[0]?.['consecutive_failures'] ?? 0);
    const level = Number(result.rows[0]?.['lock_level'] ?? 0);
    if (failures < LOCKOUT_THRESHOLD) return { consecutiveFailures: failures, lockedUntil: null };

    // Threshold reached: lock, escalate the backoff level, and reset the counter so
    // the next ten failures produce the next (longer) lock rather than an instant
    // re-lock on the eleventh.
    const nextLevel = level + 1;
    const lockedUntil = new Date(now.getTime() + lockoutSecondsForLevel(nextLevel) * 1_000);
    await this.#db.query(
      `UPDATE auth_lockouts
       SET consecutive_failures = 0, lock_level = $3, locked_until = $4, updated_at = $5
       WHERE bucket = $1 AND subject = $2`,
      [bucket, subject, nextLevel, lockedUntil, now],
    );
    return { consecutiveFailures: failures, lockedUntil };
  }

  /**
   * A success clears the consecutive-failure counter but **not** `lock_level`.
   *
   * Keeping the level means an attacker who occasionally guesses right does not
   * reset the backoff ladder. It decays instead: `clearLockout` drops the level
   * once the subject has been quiet for a full maximum window.
   */
  async recordSuccess(bucket: string, subject: string): Promise<void> {
    const now = this.#clock.now();
    await this.#db.query(
      `UPDATE auth_lockouts
       SET consecutive_failures = 0, locked_until = NULL, first_failure_at = NULL, updated_at = $3,
           lock_level = CASE
             WHEN auth_lockouts.updated_at < $4 THEN 0
             ELSE auth_lockouts.lock_level
           END
       WHERE bucket = $1 AND subject = $2`,
      [bucket, subject, now, new Date(now.getTime() - LOCKOUT_MAX_SECONDS * 1_000)],
    );
  }

  /** Operator escape hatch, for the runbook and for `just`-driven recovery. */
  async clearLockout(bucket: string, subject: string): Promise<void> {
    await this.#db.query(`DELETE FROM auth_lockouts WHERE bucket = $1 AND subject = $2`, [
      bucket,
      subject,
    ]);
  }

  /** Housekeeping. Old windows are noise; WP 0.3's job runner will call this. */
  async purgeExpired(): Promise<void> {
    const cutoff = new Date(this.#clock.nowMs() - 7 * 24 * 3_600 * 1_000);
    await this.#db.query(`DELETE FROM auth_attempts WHERE window_start < $1`, [cutoff]);
  }
}

function floorToWindow(now: Date, windowSeconds: number): Date {
  const windowMs = windowSeconds * 1_000;
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}
