// SPDX-License-Identifier: MIT
/**
 * The arithmetic behind the stacked net-worth chart (WP 10.13, V6): buckets off the wire, the stack's
 * geometry in minor units, the scrub readout's deltas, the legend's totals, keyboard movement. Pure, so
 * each rule is a unit test rather than a screenshot.
 *
 * Money stays exact (`bigint` minor units) for every figure a reader sees; numbers are made only for
 * pixel positions (08 §6.5's presentation carve-out) and for the percent, a display-only ratio.
 */
import type { NetWorthBucket as WireBucket } from '../../api/generated/types.gen.ts';
import {
  accountTypeHue,
  chartFillVar,
  type AccountKind,
} from '../../components/finance/chart-hue.ts';
import type { DashboardPeriod } from './search.ts';

export type Bucketing = 'day' | 'week' | 'month';

/** 1M is drawn by day, 3M and 6M by week, 1Y and All by month. */
export const BUCKETING_FOR_PERIOD: Readonly<Record<DashboardPeriod, Bucketing>> = {
  '1M': 'day',
  '3M': 'week',
  '6M': 'week',
  '1Y': 'month',
  ALL: 'month',
};

/** The bucketing rule in words — the table's caption says it, so a reader knows what one bar is. */
export const BUCKETING_RULE: Readonly<Record<Bucketing, string>> = {
  day: 'One bar per day.',
  week: 'One bar per week (Monday to Sunday), showing the last recorded day of the week; the first and last weeks are cut at the edges of the period.',
  month:
    'One bar per month, showing the last recorded day of the month; the first and last months are cut at the edges of the period.',
};

/**
 * Stacking order above the zero line, from the baseline out. Not the legend's alphabetical order: chosen so
 * every pair of neighbours clears the dataviz validator in both themes (property↔cash ΔE 16.4 normal-vision;
 * the light theme's 7.3 protan is in the 6–8 band, legal with the 2 px surface gap, the legend and the table
 * as secondary encoding). Brown beside neutral (7.8) or beside orange (10.1 dark) would not be.
 */
export const POSITIVE_STACK: readonly AccountKind[] = [
  'property',
  'cash',
  'crypto',
  'investments',
  'other',
];

/** Below the zero line, from the baseline down: liabilities first, then any asset type that is negative. */
export const NEGATIVE_STACK: readonly AccountKind[] = [
  'liabilities',
  'cash',
  'investments',
  'crypto',
  'property',
  'other',
];

/** The legend's order: assets as stacked, then liabilities. */
export const LEGEND_ORDER: readonly AccountKind[] = [...POSITIVE_STACK, 'liabilities'];

export const KIND_LABEL: Readonly<Record<AccountKind, string>> = {
  cash: 'Cash',
  investments: 'Investments',
  crypto: 'Crypto',
  property: 'Property',
  liabilities: 'Liabilities',
  other: 'Other',
};

export function kindFillVar(kind: AccountKind): string {
  return chartFillVar(accountTypeHue(kind));
}

export interface StackedSegment {
  readonly kind: AccountKind;
  readonly minor: bigint;
}

export interface StackedBucket {
  readonly start: string;
  readonly end: string;
  /** The closing snapshot day; `null` for a bucket with no snapshot (a gap). */
  readonly asOfDate: string | null;
  readonly currency: string | null;
  readonly netMinor: bigint | null;
  readonly segments: readonly StackedSegment[];
  readonly sealed: boolean;
  readonly source: string | null;
}

export function fromWire(buckets: readonly WireBucket[] | null | undefined): StackedBucket[] {
  return (buckets ?? []).map((bucket) => ({
    start: bucket.start,
    end: bucket.end,
    asOfDate: bucket.asOfDate,
    currency: bucket.netWorth?.currency ?? null,
    netMinor: bucket.netWorth === null ? null : BigInt(bucket.netWorth.minor),
    segments: bucket.segments.map((segment) => ({
      kind: segment.kind,
      minor: BigInt(segment.amount.minor),
    })),
    sealed: bucket.sealed,
    source: bucket.source,
  }));
}

