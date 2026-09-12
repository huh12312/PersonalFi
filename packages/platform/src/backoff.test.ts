// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSUMER_BACKOFF,
  DEFAULT_JOB_BACKOFF,
  backoffCeilingMs,
  backoffDelayMs,
  type BackoffOptions,
} from './backoff.ts';

/**
 * Backoff is one of the few pure functions in this package and it is load-bearing
 * for every retry path, so it gets a property test rather than three examples.
 *
 * The properties are the promises the rest of the code makes to the operator: a
 * retry is never scheduled in the past, never scheduled past the cap, and never
 * produces a `NaN` that turns into an `Invalid Date` in `run_after` and takes a
 * job out of the queue forever.
 */
const optionsArb = fc.record({
  baseMs: fc.integer({ min: 0, max: 60_000 }),
  factor: fc.double({ min: 1, max: 5, noNaN: true }),
  maxMs: fc.integer({ min: 0, max: 6 * 60 * 60 * 1_000 }),
  jitter: fc.constantFrom<'full' | 'none'>('full', 'none'),
});

const attemptArb = fc.integer({ min: 1, max: 200 });

describe('backoffDelayMs', () => {
  it('always returns a finite, non-negative integer no greater than maxMs', () => {
    fc.assert(
      fc.property(
        attemptArb,
        optionsArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attempt, options, draw) => {
          const delay = backoffDelayMs(attempt, options, () => draw);
          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(0);
          expect(delay).toBeLessThanOrEqual(options.maxMs);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never exceeds its own ceiling for the attempt', () => {
    fc.assert(
      fc.property(
        attemptArb,
        optionsArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attempt, options, draw) => {
          expect(backoffDelayMs(attempt, options, () => draw)).toBeLessThanOrEqual(
            backoffCeilingMs(attempt, options),
          );
        },
      ),
      { numRuns: 500 },
    );
  });

  it('has a monotonically non-decreasing ceiling: later retries never come sooner', () => {
    fc.assert(
      fc.property(attemptArb, optionsArb, (attempt, options) => {
        expect(backoffCeilingMs(attempt + 1, options)).toBeGreaterThanOrEqual(
          backoffCeilingMs(attempt, options),
        );
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic with jitter off', () => {
    fc.assert(
      fc.property(attemptArb, optionsArb, (attempt, options) => {
        const fixed: BackoffOptions = { ...options, jitter: 'none' };
        expect(backoffDelayMs(attempt, fixed)).toBe(backoffDelayMs(attempt, fixed));
      }),
      { numRuns: 200 },
    );
  });

  it('survives a broken random source rather than producing NaN', () => {
    // A NaN here becomes `make_interval(secs => NaN)`, which takes the job out of
    // the queue permanently. Clamp instead.
    for (const draw of [Number.NaN, -1, 2, Infinity, -Infinity]) {
      const delay = backoffDelayMs(3, DEFAULT_JOB_BACKOFF, () => draw);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(DEFAULT_JOB_BACKOFF.maxMs);
    }
  });

  it('saturates at the cap rather than overflowing to Infinity', () => {
    // attempt 2000 with factor 2 overflows a double long before it reaches the
    // cap; the result must still be the cap, not Infinity and not NaN.
    expect(backoffCeilingMs(2_000, DEFAULT_JOB_BACKOFF)).toBe(DEFAULT_JOB_BACKOFF.maxMs);
  });

  it('spreads full jitter across the whole window rather than clustering', () => {
    // The point of full jitter is that N clients retrying together do not
    // reconverge. A draw of 0 and a draw of 1 must land far apart.
    const low = backoffDelayMs(6, DEFAULT_JOB_BACKOFF, () => 0);
    const high = backoffDelayMs(6, DEFAULT_JOB_BACKOFF, () => 1);
    expect(low).toBe(0);
    expect(high).toBe(backoffCeilingMs(6, DEFAULT_JOB_BACKOFF));
  });

  it('caps the consumer backoff far below the job backoff', () => {
    // A stuck consumer should be retried in minutes; a provider that is down
    // should be left alone for hours. Same function, deliberately different caps.
    expect(DEFAULT_CONSUMER_BACKOFF.maxMs).toBeLessThan(DEFAULT_JOB_BACKOFF.maxMs);
  });

  it('rejects an attempt number that is not a positive integer', () => {
    expect(() => backoffDelayMs(0, DEFAULT_JOB_BACKOFF)).toThrow();
    expect(() => backoffDelayMs(-1, DEFAULT_JOB_BACKOFF)).toThrow();
    expect(() => backoffDelayMs(1.5, DEFAULT_JOB_BACKOFF)).toThrow();
  });
});
