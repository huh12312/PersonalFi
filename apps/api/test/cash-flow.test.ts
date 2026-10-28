// SPDX-License-Identifier: MIT
/**
 * WP 10.10 — the Cash Flow hub's pure parts: the period arithmetic (quarters across a year boundary), the savings
 * rate's withholding, and the month-cached `windowReader` agreeing with `cellsOfWindow` — Reports over each window's
 * own rows — over every window of a generated ledger that has cross-month refunds, transfers, excluded rows, an
 * off-budget account and a second currency.
 */
import { DateOnly, money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import {
  cellsOfWindow,
  parsePeriodKey,
  periodContaining,
  savingsRateOf,
  shiftPeriod,
  windowReader,
} from '../src/reports/cash-flow.ts';
import type { ReportAccount, ReportRow } from '../src/reports/types.ts';

describe('periods', () => {
  it('parses each timeframe’s keys and refuses the others', () => {
    expect(parsePeriodKey('month', '2026-02')).toEqual({
      timeframe: 'month',
      key: '2026-02',
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(parsePeriodKey('quarter', '2025-Q4')).toMatchObject({
      start: '2025-10-01',
      end: '2025-12-31',
    });
    expect(parsePeriodKey('year', '2024')).toMatchObject({
      start: '2024-01-01',
      end: '2024-12-31',
    });
    for (const [timeframe, key] of [
      ['month', '2026-13'],
      ['month', '2026-Q1'],
      ['quarter', '2026-Q5'],
      ['quarter', '2026-03'],
      ['year', '26'],
      ['year', '2026-01'],
    ] as const) {
      expect(parsePeriodKey(timeframe, key)).toBeNull();
    }
  });

  it('steps a quarter back across the year boundary, and a month back twelve to the same month last year', () => {
    const q1 = parsePeriodKey('quarter', '2026-Q1')!;
    expect(shiftPeriod(q1, -1).key).toBe('2025-Q4');
    expect(shiftPeriod(q1, -4).key).toBe('2025-Q1');
    expect(shiftPeriod(shiftPeriod(q1, -1), 1).key).toBe('2026-Q1');
    expect(shiftPeriod(parsePeriodKey('month', '2026-01')!, -1).key).toBe('2025-12');
    expect(shiftPeriod(parsePeriodKey('month', '2026-03')!, -12).key).toBe('2025-03');
    expect(shiftPeriod(parsePeriodKey('year', '2026')!, -1).end).toBe('2025-12-31');
    expect(periodContaining('quarter', DateOnly.parse('2026-12-31')).key).toBe('2026-Q4');
    expect(periodContaining('month', DateOnly.parse('2024-02-29')).end).toBe('2024-02-29');
  });
});

describe('savings rate', () => {
  const done = { isCurrent: false, isFuture: false };
  it('is net ÷ income for a complete period with income', () => {
    expect(savingsRateOf({ hasData: true, income: 200000n, net: 50000n }, done)).toEqual({
      savingsRate: 0.25,
      savingsRateWithheld: null,
    });
    // Spending more than came in is a negative rate, not a withheld one.
    expect(savingsRateOf({ hasData: true, income: 100000n, net: -20000n }, done).savingsRate).toBe(
      -0.2,
    );
  });
  it('is withheld, with the reason, at zero or negative income, with no data, mid-period and before it starts', () => {
    expect(savingsRateOf({ hasData: true, income: 0n, net: -500n }, done).savingsRateWithheld).toBe(
      'no_income',
    );
    expect(
      savingsRateOf({ hasData: true, income: -100n, net: -100n }, done).savingsRateWithheld,
    ).toBe('no_income');
    expect(savingsRateOf({ hasData: false, income: 0n, net: 0n }, done).savingsRateWithheld).toBe(
      'no_data',
    );
    expect(
      savingsRateOf({ hasData: true, income: 9n, net: 1n }, { isCurrent: true, isFuture: false }),
    ).toEqual({ savingsRate: null, savingsRateWithheld: 'incomplete' });
    expect(
      savingsRateOf({ hasData: false, income: 0n, net: 0n }, { isCurrent: false, isFuture: true })
        .savingsRateWithheld,
    ).toBe('not_started');
  });
});

/** A deterministic ledger: 30 months, a refund that often lands the month after its purchase. */
function ledger(): { rows: ReportRow[]; accounts: ReportAccount[] } {
  const accounts: ReportAccount[] = [
    { id: 'chk', role: 'CASH', currency: 'USD' },
    { id: 'card', role: 'CREDIT', currency: 'USD' },
    { id: 'brk', role: 'OFF_BUDGET', currency: 'USD' },
    { id: 'eur', role: 'CASH', currency: 'EUR' },
  ];
  const rows: ReportRow[] = [];
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  const categories = ['groceries', 'rent', 'fun', null, 'salary'];
  let n = 0;
  for (let day = 0; day < 30 * 30; day += 1) {
    const date = DateOnly.addDays(DateOnly.parse('2024-01-01'), day);
    for (let k = 0; k < 2; k += 1) {
      const r = next();
      const category = categories[r % categories.length] ?? null;
      const account = (['chk', 'card', 'brk', 'eur'] as const)[(r >> 3) % 4] ?? 'chk';
      const income = category === 'salary';
      const minor = BigInt(((r >> 5) % 9000) + 100) * (income ? 10n : -1n);
      const id = `t${String((n += 1))}`;
      rows.push({
        id,
        accountId: account,
        date,
        amount: money(minor, account === 'eur' ? 'EUR' : 'USD'),
        categoryId: category,
        merchantId: `m${String(r % 11)}`,
        isTransfer: (r >> 7) % 23 === 0,
        transferLinkId: (r >> 9) % 31 === 0 ? `link${id}` : null,
        refundOfId: null,
        excluded: (r >> 11) % 19 === 0,
        pending: (r >> 13) % 7 === 0,
      });
      // An uncategorised refund of an earlier purchase, 3–40 days later: across a month (and a window) often.
      if (!income && (r >> 15) % 5 === 0) {
        const later = DateOnly.addDays(date, 3 + ((r >> 17) % 38));
        rows.push({
          id: `r${id}`,
          accountId: account,
          date: later,
          amount: money(-minor / 2n, account === 'eur' ? 'EUR' : 'USD'),
          categoryId: null,
          merchantId: `m${String(r % 11)}`,
          isTransfer: false,
          transferLinkId: null,
          refundOfId: id,
          excluded: false,
          pending: false,
        });
      }
    }
  }
  return { rows: rows.filter((row) => row.amount.currency === 'USD'), accounts };
}

const cellKey = (cell: { month: string; categoryId: string | null }) =>
  `${cell.month}|${cell.categoryId ?? '-'}`;
function asMap(
  cells: readonly { month: string; categoryId: string | null; amount: { minor: bigint } }[],
) {
  return new Map(cells.map((cell) => [cellKey(cell), cell.amount.minor]));
}

describe('windowReader', () => {
  it('agrees with cellsOfWindow (Reports over the window’s own rows) for every window, whole or cut mid-month', () => {
    const { rows, accounts } = ledger();
    const income = new Set(['salary']);
    const reader = windowReader(rows, accounts, income, new Set<string>());
    const crossMonthRefunds = rows.filter((row) => {
      if (row.refundOfId === null) return false;
      const purchase = rows.find((candidate) => candidate.id === row.refundOfId);
      return purchase !== undefined && purchase.date.slice(0, 7) !== row.date.slice(0, 7);
    });
    expect(crossMonthRefunds.length).toBeGreaterThan(20);

    const windows: [string, string][] = [];
    for (const timeframe of ['month', 'quarter', 'year'] as const) {
      let period = parsePeriodKey(
        timeframe,
        timeframe === 'year' ? '2024' : timeframe === 'quarter' ? '2024-Q1' : '2024-01',
      )!;
      while (period.start < '2026-07-01') {
        windows.push([period.start, period.end]);
        for (const offset of [0, 9, 16, 40, 75, 200]) {
          const to = DateOnly.min(DateOnly.addDays(period.start, offset), period.end);
          windows.push([period.start, to]);
        }
        period = shiftPeriod(period, 1);
      }
    }
    expect(windows.length).toBeGreaterThan(150);
    for (const [from, to] of windows) {
      const expected = cellsOfWindow(
        rows,
        accounts,
        income,
        DateOnly.parse(from),
        DateOnly.parse(to),
        new Set<string>(),
      );
      const actual = reader.cells(DateOnly.parse(from), DateOnly.parse(to));
      expect({ from, to, spending: asMap(actual.spending) }).toEqual({
        from,
        to,
        spending: asMap(expected.spending),
      });
      expect({ from, to, income: asMap(actual.income) }).toEqual({
        from,
        to,
        income: asMap(expected.income),
      });
    }
  });
});

/** The grouping `listAggregateSumsInWindow` does in SQL, modelled: refund-linked rows kept, the rest summed by segment. */
function summed(
  rows: readonly ReportRow[],
  cuts: readonly string[],
): { rows: ReportRow[]; weights: Map<string, number> } {
  const targets = new Set(rows.flatMap((row) => (row.refundOfId === null ? [] : [row.refundOfId])));
  const kept: ReportRow[] = [];
  const groups = new Map<string, { row: ReportRow; count: number }>();
  for (const row of rows) {
    if (row.refundOfId !== null || targets.has(row.id)) {
      kept.push(row);
      continue;
    }
    const month = row.date.slice(0, 7);
    const cut = cuts.filter((c) => c >= row.date && c.slice(0, 7) === month).sort()[0];
    const end = cut ?? DateOnly.endOfMonth(DateOnly.parse(`${month}-01`));
    const key = [
      row.accountId,
      end,
      row.amount.currency,
      row.categoryId,
      row.merchantId,
      row.isTransfer,
      row.transferLinkId !== null,
      row.excluded,
    ].join('|');
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, {
        count: 1,
        row: {
          ...row,
          id: `sum:${String(groups.size)}`,
          date: DateOnly.parse(end),
          refundOfId: null,
          transferLinkId: row.transferLinkId === null ? null : 'linked',
          pending: false,
        },
      });
    } else {
      group.count += 1;
      group.row = {
        ...group.row,
        amount: money(group.row.amount.minor + row.amount.minor, row.amount.currency),
      };
    }
  }
  const weights = new Map([...groups.values()].map((g) => [g.row.id, g.count] as const));
  return { rows: [...kept, ...[...groups.values()].map((g) => g.row)], weights };
}

describe('summed history (loadReportHistoryInOneRead)', () => {
  it('gives every window ending on a cut or a month end the same cells as the rows themselves', () => {
    const { rows, accounts } = ledger();
    const income = new Set(['salary']);
    const cuts = ['2024-03-17', '2024-06-15', '2025-02-17', '2025-10-18', '2026-01-09'];
    const history = summed(rows, cuts);
    expect(history.rows.length).toBeLessThan(rows.length * 0.9);
    expect(
      [...history.weights.values()].reduce((a, b) => a + b, 0) +
        history.rows.filter((r) => !r.id.startsWith('sum:')).length,
    ).toBe(rows.length);
    const reader = windowReader(history.rows, accounts, income, new Set<string>());
    const ends: string[] = [...cuts];
    for (
      let first = DateOnly.parse('2024-01-01');
      first < '2026-07-01';
      first = DateOnly.addMonths(first, 1)
    )
      ends.push(DateOnly.endOfMonth(first));
    let compared = 0;
    for (const start of ['2024-01-01', '2024-04-01', '2025-01-01', '2025-10-01', '2026-01-01']) {
      for (const end of ends) {
        if (end < start) continue;
        const from = DateOnly.parse(start);
        const to = DateOnly.parse(end);
        const expected = cellsOfWindow(rows, accounts, income, from, to, new Set<string>());
        const actual = reader.cells(from, to);
        expect({
          start,
          end,
          spending: asMap(actual.spending),
          income: asMap(actual.income),
        }).toEqual({
          start,
          end,
          spending: asMap(expected.spending),
          income: asMap(expected.income),
        });
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(100);
  });
});