/** Whether a bucket has a figure. */
export function hasData(bucket: StackedBucket): boolean {
  return bucket.asOfDate !== null && bucket.netMinor !== null;
}

export interface CurrencyBuckets {
  readonly currency: string;
  /** Every bucket of the window, in order; a bucket closing in another currency is a gap here. */
  readonly buckets: readonly StackedBucket[];
}

const GAP_OF = (bucket: StackedBucket): StackedBucket => ({
  ...bucket,
  asOfDate: null,
  currency: null,
  netMinor: null,
  segments: [],
});

/**
 * One series of buckets per currency (D4: never summed across currencies, never converted without a rate).
 * Each keeps every bucket position so the x-axis is the same window; a bucket that closes in another
 * currency is a gap in this one. Sorted by currency code.
 */
export function groupBucketsByCurrency(buckets: readonly StackedBucket[]): CurrencyBuckets[] {
  const currencies = [
    ...new Set(buckets.flatMap((b) => (b.currency === null ? [] : [b.currency]))),
  ].sort();
  return currencies.map((currency) => ({
    currency,
    buckets: buckets.map((bucket) => (bucket.currency === currency ? bucket : GAP_OF(bucket))),
  }));
}

/** For All: the window opens ten years back, so leading buckets before the first snapshot are dropped. */
export function trimLeadingGaps(buckets: readonly StackedBucket[]): StackedBucket[] {
  const first = buckets.findIndex(hasData);
  return first < 0 ? [] : buckets.slice(first);
}

export interface StackPiece {
  readonly kind: AccountKind;
  readonly minor: bigint;
  /** The piece's extent in minor units: `from` nearer the zero line, `to` farther from it. */
  readonly from: number;
  readonly to: number;
  /** Above (`up`) or below (`down`) the zero line. */
  readonly side: 'up' | 'down';
  /** Only the outermost piece on each side carries the rounded data-end. */
  readonly rounded: boolean;
}

/** Presentation only: a pixel-scale number from minor units (08 §6.5's carve-out). */
function num(minor: bigint): number {
  return Number(minor);
}

/**
 * The stack for one bucket: positive segments upward from zero in `POSITIVE_STACK` order, negative ones
 * downward in `NEGATIVE_STACK` order — a liability is always below the line. Zero-valued segments draw
 * nothing.
 */
export function stackOf(bucket: StackedBucket): StackPiece[] {
  const byKind = new Map(bucket.segments.map((segment) => [segment.kind, segment.minor]));
  const pieces: StackPiece[] = [];
  let up = 0;
  for (const kind of POSITIVE_STACK) {
    const minor = byKind.get(kind);
    if (minor === undefined || minor <= 0n) continue;
    pieces.push({ kind, minor, from: up, to: up + num(minor), side: 'up', rounded: false });
    up += num(minor);
  }
  let down = 0;
  for (const kind of NEGATIVE_STACK) {
    const minor = byKind.get(kind);
    if (minor === undefined || minor >= 0n) continue;
    pieces.push({ kind, minor, from: down, to: down + num(minor), side: 'down', rounded: false });
    down += num(minor);
  }
  const lastUp = pieces.map((p) => p.side).lastIndexOf('up');
  const lastDown = pieces.map((p) => p.side).lastIndexOf('down');
  return pieces.map((piece, index) =>
    index === lastUp || index === lastDown ? { ...piece, rounded: true } : piece,
  );
}

/** The chart's y-extent in minor units: every stack's top and bottom, the net, and zero. */
export function extentOf(buckets: readonly StackedBucket[]): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const bucket of buckets) {
    for (const piece of stackOf(bucket)) {
      lo = Math.min(lo, piece.to);
      hi = Math.max(hi, piece.to);
    }
    if (bucket.netMinor !== null) {
      lo = Math.min(lo, num(bucket.netMinor));
      hi = Math.max(hi, num(bucket.netMinor));
    }
  }
  return [lo, hi];
}

export interface Change {
  /** Exact, minor units. */
  readonly changeMinor: bigint;
  /** change ÷ base, display only; `null` when withheld. */
  readonly ratio: number | null;
  /** Why the percent is withheld, in words; `null` when it is shown. */
  readonly withheld: string | null;
  /** The bucket compared against. */
  readonly against: StackedBucket;
}

