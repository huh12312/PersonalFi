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
 * Every cell is computed by `@ctx/budgeting`'s real `computeActuals` — the
 * reuse WP 2.8 was told to make rather than re-deriving "transfers excluded,
 * refunds netted", now that `@ctx/budgeting` is a declared dependency of
 * `apps/api` (the orchestrator's dependency batch;
 * `docs/evidence/phase-2/wp2.8-reports.md` §2 recorded this exact swap as its
 * open item — the netting.ts port it names has been deleted). `categoryOfPurchase`
 * is built once, over the **whole** requested window, and handed to every
 * month's call: a refund that posts in a later month than its purchase still
 * nets into the *refund's* month, against the *purchase's* category, exactly
 * as `actuals.ts`'s own header describes and exactly what `@ctx/budgeting`'s
 * multi-period caller does.
 */
import { Money } from '@core/kernel';
import { computeActuals } from '@ctx/budgeting';
import type { LedgerDatabase } from '@ctx/ledger';
import {
  groupByCurrency,
  loadReportAccounts,
  loadReportRows,
  toBudgetAccounts,
  toBudgetTransactions,
  type ReportWindow,
} from './ledger-source.ts';
import type { CategoryMonthActivity, ReportAccount, ReportRow } from './types.ts';

function monthOf(date: string): string {
  return date.slice(0, 7);
}

/** One calendar month of one currency, split by `computeActuals` into per-envelope activity. */
export interface MonthActuals {
  readonly month: string;
  readonly currency: string;
  readonly byCategory: ReturnType<typeof computeActuals>['byCategory'];
}

/**
 * The month-by-month `computeActuals` split every report in this directory starts from: rows grouped by
 * currency, then by `effective.date`'s `YYYY-MM`, each month run through `@ctx/budgeting`'s own
 * `computeActuals` with `categoryOfPurchase` built once over **every** row handed in (so a refund that posts a
 * month after its purchase still nets against the purchase's category). `computeCategoryMonthActivity` sums
 * each line; `spending-pace.ts` (WP 10.9) accumulates each line's transactions day by day. One split, two
 * readers: neither re-derives which rows count.
 */
export function monthActualsOf(
  rows: readonly ReportRow[],
  accounts: readonly ReportAccount[],
): MonthActuals[] {
  const results: MonthActuals[] = [];

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
      const { byCategory } = computeActuals({
        transactions: toBudgetTransactions(monthRows, currencyAccounts),
        accounts: toBudgetAccounts(currencyAccounts),
        categoryOfPurchase,
        currency,
      });
      results.push({ month, currency, byCategory });
    }
  }

  return results;
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

  for (const { month, currency, byCategory } of monthActualsOf(rows, accounts)) {
    for (const activity of byCategory.values()) {
      results.push({
        month,
        categoryId: activity.categoryId,
        currency,
        amount: Money.sum(
          activity.transactions.map((transaction) => transaction.amount),
          currency,
        ),
        transactionCount: activity.transactionCount,
        transferExcludedCount: activity.transferExcludedCount,
        refundNettedCount: activity.refundNettedCount,
      });
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
