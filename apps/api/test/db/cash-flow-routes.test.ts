// SPDX-License-Identifier: MIT
/**
 * WP 10.10 — `GET /reports/cash-flow`, over a real database, and the switch of `GET /reports/spending` and the
 * Sankey to the one-read loader.
 *
 * Every fixture row goes in through a production writer (the O-11 fixture rule): the manual connector's opening
 * batch (`linkManual` — the only writer that can say *pending*), `POST /accounts/{id}/transactions`, `PATCH
 * /transactions/{id}` (category, excluded), `POST /transfers/pair`, and the refund heuristic as the consumer runs it.
 *
 *   2025-03-10    −20.00  grocery
 *   2025-03-20 +1,000.00  salary
 *   2025-12-05    −30.00  grocery
 *   2025-12-15 +2,000.00  salary
 *   2026-01-10    −60.00  grocery
 *   2026-01-15 +2,000.00  salary
 *   2026-02-03    −90.00  grocery
 *   2026-02-28    −10.00  grocery                       (February: no income at all)
 *   2026-03-01 +5,000.00  salary
 *   2026-03-02    −25.00  grocery
 *   2026-03-05 −1,000.00 / +1,000.00 checking → brokerage, paired → a transfer: neither income nor expense
 *   2026-03-09    −15.00  hardware, grocery category
 *   2026-03-10     −7.00  coffee, PENDING              → counted, as Reports counts it
 *   2026-03-11    −44.00  grocery, excluded            → not counted
 *   2026-03-12     +5.00  hardware refund              → nets into grocery: −5.00
 *   2026-03-15     −8.00  uncategorised                → spend (the bucket is net negative)
 *   2026-03-16    −12.00  EUR, a euro account          → another currency: named, never summed
 *
 * "Today" is 2026-03-17 (a fixed clock, holder zone UTC). March: income 5,000.00, expenses 50.00.
 */
import { DateOnly, fixedClock, money, systemClock } from '@core/kernel';
import { manualTransaction } from '@connector/manual';
import { detectRefundHints } from '@ctx/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadReportAccounts, loadReportRows } from '../../src/reports/ledger-source.ts';
import { sankeyOf } from '../../src/reports/sankey.ts';
import { categoryMonthCellsOf } from '../../src/reports/spending-income.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres for the fixture ledger (CI's api-db job has one)
const describeWithDb = describe.skipIf(NO_DATABASE);

interface FiguresWire {
  readonly from: string;
  readonly to: string;
  readonly hasData: boolean;
  readonly incomeMinor: string;
  readonly expensesMinor: string;
  readonly netMinor: string;
  readonly transactionCount: number;
}
interface ComparisonWire {
  readonly kind: 'previous' | 'average' | 'year_ago';
  readonly periods: string[];
  readonly available: boolean;
  readonly withheld: 'no_data' | 'no_history' | null;
  readonly periodsAveraged: number;
  readonly throughOffsetDays: number | null;
  readonly incomeMinor: string | null;
  readonly expensesMinor: string | null;
  readonly netMinor: string | null;
}
interface RowWire {
  readonly key: string | null;
  readonly label: string;
  readonly hue: string;
  readonly sumMinor: string;
  readonly share: number | null;
  readonly count: number;
  readonly drillThrough: {
    categoryIds?: string[];
    merchantIds?: string[];
    uncategorized?: boolean;
    from: string;
    to: string;
  } | null;
}
interface BreakdownsWire {
  readonly category: RowWire[];
  readonly group: RowWire[];
  readonly merchant: RowWire[];
}
interface CashFlowWire {
  readonly timeframe: string;
  readonly period: string;
  readonly start: string;
  readonly end: string;
  readonly currentPeriod: string;
  readonly isCurrent: boolean;
  readonly isFuture: boolean;
  readonly through: string | null;
  readonly currency: string | null;
  readonly otherCurrencies: string[];
  readonly summary: FiguresWire & {
    readonly savingsRate: number | null;
    readonly savingsRateWithheld: string | null;
  };
  readonly comparisons: ComparisonWire[];
  readonly bars: (FiguresWire & { readonly period: string; readonly complete: boolean })[];
  readonly breakdowns: { readonly income: BreakdownsWire; readonly expenses: BreakdownsWire };
}
interface WireCategory {
  readonly id: string;
  readonly kind: string;
  readonly assignable: boolean;
  readonly parentId: string | null;
  readonly hue: string;
  readonly label: string;
}

