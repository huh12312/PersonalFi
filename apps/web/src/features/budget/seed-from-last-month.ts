// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';

import type { ReportCategoryMonthCell } from '../../api/generated/types.gen.ts';
import { parseWireMoney } from '../../lib/money.ts';

/**
 * The empty-state "start from last month's spending" action
 * (02-phase-2-dispatch.md §3 WP 2.9's DELIVER item) has no dedicated
 * bulk-seed API route — `wp2.r-routes.md`'s route table is `POST
 * /budgets/lines` (one category at a time) and `PATCH /budgets/lines/{id}`
 * (assign), nothing that takes a whole month. So the seed is a client-side
 * plan built from `GET /reports/spending` for last month, executed as one
 * `POST` + one `PATCH` per category through the existing routes — "via the
 * API's create path", per the dispatch text, not a new server capability.
 *
 * This module is the pure "plan" half: turn a month of spending cells into
 * the ordered list of `(categoryId, assignMinor)` pairs to create, so the
 * decision of *which* categories qualify and *how much* to assign is
 * unit-testable without a network call.
 */
export interface SeedLine {
  readonly categoryId: string;
  readonly assign: Money;
}

/**
 * One line per distinct category with net spending (a negative total —
 * house sign convention, `docs/CONVENTIONS.md`) in the window, assigned the
 * exact amount spent. `categoryId: null` (the uncategorised bucket) is
 * skipped — an envelope needs a real category to attach to (`POST
 * /budgets/lines`'s `categoryId` is required). A category that nets
 * *positive* (a refund-heavy month, or an income category miscategorised
 * into the window) is skipped too: seeding a budget line with a negative
 * "amount to assign" would silently create a line the user never asked for.
 * A currency other than the budget's own is dropped with nothing pretended.
 */
export function planSeedLines(
  cells: readonly ReportCategoryMonthCell[],
  budgetCurrency: string,
): readonly SeedLine[] {
  const totals = new Map<string, Money>();
  for (const cell of cells) {
    if (cell.categoryId === null) continue;
    if (cell.amount.currency !== budgetCurrency) continue;
    const amount = parseWireMoney(cell.amount);
    const running = totals.get(cell.categoryId) ?? Money.zero(budgetCurrency);
    totals.set(cell.categoryId, Money.add(running, amount));
  }

  const lines: SeedLine[] = [];
  for (const [categoryId, total] of totals) {
    if (!Money.isNegative(total)) continue;
    lines.push({ categoryId, assign: Money.absolute(total) });
  }
  return lines;
}

/** `[from, to)`-style `YYYY-MM-DD` bounds for "last calendar month" relative to `today`, in the given timezone-naive sense (dates are already zone-resolved by the server; this only needs the calendar month boundary). */
export function lastCalendarMonthRange(today: Date): { from: string; to: string } {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth(); // 0-based; "last month" is month - 1
  const firstOfThisMonth = new Date(Date.UTC(year, month, 1));
  const firstOfLastMonth = new Date(Date.UTC(year, month - 1, 1));
  return {
    from: firstOfLastMonth.toISOString().slice(0, 10),
    to: firstOfThisMonth.toISOString().slice(0, 10),
  };
}
