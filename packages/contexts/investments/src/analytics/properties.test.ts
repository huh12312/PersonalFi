// SPDX-License-Identifier: MIT
/**
 * The three properties that hold for *every* portfolio, not just the ones
 * somebody thought to write down.
 *
 * Example tests pin the cases a person imagined; a property test looks for the
 * portfolio nobody imagined — the one with a single holding, or ten identical
 * ones, or a sleeve worth one cent. Each property here corresponds to a claim
 * made elsewhere in prose:
 *
 *   * a TWR with no external flows is *just* the simple return, which is the
 *     sanity check on the whole sub-period machinery;
 *   * the allocation weights account for the entire portfolio, with the
 *     unclassified share visible rather than missing;
 *   * the Herfindahl index stays inside `[1/n, 1]`, its mathematical bounds,
 *     which is what makes `1/HHI` readable as "behaves like N positions".
 */
import { Money, Quantity, currency } from '@core/kernel';
import { DateOnly } from '@core/kernel';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AssetClass } from '../../schema/index.ts';
import { allocationByAssetClass, totalWeightOf } from './allocation.ts';
import { concentration } from './concentration.ts';
import { timeWeightedReturn } from './twr.ts';
import { ratio, type AnalyticsHolding, type ValuationOptions } from './types.ts';

const USD = currency('USD');
const OPTIONS: ValuationOptions = { currency: USD, scale: 2, basis: 'last_known' };

/**
 * One ulp of the ratio scale per slice.
 *
 * Every weight is rounded to ten places independently, so a sum over `k`
 * slices can be up to `k × 5e-11` away from 1. Stating the bound is the point:
 * an unstated "approximately 1" is where a real error hides.
 */
const tolerance = (slices: number): number => slices * 1e-10;

const CLASSES: readonly AssetClass[] = [
  'US_EQUITY',
  'INTL_DEV_EQUITY',
  'US_BOND',
  'CRYPTO',
  'CASH',
  'UNCLASSIFIED',
];

const holdingArbitrary = fc.record({
  index: fc.nat({ max: 999 }),
  assetClass: fc.constantFrom(...CLASSES),
  securityIndex: fc.nat({ max: 5 }),
  cents: fc.integer({ min: 1, max: 50_000_000 }),
});

function holdingOf(spec: {
  index: number;
  assetClass: AssetClass;
  securityIndex: number;
  cents: number;
}): AnalyticsHolding {
  // Quantity 1 at a price of `cents/100` keeps the generated value exact, so
  // the property is about the weights rather than about a rounding.
  const price = `${Math.floor(spec.cents / 100)}.${String(spec.cents % 100).padStart(2, '0')}`;
  return {
    holdingId: `h-${spec.index}`,
    accountId: `acct-${spec.securityIndex % 2}`,
    securityId: `sec-${spec.securityIndex}`,
    symbol: `S${spec.securityIndex}`,
    quantity: Quantity.of('1'),
    price: { amount: Quantity.of(price), currency: USD },
    staleness: 'FRESH',
    assetClass: spec.assetClass,
    region: 'US',
    sector: 'Diversified',
    expenseRatio: '0.0003',
    isCashEquivalent: spec.assetClass === 'CASH',
    isInvestable: true,
    costBasis: Money.of(BigInt(spec.cents), USD),
  };
}

const portfolioArbitrary = fc
  .array(holdingArbitrary, { minLength: 1, maxLength: 12 })
  .map((specs) => specs.map((spec, index) => holdingOf({ ...spec, index })));

describe('analytics properties', () => {
  it('TWR of zero flows equals simple return', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 1, max: 100_000_000 }),
        fc.integer({ min: 1, max: 3650 }),
        (beginCents, endCents, days) => {
          const from = DateOnly.parse('2020-01-01');
          const result = timeWeightedReturn({
            valuations: [
              { date: from, value: Money.of(BigInt(beginCents), USD) },
              { date: DateOnly.addDays(from, days), value: Money.of(BigInt(endCents), USD) },
            ],
            flows: [],
          });
          const simple = ratio(
            Quantity.subtract(
              Quantity.divide(Quantity.of(String(endCents)), String(beginCents)),
              Quantity.of('1'),
            ),
          );
          expect(result.periodReturn).toBe(simple);
          // And the never-annualise rule holds across the whole range.
          expect(result.annualized === null).toBe(days < 365);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('allocation sums to 100% ± unclassified', () => {
    fc.assert(
      fc.property(portfolioArbitrary, (holdings) => {
        const report = allocationByAssetClass(holdings, OPTIONS);
        const limit = tolerance(report.slices.length);

        // Every slice, including the unclassified one, accounts for the whole.
        expect(Math.abs(Number(totalWeightOf(report)) - 1)).toBeLessThanOrEqual(limit);

        // And the classified share is exactly the remainder: the unclassified
        // number is visible rather than folded into "other".
        const classified = report.slices
          .filter((slice) => slice.key !== 'UNCLASSIFIED')
          .reduce((total, slice) => total + Number(slice.weight), 0);
        expect(Math.abs(classified - (1 - Number(report.unclassifiedPct)))).toBeLessThanOrEqual(
          limit,
        );

        // `unclassifiedPct` is always present, and is zero exactly when no
        // holding is unclassified.
        expect(report).toHaveProperty('unclassifiedPct');
        expect(Number(report.unclassifiedPct) === 0).toBe(
          !holdings.some((holding) => holding.assetClass === 'UNCLASSIFIED'),
        );
      }),
      { numRuns: 200 },
    );
  });

  it('Herfindahl in [1/n, 1]', () => {
    fc.assert(
      fc.property(portfolioArbitrary, (holdings) => {
        const report = concentration(holdings, OPTIONS);
        const n = report.positionCount;
        const hhi = Number(report.herfindahl);
        const limit = tolerance(n);

        expect(hhi).toBeGreaterThanOrEqual(1 / n - limit);
        expect(hhi).toBeLessThanOrEqual(1 + limit);
        // The top holding can never be a smaller share than an equal split.
        expect(Number(report.topHoldingPct)).toBeGreaterThanOrEqual(1 / n - limit);
        // 1/HHI is between one position and n of them.
        expect(Number(report.effectivePositions)).toBeGreaterThanOrEqual(1 - limit);
        expect(Number(report.effectivePositions)).toBeLessThanOrEqual(n + limit);
      }),
      { numRuns: 200 },
    );
  });

  it('a single holding is 100% of the portfolio and a Herfindahl of 1', () => {
    fc.assert(
      fc.property(holdingArbitrary, (spec) => {
        const holdings = [holdingOf({ ...spec, index: 0 })];
        expect(allocationByAssetClass(holdings, OPTIONS).slices[0]?.weight).toBe(ratio('1'));
        expect(concentration(holdings, OPTIONS).herfindahl).toBe(ratio('1'));
      }),
      { numRuns: 100 },
    );
  });
});
