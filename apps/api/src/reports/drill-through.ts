// SPDX-License-Identifier: MIT
/**
 * A report cell → `GET /transactions`'s own filter params.
 *
 * The dispatch's drill-through rule is to reuse the transaction list's existing
 * `categoryIds`/date params rather than invent a report-specific filter
 * language WP 2.9's frontend would have to learn twice. This is the one place
 * that mapping is written down, so a report cell and the transactions screen
 * can never disagree about what "this cell" means.
 */
import { DateOnly } from '@core/kernel';
import type { DrillThroughFilter } from './types.ts';

/** `YYYY-MM` → the whole calendar month, inclusive both ends (`GET /transactions`'s `to` is `<=`). */
export function drillThroughForMonth(month: string, categoryId: string | null): DrillThroughFilter {
  const start = DateOnly.parse(`${month}-01`);
  return {
    ...(categoryId === null ? {} : { categoryIds: [categoryId] }),
    from: start,
    to: DateOnly.endOfMonth(start),
  };
}

/** A Sankey category or merchant band → the same category over the whole window. */
export function drillThroughForWindow(
  from: string,
  to: string,
  categoryId: string | null,
): DrillThroughFilter {
  return {
    ...(categoryId === null ? {} : { categoryIds: [categoryId] }),
    from,
    to,
  };
}
