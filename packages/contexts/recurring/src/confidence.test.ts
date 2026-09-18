// SPDX-License-Identifier: MIT
/**
 * The early-detection cap, and the property that says how it must be written.
 *
 * The cap is one line — `Math.min(raw, 0.7)` — and the obvious wrong way to
 * write it is an assignment (`confidence = 0.7`). Both pass a test that only
 * checks `n = 2 ⇒ 0.70`. Only the monotonicity property tells them apart, and
 * an assignment is a real bug: a two-charge stream would outrank a five-charge
 * stream whose merchant is unknown, and the candidate queue would be sorted
 * with the least evidence on top.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AUTO_CONFIRM_CONFIDENCE,
  CANDIDATE_CONFIDENCE,
  EARLY_DETECTION_CAP,
  featuresOf,
  merchantPrior,
  scoreConfidence,
  type ConfidenceInputs,
} from './confidence.ts';
import { detectRecurring } from './detect.ts';
import type { MerchantFacts, RecurringInput } from './types.ts';
import { DateOnly, Money, fixedClock } from '@core/kernel';

function inputs(overrides: Partial<ConfidenceInputs> = {}): ConfidenceInputs {
  return {
    cadenceScore: 0.78,
    amountCv: 0,
    occurrences: 6,
    merchantClass: 'SUBSCRIPTION',
    daysSinceLast: 5,
    periodDays: 30,
    coverage: 1,
    ...overrides,
  };
}

function charge(date: string, index: number): RecurringInput {
  return {
    transactionId: `t-${index}`,
    merchantId: 'mer-1',
    accountId: 'acc-1',
    amount: Money.of(-1799n, 'USD'),
    date: DateOnly.parse(date),
    pending: false,
    isTransfer: false,
  };
}

describe('confidence', () => {
  it('n=2 is capped at 0.70 and typed EARLY_DETECTION', () => {
    // The raw score for two clean monthly charges from a known subscription
    // merchant is well above the cap — this is not a case where the cap is
    // inert and the test would pass either way.
    const raw = scoreConfidence(inputs({ occurrences: 2 }));
    expect(raw.earlyDetection).toBe(true);
    expect(raw.confidence).toBe(EARLY_DETECTION_CAP);
    expect(raw.eligibleForImpact).toBe(false);

    const uncapped = scoreConfidence(inputs({ occurrences: 3 }));
    expect(uncapped.confidence).toBeGreaterThan(EARLY_DETECTION_CAP);

    // And end to end: two charges, a whole detection pass, one stream.
    const facts = new Map<string, MerchantFacts>([['mer-1', { class: 'SUBSCRIPTION' }]]);
    const result = detectRecurring([charge('2026-07-15', 1), charge('2026-08-15', 2)], {
      clock: fixedClock('2026-08-20T12:00:00Z'),
      timeZone: 'UTC',
      merchantFacts: facts,
    });
    expect(result.streams).toHaveLength(1);
    const stream = result.streams[0];
    expect(stream?.status).toBe('EARLY_DETECTION');
    expect(stream?.confidence).toBeLessThanOrEqual(EARLY_DETECTION_CAP);
    expect(stream?.eligibleForImpact).toBe(false);

    // A third charge matures it, and the cap lifts.
    const matured = detectRecurring(
      [charge('2026-07-15', 1), charge('2026-08-15', 2), charge('2026-09-15', 3)],
      {
        clock: fixedClock('2026-09-20T12:00:00Z'),
        timeZone: 'UTC',
        merchantFacts: facts,
      },
    );
    expect(matured.streams[0]?.status).toBe('ACTIVE');
    expect(matured.streams[0]?.confidence).toBeGreaterThan(EARLY_DETECTION_CAP);
    expect(matured.streams[0]?.eligibleForImpact).toBe(true);
  });

  it('the 07 §2.4 features are the ones the memo names', () => {
    const features = featuresOf(inputs({ amountCv: 0.175, occurrences: 3, daysSinceLast: 15 }));
    expect(features.amountStability).toBeCloseTo(0.5, 10);
    expect(features.maturity).toBeCloseTo(0.5, 10);
    expect(features.recency).toBeCloseTo(0.75, 10);
    expect(features.merchantPrior).toBe(1);
    expect(merchantPrior('RETAIL')).toBe(0.1);
    expect(merchantPrior('UNKNOWN')).toBe(0.5);
    expect(CANDIDATE_CONFIDENCE).toBeLessThan(AUTO_CONFIRM_CONFIDENCE);
  });

  it('the merchant prior decides a marginal stream and not a clean one', () => {
    // On a clean shape the sigmoid has saturated and the prior barely moves the
    // number — which is correct: a perfectly regular fixed charge is a
    // subscription whoever bills it. The prior earns its weight on the
    // marginal cases, where it is the difference between asking the user and
    // keeping quiet.
    const marginal = {
      cadenceScore: 0.35,
      occurrences: 2,
      coverage: 0.5,
      amountCv: 0.3,
      daysSinceLast: 40,
    } as const;
    const subscription = scoreConfidence(inputs({ ...marginal, merchantClass: 'SUBSCRIPTION' }));
    const retail = scoreConfidence(inputs({ ...marginal, merchantClass: 'RETAIL' }));
    expect(subscription.confidence - retail.confidence).toBeGreaterThan(0.15);
    expect(subscription.confidence).toBeGreaterThan(CANDIDATE_CONFIDENCE);
    expect(retail.confidence).toBeLessThan(CANDIDATE_CONFIDENCE);

    const clean = scoreConfidence(inputs({ merchantClass: 'SUBSCRIPTION' }));
    const cleanRetail = scoreConfidence(inputs({ merchantClass: 'RETAIL' }));
    expect(clean.confidence - cleanRetail.confidence).toBeLessThan(0.05);
  });
});

describe('confidence properties', () => {
  it('confidence is monotone in n', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2, max: 40 }),
        fc.integer({ min: 1, max: 20 }),
        fc.double({ min: 0, max: 0.8, noNaN: true }),
        fc.double({ min: 0, max: 0.6, noNaN: true }),
        (low, delta, cadenceScore, amountCv) => {
          const shared = { cadenceScore, amountCv } as const;
          const smaller = scoreConfidence(inputs({ ...shared, occurrences: low }));
          const larger = scoreConfidence(inputs({ ...shared, occurrences: low + delta }));
          // The cap only ever lowers a score, so adding occurrences can never
          // make the engine less sure. An assignment-style cap breaks this.
          expect(larger.confidence).toBeGreaterThanOrEqual(smaller.confidence);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('confidence is monotone in the cadence score and in coverage', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 0.7, noNaN: true }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        (score, bump) => {
          const lower = scoreConfidence(inputs({ cadenceScore: score }));
          const higher = scoreConfidence(inputs({ cadenceScore: score + bump }));
          expect(higher.confidence).toBeGreaterThanOrEqual(lower.confidence);

          const sparse = scoreConfidence(inputs({ coverage: score }));
          const complete = scoreConfidence(inputs({ coverage: score + bump }));
          expect(complete.confidence).toBeGreaterThanOrEqual(sparse.confidence);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('confidence never leaves [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.double({ min: -5, max: 5, noNaN: true }),
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 0, max: 5_000 }),
        (cadenceScore, amountCv, occurrences, daysSinceLast) => {
          const outcome = scoreConfidence(
            inputs({ cadenceScore, amountCv, occurrences, daysSinceLast }),
          );
          expect(outcome.confidence).toBeGreaterThanOrEqual(0);
          expect(outcome.confidence).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
