// SPDX-License-Identifier: MIT
import type { HistoryWire } from './history.ts';

/**
 * A category history as `GET /reports/category-history` sends it (WP 10.14): thirteen months, Oct 2025 – Oct 2026,
 * the current month last. Amounts in minor units, spending side. `withOneCompleteMonth` is a ledger that started
 * last month.
 */
export function historyWire(overrides: Partial<HistoryWire> = {}): HistoryWire {
  const amounts = [
    41000, 38000, 0, 45000, 40000, 39000, 52000, 44000, 0, 47000, 43000, 39000, 21000,
  ];
  const months = amounts.map((amount, index) => {
    const year = index < 3 ? 2025 : 2026;
    const monthNumber = ((index + 9) % 12) + 1;
    const month = `${String(year)}-${String(monthNumber).padStart(2, '0')}`;
    const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    return {
      month,
      start: `${month}-01`,
      end: `${month}-${String(last).padStart(2, '0')}`,
      amountMinor: String(amount),
      transactionCount: amount === 0 ? 0 : 5,
      hasActivity: amount !== 0,
      complete: index < 12,
      isCurrent: index === 12,
      inHistory: true,
    };
  });
  // The 12 complete months: Σ = 428 000, ÷ 12 = 35 666.67 → 35 667 (half-even).
  return {
    side: 'spending',
    currency: 'USD',
    otherCurrencies: [],
    currentMonth: '2026-10',
    through: '2026-10-18',
    months,
    average: { available: true, withheld: null, amountMinor: '35667', monthsAveraged: 12 },
    comparison: { thisMonthMinor: '21000', differenceMinor: '-14667', direction: 'less' },
    ...overrides,
  };
}

export function withOneCompleteMonth(): HistoryWire {
  const base = historyWire();
  return {
    ...base,
    months: base.months.map((month, index) => ({ ...month, inHistory: index >= 11 })),
    average: {
      available: false,
      withheld: 'insufficient_history',
      amountMinor: null,
      monthsAveraged: 1,
    },
    comparison: { thisMonthMinor: '21000', differenceMinor: null, direction: null },
  };
}
