// SPDX-License-Identifier: MIT
/**
 * `@ctx/insights`' `LivingExpensesPort`, bound at the composition root (WP 10.12): the holder's categories
 * with the variability they classified on the Budget screen (WP 10.11), and Reports' own spending cells
 * (`computeCategoryMonthActivity` → `spendingRowsOf`, the exact cells `GET /reports/spending` serves:
 * transfers excluded, refunds netted) over the window the rule asks for. The rule itself —
 * which categories count and how the months are averaged — is `@ctx/insights`' `computeLivingExpenses`;
 * this file only reads.
 */
import type { Database } from '@core/db';
import { listCategories } from '@ctx/categorization';
import type { LivingExpensesPort } from '@ctx/insights';
import { computeCategoryMonthActivity, spendingRowsOf } from './spending-income.ts';

export function createLivingExpensesPort(
  database: Database,
  currency: string = 'USD',
): LivingExpensesPort {
  return async ({ userId, window }) => {
    const categories = await listCategories(database, userId, {});
    const incomeIds = new Set(
      categories.filter((category) => category.kind === 'income').map((category) => category.id),
    );
    const cells = spendingRowsOf(
      await computeCategoryMonthActivity(database, {
        userId,
        dateFrom: window.from,
        dateTo: window.to,
      }),
      incomeIds,
    );
    return {
      currency,
      categories: categories.map((category) => ({
        id: category.id,
        variability: category.variability,
      })),
      cells: cells
        .filter((cell) => cell.amount.currency === currency)
        .map((cell) => ({
          month: cell.month,
          categoryId: cell.categoryId,
          amountMinor: cell.amount.minor,
        })),
    };
  };
}
