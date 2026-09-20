// SPDX-License-Identifier: MIT
import { DateOnly, Money } from '@core/kernel';
import type { Transaction } from '../../api/generated/types.gen.ts';

/**
 * Transfer-pair creation (wp1.6-ui.md §7's carried-over "transfer pairs"
 * deliverable; `POST /transfers/pair` has existed since Phase 1 with no UI
 * affordance to reach it). There is no candidate-suggestion route — 05 §5's
 * own wording for this feature is "pick the counterpart from same-amount-
 * opposite-sign candidates in a date window," which is exactly a client-side
 * filter over `GET /transactions`, not a new endpoint. This module is that
 * filter, kept pure and unit-tested apart from the dialog that calls it.
 */

const DEFAULT_WINDOW_DAYS = 5;

export interface TransferCandidateOptions {
  /** How many days on either side of the target's date still count. */
  windowDays?: number;
}

/**
 * Same absolute amount, opposite sign, a different account, within
 * `windowDays` of the target's date, and not already part of a pair — the
 * shape of two rows that are one movement of money between the user's own
 * accounts. Ordered by date proximity to the target (closest first), since
 * that is the likeliest real match.
 */
export function findTransferCandidates(
  target: Pick<Transaction, 'id' | 'accountId' | 'amount' | 'date' | 'isTransfer'>,
  pool: readonly Transaction[],
  options: TransferCandidateOptions = {},
): Transaction[] {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const targetAmount = Money.fromJSON(target.amount);
  const targetDate = DateOnly.parse(target.date);

  const candidates = pool.filter((candidate) => {
    if (candidate.id === target.id) return false;
    if (candidate.accountId === target.accountId) return false;
    if (candidate.isTransfer || candidate.transferLinkId !== null) return false;
    const candidateAmount = Money.fromJSON(candidate.amount);
    if (!Money.equals(candidateAmount, Money.negate(targetAmount))) return false;
    const candidateDate = DateOnly.parse(candidate.date);
    const dayGap = Math.abs(DateOnly.differenceInDays(candidateDate, targetDate));
    return dayGap <= windowDays;
  });

  return candidates
    .slice()
    .sort(
      (a, b) =>
        Math.abs(DateOnly.differenceInDays(DateOnly.parse(a.date), targetDate)) -
        Math.abs(DateOnly.differenceInDays(DateOnly.parse(b.date), targetDate)),
    );
}

/** The two ids `POST /transfers/pair` wants, oriented by sign — the negative (outflow) leg is always `outflowTransactionId`. */
export function orientPair(
  a: Pick<Transaction, 'id' | 'amount'>,
  b: Pick<Transaction, 'id' | 'amount'>,
): { outflowTransactionId: string; inflowTransactionId: string } {
  const aIsOutflow = Money.isNegative(Money.fromJSON(a.amount));
  return aIsOutflow
    ? { outflowTransactionId: a.id, inflowTransactionId: b.id }
    : { outflowTransactionId: b.id, inflowTransactionId: a.id };
}
