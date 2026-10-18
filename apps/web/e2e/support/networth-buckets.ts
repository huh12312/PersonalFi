// SPDX-License-Identifier: MIT
/**
 * WP 10.13: the mock's half of `GET /net-worth/series?bucket=` — the same bucketing rule as `@ctx/planning`'s
 * `buckets.ts` (days; ISO weeks, Monday to Sunday; calendar months; each bucket's figure is its last day with a
 * value inside the window; the first and last cut at the window's edges; a bucket with no value is a gap), so a
 * spec drives the chart with buckets shaped exactly like the route's.
 *
 * Two fixtures: the WP 3.12 five days (`SERIES_DAYS` in `mock-networth.ts`, each split into a cash, an
 * investments and a liabilities segment that sum to the day exactly), and `stackedDay` — a deterministic holder
 * with every account type, two years of days up to the requested `to`, the last one live.
 */

export interface DayFigure {
  readonly asOfDate: string;
  readonly currency: string;
  readonly sealed: boolean;
  readonly source: string;
  /** Signed minor units per account type; their sum is the day's net. */
  readonly segments: Readonly<Record<string, number>>;
}

const DAY_MS = 86_400_000;

function epoch(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / DAY_MS;
}

function dateOf(epochDay: number): string {
  return new Date(epochDay * DAY_MS).toISOString().slice(0, 10);
}

export function bucketStartOf(date: string, bucketing: string): string {
  if (bucketing === 'day') return date;
  if (bucketing === 'week') {
    const day = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return dateOf(epoch(date) - ((day + 6) % 7));
  }
  return `${date.slice(0, 7)}-01`;
}

function bucketLastOf(start: string, bucketing: string): string {
  if (bucketing === 'day') return start;
  if (bucketing === 'week') return dateOf(epoch(start) + 6);
  const [y, m] = start.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function netOf(day: DayFigure): number {
  return Object.values(day.segments).reduce((sum, value) => sum + value, 0);
}

function money(minor: number, currency: string) {
  return { minor: String(minor), currency };
}

/** Every bucket in `[from, to]` from the days given (any order), shaped like the route's `NetWorthBucket`. */
export function bucketsFor(
  days: readonly DayFigure[],
  from: string,
  to: string,
  bucketing: string,
) {
  const byDate = new Map(days.map((day) => [day.asOfDate, day]));
  const out = [];
  let key = bucketStartOf(from, bucketing);
  while (key <= to) {
    const last = bucketLastOf(key, bucketing);
    const start = key < from ? from : key;
    const end = last > to ? to : last;
    let closing: DayFigure | undefined;
    for (let e = epoch(end); e >= epoch(start); e -= 1) {
      closing = byDate.get(dateOf(e));
      if (closing !== undefined) break;
    }
    out.push(
      closing === undefined
        ? { start, end, asOfDate: null, netWorth: null, segments: [], sealed: false, source: null }
        : {
            start,
            end,
            asOfDate: closing.asOfDate,
            netWorth: money(netOf(closing), closing.currency),
            segments: Object.entries(closing.segments).map(([kind, minor]) => ({
              kind,
              amount: money(minor, closing.currency),
              accounts: 1,
            })),
            sealed: closing.sealed,
            source: closing.source,
          },
    );
    key = dateOf(epoch(last) + 1);
  }
  return out;
}

/** WP 3.12's day, split into three segments that sum to it exactly. */
export function splitDay(
  asOfDate: string,
  minor: number,
  currency: string,
  sealed: boolean,
  source: string,
): DayFigure {
  const liabilities = -Math.floor(minor / 10);
  const investments = Math.floor(minor * 0.4);
  const cash = minor - investments - liabilities;
  return { asOfDate, currency, sealed, source, segments: { cash, investments, liabilities } };
}

/** The first day the stacked holder has a figure. */
export const STACKED_FIRST_DAY = '2024-10-01';

/**
 * A deterministic holder with every account type: a house, cash, a brokerage, a little crypto, a car under
 * "other", a mortgage and a card. Smooth growth plus a small wobble, so weekly and monthly bars differ visibly.
 * `null` before `STACKED_FIRST_DAY`. The day equal to `today` is live (unsealed).
 */
export function stackedDay(date: string, today: string): DayFigure | null {
  if (date < STACKED_FIRST_DAY || date > today) return null;
  const t = epoch(date) - epoch(STACKED_FIRST_DAY);
  const wobble = Math.round(Math.sin(t / 5) * 120_000);
  return {
    asOfDate: date,
    currency: 'USD',
    sealed: date !== today,
    source: 'observed',
    segments: {
      property: 42_000_000 + t * 2_000,
      cash: 2_400_000 + wobble + t * 1_500,
      crypto: 300_000 + Math.round(Math.sin(t / 11) * 90_000),
      investments: 9_000_000 + t * 9_000 + wobble * 2,
      other: 1_100_000,
      liabilities: -(31_000_000 - t * 6_000) - 180_000,
    },
  };
}

/** Every stacked day in `[from, to]`. */
export function stackedDays(from: string, to: string, today: string): DayFigure[] {
  const days: DayFigure[] = [];
  for (let e = epoch(from); e <= epoch(to); e += 1) {
    const day = stackedDay(dateOf(e), today);
    if (day !== null) days.push(day);
  }
  return days;
}

/** A gapless `NetWorthSeriesPoint` per day of `[from, to]` from the days given. */
export function pointsFor(days: readonly DayFigure[], from: string, to: string) {
  const byDate = new Map(days.map((day) => [day.asOfDate, day]));
  const points = [];
  for (let e = epoch(from); e <= epoch(to); e += 1) {
    const date = dateOf(e);
    const day = byDate.get(date);
    points.push({
      asOfDate: date,
      netWorth: day === undefined ? null : money(netOf(day), day.currency),
      assets: null,
      liabilities: null,
      liquid: null,
      investable: null,
      onBudget: null,
      sealed: day?.sealed ?? false,
      sealedAt: day?.sealed === true ? `${date}T06:00:00.000Z` : null,
      revision: day === undefined ? 0 : 1,
      source: day?.source ?? null,
      stalePrice: false,
      dirty: false,
      accountsCounted: day === undefined ? null : 7,
      accountsUnvalued: day === undefined ? null : 0,
      correctionReason: null,
    });
  }
  return points;
}
