// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type {
  CashFlow,
  CashFlowBreakdownRow,
  CashFlowComparison,
} from '../../api/generated/types.gen.ts';
import { comparisonOf, foldTail, initialsOf, savingsRateOf, signedFigureMinor } from './figures.ts';

function summary(overrides: Partial<CashFlow['summary']> = {}): CashFlow['summary'] {
  return {
    from: '2026-01-01',
    to: '2026-01-31',
    hasData: true,
    incomeMinor: '200000',
    expensesMinor: '150000',
    netMinor: '50000',
    transactionCount: 12,
    savingsRate: 0.25,
    savingsRateWithheld: null,
    ...overrides,
  };
}

function comparison(overrides: Partial<CashFlowComparison> = {}): CashFlowComparison {
  return {
    kind: 'previous',
    periods: ['2025-12'],
    available: true,
    withheld: null,
    periodsAveraged: 1,
    throughOffsetDays: null,
    incomeMinor: '200000',
    expensesMinor: '170000',
    netMinor: '30000',
    ...overrides,
  };
}

const data = (s = summary(), isCurrent = false) => ({
  summary: s,
  currency: 'USD',
  isCurrent,
  period: '2026-01',
});

describe('the strip', () => {
  it('signs each figure by the house rule: income in, expenses out, net either way', () => {
    const s = summary({ netMinor: '-2500', incomeMinor: '1000', expensesMinor: '3500' });
    expect(signedFigureMinor(s, 'income')).toBe(1000n);
    expect(signedFigureMinor(s, 'expenses')).toBe(-3500n);
    expect(signedFigureMinor(s, 'net')).toBe(-2500n);
  });

  it('shows the savings rate for a complete period with income', () => {
    expect(savingsRateOf(summary(), 'month')).toEqual({ kind: 'shown', rate: 0.25, text: '25%' });
    expect(savingsRateOf(summary({ savingsRate: -0.125 }), 'month')).toMatchObject({
      text: '-12.5%',
    });
  });

  it('withholds the savings rate at zero income, with the reason — even if a rate were sent', () => {
    expect(
      savingsRateOf(
        summary({ incomeMinor: '0', savingsRate: null, savingsRateWithheld: 'no_income' }),
        'month',
      ),
    ).toEqual({
      kind: 'withheld',
      reason: 'No income this month, so there is no rate to work out.',
    });
    // A malformed body (a rate beside zero income) never divides by zero on screen.
    expect(savingsRateOf(summary({ incomeMinor: '0', savingsRate: 0.5 }), 'quarter')).toEqual({
      kind: 'withheld',
      reason: 'No income this quarter, so there is no rate to work out.',
    });
    expect(
      savingsRateOf(summary({ savingsRate: null, savingsRateWithheld: 'incomplete' }), 'year'),
    ).toMatchObject({
      kind: 'withheld',
      reason: expect.stringContaining('once the year is over'),
    });
  });
});

