// SPDX-License-Identifier: MIT
/**
 * The category detail's figures (WP 10.14), pure: the window, where history starts, and the average and comparison
 * over the months. The database-backed half (each month's amount equal to the Cash Flow hub's) is
 * `test/db/category-history-routes.test.ts`.
 */
import { DateOnly } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  HISTORY_MONTHS,
  historyFigures,
  historyStartOf,
  windowMonths,
  type CategoryHistoryMonth,
} from '../src/reports/category-history.ts';

const TODAY = DateOnly.parse('2026-10-18');
const WINDOW = windowMonths(TODAY);

/** The window's months with these amounts (oldest first; the last is the current month), all in history from `from`. */
function months(amounts: readonly bigint[], from: string | null): CategoryHistoryMonth[] {
  if (amounts.length !== HISTORY_MONTHS) throw new Error('thirteen amounts');
  return WINDOW.map((month, index) => {
    const isCurrent = index === HISTORY_MONTHS - 1;
    const amount = amounts[index] ?? 0n;
    return {
      ...month,
      amount,
      transactionCount: amount === 0n ? 0 : 1,
      hasActivity: amount !== 0n,
      complete: !isCurrent,
      isCurrent,
      inHistory: from !== null && month.month >= from,
    };
  });
}

describe('the window', () => {
  it('is the twelve complete months before the current one, then it, oldest first', () => {
    expect(WINDOW).toHaveLength(13);
    expect(WINDOW[0]).toEqual({ month: '2025-10', start: '2025-10-01', end: '2025-10-31' });
    expect(WINDOW[12]).toEqual({ month: '2026-10', start: '2026-10-01', end: '2026-10-31' });
    expect(WINDOW.map((m) => m.month)).toEqual([...WINDOW.map((m) => m.month)].sort());
    // February of a non-leap year ends on the 28th.
    expect(WINDOW.find((m) => m.month === '2026-02')?.end).toBe('2026-02-28');
  });

  it('crosses a year boundary from January', () => {
    const january = windowMonths(DateOnly.parse('2026-01-01'));
    expect(january[0]?.month).toBe('2025-01');
    expect(january[12]?.month).toBe('2026-01');
  });
});

describe('where history starts', () => {
  it('at the window start when the ledger reaches back before it', () => {
    expect(historyStartOf(WINDOW, true, DateOnly.parse('2026-03-04'))).toBe('2025-10');
    expect(historyStartOf(WINDOW, true, null)).toBe('2025-10');
  });

  it("at the earliest row's month inside the window otherwise, and nowhere with no rows", () => {
    expect(historyStartOf(WINDOW, false, DateOnly.parse('2026-03-04'))).toBe('2026-03');
    expect(historyStartOf(WINDOW, false, null)).toBeNull();
  });
});

describe('the average and the comparison', () => {
  // Complete months 2026-07, 2026-08, 2026-09 in history: 90.00, 0, 60.00. The current month: 1,000.00.
  const amounts = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 9000n, 0n, 6000n, 100000n];

  it('averages every complete month in history, a zero month counted, the current month never', () => {
    const { average, comparison } = historyFigures(months(amounts, '2026-07'), false);
    // (9000 + 0 + 6000) / 3 = 5000. Dropping the zero gives 7500; adding the current month gives 28750.
    expect(average).toEqual({
      available: true,
      withheld: null,
      amount: 5000n,
      monthsAveraged: 3,
      months: ['2026-07', '2026-08', '2026-09'],
    });
    expect(comparison).toEqual({
      available: true,
      withheld: null,
      thisMonth: 100000n,
      average: 5000n,
      difference: 95000n,
      direction: 'more',
    });
  });

  it('rounds half-even to a minor unit', () => {
    // In history from 2026-08, two complete months: (1 + 2) / 2 = 1.5 → 2 (the even neighbour); (5 + 0) / 2 = 2.5 → 2.
    const one = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 1n, 2n, 0n];
    expect(historyFigures(months(one, '2026-08'), false).average.amount).toBe(2n);
    const two = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 5n, 0n, 0n];
    expect(historyFigures(months(two, '2026-08'), false).average.amount).toBe(2n);
  });

  it('compares less and same', () => {
    const less = [...amounts.slice(0, 12), 1000n];
    expect(historyFigures(months(less, '2026-07'), false).comparison).toMatchObject({
      difference: -4000n,
      direction: 'less',
    });
    const same = [...amounts.slice(0, 12), 5000n];
    expect(historyFigures(months(same, '2026-07'), false).comparison).toMatchObject({
      difference: 0n,
      direction: 'same',
    });
  });

  it('a refund-heavy month averages as the negative it is', () => {
    const refunds = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, -3000n, 1000n, 0n];
    expect(historyFigures(months(refunds, '2026-08'), false).average.amount).toBe(-1000n);
  });

  it('withholds both below two complete months in history, and says so', () => {
    const { average, comparison } = historyFigures(months(amounts, '2026-09'), false);
    expect(average).toEqual({
      available: false,
      withheld: 'insufficient_history',
      amount: null,
      monthsAveraged: 0,
      months: [],
    });
    expect(comparison).toEqual({
      available: false,
      withheld: 'insufficient_history',
      thisMonth: 100000n,
      average: null,
      difference: null,
      direction: null,
    });
    // History starting this month: no complete month at all.
    expect(historyFigures(months(amounts, '2026-10'), false).average.withheld).toBe(
      'insufficient_history',
    );
  });

  it('withholds both as no_data when there is no ledger row at all', () => {
    const empty = months(
      Array.from({ length: 13 }, () => 0n),
      null,
    );
    const { average, comparison } = historyFigures(empty, true);
    expect(average.withheld).toBe('no_data');
    expect(comparison).toMatchObject({ withheld: 'no_data', thisMonth: 0n, direction: null });
  });
});
