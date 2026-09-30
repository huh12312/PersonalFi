// SPDX-License-Identifier: MIT
/**
 * The dismiss-reason feedback loop (07 §8.3; 05-phase-5-dispatch.md §3 WP 5.9)
 * — what each of the seven reason codes *does*, as a pure function of the
 * state before it.
 *
 * ## Why this is pure, and `store.ts`'s `recordFeedback` is not
 *
 * The same split `policy/kill-switches.ts`'s `decideRun` draws: a decision
 * with no database handle is a decision `test/feedback.test.ts` can check
 * with plain objects, at the speed of the `insights` vitest project (one
 * level deep, no Postgres — `vitest.config.ts`). `decideFeedbackEffects`
 * takes the state `recordFeedback` already had to read for other reasons
 * (the previous suppression row, the advisor's own quarantine and enabled
 * state, the feedback counts so far) and returns what to write; `store.ts`
 * is the only place that touches a table.
 *
 * ## Each reason's effect, verbatim from 07 §8.3 and the dispatch entry
 *
 * | Code | Effect |
 * | --- | --- |
 * | `NOT_TRUE` | Counts toward the rule's rate; over 0.2 across ≥5 firings, quarantines the advisor with reason `not_true_rate`. |
 * | `ALREADY_KNOW` | Skips to the 90-day rung (`cooldown.ts`'s `afterAlreadyKnow`). |
 * | `NOT_ACTIONABLE` | The ordinary dismiss penalty — the ladder advances exactly as an unreasoned dismissal would. |
 * | `DONT_CARE` | Switches the rule off for this holder, `enabled_source = 'feedback'`, undoable by a human. |
 * | `WRONG_AMOUNT` | Flags the insight's derivations and digest for review on rule health (a read, `rule-health.ts` — no write here). |
 * | `INTENTIONAL` | That entity suppressed permanently, immediately (`cooldown.ts`'s `afterIntentional`). |
 * | `LATER` | A snooze — realised entirely by `action = 'snooze'`; no ladder override. |
 *
 * `NOT_ACTIONABLE` and `WRONG_AMOUNT` do not change what this module
 * computes for the ladder or the advisor row; their effect is either already
 * the default (the plain dismiss penalty) or lives on the read side
 * (`rule-health.ts` joins `insight_feedback` back to `insights` for
 * `WRONG_AMOUNT`, rather than this module writing a second copy of the
 * insight's own derivations).
 */
import { afterAlreadyKnow, afterDismissal, afterIntentional, afterSnooze } from './cooldown.ts';
import type { SuppressionState } from './cooldown.ts';
import type { FeedbackAction, ReasonCode } from '../../schema/index.ts';

export { REASON_CODES, type ReasonCode } from '../../schema/index.ts';

/**
 * The three preset strings `DismissReasonDialog.tsx` has been storing,
 * mapped to codes by exact match — the same mapping migration
 * `0030_insight_feedback_reasons.sql` applies once, at deploy time, to every
 * row already in the table. Kept here too so a live write from the current
 * UI (which still sends only free text — WP 5.11 is what teaches it to send
 * `reasonCode`) is classified the same way immediately, rather than waiting
 * for the next migration to catch up with it.
 */
export const PRESET_REASON_CODES: Readonly<Record<string, ReasonCode>> = Object.freeze({
  "That's wrong": 'NOT_TRUE',
  'Already handled': 'ALREADY_KNOW',
  'Not useful': 'NOT_ACTIONABLE',
});

/** `null` for free text that matches no preset — kept as a note, no code. */
export function reasonCodeForPreset(reason: string | null | undefined): ReasonCode | null {
  if (reason === null || reason === undefined) return null;
  return PRESET_REASON_CODES[reason] ?? null;
}

/** 07 §8.3: "if NOT_TRUE rate > 0.2: disable the rule; it's broken, not noisy." */
export const NOT_TRUE_RATE_THRESHOLD = 0.2;
/** "…over at least five firings" — the dispatch entry's own number. */
export const NOT_TRUE_MIN_FIRINGS = 5;

