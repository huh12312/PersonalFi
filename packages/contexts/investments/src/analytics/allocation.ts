// SPDX-License-Identifier: MIT
/**
 * Allocation by asset class, region and sector — **fund-level only**, with
 * `unclassifiedPct` returned beside every number and a STALE price kept out of
 * any "as of now" answer.
 *
 * ## Fund-level only, and why that is a feature in v1
 *
 * 07 §4.3 is blunt about look-through: N-PORT is quarterly with a ~60-day lag,
 * derivatives report market value rather than notional, fund-of-funds need
 * recursion with a depth cap. WP 3.1's `classify()` already implements that
 * waterfall, cap and cycle detection, and records `classification_source` on
 * every answer. This file does **not** re-derive any of it: a holding arrives
 * with the asset class it has, and contributes its whole market value to that
 * one class. Synthesising a look-through here would invent a second, worse
 * classifier and label its output identically to the good one.
 *
 * ## `unclassifiedPct` is not optional, and not a footnote
 *
 * 07 §4.3, normative: *"Surface `% unclassified` next to every allocation
 * chart and drift number. If 18% of the portfolio is unclassified, a '7pp
 * drift' claim is noise."* So it is a required field of every report this
 * module and `drift.ts`, `fees.ts` and `concentration.ts` return — present and
 * `'0.0000000000'` when nothing is unclassified, rather than absent and
 * inferred. `src/analytics/allocation.test.ts` →
 * `'unclassifiedPct is returned whenever any holding is UNCLASSIFIED'`.
 *
 * ## The denominator includes cash. All of it.
 *
 * A portfolio is worth the sum of what is in it, and a sweep balance is in it.
 * Dropping cash from the denominator inflates every equity weight — a 60/40
 * portfolio with 10% cash reads as 66.7/44.4, which is a drift alert nobody
 * needs and a rebalance trade nobody should make. The sabotage in
 * `docs/evidence/phase-3/wp3.3-analytics.md` is exactly that one filter, and
 * `'allocation matches the committed spreadsheet fixture to the cent'` is what
 * turns red when it is applied.
 *
 * ## STALE prices and `as_of_now`
 *
 * 07 §6.1: *"if last price > 24h old, mark the holding STALE and exclude from
 * 'as of now' deltas."* WP 3.4 computes that verdict at read time and hands it
 * over on the holding; this file honours it by dropping the holding from
 * **both** the numerator and the denominator of an `as_of_now` allocation and
 * naming it in `excluded`. It is never coerced to zero, and never quietly
 * counted at a price from last week.
 */
import { Money, type CurrencyCode, type Money as MoneyType } from '@core/kernel';
import type { AssetClass } from '../../schema/index.ts';
import { marketValueOf } from '../basis.ts';
import {
  AnalyticsInputError,
  RATIO_ZERO,
  ratioOfMoney,
  sumRatios,
  type AnalyticsHolding,
  type ExcludedHolding,
  type Ratio,
  type ValuationOptions,
} from './types.ts';

/** The three dimensions v1 answers. Style and duration are deliberately absent. */
export const ALLOCATION_DIMENSIONS = ['asset_class', 'region', 'sector'] as const;
export type AllocationDimension = (typeof ALLOCATION_DIMENSIONS)[number];

/** The key that means "the waterfall ran and fell through", per dimension. */
export const UNCLASSIFIED_KEYS: Readonly<Record<AllocationDimension, string>> = {
  asset_class: 'UNCLASSIFIED' satisfies AssetClass,
  region: 'UNKNOWN',
  sector: 'UNKNOWN',
};

export interface ValuedHolding {
  readonly holding: AnalyticsHolding;
  readonly marketValue: MoneyType;
}

export interface ValuationSet {
  readonly valued: readonly ValuedHolding[];
  readonly excluded: readonly ExcludedHolding[];
  /** The denominator every weight in every report is taken against. Cash included. */
  readonly total: MoneyType;
  readonly currency: CurrencyCode;
}

/**
 * Value every holding, dropping the ones that cannot honestly be valued and
 * saying which and why.
 *
 * The one place `quantity × price` happens in this module, so the rounding
 * happens once, half-even, at the boundary into minor units — `basis.ts`'s
 * `marketValueOf`, reused rather than reimplemented.
 */
export function valueHoldings(
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): ValuationSet {
  const valued: ValuedHolding[] = [];
  const excluded: ExcludedHolding[] = [];

  for (const holding of holdings) {
    if (holding.price === null) {
      excluded.push({
        holdingId: holding.holdingId,
        symbol: holding.symbol,
        reason: 'price_unknown',
      });
      continue;
    }
    if (holding.price.currency !== options.currency) {
      excluded.push({
        holdingId: holding.holdingId,
        symbol: holding.symbol,
        reason: 'currency_mismatch',
      });
      continue;
    }
    if (options.basis === 'as_of_now' && holding.staleness === 'STALE') {
      excluded.push({
        holdingId: holding.holdingId,
        symbol: holding.symbol,
        reason: 'stale_price',
      });
      continue;
    }
    valued.push({
      holding,
      marketValue: marketValueOf(holding.quantity, holding.price, options.scale),
    });
  }

  const total = valued.reduce(
    (running, entry) => Money.add(running, entry.marketValue),
    Money.zero(options.currency),
  );
  return { valued, excluded, total, currency: options.currency };
}

