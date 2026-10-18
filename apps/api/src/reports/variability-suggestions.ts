// SPDX-License-Identifier: MIT
/**
 * Which unclassified categories look **fixed** because a recurring stream lands in them (WP 10.11;
 * docs/research/10-visual-design-notes.md §3 V4, Monarch's equivalent).
 *
 * A suggestion, never a write. `categories.variability` (migration 0047) is the holder's classification and only
 * `PATCH /categories/{id}` sets it; this module computes, on read, what the budget screen shows as a "Suggested"
 * chip beside an unclassified category. Nothing here persists anything, and a category the holder has already
 * classified (any of the three values) is never suggested, so a suggestion can never contradict a choice.
 *
 * ## What counts
 *
 * - **An active stream**: `@ctx/recurring`'s `listSeries` with `state = 'ACTIVE'` (a stream the detector or the
 *   holder established, not a candidate and not archived), a `status` that still projects (`EARLY_DETECTION`,
 *   `ACTIVE`, `AT_RISK`, `MIGRATED` — the forecast's own `PROJECTING_STATUSES`: a stream the dormancy ladder has
 *   called cancelled is not evidence of a fixed cost any more) and `sign = 'OUTFLOW'` (an income stream says
 *   nothing about spending).
 * - **Its category**: a series has a merchant, not a category, so the category is where that merchant's money
 *   actually went — the most frequent effective category (`@ctx/ledger`'s resolved user > rule tier) among the
 *   merchant's outflows inside the stream's own observed span (`firstSeen`–`lastSeen`, bounded to the last 400
 *   days), transfers and holder-excluded rows left out. Ties break on the category id so the answer is stable.
 * - **Only an expense category with no variability** is suggested.
 */
import { DateOnly, type DateOnly as DateOnlyType } from '@core/kernel';
import type { UserCategory } from '@ctx/categorization';
import type { LedgerAggregateRow } from '@ctx/ledger';

/** The recurring stream fields this needs — `RecurringSeriesRow`'s, by name. */
export interface SuggestionSeries {
  readonly id: string;
  readonly merchantId: string;
  readonly state: string;
  readonly status: string;
  readonly sign: 'OUTFLOW' | 'INFLOW';
  readonly firstSeen: string;
  readonly lastSeen: string;
}

export interface VariabilitySuggestion {
  readonly categoryId: string;
  readonly variability: 'fixed';
  /** The active outflow streams whose merchant's money lands in this category, ids sorted. */
  readonly seriesIds: string[];
}

export const SUGGESTING_STATUSES: ReadonlySet<string> = new Set([
  'EARLY_DETECTION',
  'ACTIVE',
  'AT_RISK',
  'MIGRATED',
]);

/** How far back the merchant's rows are read: a year and a bit, so an annual stream is still seen. */
export const SUGGESTION_LOOKBACK_DAYS = 400;

export function isSuggestingSeries(series: SuggestionSeries): boolean {
  return (
    series.state === 'ACTIVE' && series.sign === 'OUTFLOW' && SUGGESTING_STATUSES.has(series.status)
  );
}

/** The window the merchants' rows are read over: the streams' spans, clipped to the lookback. */
export function suggestionWindow(
  series: readonly SuggestionSeries[],
  today: DateOnlyType,
): { readonly from: DateOnlyType; readonly to: DateOnlyType } | null {
  const active = series.filter(isSuggestingSeries);
  if (active.length === 0) return null;
  const floor = DateOnly.addDays(today, -SUGGESTION_LOOKBACK_DAYS);
  const first = active.map((s) => DateOnly.parse(s.firstSeen)).reduce((a, b) => DateOnly.min(a, b));
  return { from: DateOnly.max(first, floor), to: today };
}

/**
 * The pure half: streams + the merchants' rows + the chart of categories → suggestions, sorted by category id.
 */
export function suggestFixedCategories(input: {
  readonly series: readonly SuggestionSeries[];
  readonly rows: readonly Pick<
    LedgerAggregateRow,
    'date' | 'amount' | 'categoryId' | 'merchantId' | 'isTransfer' | 'excluded'
  >[];
  readonly categories: readonly Pick<UserCategory, 'id' | 'kind' | 'variability' | 'archivedAt'>[];
}): VariabilitySuggestion[] {
  const eligible = new Set(
    input.categories
      .filter((c) => c.kind === 'expense' && c.variability === null && c.archivedAt === null)
      .map((c) => c.id),
  );
  const seriesByCategory = new Map<string, Set<string>>();
  for (const series of input.series) {
    if (!isSuggestingSeries(series)) continue;
    const counts = new Map<string, number>();
    for (const row of input.rows) {
      if (row.merchantId !== series.merchantId || row.categoryId === null) continue;
      if (row.isTransfer || row.excluded || row.amount.minor >= 0n) continue;
      if (row.date < series.firstSeen || row.date > series.lastSeen) continue;
      counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
    }
    const modal = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
    if (modal === undefined || !eligible.has(modal[0])) continue;
    const bucket = seriesByCategory.get(modal[0]) ?? new Set<string>();
    bucket.add(series.id);
    seriesByCategory.set(modal[0], bucket);
  }
  return [...seriesByCategory]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([categoryId, ids]) => ({
      categoryId,
      variability: 'fixed' as const,
      seriesIds: [...ids].sort(),
    }));
}
