// SPDX-License-Identifier: MIT
import type { ReportDrillThrough } from '../../api/generated/types.gen.ts';
import type { TransactionsSearch } from '../transactions/filters.ts';

/**
 * Every report cell/link carries a `drillThrough` object that is, per
 * `wp2.8-reports.md` §3, "literally `GET /transactions`'s own
 * `categoryIds`/`from`/`to`" — reused, not a second filter language. This is
 * the one place that reuse becomes a `<Link to="/transactions" search={...}>`
 * target, so `ReportsScreen.tsx`/`BudgetVsActualTable.tsx`/the Sankey and bar
 * charts all click through the same way.
 *
 * `merchantIds` (a Sankey merchant band, a Cash Flow merchant row) and `uncategorized` (the Cash Flow hub's
 * "Uncategorised" row) go straight through too: `transactionsSearchSchema` carries both since WP 10.10, which
 * closed the open item `docs/evidence/phase-2/wp2.9-budget-ui.md` recorded (a merchant click used to land on
 * every transaction in the category).
 */
export function toTransactionsSearch(drillThrough: ReportDrillThrough): TransactionsSearch {
  return {
    ...(drillThrough.categoryIds !== undefined && drillThrough.categoryIds.length > 0
      ? { categoryIds: [...drillThrough.categoryIds] }
      : {}),
    ...(drillThrough.merchantIds !== undefined && drillThrough.merchantIds.length > 0
      ? { merchantIds: [...drillThrough.merchantIds] }
      : {}),
    ...(drillThrough.uncategorized === true ? { uncategorized: true } : {}),
    from: drillThrough.from,
    to: drillThrough.to,
  };
}
