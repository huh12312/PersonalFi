// SPDX-License-Identifier: MIT
/**
 * In-app hrefs a block may carry (WP 10.15). Every one is a path inside the SPA — never a scheme or a host — and the
 * block schema refuses anything else (`BLOCK_HREF_PATTERN`).
 *
 * `transactionsHref` writes a `/transactions` search the way the web's router reads it (TanStack Router's default
 * search serialisation: an array or a boolean as JSON, a date as itself), so following a block's link lands on the
 * same filtered list `drill-through.ts`'s `toTransactionsSearch` produced from the same `drillThrough`.
 */
export interface DrillThroughWire {
  readonly categoryIds?: readonly string[] | undefined;
  readonly merchantIds?: readonly string[] | undefined;
  readonly uncategorized?: boolean | undefined;
  readonly from: string;
  readonly to: string;
}

export function transactionsHref(drill: DrillThroughWire): string {
  const parts: string[] = [];
  if (drill.categoryIds !== undefined && drill.categoryIds.length > 0) {
    parts.push(`categoryIds=${encodeURIComponent(JSON.stringify([...drill.categoryIds]))}`);
  }
  if (drill.merchantIds !== undefined && drill.merchantIds.length > 0) {
    parts.push(`merchantIds=${encodeURIComponent(JSON.stringify([...drill.merchantIds]))}`);
  }
  if (drill.uncategorized === true) parts.push('uncategorized=true');
  parts.push(`from=${encodeURIComponent(drill.from)}`, `to=${encodeURIComponent(drill.to)}`);
  return `/transactions?${parts.join('&')}`;
}

/** V7's category screen; `month` (`YYYY-MM`) selects that month on it. */
export function categoryHref(categoryId: string, month?: string): string {
  const path = `/categories/${encodeURIComponent(categoryId)}`;
  return month === undefined ? path : `${path}?month=${encodeURIComponent(month)}`;
}
