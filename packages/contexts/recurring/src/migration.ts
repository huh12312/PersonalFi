// SPDX-License-Identifier: MIT
/**
 * Cross-account stream continuity — the reissued card (07 §2.2).
 *
 * > if stream A on account X goes dormant and stream B on account Y starts
 * > within 2 periods, same merchant, amount within 5% → propose merge with
 * > `link_reason=CARD_MIGRATION`, `confidence *= 0.9`. **Do this before
 * > declaring a cancellation**, or you'll fire a false "you cancelled Netflix"
 * > every time a card is replaced.
 *
 * Two shapes, because a reissue produces two different artefacts depending on
 * whether the price moved at the same time:
 *
 *  1. **Within one stream.** Stage 1 groups on `(merchantId, sign)` and
 *     deliberately *not* on the account, so the usual reissue — same price, new
 *     card, maybe one missed period — never splits at all. What is left to do is
 *     notice it and say so: the accounts partition cleanly in time, so the
 *     stream carries a proposal naming the old and new account.
 *  2. **Across two streams.** If the price changed at the same time and the gap
 *     broke the schedule, Stage 2 leaves two segments. This module pairs them so
 *     one series survives instead of one cancellation and one new subscription.
 *
 * The proposal is a *proposal*. WP 2.3 persists it for a human; nothing here
 * merges two accounts' history on its own authority beyond forming the stream.
 */

import { DateOnly } from '@core/kernel';
import { withinPercent } from './amount.ts';
import { periodDaysOf } from './cadence.ts';
import type { StreamSegment } from './grouping.ts';
import type { MergeProposal, Occurrence } from './types.ts';

/** 07 §2.2: "starts within 2 periods". */
export const MIGRATION_MAX_PERIODS = 2;
/** 07 §2.2: "amount within 5%". */
export const MIGRATION_AMOUNT_PERCENT = 5n;
/** 07 §2.2: a proposed, unconfirmed merge is worth a little less. */
export const MIGRATION_CONFIDENCE_FACTOR = 0.9;

/**
 * Do the accounts on this stream partition cleanly in time — everything on one
 * account, then everything on another? That is a reissue. Interleaved accounts
 * are a household paying one bill from two cards, which is not.
 */
export function migrationWithin(
  occurrences: readonly Occurrence[],
  periodDays: number,
  streamKey: string,
): MergeProposal | null {
  const series = [...occurrences].sort((a, b) => DateOnly.compare(a.date, b.date));
  if (series.length < 2) return null;

  let switchIndex = -1;
  for (let index = 1; index < series.length; index += 1) {
    if ((series[index] as Occurrence).accountId !== (series[index - 1] as Occurrence).accountId) {
      if (switchIndex >= 0) return null; // more than one switch: not a reissue
      switchIndex = index;
    }
  }
  if (switchIndex < 0) return null;

  const before = new Set(series.slice(0, switchIndex).map((occurrence) => occurrence.accountId));
  const after = new Set(series.slice(switchIndex).map((occurrence) => occurrence.accountId));
  if (before.size !== 1 || after.size !== 1) return null;

  const gapDays = DateOnly.differenceInDays(
    (series[switchIndex - 1] as Occurrence).date,
    (series[switchIndex] as Occurrence).date,
  );
  if (gapDays > periodDays * (MIGRATION_MAX_PERIODS + 1)) return null;

  return {
    reason: 'CARD_MIGRATION',
    fromAccountId: [...before][0] as string,
    toAccountId: [...after][0] as string,
    gapDays,
    confidenceFactor: MIGRATION_CONFIDENCE_FACTOR,
    segmentKeys: [streamKey],
  };
}

/** Should these two segments be one series that changed cards? */
export function isCrossSegmentMigration(earlier: StreamSegment, later: StreamSegment): boolean {
  if (earlier.merchantId !== later.merchantId || earlier.sign !== later.sign) return false;
  if (earlier.inference.cadence === 'UNKNOWN') return false;

  const earlierAccounts = new Set(earlier.inputs.map((input) => input.accountId));
  const laterAccounts = new Set(later.inputs.map((input) => input.accountId));
  const shared = [...laterAccounts].some((account) => earlierAccounts.has(account));
  if (shared) return false;

  const earlierLast = earlier.inputs[earlier.inputs.length - 1]?.date;
  const laterFirst = later.inputs[0]?.date;
  if (earlierLast === undefined || laterFirst === undefined) return false;
  if (!DateOnly.isBefore(earlierLast, laterFirst)) return false;

  const gap = DateOnly.differenceInDays(earlierLast, laterFirst);
  const window = periodDaysOf(earlier.inference.cadence) * MIGRATION_MAX_PERIODS;
  if (gap > window) return false;

  return withinPercent(earlier.amount.typical, later.amount.typical, MIGRATION_AMOUNT_PERCENT);
}
