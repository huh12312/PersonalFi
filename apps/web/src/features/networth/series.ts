// SPDX-License-Identifier: MIT
import type { NetWorthPoint } from '../../charts/NetWorthAreaChart.tsx';
import type { GetNetWorthSeriesResponse } from '../../api/generated/types.gen.ts';

export type RawSeriesPoint = GetNetWorthSeriesResponse['points'][number];

export interface CurrencySeries {
  readonly currency: string;
  readonly color: string;
  readonly points: readonly NetWorthPoint[];
}

/**
 * Reuses existing theme tokens rather than declaring new CSS — a second,
 * third currency is rare, and this codebase has no categorical chart
 * palette yet (`dataviz`'s brand-neutral palette is a separate concern this
 * work package does not introduce). Cycles if a user somehow has more
 * currencies than colours.
 */
const SERIES_COLORS = [
  'var(--accent)',
  'var(--status-good)',
  'var(--status-critical)',
  'var(--chart-axis-ink)',
] as const;

export function colorForIndex(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? SERIES_COLORS[0];
}

/**
 * Presentation-only conversion of a `Money.minor` decimal string to a chart
 * y-coordinate. 08 §6.5 (the numeric-boundary rule the whole codebase lints
 * for) carves out exactly this: `toNumberApproximate` is legal "for
 * presentation." A net worth in cents comfortably fits
 * `Number.MAX_SAFE_INTEGER` (~90 trillion dollars) so precision loss is not
 * a practical concern for a pixel position. The result is never sent back to
 * the API, stored, or used in a comparison that matters.
 */
function toChartMinor(minor: string): number {
  return Number(minor);
}

/**
 * Groups `GET /net-worth/series`' gapless points into one series per
 * currency — the dispatch's own line: "ONE SERIES PER CURRENCY UNTIL AN FX
 * RATE EXISTS, never a silently-summed line." Each row already carries at
 * most one currency (planning's `net_worth_daily` is a single base-currency
 * snapshot per day — see `apps/api/src/routes/net-worth.ts`'s own comment on
 * why `baseCurrency` can vary row to row), so a window that spans a display-
 * currency change, or that otherwise mixes currencies across days, produces
 * more than one entry here. Every series carries a `null` on any day that
 * either has no data at all or belongs to a *different* currency — never a
 * value borrowed, converted at par, or summed with another currency's.
 */
export function groupByCurrency(points: readonly RawSeriesPoint[]): CurrencySeries[] {
  const currencies = new Set<string>();
  for (const point of points) {
    if (point.netWorth !== null) currencies.add(point.netWorth.currency);
  }
  const ordered = [...currencies].sort((a, b) => a.localeCompare(b));

  return ordered.map((currency, index) => ({
    currency,
    color: colorForIndex(index),
    points: points.map((point) => ({
      date: new Date(`${point.asOfDate}T00:00:00Z`),
      netWorthMinor:
        point.netWorth !== null && point.netWorth.currency === currency
          ? toChartMinor(point.netWorth.minor)
          : null,
      sealed: point.sealed,
      source: point.source,
    })),
  }));
}

/** The most recent point that actually carries a value, or `undefined` on an all-gap window. */
export function latestValued(points: readonly RawSeriesPoint[]): RawSeriesPoint | undefined {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if (points[i]!.netWorth !== null) return points[i];
  }
  return undefined;
}

/** Days the API labelled `source: 'interpolated'` — no observation, filled from neighbours. */
export function interpolatedCount(points: readonly RawSeriesPoint[]): number {
  return points.filter((point) => point.source === 'interpolated').length;
}

/**
 * Days with no net-worth value at all (`netWorth === null`) — the '—' rows
 * `RecentDayDetail` renders. C-9 (gate-security-review.md G3-12): before
 * this, `NetWorthFullView`'s "every day has a value" caption was derived
 * only from {@link interpolatedCount}, which counts `source === 'interpolated'`
 * and nothing else — so a day with no row at all (`source: null`, never
 * written by the snapshot job, e.g. because it failed on a missing FX rate)
 * counted as zero "interpolated" days while still showing '—' in the table
 * beneath a caption claiming full coverage. This counts the thing the
 * caption is actually claiming: does every day have *some* value, observed,
 * interpolated, or corrected — not just "is it not specifically the
 * interpolated label".
 */
export function missingCount(points: readonly RawSeriesPoint[]): number {
  return points.filter((point) => point.netWorth === null).length;
}
