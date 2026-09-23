// SPDX-License-Identifier: MIT
/**
 * Fee drag over the committed fixture, and the rule that keeps it honest: a
 * holding with no expense ratio is **named**, not counted as free.
 *
 * The fixture's eleven positions include three with no expense ratio at all
 * (BTC, the cash sweep and the unclassified fund), which is 20% of the
 * portfolio by value. A "total annual fee" computed over the other 80% and
 * presented as a total would understate the real figure and read as complete.
 */
import { Money, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { FIXTURE_HOLDINGS } from '../../test/fixtures/portfolio.ts';
import { HIGH_EXPENSE_RATIO, feeDrag } from './fees.ts';
import { ratio, type ValuationOptions } from './types.ts';

const USD = currency('USD');
const LAST_KNOWN: ValuationOptions = { currency: USD, scale: 2, basis: 'last_known' };

describe('fee drag', () => {
  it('is Σ(value × expense_ratio), to the cent, over the fixture', () => {
    const report = feeDrag(FIXTURE_HOLDINGS, LAST_KNOWN);

    // Computed independently in the evidence note, row by row:
    //   VTI   40,892.61 × 0.0003 = 12.27      VXUS 19,055.38 × 0.0008 = 15.24
    //   BND   34,632.00 × 0.0003 = 10.39      VWO   5,521.02 × 0.0008 =  4.42
    //   VNQ    5,539.80 × 0.0012 =  6.65      VTI  12,791.39 × 0.0003 =  3.84
    //   AAPL and OLDCO charge 0.0000, which is a fee of 0.00 — not unknown.
    expect(Money.formatAmount(report.annualFeeDrag)).toBe('52.81');
    expect(Money.formatAmount(report.coveredValue)).toBe('141049.00');
    expect(report.weightedExpenseRatio).toBe('0.0003744089');
    expect(report.coveragePct).toBe('0.7991462870');
  });

  it('treats a missing expense ratio as unknown, never as zero', () => {
    const report = feeDrag(FIXTURE_HOLDINGS, LAST_KNOWN);

    expect(report.holdingsMissingExpenseRatio).toEqual(['h-06', 'h-07', 'h-09']);
    expect(report.isLowerBound).toBe(true);
    // The three unknowns are $35,450.60 of the portfolio — a fifth of it. The
    // drag above is a floor over the other four fifths, and `coveragePct`
    // says so rather than leaving the reader to assume otherwise.
    expect(Number(report.coveragePct)).toBeLessThan(0.8);
    expect(report.rows.map((row) => row.holdingId)).not.toContain('h-06');

    // A security that genuinely charges nothing is a *zero*, and it is in the
    // covered base — the distinction the null is protecting.
    const apple = report.rows.find((row) => row.holdingId === 'h-05');
    expect(apple?.expenseRatio).toBe(ratio('0'));
    expect(Money.formatAmount(apple?.annualCost ?? Money.zero(USD))).toBe('0.00');

    // With every ratio supplied, the report stops calling itself a floor.
    const complete = feeDrag(
      FIXTURE_HOLDINGS.map((holding) => ({
        ...holding,
        expenseRatio: holding.expenseRatio ?? '0',
      })),
      LAST_KNOWN,
    );
    expect(complete.isLowerBound).toBe(false);
    expect(complete.coveragePct).toBe(ratio('1'));
  });

  it('flags a position over 07 I2’s half-a-point trigger', () => {
    expect(HIGH_EXPENSE_RATIO).toBe(ratio('0.005'));
    const expensive = feeDrag(
      FIXTURE_HOLDINGS.map((holding) =>
        holding.holdingId === 'h-02' ? { ...holding, expenseRatio: '0.0075' } : holding,
      ),
      LAST_KNOWN,
    );
    expect(expensive.rows.filter((row) => row.high).map((row) => row.holdingId)).toEqual(['h-02']);
    // 19,055.38 × 0.75% = $142.92 a year out of one fund.
    expect(
      Money.formatAmount(
        expensive.rows.find((row) => row.holdingId === 'h-02')?.annualCost ?? Money.zero(USD),
      ),
    ).toBe('142.92');
    // Exactly 0.50% is not "over 0.50%".
    const onTheLine = feeDrag(
      FIXTURE_HOLDINGS.map((holding) =>
        holding.holdingId === 'h-02' ? { ...holding, expenseRatio: '0.005' } : holding,
      ),
      LAST_KNOWN,
    );
    expect(onTheLine.rows.some((row) => row.high)).toBe(false);
  });

  it('reports unclassifiedPct beside the fee number', () => {
    expect(feeDrag(FIXTURE_HOLDINGS, LAST_KNOWN).unclassifiedPct).toBe('0.0174504645');
  });
});
