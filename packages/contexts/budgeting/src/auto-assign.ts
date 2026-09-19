// SPDX-License-Identifier: MIT
/**
 * Envelope-lite's auto-assign — 07 §1.9.
 *
 * > Concretely, on period roll:
 * >
 * > ```
 * > 1. carryover all categories per policy
 * > 2. auto_assign: iterate categories by user-set priority, assign needed_this_period(c,p) from RTA
 * >    until RTA == 0 or all funded
 * > 3. if RTA > 0: leave it positive and show "you have $X unassigned" as an *opportunity*, not an error
 * > 4. if RTA < 0: this is the one hard alert — "you've assigned $X more than you have"
 * > 5. never block the user; never require reaching zero
 * > ```
 * > — 07 §1.9, lines 242–251
 *
 * Steps 3, 4 and 5 are the reason this function returns a plan and never throws.
 * There is no input — not a negative RTA, not a goal larger than the whole
 * budget, not a grid with no lines at all — that makes auto-assign an error. The
 * worst case is that it assigns nothing, which is step 3 with `$X` equal to
 * everything.
 *
 * ## Why it is a plan rather than a write
 *
 * The caller applies it inside the same transaction as the roll, appends
 * `budgeting.BudgetLineAssigned` for each entry, and recomputes. Separating them
 * means the whole of step 2 is testable without a database and, more usefully,
 * that "what would auto-assign do?" is answerable for a preview UI without
 * doing it — which 07 §1.9's "non-nagging" framing needs, because an
 * auto-assignment the user cannot see before it happens is one they will turn
 * off.
 *
 * ## Determinism
 *
 * Ordering is `(priority, id)`. Priority alone is not a total order — two
 * envelopes at the default 100 are common — and an unstable order means two
 * recomputes of the same period fund different envelopes when RTA runs out
 * partway down the list. That is the shape of bug that looks like the app
 * "changing its mind".
 */
import { Money, type Money as MoneyType } from '@core/kernel';

export interface AutoAssignCandidate {
  readonly lineId: string;
  readonly priority: number;
  /** `underfunded(c, p)` — 07 §1.8 line 224. Non-negative. */
  readonly underfunded: MoneyType;
  readonly assigned: MoneyType;
}

export interface AutoAssignEntry {
  readonly lineId: string;
  /** What to add. Always positive — auto-assign never takes money back. */
  readonly amount: MoneyType;
  /** `assigned` after applying `amount`. */
  readonly assignedAfter: MoneyType;
}

export interface AutoAssignPlan {
  readonly entries: readonly AutoAssignEntry[];
  readonly assignedTotal: MoneyType;
  readonly readyToAssignAfter: MoneyType;
  /** Step 3's "you have $X unassigned", or zero when RTA ran out. */
  readonly leftOver: MoneyType;
  /** Σ of what the goals wanted and RTA could not cover. Drives the pace copy. */
  readonly stillUnderfunded: MoneyType;
}

export function planAutoAssign(
  readyToAssign: MoneyType,
  candidates: readonly AutoAssignCandidate[],
): AutoAssignPlan {
  const code = readyToAssign.currency;
  const zero = Money.zero(code);

  const ordered = [...candidates].sort((a, b) =>
    a.priority !== b.priority
      ? a.priority - b.priority
      : a.lineId < b.lineId
        ? -1
        : a.lineId > b.lineId
          ? 1
          : 0,
  );

  // Step 4: a negative RTA means the user has already assigned more than they
  // have. Auto-assign must not make that worse, so it does nothing and the
  // caller raises the one hard alert.
  let remaining = Money.max(readyToAssign, zero);
  const entries: AutoAssignEntry[] = [];
  let assignedTotal = zero;
  let stillUnderfunded = zero;

  for (const candidate of ordered) {
    const want = Money.max(candidate.underfunded, zero);
    if (Money.isZero(want)) continue;
    // Partial funding on purpose. Skipping an envelope RTA cannot fully cover in
    // order to fully fund a later one would be a different, and worse, policy:
    // the user set the priority order, and "rent got $0 so that streaming got
    // $12" is not a defensible reading of it.
    const give = Money.min(want, remaining);
    stillUnderfunded = Money.add(stillUnderfunded, Money.subtract(want, give));
    if (Money.isZero(give)) continue;
    remaining = Money.subtract(remaining, give);
    assignedTotal = Money.add(assignedTotal, give);
    entries.push({
      lineId: candidate.lineId,
      amount: give,
      assignedAfter: Money.add(candidate.assigned, give),
    });
  }

  return {
    entries,
    assignedTotal,
    readyToAssignAfter: Money.subtract(readyToAssign, assignedTotal),
    leftOver: remaining,
    stillUnderfunded,
  };
}

/**
 * 07 §1.8 line 227: "to stay on track this month, assign $X more".
 *
 * > Surface `Σ_c underfunded` as "to stay on track this month, assign $X more".
 * > That single number is the whole value proposition of envelope budgeting.
 */
export function toStayOnTrack(
  candidates: readonly AutoAssignCandidate[],
  currency: string,
): MoneyType {
  return Money.sum(
    candidates.map((candidate) => Money.max(candidate.underfunded, Money.zero(currency))),
    currency,
  );
}
