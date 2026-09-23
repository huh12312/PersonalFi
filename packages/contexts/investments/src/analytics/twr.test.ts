// SPDX-License-Identifier: MIT
/**
 * The two questions 07 §4.2 insists are different questions, asked of the same
 * portfolio.
 *
 * The worked portfolio both tests use, and the one the evidence note walks:
 *
 * | Date | Event | Value |
 * |---|---|---|
 * | 2025-01-01 | opening | $100,000 |
 * | 2025-07-01 | +20% half-year, then a $100,000 deposit | $220,000 |
 * | 2026-01-01 | −10% half-year | $198,000 |
 *
 * TWR is `1.20 × 0.90 − 1 = +8%`: the investments did well in the first half
 * and badly in the second, and the deposit is invisible to it. MWR is about
 * **−1.3%**: $200,000 went in and $198,000 is there, because the big deposit
 * landed immediately before the bad half. Both are correct. Neither answers
 * the other's question, which is why they live in different shapes.
 */
import { DateOnly, Money, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { moneyWeightedReturn } from './mwr.ts';
import { modifiedDietzReturn, timeWeightedReturn, type ExternalFlow } from './twr.ts';
import { AnalyticsInputError, comparePoints, points, pointsBetween, ratio } from './types.ts';

const USD = currency('USD');
const usd = (dollars: string) => Money.parseAmount(dollars, USD);
const on = (date: string) => DateOnly.parse(date);

const OPENING = { date: on('2025-01-01'), value: usd('100000.00') };

/** The portfolio above, with the deposit. */
const WITH_DEPOSIT = {
  valuations: [
    OPENING,
    { date: on('2025-07-01'), value: usd('220000.00') },
    { date: on('2026-01-01'), value: usd('198000.00') },
  ],
  flows: [{ date: on('2025-07-01'), amount: usd('100000.00') }] satisfies ExternalFlow[],
};

/** The same sub-period returns, no deposit: 100,000 → 120,000 → 108,000. */
const WITHOUT_DEPOSIT = {
  valuations: [
    OPENING,
    { date: on('2025-07-01'), value: usd('120000.00') },
    { date: on('2026-01-01'), value: usd('108000.00') },
  ],
  flows: [],
};

describe('time-weighted return', () => {
  it('a mid-period deposit does not change TWR', () => {
    const withDeposit = timeWeightedReturn(WITH_DEPOSIT);
    const withoutDeposit = timeWeightedReturn(WITHOUT_DEPOSIT);

    expect(withDeposit.periodReturn).toBe(ratio('0.08'));
    expect(withDeposit.periodReturn).toBe(withoutDeposit.periodReturn);

    // The linking is what makes it true, so assert the links, not only the product.
    expect(withDeposit.subPeriods.map((period) => period.returnRatio)).toEqual([
      ratio('0.20'),
      ratio('-0.10'),
    ]);
    expect(withDeposit.subPeriods[0]?.flow).toEqual(usd('100000.00'));
    expect(withDeposit.method).toBe('sub_period_linking');
    expect(withDeposit.approximate).toBe(false);

    // A deposit four times the portfolio's size is still invisible to TWR.
    const hugeDeposit = timeWeightedReturn({
      valuations: [
        OPENING,
        { date: on('2025-07-01'), value: usd('520000.00') },
        { date: on('2026-01-01'), value: usd('468000.00') },
      ],
      flows: [{ date: on('2025-07-01'), amount: usd('400000.00') }],
    });
    expect(hugeDeposit.periodReturn).toBe(ratio('0.08'));
  });

  it('the same flows give a materially different MWR', () => {
    const twr = timeWeightedReturn(WITH_DEPOSIT);
    const mwr = moneyWeightedReturn({
      openingValue: OPENING,
      flows: WITH_DEPOSIT.flows,
      closingValue: { date: on('2026-01-01'), value: usd('198000.00') },
    });

    expect(twr.periodReturn).toBe(ratio('0.08'));
    if (mwr.status !== 'available') throw new Error(`expected a rate, got ${mwr.reason}`);

    // The investor lost money on a portfolio whose investments gained 8%.
    expect(mwr.periodReturn.startsWith('-')).toBe(true);
    expect(Number(mwr.periodReturn)).toBeCloseTo(-0.0133, 3);

    // "Materially different" made an assertion rather than an adjective:
    // more than nine percentage points apart.
    const gap = pointsBetween(twr.periodReturn, mwr.periodReturn);
    expect(comparePoints(gap, points('9'))).toBe(1);

    // And the shapes cannot be confused for one another at the call site.
    expect(twr.benchmarkComparable).toBe(true);
    expect(mwr.benchmarkComparable).toBe(false);
  });

  it('a period of exactly one year annualises and a shorter one does not', () => {
    const year = timeWeightedReturn(WITH_DEPOSIT);
    expect(year.spanDays).toBe(365);
    expect(year.annualized).toBe(ratio('0.08'));
    expect(year.annualizationWithheld).toBeNull();

    const nineMonths = timeWeightedReturn({
      valuations: [OPENING, { date: on('2025-10-02'), value: usd('108000.00') }],
      flows: [],
    });
    expect(nineMonths.spanDays).toBe(274);
    expect(nineMonths.annualized).toBeNull();
    expect(nineMonths.annualizationWithheld).toBe('period_under_one_year');
  });

  it('a multi-year return annualises by compounding, not by division', () => {
    const twoYears = timeWeightedReturn({
      valuations: [
        { date: on('2024-01-01'), value: usd('100000.00') },
        { date: on('2026-01-01'), value: usd('121000.00') },
      ],
      flows: [],
    });
    expect(twoYears.periodReturn).toBe(ratio('0.21'));
    // 1.21 over 731 days: the compounded rate, not 21%/2 = 10.5%.
    expect(Number(twoYears.annualized)).toBeCloseTo(0.09985, 4);
  });

  it('Modified Dietz answers when a flow date has no valuation, and says it is approximate', () => {
    const result = timeWeightedReturn({
      // A CSV-imported account: month-end statements, a deposit on the 12th.
      valuations: [OPENING, { date: on('2026-01-01'), value: usd('198000.00') }],
      flows: [{ date: on('2025-07-01'), amount: usd('100000.00') }],
    });

    expect(result.method).toBe('modified_dietz');
    expect(result.approximate).toBe(true);
    expect(result.warnings.map((warning) => warning.code)).toContain('valuation_dates_missing');
    // (198,000 − 100,000 − 100,000) / (100,000 + 0.5041×100,000) = −1.33%
    expect(Number(result.periodReturn)).toBeCloseTo(-0.0133, 3);

    // And a caller that would rather fail than approximate can say so.
    expect(() =>
      timeWeightedReturn(
        {
          valuations: [OPENING, { date: on('2026-01-01'), value: usd('198000.00') }],
          flows: [{ date: on('2025-07-01'), amount: usd('100000.00') }],
        },
        { allowApproximateFallback: false },
      ),
    ).toThrow(AnalyticsInputError);
  });

  it('is always flagged approximate when Modified Dietz is asked for directly', () => {
    const result = modifiedDietzReturn({
      valuations: [OPENING, { date: on('2026-01-01'), value: usd('108000.00') }],
      flows: [],
    });
    expect(result.approximate).toBe(true);
    expect(result.periodReturn).toBe(ratio('0.08'));
  });

  it('refuses a question it cannot answer instead of inventing a base', () => {
    expect(() => timeWeightedReturn({ valuations: [OPENING], flows: [] })).toThrow(
      AnalyticsInputError,
    );
    expect(() =>
      timeWeightedReturn({
        valuations: WITHOUT_DEPOSIT.valuations,
        flows: [{ date: on('2026-06-01'), amount: usd('100.00') }],
      }),
    ).toThrow(/outside/);
    expect(() =>
      timeWeightedReturn({
        valuations: [
          OPENING,
          { date: on('2026-01-01'), value: Money.parseAmount('108000.00', currency('EUR')) },
        ],
        flows: [],
      }),
    ).toThrow(/mix/);
  });

  it('links a zero-value sub-period as 0% rather than dividing by zero', () => {
    const result = timeWeightedReturn({
      valuations: [
        { date: on('2025-01-01'), value: usd('0.00') },
        { date: on('2025-06-01'), value: usd('10000.00') },
        { date: on('2026-01-01'), value: usd('11000.00') },
      ],
      flows: [{ date: on('2025-06-01'), amount: usd('10000.00') }],
    });
    expect(result.warnings.map((warning) => warning.code)).toContain('zero_base_subperiod');
    expect(result.periodReturn).toBe(ratio('0.10'));
  });
});
