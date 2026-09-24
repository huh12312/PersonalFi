// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * URL search state for the net-worth full view (`_app.index.tsx`'s
 * `validateSearch`, WP 3.12's own addition). Kept to one field — `range` —
 * because that is the one piece of state the dispatch names explicitly:
 * "URL state (range) round-trips."
 */
export const NET_WORTH_RANGES = ['p30d', 'p90d', 'p1y', 'all'] as const;

export type NetWorthRange = (typeof NET_WORTH_RANGES)[number];

export const DEFAULT_NET_WORTH_RANGE: NetWorthRange = 'p90d';

export const netWorthSearchSchema = z.object({
  netWorthRange: z.enum(NET_WORTH_RANGES).optional(),
});

export type NetWorthSearch = z.infer<typeof netWorthSearchSchema>;

export const NET_WORTH_RANGE_LABELS: Record<NetWorthRange, string> = {
  p30d: '30 days',
  p90d: '90 days',
  p1y: '1 year',
  all: 'All time',
};

/** The widest window `GET /net-worth/series` will materialise (apps/api/src/routes/net-worth.ts). */
const MAX_SERIES_DAYS = 3653;

const RANGE_DAYS: Record<NetWorthRange, number> = {
  p30d: 30,
  p90d: 90,
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