const sumOf = (rows: readonly RowWire[]) =>
  rows.reduce((sum, row) => sum + BigInt(row.sumMinor), 0n);

describeWithDb('[slow] the Cash Flow hub (WP 10.10)', () => {
  let h: ApiHarness;
  let grocery: WireCategory;
  let salary: WireCategory;

  async function cashFlow(query: string): Promise<CashFlowWire> {
    const response = await h.request({
      method: 'GET',
      url: `/reports/cash-flow${query}`,
      session: h.fresh,
    });
    expectStatus(response, 200);
    return response.json() as CashFlowWire;
  }

  /** `GET /reports/spending` (and income) over `[from, to]`, summed: expenses as a positive amount. */
  async function reports(from: string, to: string): Promise<{ expenses: bigint; income: bigint }> {
    const total = async (path: string) => {
      const response = await h.request({
        method: 'GET',
        url: `/reports/${path}?from=${from}&to=${to}`,
        session: h.fresh,
      });
      expectStatus(response, 200);
      const { cells } = response.json() as {
        cells: { amount: { minor: string; currency: string } }[];
      };
      return cells
        .filter((cell) => cell.amount.currency === 'USD')
        .reduce((sum, cell) => sum + BigInt(cell.amount.minor), 0n);
    };
    return { expenses: -(await total('spending')), income: await total('income') };
  }

  async function add(
    accountId: string,
    amountMinor: string,
    postedDate: string,
    name: string,
    currency = 'USD',
  ): Promise<string> {
    const response = await h.request({
      method: 'POST',
      url: `/accounts/${accountId}/transactions`,
      session: h.fresh,
      body: {
        transactions: [
          { amount: { minor: amountMinor, currency }, postedDate, name, merchantName: name },
        ],
      },
    });
    expectStatus(response, 201);
    const id = (response.json() as { addedTransactionIds: string[] }).addedTransactionIds[0];
    if (id === undefined) throw new Error('not added');
    return id;
  }

  async function patch(id: string, body: Record<string, unknown>): Promise<void> {
    const response = await h.request({
      method: 'PATCH',
      url: `/transactions/${id}`,
      session: h.fresh,
      body,
    });
    expectStatus(response, 200);
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp1010_cash_flow',
      clock: fixedClock('2026-03-17T15:00:00.000Z'),
    });

    const categoriesResponse = await h.request({
      method: 'GET',
      url: '/categories',
      session: h.fresh,
    });
    expectStatus(categoriesResponse, 200);
    const { categories } = categoriesResponse.json() as { categories: WireCategory[] };
    const expenseLeaf = categories.find(
      (c) => c.assignable && c.kind === 'expense' && c.parentId !== null,
    );
    const incomeLeaf = categories.find((c) => c.assignable && c.kind === 'income');
    if (expenseLeaf === undefined || incomeLeaf === undefined)
      throw new Error('taxonomy not seeded');
    grocery = expenseLeaf;
    salary = incomeLeaf;

    const bank = await linkManual(h, {
      providerConnectionId: 'wp1010-bank',
      displayName: 'Everyday Bank',
      accounts: [
        { providerAccountId: 'chk', name: 'Checking', type: 'depository', currency: 'USD' },
        { providerAccountId: 'brk', name: 'Brokerage', type: 'investment', currency: 'USD' },
        { providerAccountId: 'eur', name: 'Euro Current', type: 'depository', currency: 'EUR' },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: 'chk',
            providerTransactionId: 'wp1010-pending-coffee',
            amount: money(-700n, 'USD'),
            postedDate: DateOnly.parse('2026-03-10'),
            name: 'PENDING COFFEE',
            pending: true,
          }),
        ],
      },
    });
    const [checking, brokerage, euro] = bank.accountIds;
    if (checking === undefined || brokerage === undefined || euro === undefined)
      throw new Error('accounts missing');

    const categorised = async (minor: string, date: string, name: string, categoryId: string) => {
      const id = await add(checking, minor, date, name);
      await patch(id, { categoryId });
      return id;
    };
    await categorised('-2000', '2025-03-10', 'Corner Grocery', grocery.id);
    await categorised('100000', '2025-03-20', 'ACME PAYROLL', salary.id);
    await categorised('-3000', '2025-12-05', 'Corner Grocery', grocery.id);
    await categorised('200000', '2025-12-15', 'ACME PAYROLL', salary.id);
    await categorised('-6000', '2026-01-10', 'Corner Grocery', grocery.id);
    await categorised('200000', '2026-01-15', 'ACME PAYROLL', salary.id);
    await categorised('-9000', '2026-02-03', 'Corner Grocery', grocery.id);
    await categorised('-1000', '2026-02-28', 'Corner Grocery', grocery.id);
    await categorised('500000', '2026-03-01', 'ACME PAYROLL', salary.id);
    await categorised('-2500', '2026-03-02', 'Corner Grocery', grocery.id);
    await categorised('-1500', '2026-03-09', 'Hardware Store', grocery.id);
    const excludedId = await categorised('-4400', '2026-03-11', 'Corner Grocery', grocery.id);
    await patch(excludedId, { excluded: true });
    await add(checking, '500', '2026-03-12', 'Hardware Store');
    await add(checking, '-800', '2026-03-15', 'Mystery Charge');
    await add(euro, '-1200', '2026-03-16', 'Boulangerie', 'EUR');

    const outflowId = await add(checking, '-100000', '2026-03-05', 'Transfer to Brokerage');
    const inflowId = await add(brokerage, '100000', '2026-03-05', 'Transfer from Checking');
    const paired = await h.request({
      method: 'POST',
      url: '/transfers/pair',
      session: h.fresh,
      body: { outflowTransactionId: outflowId, inflowTransactionId: inflowId },
    });
    expectStatus(paired, 200);

    const hints = await detectRefundHints(
      h.database.db,
      { userId: h.userId },
      { clock: systemClock, correlationId: 'wp1010-refund' },
    );
    expect(hints.length).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('this month: income, expenses and net; transfers, the excluded row and the euro left out; pending counted; so far', async () => {
    const body = await cashFlow('?timeframe=month');
    expect(body.period).toBe('2026-03');
    expect(body.currentPeriod).toBe('2026-03');
    expect(body.isCurrent).toBe(true);
    expect(body.isFuture).toBe(false);
    expect(body.through).toBe('2026-03-17');
    expect(body.start).toBe('2026-03-01');
    expect(body.end).toBe('2026-03-31');
    expect(body.currency).toBe('USD');
    expect(body.otherCurrencies).toEqual(['EUR']);
    expect(body.summary.hasData).toBe(true);
    expect(body.summary.incomeMinor).toBe('500000');
    // 25.00 + 15.00 − 5.00 (refund netted) + 7.00 (pending) + 8.00 (uncategorised): no transfer, no excluded row.
    expect(body.summary.expensesMinor).toBe('5000');
    expect(body.summary.netMinor).toBe('495000');
    expect(body.summary.savingsRate).toBeNull();
    expect(body.summary.savingsRateWithheld).toBe('incomplete');
  });

  it("a month's expenses and income equal GET /reports/spending and /reports/income for that month", async () => {
    for (const month of ['2025-03', '2025-12', '2026-01', '2026-02', '2026-03']) {
      const body = await cashFlow(`?timeframe=month&period=${month}`);
      const report = await reports(body.start, body.end);
      expect({
        month,
        expenses: body.summary.expensesMinor,
        income: body.summary.incomeMinor,
      }).toEqual({
        month,
        expenses: report.expenses.toString(),
        income: report.income.toString(),
      });
    }
  });

  it('the savings rate: net ÷ income for a complete month, withheld at zero income', async () => {
    const january = await cashFlow('?timeframe=month&period=2026-01');
    expect(january.summary.savingsRateWithheld).toBeNull();
    expect(january.summary.savingsRate).toBeCloseTo(194000 / 200000, 10);
    const february = await cashFlow('?timeframe=month&period=2026-02');
    expect(february.summary.incomeMinor).toBe('0');
    expect(february.summary.expensesMinor).toBe('10000');
    expect(february.summary.savingsRate).toBeNull();
    expect(february.summary.savingsRateWithheld).toBe('no_income');
    const empty = await cashFlow('?timeframe=month&period=2025-06');
    expect(empty.summary.hasData).toBe(false);
    expect(empty.summary.savingsRateWithheld).toBe('no_data');
    const future = await cashFlow('?timeframe=month&period=2026-05');
    expect(future.isFuture).toBe(true);
    expect(future.summary.savingsRateWithheld).toBe('not_started');
  });

  it('the current month compares its counterparts through the same day: last month, the 12-month average, a year ago', async () => {
    const body = await cashFlow('?timeframe=month&period=2026-03');
    const [previous, average, yearAgo] = body.comparisons;
    expect(previous).toMatchObject({
      kind: 'previous',
      periods: ['2026-02'],
      available: true,
      throughOffsetDays: 16,
      expensesMinor: '9000', // 3 Feb only: the 28th is past day 17
      incomeMinor: '0',
      netMinor: '-9000',
    });
    // The months of 2025-03 … 2026-02 that have rows: four. Through day 17: 20 + 30 + 60 + 90 = 200.00 / 4.
    expect(average).toMatchObject({
      kind: 'average',
      periods: ['2025-03', '2025-12', '2026-01', '2026-02'],
      available: true,
      periodsAveraged: 4,
      expensesMinor: '5000',
      incomeMinor: '100000', // 0 + 2,000 + 2,000 + 0 (2025-03's salary is on the 20th)
      netMinor: '95000',
    });
    expect(yearAgo).toMatchObject({
      kind: 'year_ago',
      periods: ['2025-03'],
      available: true,
      expensesMinor: '2000',
      incomeMinor: '0',
    });
  });

  it('a comparison with no counterpart is withheld, with the reason', async () => {
    const february = await cashFlow('?timeframe=month&period=2026-02');
    const yearAgo = february.comparisons.find((c) => c.kind === 'year_ago');
    expect(yearAgo).toMatchObject({
      available: false,
      withheld: 'no_data',
      periods: ['2025-02'],
      expensesMinor: null,
      incomeMinor: null,
      netMinor: null,
    });
    const first = await cashFlow('?timeframe=month&period=2025-03');
    expect(first.comparisons.find((c) => c.kind === 'previous')?.withheld).toBe('no_data');
    expect(first.comparisons.find((c) => c.kind === 'average')).toMatchObject({
      available: false,
      withheld: 'no_history',
      periodsAveraged: 0,
      periods: [],
    });
    // A complete month reads its counterparts whole.
    const january = await cashFlow('?timeframe=month&period=2026-01');
    expect(january.comparisons.find((c) => c.kind === 'previous')).toMatchObject({
      periods: ['2025-12'],
      throughOffsetDays: null,
      expensesMinor: '3000',
      incomeMinor: '200000',
    });
  });

  it('quarters roll up across the year boundary: Q1 2026 against Q4 2025, each equal to Reports over its window', async () => {
    const q1 = await cashFlow('?timeframe=quarter&period=2026-Q1');
    expect(q1.isCurrent).toBe(true);
    expect([q1.start, q1.end]).toEqual(['2026-01-01', '2026-03-31']);
    expect(q1.summary.expensesMinor).toBe('21000'); // 60 + 100 + 50
    expect(q1.summary.incomeMinor).toBe('700000');
    const q1Report = await reports(q1.start, q1.end);
    expect(q1.summary.expensesMinor).toBe(q1Report.expenses.toString());
    // Q1 is 75 days in on 17 March, so Q4 2025 is read through 15 December — the salary on the 15th included.
    expect(q1.comparisons.find((c) => c.kind === 'previous')).toMatchObject({
      periods: ['2025-Q4'],
      throughOffsetDays: 75,
      expensesMinor: '3000',
      incomeMinor: '200000',
    });
    expect(q1.comparisons.find((c) => c.kind === 'year_ago')).toMatchObject({
      periods: ['2025-Q1'],
      expensesMinor: '2000', // 10 March 2025; the salary of the 20th is past day 75
      incomeMinor: '0',
    });
    expect(q1.comparisons.find((c) => c.kind === 'average')).toMatchObject({
      periods: ['2025-Q1', '2025-Q4'],
      periodsAveraged: 2,
      expensesMinor: '2500',
      incomeMinor: '100000',
    });
    expect(q1.bars.map((bar) => bar.period).slice(-5)).toEqual([
      '2025-Q1',
      '2025-Q2',
      '2025-Q3',
      '2025-Q4',
      '2026-Q1',
    ]);
    expect(q1.bars).toHaveLength(12);
    expect(q1.bars.at(-1)?.complete).toBe(false);

    const q4 = await cashFlow('?timeframe=quarter&period=2025-Q4');
    expect([q4.start, q4.end]).toEqual(['2025-10-01', '2025-12-31']);
    const q4Report = await reports(q4.start, q4.end);
    expect(q4.summary.expensesMinor).toBe(q4Report.expenses.toString());
    expect(q4.summary.incomeMinor).toBe(q4Report.income.toString());
    expect(q4.summary.savingsRate).toBeCloseTo(197000 / 200000, 10);
    expect(q4.comparisons.find((c) => c.kind === 'previous')?.withheld).toBe('no_data');
    expect(q4.comparisons.find((c) => c.kind === 'average')).toMatchObject({
      periods: ['2025-Q1'],
      expensesMinor: '2000',
      incomeMinor: '100000',
    });
  });

  it('years: 2025 whole, 2026 so far against 2025 through the same day', async () => {
    const y2025 = await cashFlow('?timeframe=year&period=2025');
    expect(y2025.summary.expensesMinor).toBe('5000');
    expect(y2025.summary.incomeMinor).toBe('300000');
    const report = await reports('2025-01-01', '2025-12-31');
    expect(y2025.summary.expensesMinor).toBe(report.expenses.toString());
    expect(y2025.comparisons.find((c) => c.kind === 'previous')?.withheld).toBe('no_data');
    expect(y2025.comparisons.find((c) => c.kind === 'average')?.withheld).toBe('no_history');
    const y2026 = await cashFlow('?timeframe=year');
    expect(y2026.period).toBe('2026');
    expect(y2026.comparisons.find((c) => c.kind === 'previous')).toMatchObject({
      periods: ['2025'],
      expensesMinor: '2000',
      incomeMinor: '0',
    });
  });

  it('the bars: twelve months ending with the selected one, a month with no row is no data, never zero', async () => {
    const body = await cashFlow('?timeframe=month&period=2026-03');
    expect(body.bars.map((bar) => bar.period)).toEqual([
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
    ]);
    expect(body.bars[0]).toMatchObject({ hasData: false, expensesMinor: '0' });
    expect(body.bars[8]).toMatchObject({
      hasData: true,
      complete: true,
      expensesMinor: '3000',
      incomeMinor: '200000',
      netMinor: '197000',
    });
    expect(body.bars[11]).toMatchObject({ complete: false, expensesMinor: '5000' });
  });

  it('the breakdowns: every list sums to its side total, sorted, with shares, hues and drill-throughs', async () => {
    const body = await cashFlow('?timeframe=month&period=2026-03');
    const expenses = body.breakdowns.expenses;
    for (const rows of [expenses.category, expenses.group, expenses.merchant]) {
      expect(sumOf(rows)).toBe(5000n);
      const sums = rows.map((row) => BigInt(row.sumMinor));
      expect([...sums].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))).toEqual(sums);
      const shares = rows.reduce((sum, row) => sum + (row.share ?? 0), 0);
      expect(shares).toBeCloseTo(1, 10);
    }
    const groceryRow = expenses.category.find((row) => row.key === grocery.id);
    expect(groceryRow).toMatchObject({
      label: grocery.label,
      hue: grocery.hue,
      sumMinor: '3500', // 25 + 15 − 5
      count: 3,
      drillThrough: { categoryIds: [grocery.id], from: '2026-03-01', to: '2026-03-31' },
    });
    const uncategorised = expenses.category.find((row) => row.key === null);
    expect(uncategorised?.label).toBe('Uncategorised');
    expect(uncategorised?.hue).toBe('neutral');
    expect(uncategorised?.drillThrough).toMatchObject({ uncategorized: true });
    const group = expenses.group.find((row) => row.key === grocery.parentId);
    expect(group?.drillThrough?.categoryIds).toContain(grocery.id);
    expect(group?.drillThrough?.categoryIds?.[0]).toBe(grocery.parentId);
    const hardware = expenses.merchant.find((row) => row.label === 'Hardware Store');
    expect(hardware).toMatchObject({ sumMinor: '1000', count: 2 }); // 15.00 less the 5.00 refund
    expect(hardware?.drillThrough?.merchantIds).toEqual([hardware?.key]);
    expect(expenses.merchant.some((row) => row.label === 'Transfer to Brokerage')).toBe(false);

    const income = body.breakdowns.income;
    expect(income.category).toEqual([
      expect.objectContaining({ key: salary.id, sumMinor: '500000', share: 1, count: 1 }),
    ]);
    expect(sumOf(income.merchant)).toBe(500000n);
  });

  it("refuses a period that is not one of the timeframe's", async () => {
    for (const query of [
      '?timeframe=month&period=2026-Q1',
      '?timeframe=quarter&period=2026-03',
      '?timeframe=year&period=2026-13',
      '?timeframe=month&period=2026-13',
      '?timeframe=week',
    ]) {
      const response = await h.request({
        method: 'GET',
        url: `/reports/cash-flow${query}`,
        session: h.fresh,
      });
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
    }
  });

  it('GET /reports/spending, /reports/income and the Sankey on the one-read loader: unchanged against the paged reader', async () => {
    const window = {
      userId: h.userId,
      dateFrom: DateOnly.parse('2025-01-01'),
      dateTo: DateOnly.parse('2026-03-31'),
    };
    const [rows, accounts] = await Promise.all([
      loadReportRows(h.database.db, window),
      loadReportAccounts(h.database.db, h.userId),
    ]);
    const reference = categoryMonthCellsOf(rows, accounts)
      .map((cell) => ({
        month: cell.month,
        categoryId: cell.categoryId,
        amount: { minor: cell.amount.minor.toString(), currency: cell.amount.currency },
        transactionCount: cell.transactionCount,
      }))
      .sort((a, b) =>
        `${a.month}${a.categoryId ?? ''}${a.amount.currency}`.localeCompare(
          `${b.month}${b.categoryId ?? ''}${b.amount.currency}`,
        ),
      );
    const served = [];
    for (const path of ['spending', 'income']) {
      const response = await h.request({
        method: 'GET',
        url: `/reports/${path}?from=2025-01-01&to=2026-03-31`,
        session: h.fresh,
      });
      expectStatus(response, 200);
      served.push(
        ...(
          response.json() as {
            cells: {
              month: string;
              categoryId: string | null;
              amount: { minor: string; currency: string };
              transactionCount: number;
            }[];
          }
        ).cells.map((cell) => ({
          month: cell.month,
          categoryId: cell.categoryId,
          amount: cell.amount,
          transactionCount: cell.transactionCount,
        })),
      );
    }
    served.sort((a, b) =>
      `${a.month}${a.categoryId ?? ''}${a.amount.currency}`.localeCompare(
        `${b.month}${b.categoryId ?? ''}${b.amount.currency}`,
      ),
    );
    // Every cell is spending or income, never both and never neither, so the two reports together are the cells.
    expect(served).toEqual(reference);
    expect(served.length).toBeGreaterThan(5);

    const sankeyResponse = await h.request({
      method: 'GET',
      url: '/reports/sankey?from=2025-01-01&to=2026-03-31',
      session: h.fresh,
    });
    expectStatus(sankeyResponse, 200);
    const sankey = sankeyResponse.json() as {
      currency: string;
      nodes: unknown[];
      links: { source: string; target: string; amount: { minor: string } }[];
    };
    const expected = sankeyOf(rows, accounts);
    expect(sankey.currency).toBe(expected.currency);
    expect(sankey.nodes).toEqual(expected.nodes.map((node) => ({ ...node })));
    expect(sankey.links.map((link) => [link.source, link.target, link.amount.minor])).toEqual(
      expected.links.map((link) => [link.source, link.target, link.amount.minor.toString()]),
    );
  });
});