/**
 * "Firings", operationalised: the `dismiss` responses this advisor has
 * received from this holder. `07`'s pseudocode never fixes a denominator for
 * either its `dismiss_rate` or its `NOT_TRUE rate` check, and this repo has
 * no per-run log of every proposal a rule ever made to draw one from (that
 * *is* the bitemporal store §1 cut line 2 declines to build). Feedback
 * events are the one countable, bounded signal this phase has, so both rates
 * are read from them — recorded here once so `feedback.ts` and
 * `rule-health.ts` cannot compute it two different ways.
 */
export function notTrueRate(notTrueCount: number, totalDismissFirings: number): number {
  if (totalDismissFirings <= 0) return 0;
  return notTrueCount / totalDismissFirings;
}

export function shouldQuarantineForNotTrue(
  notTrueCount: number,
  totalDismissFirings: number,
): boolean {
  if (totalDismissFirings < NOT_TRUE_MIN_FIRINGS) return false;
  return notTrueRate(notTrueCount, totalDismissFirings) > NOT_TRUE_RATE_THRESHOLD;
}

export interface FeedbackFirings {
  /** Dismiss responses recorded for this advisor before this one. */
  readonly priorDismissTotal: number;
  /** Of those, how many carried `NOT_TRUE`. */
  readonly priorNotTrue: number;
}

export interface ReasonEffectInput {
  readonly action: FeedbackAction;
  readonly reasonCode: ReasonCode | null;
  readonly previousSuppression: SuppressionState | null;
  readonly now: Date;
  /** Required for `snooze`; the caller's default (`now`, or `LATER`'s own). */
  readonly snoozeUntil: Date | null;
  readonly advisorQuarantined: boolean;
  readonly firings: FeedbackFirings;
}

export interface ReasonEffectResult {
  /** The ladder row to write — always present, even when nothing changed. */
  readonly suppression: SuppressionState;
  /** Set when `DONT_CARE` fired. `null` otherwise: nothing to write. */
  readonly setEnabled: { readonly enabled: false; readonly source: 'feedback' } | null;
  /** Set when this feedback event crosses the `NOT_TRUE` threshold. */
  readonly quarantine: { readonly reason: 'not_true_rate' } | null;
  /** The rate as it stands *after* this event — for evidence and callers. */
  readonly notTrueRateAfter: number;
}

/**
 * The whole feedback loop, decided in one place from state the caller already
 * had to read.
 *
 * `WRONG_AMOUNT` is deliberately absent from the switch below: its effect is
 * a read-side join (`rule-health.ts`), not a write this function could name.
 */
export function decideFeedbackEffects(input: ReasonEffectInput): ReasonEffectResult {
  const { action, reasonCode, previousSuppression, now } = input;

  const suppression: SuppressionState =
    action === 'dismiss' && reasonCode === 'ALREADY_KNOW'
      ? afterAlreadyKnow(previousSuppression, now)
      : action === 'dismiss' && reasonCode === 'INTENTIONAL'
        ? afterIntentional(previousSuppression, now)
        : action === 'dismiss'
          ? afterDismissal(previousSuppression, now)
          : action === 'snooze'
            ? afterSnooze(previousSuppression, input.snoozeUntil ?? now)
            : {
                // `reopen`: the count stands, nothing is silenced right now.
                dismissCount: previousSuppression?.dismissCount ?? 0,
                suppressedUntil: null,
                permanent: false,
              };

  const dismissTotal = input.firings.priorDismissTotal + (action === 'dismiss' ? 1 : 0);
  const notTrueCount =
    input.firings.priorNotTrue + (action === 'dismiss' && reasonCode === 'NOT_TRUE' ? 1 : 0);
  const rateAfter = notTrueRate(notTrueCount, dismissTotal);

  const quarantine: ReasonEffectResult['quarantine'] =
    reasonCode === 'NOT_TRUE' &&
    !input.advisorQuarantined &&
    shouldQuarantineForNotTrue(notTrueCount, dismissTotal)
      ? { reason: 'not_true_rate' }
      : null;

  const setEnabled: ReasonEffectResult['setEnabled'] =
    reasonCode === 'DONT_CARE' ? { enabled: false, source: 'feedback' } : null;

  return { suppression, setEnabled, quarantine, notTrueRateAfter: rateAfter };
}
