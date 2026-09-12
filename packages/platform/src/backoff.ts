// SPDX-License-Identifier: MIT
import { InvalidValueError } from '@core/kernel';

/**
 * Retry backoff, shared by the consumer pump and the job runner.
 *
 * Full jitter (`random() * capped`) rather than exponential-with-a-little-noise.
 * The failure this app actually hits is a provider returning 429 or 503 to every
 * request at once; with equal-jitter or none, every retry lands in the same
 * narrow window and the herd reconverges on each round. Full jitter is the AWS
 * architecture blog's recommendation and it is one multiplication.
 *
 * The cap matters as much as the growth: without it, attempt 12 of a nightly sync
 * is scheduled eleven days out and the ledger is silently stale, which is the
 * worst failure mode in a finance app.
 */
export interface BackoffOptions {
  /** Delay before the first retry, before jitter. */
  readonly baseMs: number;
  /** Growth per attempt. 2 doubles; 1 is a constant delay. */
  readonly factor?: number;
  /** Hard ceiling on the delay. Six hours for syncs (04 §4.5). */
  readonly maxMs: number;
  /** `full` spreads uniformly over [0, capped]; `none` is deterministic. */
  readonly jitter?: 'full' | 'none';
}

export const DEFAULT_JOB_BACKOFF: BackoffOptions = Object.freeze({
  baseMs: 1_000,
  factor: 2,
  maxMs: 6 * 60 * 60 * 1_000,
  jitter: 'full',
});

export const DEFAULT_CONSUMER_BACKOFF: BackoffOptions = Object.freeze({
  baseMs: 500,
  factor: 3,
  maxMs: 5 * 60 * 1_000,
  jitter: 'full',
});

/**
 * The delay before retry number `attempt` (1 = the first retry).
 *
 * Invariants, all covered by the property test next to this file:
 *   * the result is a finite integer in `[0, min(maxMs, base * factor^(n-1))]`;
 *   * the un-jittered ceiling is monotonically non-decreasing in `attempt`;
 *   * it never exceeds `maxMs`, whatever the attempt number or the random draw;
 *   * with `jitter: 'none'` it is a pure function of its arguments.
 *
 * `random` is injected rather than read from `Math.random` so a test can pin it
 * and an incident can be reproduced.
 */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions,
  random: () => number = Math.random,
): number {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new InvalidValueError('attempt', `must be an integer >= 1, got ${String(attempt)}`);
  }
  const capped = backoffCeilingMs(attempt, options);
  if ((options.jitter ?? 'full') === 'none') return capped;

  const draw = random();
  // A broken `random` must not turn into a negative delay or a NaN that later
  // becomes an `Invalid Date` in `run_after`.
  const bounded = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 1) : 0;
  return Math.floor(capped * bounded);
}

/** The un-jittered ceiling for an attempt: `min(maxMs, base * factor^(n-1))`. */
export function backoffCeilingMs(attempt: number, options: BackoffOptions): number {
  const factor = options.factor ?? 2;
  if (options.baseMs < 0 || options.maxMs < 0) {
    throw new InvalidValueError('backoff', 'baseMs and maxMs must be non-negative');
  }
  if (factor < 1) {
    throw new InvalidValueError('backoff', `factor must be >= 1, got ${String(factor)}`);
  }
  // `factor ** attempt` overflows to Infinity for large attempt counts; the cap
  // absorbs it, but Math.min(Infinity, max) must be reached without a NaN, so the
  // multiplication is done before the clamp and never after.
  const raw = options.baseMs * factor ** (attempt - 1);
  const capped = Number.isFinite(raw) ? Math.min(raw, options.maxMs) : options.maxMs;
  return Math.floor(capped);
}
