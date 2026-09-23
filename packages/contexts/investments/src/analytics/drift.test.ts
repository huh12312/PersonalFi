// SPDX-License-Identifier: MIT
/**
 * The 5-point band, tested on both sides of itself.
 *
 * A $100,000 portfolio at 60% equity / 40% bonds, measured against three
 * target sets that differ by a tenth of a point:
 *
 * | Target | Gap | Proposes |
 * |---|---|---|
 * | 55.1 / 44.9 | 4.9pp | nothing |
 * | 55.0 / 45.0 | 5.0pp | nothing (the band is `> 5`, not `≥ 5`) |
 * | 54.9 / 45.1 | 5.1pp | a $5,100 trade |
 *
 * If the comparison were written against a ratio (`0.05`) instead of points,
 * or with `>=` instead of `>`, exactly one of these three rows would change —
 * which is why all three are here.
 */
import { Money, Quantity, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import type { AssetClass } from '../../schema/index.ts';
import { DRIFT_BAND_POINTS, driftAgainstTargets, type AllocationTarget } from './drift.ts';
import {
  AnalyticsInputError,
  points,
  ratio,
  type AnalyticsHolding,
  type ValuationOptions,
} from './types.ts';

const USD = currency('USD');
const OPTIONS: ValuationOptions = { currency: USD, scale: 2, basis: 'as_of_now' };

function holding(
  id: string,
  assetClass: AssetClass,
  quantity: string,
  price: string,
): AnalyticsHolding {
  return {
    holdingId: id,
    accountId: 'acct-taxable',
    securityId: `sec-${id}`,
    symbol: id.toUpperCase(),
    quantity: Quantity.of(quantity),
    price: { amount: Quantity.of(price), currency: USD },
    staleness: 'FRESH',
    assetClass,
    region: 'US',
    sector: 'Diversified',
    expenseRatio: '0.0003',
    isCashEquivalent: false,
    isInvestable: true,
    costBasis: Money.parseAmount('1000.00', USD),
  };
}

/** $60,000 of equity and $40,000 of bonds. */
const PORTFOLIO: readonly AnalyticsHolding[] = [
  holding('eq', 'US_EQUITY', '1000', '60.00'),
  holding('bd', 'US_BOND', '1000', '40.00'),
];

const targets = (equity: string, bond: string): readonly AllocationTarget[] => [
  { assetClass: 'US_EQUITY', targetWeight: ratio(equity) },
  { assetClass: 'US_BOND', targetWeight: ratio(bond) },
];

describe('drift', () => {
  it('a 4.9-point gap proposes nothing and a 5.1-point gap proposes a trade', () => {
    const inside = driftAgainstTargets(PORTFOLIO, targets('0.551', '0.449'), OPTIONS);
    // Rows are ordered by absolute gap, descending; equal gaps break by class
    // name, so the bond row precedes the equity row here.
    expect(inside.rows.map((row) => row.gapPoints)).toEqual([points('-4.9'), points('4.9')]);
    expect(inside.rows.every((row) => row.insideBand)).toBe(true);
    expect(inside.proposals).toEqual([]);

    const outside = driftAgainstTargets(PORTFOLIO, targets('0.549', '0.451'), OPTIONS);
    expect(outside.rows.map((row) => row.gapPoints)).toEqual([points('-5.1'), points('5.1')]);
    expect(outside.rows.every((row) => row.insideBand)).toBe(false);
    expect(outside.proposals).toHaveLength(2);
    expect(outside.proposals[0]).toEqual({
      assetClass: 'US_BOND',
      gapPoints: points('-5.1'),
      direction: 'increase',
      amount: Money.parseAmount('5100.00', USD),
    });
    expect(outside.proposals[1]).toEqual({
      assetClass: 'US_EQUITY',
      gapPoints: points('5.1'),
      direction: 'reduce',
      amount: Money.parseAmount('5100.00', USD),
    });

    // The boundary itself: `> 5pp`, so exactly five points proposes nothing.
    const onTheLine = driftAgainstTargets(PORTFOLIO, targets('0.55', '0.45'), OPTIONS);
    expect(onTheLine.rows.map((row) => row.gapPoints)).toEqual([points('-5'), points('5')]);
    expect(onTheLine.proposals).toEqual([]);
    expect(onTheLine.bandPoints).toBe(DRIFT_BAND_POINTS);

    // Nothing was withheld here: every holding was valued, so the 5.1-point
    // proposal above is a real proposal and not an accident of a gap in data.
    expect(outside.proposalsWithheld).toBeNull();
  });

  it('measures drift against the full portfolio, cash included', () => {
    const withCash: readonly AnalyticsHolding[] = [
      ...PORTFOLIO,
      { ...holding('cash', 'CASH', '10000', '1.00'), isCashEquivalent: true },
    ];
    const report = driftAgainstTargets(
      withCash,
      [
        { assetClass: 'US_EQUITY', targetWeight: ratio('0.55') },
        { assetClass: 'US_BOND', targetWeight: ratio('0.36') },
        { assetClass: 'CASH', targetWeight: ratio('0.09') },
      ],
      OPTIONS,
    );
    expect(Money.formatAmount(report.total)).toBe('110000.00');
    // 60,000/110,000 = 54.5454…%, which is *inside* the band against a 55%
    // target. Drop cash from the denominator and it reads 60% — a 5-point
    // gap and a trade proposed for an artefact.
    expect(report.rows.find((row) => row.assetClass === 'US_EQUITY')?.insideBand).toBe(true);
    expect(report.proposals).toEqual([]);
  });

  it('reports unclassifiedPct beside the drift and flags it as noise past 10 points', () => {
    const quiet = driftAgainstTargets(PORTFOLIO, targets('0.55', '0.45'), OPTIONS);
    expect(quiet.unclassifiedPct).toBe(ratio('0'));
    expect(quiet.noisy).toBe(false);

    const noisy = driftAgainstTargets(
      [...PORTFOLIO, holding('mystery', 'UNCLASSIFIED', '1000', '20.00')],
      targets('0.55', '0.45'),
      OPTIONS,
    );
    // 20,000/120,000 = 16.7% unclassified: 07 §4.3 says a drift claim over this
    // portfolio is noise, and I1 must suppress itself.
    expect(Number(noisy.unclassifiedPct)).toBeCloseTo(0.1667, 4);
    expect(noisy.noisy).toBe(true);
    // The module still answers; it is the *rule* that withholds. It does not
    // pretend the position is not there, which would be the other failure.
    expect(noisy.rows.some((row) => row.assetClass === 'UNCLASSIFIED')).toBe(true);
  });

  it('reports a class held but never planned for, rather than hiding it', () => {
    const report = driftAgainstTargets(
      [...PORTFOLIO, holding('btc', 'CRYPTO', '1', '30000.00')],
      targets('0.55', '0.45'),
      OPTIONS,
    );
    const crypto = report.rows.find((row) => row.assetClass === 'CRYPTO');
    expect(crypto?.targetWeight).toBe(ratio('0'));
    expect(Number(crypto?.gapPoints)).toBeCloseTo(23.08, 2);
    expect(crypto?.proposal?.direction).toBe('reduce');
  });

  it('refuses a target set that does not sum to 100%', () => {
    expect(() => driftAgainstTargets(PORTFOLIO, targets('0.55', '0.35'), OPTIONS)).toThrow(
      AnalyticsInputError,
    );
    expect(() => driftAgainstTargets(PORTFOLIO, [], OPTIONS)).toThrow(AnalyticsInputError);
  });

  it('excludes a STALE holding from the drift it would otherwise cause', () => {
    const stale: readonly AnalyticsHolding[] = [
      PORTFOLIO[0] as AnalyticsHolding,
      { ...(PORTFOLIO[1] as AnalyticsHolding), staleness: 'STALE' },
    ];
    const report = driftAgainstTargets(stale, targets('0.55', '0.45'), OPTIONS);
    expect(report.excluded.map((entry) => entry.reason)).toEqual(['stale_price']);
    expect(report.excluded[0]?.holdingId).toBe('bd');

    // The bond sleeve now reads 0% because its only fund could not be valued —
    // a 45-point "gap" that is an artefact of a missing price. The gap is
    // still shown, because hiding it would hide the stale price too, but no
    // trade is proposed against it.
    expect(report.rows.find((row) => row.assetClass === 'US_BOND')?.actualWeight).toBe(ratio('0'));
    expect(report.rows.every((row) => row.insideBand)).toBe(false);
    expect(report.proposalsWithheld).toBe('incomplete_valuation');
    expect(report.proposals).toEqual([]);
  });
});
