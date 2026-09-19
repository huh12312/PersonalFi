// SPDX-License-Identifier: MIT
/**
 * Spending and income, by category and by calendar month.
 *
 * The rung (dispatch §3 WP 2.8) is "aggregated on `budget_date` independently
 * of the period grid": this groups by the ledger's resolved `effective.date`
 * truncated to `YYYY-MM`, never by a `@ctx/budgeting` period (a period can be
 * biweekly or semimonthly — 07 §1.7 — and a report month must mean the same
 * thing whether or not budgeting is even turned on).
 *
 * Every cell is computed by `computeCategoryActivity` (`reports/netting.ts`,
 * a documented port of `@ctx/budgeting`'s `computeActuals` — see that file's
 * header for why) — the reuse WP 2.8 was told to make rather than re-deriving
 * "transfers excluded, refunds netted". `categoryOfPurchase` is built once,
 * over the **whole** requested window, and handed to every month's call: a
 * refund that posts in a later month than its purchase still nets into the
 * *refund's* month, against the *purchase's* category, exactly as
 * `actuals.ts`'s own header describes and exactly what `@ctx/budgeting`'s
 * multi-period caller does.
 */
import { Money } from '@core/kernel';
import type { LedgerDatabase } from '@ctx/ledger';
import {
  groupByCurrency,
  loadReportAccounts,
  loadReportRows,
  type ReportWindow,
} from './ledger-source.ts';
import { computeCategoryActivity, totalOf } from './netting.ts';
import type { CategoryMonthActivity, ReportRow } from './types.ts';

function monthOf(date: string): string {
  return date.slice(0, 7);
}

/**
 * Every `(month, category, currency)` cell in the window, transfers excluded,
 * refunds netted. Callers split this into a spending report and an income
 * report by joining `categoryId` against `@ctx/categorization`'s `kind` — this
 * function does not import that context (an `apps/` file may, but doing the
 * join here would make this the one place both call, and a caller that wants
 * only spending would still pay for loading every category to find out).
 */
export async function computeCategoryMonthActivity(
  database: LedgerDatabase,
  window: ReportWindow,
): Promise<CategoryMonthActivity[]> {
  const [rows, accounts] = await Promise.all([
    loadReportRows(database, window),
    loadReportAccounts(database, window.userId),
  ]);
  const results: CategoryMonthActivity[] = [];

  for (const [currency, currencyRows] of groupByCurrency(rows)) {
    const currencyAccounts = accounts.filter((account) => account.currency === currency);

    // Built once, over the whole window, per `actuals.ts`'s cross-period rule.
    const categoryOfPurchase = new Map(
      currencyRows.map((row) => [row.id, row.categoryId] as const),
    );

    const byMonth = new Map<string, ReportRow[]>();
    for (const row of currencyRows) {
      const month = monthOf(row.date);
      const bucket = byMonth.get(month);
      if (bucket === undefined) byMonth.set(month, [row]);
      else bucket.push(row);
    }

    for (const [month, monthRows] of byMonth) {
      const byCategory = computeCategoryActivity({
        transactions: monthRows,
        accounts: currencyAccounts,
        categoryOfPurchase,
      });
      for (const activity of byCategory.values()) {
        results.push({
          month,
          categoryId: activity.categoryId,
          currency,
          amount: totalOf(activity, currency),
          transactionCount: activity.transactionCount,
          transferExcludedCount: activity.transferExcludedCount,
          refundNettedCount: activity.refundNettedCount,
        });
      }
    }
  }

  return results;
}

/** `computeCategoryMonthActivity` restricted to categories that spend money. */
export function spendingRowsOf(
  cells: readonly CategoryMonthActivity[],
  incomeCategoryIds: ReadonlySet<string>,
): CategoryMonthActivity[] {
  return cells.filter((cell) => {
    if (cell.categoryId === null) return !Money.isPositive(cell.amount);
    return !incomeCategoryIds.has(cell.categoryId);
  });
}

/** `computeCategoryMonthActivity` restricted to categories that bring money in. */
export function incomeRowsOf(
  cells: readonly CategoryMonthActivity[],
  incomeCategoryIds: ReadonlySet<string>,
): CategoryMonthActivity[] {
  return cells.filter((cell) => {
    if (cell.categoryId === null) return Money.isPositive(cell.amount);
    return incomeCategoryIds.has(cell.categoryId);
  });
}
