// SPDX-License-Identifier: MIT
/**
 * Concentration: the top holding's share, and the Herfindahl index.
 *
 * 07's I4 fires when *"any single security > 20% of investable assets"*, and
 * the denominator in that sentence is doing real work. 07 §4.1 keeps four
 * independent booleans — `on_budget`, `in_net_worth`, `is_liquid`,
 * `is_investable` — and names `is_investable` as *"for concentration
 * denominators"*. A 401(k) you cannot trade and a house are both net worth and
 * neither is an alternative to the RSUs; measuring concentration against total
 * net worth would say a $200,000 single-stock position in a $2M portfolio is
 * "10%, fine" when the investable base is $400,000 and it is 50%.
 *
 * ## Aggregated by security, not by holding
 *
 * The same ETF in three accounts is one exposure. Concentration measured per
 * holding row would report three 8% positions instead of one 24% position and
 * would miss exactly the case I4 exists for. So positions are summed by
 * `securityId` first — the same "aggregated by ticker across accounts" rule
 * WP 3.9's `GET /holdings` follows.
 *
 * ## Herfindahl, and what it is for
 *
 * `HHI = Σ wᵢ²` over security weights. It is bounded by `1/n` (n equal
 * positions) and `1` (everything in one), and `1/HHI` reads as "this portfolio
 * behaves like N equally sized positions" — which is a far more honest summary
 * than a holdings count, because forty positions where one is 60% is not a
 * diversified portfolio. `src/analytics/properties.test.ts` →
 * `'Herfindahl in [1/n, 1]'` holds it to those bounds over generated
 * portfolios.
 *
 * Both numbers are ratios (decimal strings), never floats, and both come back
 * beside `unclassifiedPct` — a concentration number computed over a portfolio
 * that is 30% unclassified is as much noise as a drift number is.
 */
import { Money, Quantity, type CurrencyCode, type Money as MoneyType } from '@core/kernel';
import { allocationOf, valueHoldings, type ValuationSet } from './allocation.ts';
import {
  RATIO_ZERO,
  ratio,
  ratioOfMoney,
  type AnalyticsHolding,
  type ExcludedHolding,
  type Ratio,
  type ValuationOptions,
} from './types.ts';

/** 07 I4: a single security above 20% of investable assets. */
export const CONCENTRATION_TRIGGER: Ratio = ratio('0.20');

/** 07 I5: employer stock above 10% — the same measurement, a lower bar. */
export const EMPLOYER_STOCK_TRIGGER: Ratio = ratio('0.10');

export interface SecurityPosition {
  readonly securityId: string;
  readonly symbol: string | null;
  readonly value: MoneyType;
  readonly weight: Ratio;
  /** How many account-level holdings were summed into this position. */
  readonly holdingCount: number;
}

export interface ConcentrationReport {
  readonly currency: CurrencyCode;
  /** 07 §4.1's `is_investable` base, not net worth and not total holdings. */
  readonly investableTotal: MoneyType;
  readonly positions: readonly SecurityPosition[];
  /** `null` only for an empty portfolio. */
  readonly topHolding: SecurityPosition | null;
  readonly topHoldingPct: Ratio;
  /** `Σ wᵢ²`, over securities. In `[1/n, 1]`. */
  readonly herfindahl: Ratio;
  /** `1/HHI` — "behaves like N equal positions". Zero for an empty portfolio. */
  readonly effectivePositions: Ratio;
  readonly positionCount: number;
  /** `topHoldingPct > 20%` — I4's trigger, evaluated once. */
  readonly aboveTrigger: boolean;
  readonly unclassifiedPct: Ratio;
  readonly excluded: readonly ExcludedHolding[];
}

export function concentration(
  holdings: readonly AnalyticsHolding[],
  options: ValuationOptions,
): ConcentrationReport {
  return concentrationOf(valueHoldings(holdings, options), options);
}

/**
 * Concentration over an already-valued set.
 *
 * Non-investable holdings are filtered *after* valuation rather than before,
 * so `excluded` still reports a stale or unpriced holding the caller needs to
 * know about even when it would not have counted anyway.
 */
export function concentrationOf(set: ValuationSet, options: ValuationOptions): ConcentrationReport {
  const investable = set.valued.filter((entry) => entry.holding.isInvestable);
  const total = investable.reduce(
    (running, entry) => Money.add(running, entry.marketValue),
    Money.zero(set.currency),
  );

  const bySecurity = new Map<
    string,
    { symbol: string | null; value: MoneyType; holdingCount: number }
  >();
  for (const entry of investable) {
    const existing = bySecurity.get(entry.holding.securityId);
    bySecurity.set(entry.holding.securityId, {
      symbol: existing?.symbol ?? entry.holding.symbol,
      value: Money.add(existing?.value ?? Money.zero(set.currency), entry.marketValue),
      holdingCount: (existing?.holdingCount ?? 0) + 1,
    });
  }

  const empty = Money.isZero(total);
  const positions: SecurityPosition[] = [...bySecurity]
    .map(([securityId, position]) => ({
      securityId,
      symbol: position.symbol,
      value: position.value,
      weight: empty ? RATIO_ZERO : ratioOfMoney(position.value, total),
      holdingCount: position.holdingCount,
    }))
    .sort((a, b) => {
      const byValue = Money.compare(b.value, a.value);
      return byValue !== 0 ? byValue : a.securityId < b.securityId ? -1 : 1;
    });

  let herfindahl = Quantity.zero;
  for (const position of positions) {
    const weight = Quantity.of(position.weight);
    herfindahl = Quantity.add(herfindahl, Quantity.multiply(weight, weight));
  }
  const hhi = ratio(herfindahl);
  const top = positions[0] ?? null;

  return {
    currency: set.currency,
    investableTotal: total,
    positions,
    topHolding: top,
    topHoldingPct: top?.weight ?? RATIO_ZERO,
    herfindahl: hhi,
    effectivePositions: Quantity.isZero(Quantity.of(hhi))
      ? RATIO_ZERO
      : ratio(Quantity.divide(Quantity.of('1'), Quantity.of(hhi))),
    positionCount: positions.length,
    aboveTrigger:
      Quantity.compare(Quantity.of(top?.weight ?? RATIO_ZERO), Quantity.of(CONCENTRATION_TRIGGER)) >
      0,
    unclassifiedPct: allocationOf('asset_class', set, options).unclassifiedPct,
    excluded: set.excluded,
  };
}
