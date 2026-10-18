// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * URL search state for the net-worth full view (`_app.index.tsx`'s
 * `validateSearch`, WP 3.12's own addition). Kept to one field — `range` —
 * because that is the one piece of state the dispatch names explicitly:
 * "URL state (range) round-trips."
 */
export const NET_WORTH_RANGES = ['p30d', 'p90d', 'p182d', 'p1y', 'all'] as const;

export type NetWorthRange = (typeof NET_WORTH_RANGES)[number];

export const DEFAULT_NET_WORTH_RANGE: NetWorthRange = 'p90d';

export const netWorthSearchSchema = z.object({
  netWorthRange: z.enum(NET_WORTH_RANGES).optional(),
});

export type NetWorthSearch = z.infer<typeof netWorthSearchSchema>;

export const NET_WORTH_RANGE_LABELS: Record<NetWorthRange, string> = {
  p30d: '30 days',
  p90d: '90 days',
  p182d: '6 months',
  p1y: '1 year',
  all: 'All time',
};

/** The widest window `GET /net-worth/series` will materialise (apps/api/src/routes/net-worth.ts). */
const MAX_SERIES_DAYS = 3653;

const RANGE_DAYS: Record<NetWorthRange, number> = {
  p30d: 30,
  p90d: 90,
  p182d: 182,
  p1y: 365,
  all: MAX_SERIES_DAYS,
};

/** `{from, to}` for `GET /net-worth/series`'s query string, given a range and today's date-only string. */
export function windowForRange(
  range: NetWorthRange,
  todayIso: string,
): { from: string; to: string } {
  const days = RANGE_DAYS[range];
  const to = todayIso;
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

/**
 * The dashboard widget's period chips (WP 10.9; Monarch's equivalent): 1M 3M 6M 1Y All.
 * Separate from `NET_WORTH_RANGES` (the full view's URL state, which is unchanged) because the widget has a six-month
 * window the full view never offered. 3M is 90 days — the same window as `p90d`, so the hero figure and the chart
 * at the default share one request.
 */
export const DASHBOARD_PERIODS = ['1M', '3M', '6M', '1Y', 'ALL'] as const;

export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

export const DEFAULT_DASHBOARD_PERIOD: DashboardPeriod = '3M';

export const DASHBOARD_PERIOD_LABELS: Record<DashboardPeriod, { short: string; long: string }> = {
  '1M': { short: '1M', long: 'the last month' },
  '3M': { short: '3M', long: 'the last 3 months' },
  '6M': { short: '6M', long: 'the last 6 months' },
  '1Y': { short: '1Y', long: 'the last year' },
  ALL: { short: 'All', long: 'all time' },
};

const PERIOD_DAYS: Record<DashboardPeriod, number> = {
  '1M': 30,
  '3M': 90,
  '6M': 182,
  '1Y': 365,
  ALL: MAX_SERIES_DAYS,
};

/** `{from, to}` for a dashboard period, by the same arithmetic as `windowForRange`. */
export function windowForPeriod(
  period: DashboardPeriod,
  todayIso: string,
): { from: string; to: string } {
  const to = todayIso;
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - (PERIOD_DAYS[period] - 1) * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

/**
 * WP 10.13: the full view draws V2's chips (1M 3M 6M 1Y All) but keeps its URL values (`netWorthRange=p1y`
 * still means a year), plus `p182d` for the six-month chip. Same windows, so the full view and the widget at
 * the same period share one request.
 */
export const PERIOD_FOR_RANGE: Readonly<Record<NetWorthRange, DashboardPeriod>> = {
  p30d: '1M',
  p90d: '3M',
  p182d: '6M',
  p1y: '1Y',
  all: 'ALL',
};

export const RANGE_FOR_PERIOD: Readonly<Record<DashboardPeriod, NetWorthRange>> = {
  '1M': 'p30d',
  '3M': 'p90d',
  '6M': 'p182d',
  '1Y': 'p1y',
  ALL: 'all',
};