export interface AllocationSlice {
  /** The asset class, region or sector. Never absent, never an empty string. */
  readonly key: string;
  readonly value: MoneyType;
  readonly weight: Ratio;
  readonly holdingIds: readonly string[];
}

export interface AllocationReport {
  readonly dimension: AllocationDimension;
  readonly basis: ValuationOptions['basis'];
  readonly currency: CurrencyCode;
  /** Every valued holding, cash included. The denominator. */
  readonly total: MoneyType;
  /** Descending by value, then by key — a stable order for a stable chart. */
  readonly slices: readonly AllocationSlice[];
  /** 07 §4.3's mandatory number. Present even when it is zero. */
  readonly unclassifiedPct: Ratio;
  readonly unclassifiedValue: MoneyType;
  /** What could not be valued, and why. Never silently dropped. */
  readonly excluded: readonly ExcludedHolding[];
  /** Named so a reader of the response knows the denominator's shape. */
  readonly includesCash: true;
  /** v1 states this rather than implying it: no synthetic look-through. */
  readonly lookThrough: 'fund_level_only';
}

/** Allocation across one dimension. */
export function allocationBy(
  dimension: AllocationDimension,
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): AllocationReport {
  return allocationOf(dimension, valueHoldings(holdings, options), options);
}

/**
 * Allocation over an already-valued set — the form `drift.ts` uses so a drift
 * report and its allocation cannot disagree about the denominator.
 */
export function allocationOf(
  dimension: AllocationDimension,
  set: ValuationSet,
  options: ValuationOptions,
): AllocationReport {
  const buckets = new Map<string, { value: MoneyType; holdingIds: string[] }>();
  for (const entry of set.valued) {
    const key = keyOf(dimension, entry.holding);
    const bucket = buckets.get(key) ?? { value: Money.zero(set.currency), holdingIds: [] };
    bucket.value = Money.add(bucket.value, entry.marketValue);
    bucket.holdingIds.push(entry.holding.holdingId);
    buckets.set(key, bucket);
  }

  const empty = Money.isZero(set.total);
  const slices: AllocationSlice[] = [...buckets]
    .map(([key, bucket]) => ({
      key,
      value: bucket.value,
      weight: empty ? RATIO_ZERO : ratioOfMoney(bucket.value, set.total),
      holdingIds: bucket.holdingIds,
    }))
    .sort((a, b) => {
      const byValue = Money.compare(b.value, a.value);
      return byValue !== 0 ? byValue : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  const unclassifiedKey = UNCLASSIFIED_KEYS[dimension];
  const unclassified = slices.find((slice) => slice.key === unclassifiedKey);

  return {
    dimension,
    basis: options.basis,
    currency: set.currency,
    total: set.total,
    slices,
    unclassifiedPct: unclassified?.weight ?? RATIO_ZERO,
    unclassifiedValue: unclassified?.value ?? Money.zero(set.currency),
    excluded: set.excluded,
    includesCash: true,
    lookThrough: 'fund_level_only',
  };
}

export function allocationByAssetClass(
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): AllocationReport {
  return allocationBy('asset_class', holdings, options);
}

export function allocationByRegion(
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): AllocationReport {
  return allocationBy('region', holdings, options);
}

export function allocationBySector(
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): AllocationReport {
  return allocationBy('sector', holdings, options);
}

/** The weight of one key, or zero. Zero *because absent*, never because unknown. */
export function weightOf(report: AllocationReport, key: string): Ratio {
  return report.slices.find((slice) => slice.key === key)?.weight ?? RATIO_ZERO;
}

/** The three dimensions in one pass over one valuation, for WP 3.9's response. */
export function allocationReport(
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): Readonly<Record<AllocationDimension, AllocationReport>> {
  const set = valueHoldings(holdings, options);
  return {
    asset_class: allocationOf('asset_class', set, options),
    region: allocationOf('region', set, options),
    sector: allocationOf('sector', set, options),
  };
}

/**
 * Σ of every slice weight, which is `1` for a non-empty portfolio.
 *
 * Exists for the property test (`'allocation sums to 100% ± unclassified'`)
 * and for an assertion a caller can make cheaply; the classified share is
 * `sum − unclassifiedPct` by construction, which is the *± unclassified* the
 * property is named for.
 */
export function totalWeightOf(report: AllocationReport): Ratio {
  return sumRatios(report.slices.map((slice) => slice.weight));
}

function keyOf(dimension: AllocationDimension, holding: AnalyticsHolding): string {
  switch (dimension) {
    case 'asset_class':
      return holding.assetClass;
    case 'region':
      return holding.region;
    case 'sector':
      return holding.sector.trim() === '' ? UNCLASSIFIED_KEYS.sector : holding.sector;
  }
}

/** Guard the one thing a caller can get wrong silently: the wrong minor scale. */
export function assertScaleMatches(currency: CurrencyCode, scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 4) {
    throw new AnalyticsInputError(`implausible minor-unit scale ${scale} for ${currency}`);
  }
}