export const PERCENT_WITHHELD_ZERO = 'no percent: the starting figure is zero';
export const PERCENT_WITHHELD_NEGATIVE = 'no percent: the starting figure is negative';

/**
 * `latest − base` in money, and as a percent of `base` **only when `base` is positive** — a percent of zero
 * is undefined and a percent of a negative net worth reads backwards (a debt shrinking from −$10k to −$5k
 * is "−50 %"), so both say why instead.
 */
export function changeBetween(base: StackedBucket, latest: StackedBucket): Change | null {
  if (base.netMinor === null || latest.netMinor === null) return null;
  const changeMinor = latest.netMinor - base.netMinor;
  if (base.netMinor === 0n) {
    return { changeMinor, ratio: null, withheld: PERCENT_WITHHELD_ZERO, against: base };
  }
  if (base.netMinor < 0n) {
    return { changeMinor, ratio: null, withheld: PERCENT_WITHHELD_NEGATIVE, against: base };
  }
  return {
    changeMinor,
    ratio: num(changeMinor) / num(base.netMinor),
    withheld: null,
    against: base,
  };
}

export interface Readout {
  readonly bucket: StackedBucket;
  readonly vsPrevious: Change | null;
  readonly vsFirst: Change | null;
}

/**
 * The scrub readout for bucket `index`: its figure, the change since the previous bucket that has one,
 * and since the first bucket in the period that has one (`null` for the first itself). `null` for a gap.
 */
export function readoutAt(buckets: readonly StackedBucket[], index: number): Readout | null {
  const bucket = buckets[index];
  if (bucket === undefined || !hasData(bucket)) return null;
  let previous: StackedBucket | undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (hasData(buckets[i]!)) {
      previous = buckets[i];
      break;
    }
  }
  const firstIndex = buckets.findIndex(hasData);
  const first = firstIndex >= 0 && firstIndex < index ? buckets[firstIndex] : undefined;
  return {
    bucket,
    vsPrevious: previous === undefined ? null : changeBetween(previous, bucket),
    vsFirst: first === undefined ? null : changeBetween(first, bucket),
  };
}

export interface LegendEntry {
  readonly kind: AccountKind;
  readonly minor: bigint;
}

/** Every account type present at the bucket, with its total, in `LEGEND_ORDER`. */
export function legendAt(bucket: StackedBucket | undefined): LegendEntry[] {
  if (bucket === undefined) return [];
  const byKind = new Map(bucket.segments.map((segment) => [segment.kind, segment.minor]));
  return LEGEND_ORDER.flatMap((kind) => {
    const minor = byKind.get(kind);
    return minor === undefined ? [] : [{ kind, minor }];
  });
}

/** The last bucket with a figure, or -1. */
export function latestIndex(buckets: readonly StackedBucket[]): number {
  for (let i = buckets.length - 1; i >= 0; i -= 1) if (hasData(buckets[i]!)) return i;
  return -1;
}

/**
 * Keyboard movement over the buckets that have a figure: ← / → to the previous / next one, Home / End to
 * the first / last. With nothing selected the latest is what is shown, so ← goes to the one before it and →
 * selects the latest itself. `null` for a key that does not move.
 */
export function moveSelection(
  buckets: readonly StackedBucket[],
  current: number | null,
  key: string,
): number | null {
  const valued = buckets.flatMap((bucket, index) => (hasData(bucket) ? [index] : []));
  if (valued.length === 0) return null;
  const last = valued.at(-1)!;
  const from = current ?? last;
  switch (key) {
    case 'Home':
      return valued[0]!;
    case 'End':
      return last;
    case 'ArrowLeft':
    case 'ArrowDown': {
      const before = valued.filter((index) => index < from);
      return before.at(-1) ?? from;
    }
    case 'ArrowRight':
    case 'ArrowUp': {
      if (current === null) return last;
      return valued.find((index) => index > from) ?? from;
    }
    default:
      return null;
  }
}
