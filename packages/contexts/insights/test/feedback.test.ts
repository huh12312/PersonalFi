// SPDX-License-Identifier: MIT
/**
 * The dismiss-reason feedback loop's pure half (WP 5.9): `decideFeedbackEffects`
 * over each of 07 §8.3's seven reasons, the `NOT_TRUE` quarantine threshold,
 * and `DONT_CARE`'s reversibility.
 *
 * Pure — no database — because `decideFeedbackEffects` takes exactly the
 * state `store.ts`'s `recordFeedback` already had to read (the previous
 * ladder row, the advisor's quarantine flag, the feedback counts so far) and
 * returns what to write. `store.ts`'s DB-level wiring (the actual
 * `advisors.enabled`/`enabled_source` write, the actual quarantine write) is
 * the same function called with real query results; nothing here contacts
 * Postgres, matching this file's place at `test/*.test.ts` (one level deep,
 * the `insights` vitest project).
 */
import { describe, expect, it } from 'vitest';
import {
  NOT_TRUE_MIN_FIRINGS,
  NOT_TRUE_RATE_THRESHOLD,
  decideFeedbackEffects,
  type FeedbackFirings,
  type ReasonEffectInput,
} from '../src/policy/feedback.ts';
import { afterDismissal, type SuppressionState } from '../src/policy/cooldown.ts';
import type { ReasonCode } from '../schema/index.ts';

const NOW = new Date('2026-09-30T12:00:00.000Z');
const NO_FIRINGS: FeedbackFirings = { priorDismissTotal: 0, priorNotTrue: 0 };

function input(overrides: Partial<ReasonEffectInput> = {}): ReasonEffectInput {
  return {
    action: 'dismiss',
    reasonCode: null,
    previousSuppression: null,
    now: NOW,
    snoozeUntil: null,
    advisorQuarantined: false,
    firings: NO_FIRINGS,
    ...overrides,
  };
}

describe('each of the seven reasons has exactly the effect 07 §8.3 assigns it', () => {
  it('NOT_TRUE counts toward the rate but does not change the ladder', () => {
    const plain = decideFeedbackEffects(input({ reasonCode: null }));
    const notTrue = decideFeedbackEffects(input({ reasonCode: 'NOT_TRUE' }));
    // The ladder advances exactly as an unreasoned dismissal would.
    expect(notTrue.suppression).toEqual(plain.suppression);
    // Below the five-firing floor, it does not quarantine on its own.
    expect(notTrue.quarantine).toBeNull();
  });

  it('ALREADY_KNOW skips straight to the 90-day rung', () => {
    const result = decideFeedbackEffects(input({ reasonCode: 'ALREADY_KNOW' }));
    const ninetyDays = new Date(NOW.getTime() + 90 * 24 * 60 * 60 * 1000);
    expect(result.suppression.suppressedUntil).toEqual(ninetyDays);
    expect(result.suppression.permanent).toBe(false);
    // A plain first dismissal would only have bought 30 days.
    const plain = decideFeedbackEffects(input({ reasonCode: null }));
    expect(plain.suppression.suppressedUntil).not.toEqual(ninetyDays);
  });

  it('NOT_ACTIONABLE feeds the ordinary dismiss penalty: the ladder as any dismissal would', () => {
    const result = decideFeedbackEffects(input({ reasonCode: 'NOT_ACTIONABLE' }));
    expect(result.suppression).toEqual(afterDismissal(null, NOW));
    expect(result.setEnabled).toBeNull();
    expect(result.quarantine).toBeNull();
  });

  it('DONT_CARE switches the rule off for this holder', () => {
    const result = decideFeedbackEffects(input({ reasonCode: 'DONT_CARE' }));
    expect(result.setEnabled).toEqual({ enabled: false, source: 'feedback' });
    // The ladder still advances — it is still a dismissal.
    expect(result.suppression.dismissCount).toBe(1);
  });

  it('WRONG_AMOUNT changes nothing this function writes — it is a read-side flag', () => {
    const plain = decideFeedbackEffects(input({ reasonCode: null }));
    const wrongAmount = decideFeedbackEffects(input({ reasonCode: 'WRONG_AMOUNT' }));
    expect(wrongAmount.suppression).toEqual(plain.suppression);
    expect(wrongAmount.setEnabled).toBeNull();
    expect(wrongAmount.quarantine).toBeNull();
  });

  it('INTENTIONAL suppresses the entity permanently on the first refusal, not the third', () => {
    const result = decideFeedbackEffects(input({ reasonCode: 'INTENTIONAL' }));
    expect(result.suppression.permanent).toBe(true);
    expect(result.suppression.suppressedUntil).toBeNull();
    // insight_dismissals_permanent_is_earned: dismiss_count >= 3 whenever
    // permanent is true, satisfied even though this was the first dismissal.
    expect(result.suppression.dismissCount).toBeGreaterThanOrEqual(3);
  });

  it('LATER is realised entirely by action = snooze; the reason code adds nothing further', () => {
    const until = new Date('2026-10-14T00:00:00.000Z');
    const plainSnooze = decideFeedbackEffects(
      input({ action: 'snooze', reasonCode: null, snoozeUntil: until }),
    );
    const later = decideFeedbackEffects(
      input({ action: 'snooze', reasonCode: 'LATER', snoozeUntil: until }),
    );
    expect(later.suppression).toEqual(plainSnooze.suppression);
    expect(later.suppression.suppressedUntil).toEqual(until);
  });
});