describe('comparison wording', () => {
  it('says the difference in money with a direction word and both amounts, never a bare percentage', () => {
    const result = comparisonOf(data(), comparison(), ['income', 'expenses', 'net'], 'month');
    expect(result.kind).toBe('shown');
    if (result.kind !== 'shown') return;
    const [income, expenses, net] = result.lines;
    expect(income?.text).toBe('Income: the same as last month ($2,000.00).');
    expect(income?.tone).toBe('neutral');
    expect(expenses?.text).toBe(
      'Expenses: $200.00 less than last month ($1,500.00 against $1,700.00).',
    );
    expect(expenses?.tone).toBe('good');
    expect(net?.text).toBe(
      'Net cash flow: $200.00 higher than last month ($500.00 against $300.00).',
    );
    expect(net?.tone).toBe('good');
    for (const line of result.lines) expect(line.text).not.toMatch(/%/);
  });

  it('spending more is the bad direction; the current period reads "at this point"', () => {
    const result = comparisonOf(
      data(summary({ expensesMinor: '180000' }), true),
      comparison({ throughOffsetDays: 16 }),
      ['expenses'],
      'month',
    );
    if (result.kind !== 'shown') throw new Error('withheld');
    expect(result.lines[0]?.text).toBe(
      'Expenses: $100.00 more than last month at this point ($1,800.00 against $1,700.00).',
    );
    expect(result.lines[0]?.tone).toBe('bad');
  });

  it('names the counterpart of each framing, and says how many periods an average is over', () => {
    const yearAgo = comparisonOf(
      data(),
      comparison({ kind: 'year_ago', periods: ['2025-01'] }),
      ['income'],
      'month',
    );
    expect(yearAgo.kind === 'shown' && yearAgo.counterpart).toBe('January 2025');
    const full = comparisonOf(
      data(),
      comparison({ kind: 'average', periodsAveraged: 12 }),
      ['income'],
      'month',
    );
    expect(full.kind === 'shown' && full.counterpart).toBe('your 12-month average');
    const short = comparisonOf(
      data(),
      comparison({ kind: 'average', periodsAveraged: 3 }),
      ['income'],
      'quarter',
    );
    expect(short.kind === 'shown' && short.counterpart).toBe(
      'your average over the 3 quarters with transactions',
    );
  });

  it('a comparison with no counterpart is withheld, saying what is missing', () => {
    expect(
      comparisonOf(
        data(),
        comparison({
          available: false,
          withheld: 'no_data',
          periods: ['2025-12'],
          incomeMinor: null,
        }),
        ['income'],
        'month',
      ),
    ).toEqual({ kind: 'withheld', reason: 'No comparison: December 2025 has no transactions.' });
    expect(
      comparisonOf(
        data(),
        comparison({ kind: 'average', available: false, withheld: 'no_history', periods: [] }),
        ['income'],
        'month',
      ),
    ).toEqual({
      kind: 'withheld',
      reason: 'No average yet: none of the 12 months before January 2026 has transactions.',
    });
  });
});

function row(i: number, sum: number, total: number): CashFlowBreakdownRow {
  return {
    key: `cat_${String(i)}`,
    label: `Category ${String(i)}`,
    hue: 'teal',
    sumMinor: String(sum),
    share: sum / total,
    count: i + 1,
    drillThrough: { categoryIds: [`cat_${String(i)}`], from: '2026-01-01', to: '2026-01-31' },
  };
}

describe('tail folding', () => {
  it('keeps twelve rows and folds the rest into "Other" without losing a cent, a share or a count', () => {
    const sums = [
      5000, 4000, 3000, 2500, 2000, 1500, 1200, 1000, 900, 800, 700, 600, 333, 222, 111, 1,
    ];
    const total = sums.reduce((a, b) => a + b, 0);
    const rows = sums.map((sum, i) => row(i, sum, total));
    const folded = foldTail(rows, 12, 'categories');
    expect(folded).toHaveLength(13);
    const other = folded.at(-1);
    expect(other).toMatchObject({
      key: 'other',
      label: 'Other (4 categories)',
      folded: 4,
      drillThrough: null,
    });
    expect(other?.sumMinor).toBe('667');
    expect(other?.count).toBe(13 + 14 + 15 + 16);
    expect(folded.reduce((sum, r) => sum + BigInt(r.sumMinor), 0n)).toBe(BigInt(total));
    expect(folded.reduce((sum, r) => sum + (r.share ?? 0), 0)).toBeCloseTo(1, 10);
  });

  it('leaves twelve or fewer rows as they are', () => {
    const rows = [row(0, 10, 30), row(1, 20, 30)];
    expect(foldTail(rows)).toEqual(rows);
    expect(foldTail([])).toEqual([]);
  });

  it('two-letter initials', () => {
    expect(initialsOf('Corner Grocery')).toBe('CG');
    expect(initialsOf('Rent')).toBe('RE');
    expect(initialsOf('7-Eleven')).toBe('7E');
    expect(initialsOf('Other (2 categories)')).toBe('OT');
    expect(initialsOf('!!')).toBe('?');
  });
});
