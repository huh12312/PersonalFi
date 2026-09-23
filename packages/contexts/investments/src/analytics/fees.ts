// SPDX-License-Identifier: MIT
/**
 * Fee drag — `Σ(value × expense_ratio)`, and the one thing that makes the
 * number honest: **a missing expense ratio is not a zero.**
 *
 * 07's I2 fires on *"any position's expense ratio > 0.50%"* and quotes the
 * cost as `val × er`. The arithmetic is trivial; the failure mode is not.
 * `securities.expense_ratio` is `null` for every security the classification
 * waterfall could not reach — which, on a portfolio of individual equities and
 * a couple of obscure funds, can be most of it. Treating those nulls as 0.00%
 * produces a total that is *smaller* than the truth, indistinguishable from a
 * correct total, and reassuring. It is the same fabrication WP 3.2 refuses for
 * cost basis, wearing a different hat.
 *
 * So a holding without an expense ratio is excluded from the drag, **named**
 * in `holdingsMissingExpenseRatio`, and the report is marked `isLowerBound`.
 * `coveragePct` says how much of the portfolio the number actually covers, so
 * a UI can say "at least $412/year across 78% of your portfolio" instead of
 * "$412/year", which is what the data supports.
 *
 * An individual equity legitimately has no expense ratio — it charges none.
 * That is `expenseRatio: '0'`, set by the classifier, not `null`; the
 * difference between "charges nothing" and "we do not know" is exactly the
 * difference this file exists to preserve.
 */
import { Money, Quantity, type CurrencyCode, type Money as MoneyType } from '@core/kernel';
import { valueHoldings, type ValuationSet } from './allocation.ts';
import { allocationOf } from './allocation.ts';
import {
  RATIO_ZERO,
  ratio,
  ratioOfMoney,
  scaleMoney,
  type AnalyticsHolding,
  type ExcludedHolding,
  type Ratio,
  type ValuationOptions,
} from './types.ts';

/** 07 I2's trigger: an expense ratio above 0.50% is worth telling someone about. */
export const HIGH_EXPENSE_RATIO: Ratio = ratio('0.005');

export interface FeeRow {
  readonly holdingId: string;
  readonly securityId: string;
  readonly symbol: string | null;
  readonly value: MoneyType;
  /** The ratio as supplied, e.g. `'0.0003'`. Never rounded into the report. */
  readonly expenseRatio: Ratio;
  /** `value × expenseRatio`, rounded once, half-even. */
  readonly annualCost: MoneyType;
  /** 07 I2's trigger, evaluated once here rather than five times downstream. */
  readonly high: boolean;
}

export interface FeeDragReport {
  readonly currency: CurrencyCode;
  /** `Σ(value × expense_ratio)` over the holdings that have one. */
  readonly annualFeeDrag: MoneyType;
  /** `drag / coveredValue` — the portfolio's blended expense ratio. */
  readonly weightedExpenseRatio: Ratio;
  readonly rows: readonly FeeRow[];
  /** Every valued holding, including the ones with no expense ratio. */
  readonly total: MoneyType;
  /** The part of `total` the drag was actually computed over. */
  readonly coveredValue: MoneyType;
  readonly coveragePct: Ratio;
  /** Named, so the UI can ask for the ratios it is missing. */
  readonly holdingsMissingExpenseRatio: readonly string[];
  /** `true` whenever coverage is under 100%: the drag is a floor, not a total. */
  readonly isLowerBound: boolean;
  /** 07 §4.3: beside every number. */
  readonly unclassifiedPct: Ratio;
  readonly excluded: readonly ExcludedHolding[];
}

export function feeDrag(
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): FeeDragReport {
  return feeDragOf(valueHoldings(holdings, options), options);
}

/** The already-valued form, so a page computing several reports values once. */
export function feeDragOf(set: ValuationSet, options: ValuationOptions): FeeDragReport {
  const rows: FeeRow[] = [];
  const missing: string[] = [];
  let drag = Money.zero(set.currency);
  let covered = Money.zero(set.currency);

  for (const entry of set.valued) {
    const supplied = entry.holding.expenseRatio;
    if (supplied === null) {
      missing.push(entry.holding.holdingId);
      continue;
    }
    const expenseRatio = ratio(supplied);
    const annualCost = scaleMoney(entry.marketValue, expenseRatio);
    drag = Money.add(drag, annualCost);
    covered = Money.add(covered, entry.marketValue);
    rows.push({
      holdingId: entry.holding.holdingId,
      securityId: entry.holding.securityId,
      symbol: entry.holding.symbol,
      value: entry.marketValue,
      expenseRatio,
      annualCost,
      high: Quantity.compare(Quantity.of(expenseRatio), Quantity.of(HIGH_EXPENSE_RATIO)) > 0,
    });
  }

  rows.sort((a, b) => {
    const byCost = Money.compare(b.annualCost, a.annualCost);
    return byCost !== 0 ? byCost : a.holdingId < b.holdingId ? -1 : 1;
  });

  return {
    currency: set.currency,
    annualFeeDrag: drag,
    weightedExpenseRatio: Money.isZero(covered) ? RATIO_ZERO : ratioOfMoney(drag, covered),
    rows,
    total: set.total,
    coveredValue: covered,
    coveragePct: Money.isZero(set.total) ? RATIO_ZERO : ratioOfMoney(covered, set.total),
    holdingsMissingExpenseRatio: missing,
    isLowerBound: missing.length > 0,
    unclassifiedPct: allocationOf('asset_class', set, options).unclassifiedPct,
    excluded: set.excluded,
  };
}