describe('a rule with a NOT_TRUE rate above 0.2 over five or more firings is quarantined with that reason', () => {
  it('quarantines the moment the fifth firing crosses the threshold', () => {
    // Four prior dismissals, one of them NOT_TRUE (0.25 already) — but only
    // four firings, below the floor, so no quarantine yet.
    const belowFloor = decideFeedbackEffects(
      input({
        reasonCode: 'NOT_TRUE',
        firings: { priorDismissTotal: 3, priorNotTrue: 0 },
      }),
    );
    expect(belowFloor.notTrueRateAfter).toBeCloseTo(1 / 4, 10);
    expect(belowFloor.quarantine).toBeNull();

    // The fifth firing, also NOT_TRUE: 2/5 = 0.4 > 0.2, five firings — trips.
    const atFloor = decideFeedbackEffects(
      input({
        reasonCode: 'NOT_TRUE',
        firings: { priorDismissTotal: 4, priorNotTrue: 1 },
      }),
    );
    expect(atFloor.notTrueRateAfter).toBeCloseTo(2 / 5, 10);
    expect(atFloor.quarantine).toEqual({ reason: 'not_true_rate' });
  });

  it('does not trip at exactly the threshold, and does not trip an already-quarantined advisor twice', () => {
    // Exactly 0.2 (1/5) does not exceed the threshold — "> 0.2", not "≥".
    const exactlyAtThreshold = decideFeedbackEffects(
      input({
        reasonCode: 'NOT_TRUE',
        firings: { priorDismissTotal: 4, priorNotTrue: 0 },
      }),
    );
    expect(exactlyAtThreshold.notTrueRateAfter).toBeCloseTo(NOT_TRUE_RATE_THRESHOLD, 10);
    expect(exactlyAtThreshold.quarantine).toBeNull();

    const alreadyQuarantined = decideFeedbackEffects(
      input({
        reasonCode: 'NOT_TRUE',
        advisorQuarantined: true,
        firings: { priorDismissTotal: 10, priorNotTrue: 5 },
      }),
    );
    expect(alreadyQuarantined.quarantine).toBeNull();
  });

  it('the two constants the check reads are exactly what the dispatch entry names', () => {
    expect(NOT_TRUE_RATE_THRESHOLD).toBe(0.2);
    expect(NOT_TRUE_MIN_FIRINGS).toBe(5);
  });
});

describe('DONT_CARE switches the rule off for this holder and a human can switch it back', () => {
  it('DONT_CARE writes enabled_source = feedback, never user', () => {
    const result = decideFeedbackEffects(input({ reasonCode: 'DONT_CARE' }));
    expect(result.setEnabled).toEqual({ enabled: false, source: 'feedback' });
  });

  it('a later feedback event with no DONT_CARE reason never re-touches enabled — a human’s reversal stands', () => {
    // After a human switched the rule back on (`setAdvisorEnabled(..., true,
    // 'user')` — store.ts, unconditional on the caller's own say-so, not
    // decided by this function at all), the next piece of feedback that is
    // not itself DONT_CARE must not silently flip it off again.
    const next = decideFeedbackEffects(input({ reasonCode: 'NOT_ACTIONABLE' }));
    expect(next.setEnabled).toBeNull();
  });
});

describe('a dismissal with no reason code is still a dismissal and advances the ladder', () => {
  it('reasonCode null behaves exactly like an ordinary dismissal', () => {
    const result = decideFeedbackEffects(input({ reasonCode: null }));
    expect(result.suppression).toEqual(afterDismissal(null, NOW));
    expect(result.suppression.dismissCount).toBe(1);
    expect(result.setEnabled).toBeNull();
    expect(result.quarantine).toBeNull();
  });

  it('a second unreasoned dismissal advances to the 90-day rung, same as before WP 5.9', () => {
    const first: SuppressionState = decideFeedbackEffects(input({ reasonCode: null })).suppression;
    const second = decideFeedbackEffects(
      input({ reasonCode: null, previousSuppression: first, now: new Date(NOW.getTime() + 1) }),
    );
    expect(second.suppression.dismissCount).toBe(2);
    expect(second.suppression.permanent).toBe(false);
  });

  it('every reason code is accounted for — the switch has no silent fallthrough', () => {
    const codes: readonly ReasonCode[] = [
      'NOT_TRUE',
      'ALREADY_KNOW',
      'NOT_ACTIONABLE',
      'DONT_CARE',
      'WRONG_AMOUNT',
      'INTENTIONAL',
      'LATER',
    ];
    for (const reasonCode of codes) {
      expect(() => decideFeedbackEffects(input({ reasonCode }))).not.toThrow();
    }
  });
});
