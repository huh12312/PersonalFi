// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';

import type { BudgetLine, BudgetPeriod } from '../../api/generated/types.gen.ts';
import { parseWireMoney } from '../../lib/money.ts';

/**
 * Pure display math over `BudgetLine`/`BudgetPeriod` — everything the budget
 * screen needs to decide *how* to render a number it already received from
 * the server. No money arithmetic here ever produces a number the server
 * hasn't already computed (wp2.9's evidence promise: "every number on screen
 * traced to the API field it came from, no client-side money math beyond
 * formatting") — these functions only fold/compare/branch on the `bigint`
 * fields the wire already carries.
 */

/** Which of the two colourblind-safe overspend tones (07 §1.3, 05 §2.2) a line is in, or none. */
export type OverspendTone = 'cash' | 'credit' | 'none';

/**
 * `cashOverspend`/`creditOverspend` are separate `Money` fields on every
 * `BudgetLine` (WP 2.1's own identity II) — never derived from `available`'s
 * sign, because a card's overspend can be entirely absorbed by `CCP[card]`
 * while `available` on the *category* line still reads negative for a
 * different reason (a cash overspend on the same category, 07 §1.3).
 */
export function overspendToneOf(line: BudgetLine): OverspendTone {
  if (!MoneyKernel.isZero(parseWireMoney(line.cashOverspend))) return 'cash';
  if (!MoneyKernel.isZero(parseWireMoney(line.creditOverspend))) return 'credit';
  return 'none';
}

/** Colour-by-sign tone for the `available` figure itself (never used to decide overspend — see above). */
export type AvailableTone = 'positive' | 'negative' | 'zero';

export function availableToneOf(line: BudgetLine): AvailableTone {
  const available = parseWireMoney(line.available);
  if (MoneyKernel.isZero(available)) return 'zero';
  return MoneyKernel.isNegative(available) ? 'negative' : 'positive';
}

/**
 * Ready-to-Assign is an *opportunity* when positive (there is money to give a
 * job) and the one *hard alert* when negative (07 §1.2's identity going
 * negative means a category or `CCP` is now funded by money that isn't
 * there yet). Exactly one of the two is ever true; zero is neither.
 */
export type ReadyToAssignTone = 'opportunity' | 'alert' | 'settled';

export function readyToAssignToneOf(
  period: Pick<BudgetPeriod, 'readyToAssign'>,
): ReadyToAssignTone {
  const rta = parseWireMoney(period.readyToAssign);
  if (MoneyKernel.isZero(rta)) return 'settled';
  return MoneyKernel.isNegative(rta) ? 'alert' : 'opportunity';
}

/**
 * "Assign $X more to stay on track" — `underfunded` is already `max(0,
 * neededThisPeriod - assigned)` per WP 2.1 §1.4, so this is a presence check
 * plus formatting decision, not a computation: the hint shows exactly when
 * the server says this line is short of its own goal, for exactly the amount
 * the server named.
 */
export function neededHintOf(line: BudgetLine): { readonly amount: MoneyKernel } | null {
  if (line.goalType === 'NONE') return null;
  const underfunded = parseWireMoney(line.underfunded);
  if (MoneyKernel.isZero(underfunded) || MoneyKernel.isNegative(underfunded)) return null;
  return { amount: underfunded };
}

/**
 * Sinking-fund / goal progress as a 0..1 ratio for a progress bar —
 * `assigned / neededThisPeriod`, clamped. `neededThisPeriod` (not a raw
 * `goalAmount`) is the right denominator for *every* goal type because the
 * server already folded each goal's own formula into it (WP 2.1 §1.4's six
 * `needed_this_period` definitions) — `GET /budgets/current` does not echo
 * back the stored `goalAmount`/`goalTargetDate`/`goalPercent` at all (an API
 * gap: a goal editor can *write* those fields but a read can't yet redisplay
 * what was last set, see `wp2.9-budget-ui.md`), so `neededThisPeriod` is the
 * only goal-shaped number this screen has to bar-fill against.
 *
 * `NONE` has no goal to show progress toward. A `neededThisPeriod` of zero or
 * negative means the goal has nothing left to fund this period (already met,
 * or a `PCT_OF_INCOME` goal against zero income) — also not a bar.
 *
 * The division itself is a `Number` ratio for a `<progress>` fill, never a
 * stored or compared monetary value — `docs/CONVENTIONS.md`'s bigint rule is
 * about money arithmetic, not about a UI-only percentage decoration (the same
 * exception `lib/money.ts#formatPercent` already relies on).
 */
export function goalProgressOf(line: BudgetLine): number | null {
  if (line.goalType === 'NONE') return null;
  const needed = parseWireMoney(line.neededThisPeriod);
  if (MoneyKernel.isZero(needed) || MoneyKernel.isNegative(needed)) return null;
  const assigned = parseWireMoney(line.assigned);
  const ratio = Number(assigned.minor) / Number(needed.minor);
  if (!Number.isFinite(ratio)) return null;
  return Math.min(1, Math.max(0, ratio));
}

export interface PeriodTotals {
  readonly assigned: MoneyKernel;
  readonly activity: MoneyKernel;
  readonly available: MoneyKernel;
}

/**
 * Header-row totals, folded with `Money.add` (bigint) across every
 * `kind: 'category'` line — `credit_card_payment` lines are excluded because
 * `07 §1.2`'s RTA identity itself excludes them (`wp2.1-budgeting.md` §1.5),
 * and a header total that silently included them would double-count the
 * money a card payment envelope is only *holding* on behalf of a category
 * line that already counted it.
 */
export function periodCategoryTotals(period: Pick<BudgetPeriod, 'lines'>): PeriodTotals {
  const categoryLines = period.lines.filter((line) => line.kind === 'category');
  const currency =
    categoryLines[0]?.assigned.currency ?? period.lines[0]?.assigned.currency ?? 'USD';
  return {
    assigned: MoneyKernel.sum(
      categoryLines.map((l) => parseWireMoney(l.assigned)),
      currency,
    ),
    activity: MoneyKernel.sum(
      categoryLines.map((l) => parseWireMoney(l.activity)),
      currency,
    ),
    available: MoneyKernel.sum(
      categoryLines.map((l) => parseWireMoney(l.available)),
      currency,
    ),
  };
}

/** Grouping key for the envelope list — one group per category kind, plus a synthetic group for CCP lines. */
export type EnvelopeGroupKey =
  'income' | 'expense' | 'transfer' | 'investment' | 'other' | 'credit_card_payment';

export function groupKeyOf(line: BudgetLine, categoryKind: string | undefined): EnvelopeGroupKey {
  if (line.kind === 'credit_card_payment') return 'credit_card_payment';
  switch (categoryKind) {
    case 'income':
    case 'expense':
    case 'transfer':
    case 'investment':
    case 'other':
      return categoryKind;
    default:
      return 'other';
  }
}

export const GROUP_LABELS: Record<EnvelopeGroupKey, string> = {
  expense: 'Spending',
  income: 'Income',
  transfer: 'Transfers',
  investment: 'Investments',
  other: 'Other',
  credit_card_payment: 'Credit card payments',
};

/** Stable display order — spending first (it's most of the budget), payments last. */
export const GROUP_ORDER: readonly EnvelopeGroupKey[] = [
  'expense',
  'income',
  'investment',
  'other',
  'transfer',
  'credit_card_payment',
];
