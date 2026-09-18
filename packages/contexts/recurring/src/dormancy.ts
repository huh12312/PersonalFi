// SPDX-License-Identifier: MIT
/**
 * The dormancy ladder (07 §2.8).
 *
 * ```
 * grace = max(5 days, 0.25 * cadence.period_days)
 *
 * now > next_due + uncertainty + grace   -> AT_RISK   (or MIGRATED, see below)
 * missed_periods >= 2                    -> LIKELY_CANCELED
 * missed_periods >= 3 or now > last+400d -> CANCELED   (archive, stop forecasting)
 * ```
 *
 * The ordering constraint is the important part and it is a *product* rule, not
 * a statistical one: **a `CARD_MIGRATION` candidate is checked before any rung
 * of this ladder is climbed.** A reissued card produces exactly the signal a
 * cancellation produces, and firing "we haven't seen Netflix since March" every
 * time a card is replaced is how a user learns to ignore the feature.
 *
 * Nothing here ever says "you cancelled X" — the status is `LIKELY_CANCELED`,
 * and 07 §2.8 is explicit that the copy built on it must be a question. Dormancy
 * is information: the annual renewal you forgot belongs in a sinking fund, and a
 * bill that silently failed on an expired card is about to become a late fee.
 *
 * `today` is passed in. There is no clock read in this file, or anywhere under
 * `src/` — `detectRecurring` takes a `Clock` and resolves the date once, in the
 * user's zone, through `todayIn`.
 */

import { DateOnly } from '@core/kernel';
import { slotOf, specOf } from './cadence.ts';
import type { Cadence, StreamStatus } from './types.ts';

export const GRACE_FLOOR_DAYS = 5;
export const GRACE_PERIOD_FRACTION = 0.25;
/** 07 §2.8: an annual stream silent for this long is gone, whatever the count. */
export const ANNUAL_ABANDON_DAYS = 400;

export function graceDays(cadence: Cadence): number {
  return Math.max(GRACE_FLOOR_DAYS, Math.round(GRACE_PERIOD_FRACTION * specOf(cadence).periodDays));
}

export interface DormancyInputs {
  readonly cadence: Cadence;
  readonly anchorDate: DateOnly;
  readonly dayOfMonthPair: readonly [number, number] | null;
  readonly lastSeen: DateOnly;
  readonly uncertaintyDays: number;
  readonly today: DateOnly;
  /** 07 §2.2: a cross-account continuation exists, so this is not a cancellation. */
  readonly migrationCandidate: boolean;
}

export interface DormancyOutcome {
  readonly status: StreamStatus;
  readonly missedPeriods: number;
}

/** Scheduled slots that came and went after `lastSeen`, allowing for grace. */
export function missedPeriodsSince(inputs: DormancyInputs): number {
  const spec = specOf(inputs.cadence);
  const slack = inputs.uncertaintyDays + graceDays(inputs.cadence);
  const deadline = DateOnly.addDays(inputs.today, -slack);
  let missed = 0;
  for (let index = 0; index < 4_000; index += 1) {
    const slot = slotOf(inputs.anchorDate, spec, index, inputs.dayOfMonthPair);
    if (DateOnly.isAfter(slot, deadline)) break;
    if (DateOnly.isAfter(slot, inputs.lastSeen)) missed += 1;
  }
  return missed;
}

export function assessDormancy(inputs: DormancyInputs): DormancyOutcome {
  const missedPeriods = missedPeriodsSince(inputs);
  const sinceLast = DateOnly.differenceInDays(inputs.lastSeen, inputs.today);

  if (missedPeriods === 0) return { status: 'ACTIVE', missedPeriods };
  // Checked before every rung below, never after.
  if (inputs.migrationCandidate) return { status: 'MIGRATED', missedPeriods };
  if (missedPeriods >= 3 || sinceLast > ANNUAL_ABANDON_DAYS) {
    return { status: 'CANCELED', missedPeriods };
  }
  if (missedPeriods >= 2) return { status: 'LIKELY_CANCELED', missedPeriods };
  return { status: 'AT_RISK', missedPeriods };
}
