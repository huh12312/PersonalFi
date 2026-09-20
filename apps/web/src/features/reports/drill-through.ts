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
 * `merchantIds` (present on a Sankey merchant-band link) has nowhere to go:
 * `apps/web/src/features/transactions/filters.ts#transactionsSearchSchema` —
 * owned by WP 2.11/the transactions feature, out of this work package's
 * scope to edit — validates the `/transactions` route's URL search and does
 * not include a `merchantIds` field, even though `GET /transactions` itself
 * accepts one. A merchant-band click therefore drills through on
 * `categoryIds`/`from`/`to` alone, landing on a *superset* of the exact
 * merchant (every transaction in that category and window) rather than
 * failing or silently dropping the click. Flagged in
 * `docs/evidence/phase-2/wp2.9-budget-ui.md` as an open item: add
 * `merchantIds` to `transactionsSearchSchema` and thread it through here.
 */
export function toTransactionsSearch(drillThrough: ReportDrillThrough): TransactionsSearch {
  return {
    ...(drillThrough.categoryIds !== undefined && drillThrough.categoryIds.length > 0
      ? { categoryIds: [...drillThrough.categoryIds] }
      : {}),
    from: drillThrough.from,
    to: drillThrough.to,
  };
}
