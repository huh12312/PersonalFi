// SPDX-License-Identifier: MIT
/**
 * The Cash Flow hub (WP 10.10; docs/research/10-visual-design-notes.md §1.4): one period's income,
 * expenses, net cash flow and savings rate; three comparisons; a bar series of the trailing periods; and the period's
 * breakdowns by category, by category group and by merchant.
 *
 * ## Every figure is Reports over a window — never a second predicate
 *
 * A figure for a window `[from, to]` is exactly what `GET /reports/spending` and `GET /reports/income` report for that
 * window: the rows are `loadReportRowsInOneRead`'s (Reports' filters and mapper), the split is `categoryMonthCellsOf`
 * (the same `monthActualsOf` → `computeActuals` call: transfers out on both legs, refunds netted into the purchase's
 * category, holder-excluded rows and off-budget accounts dropped, pending rows **counted**, as Reports counts them),
 * and the sides are `spendingRowsOf` / `incomeRowsOf` unchanged (income categories, and the uncategorised bucket of a
 * month only while it is net positive, are income; everything else is spending). So:
 *
 *  - **expenses** = −Σ spending cells; **income** = Σ income cells; **net** = income − expenses;
 *  - a month's expenses here equal `GET /reports/spending` for that month (asserted by
 *    `apps/api/test/db/cash-flow-routes.test.ts`), and a quarter's or a year's equal the same report over the
 *    quarter's or the year's window.
 *
 * Each period is computed over **its own window's rows** (`categoryOfPurchase` spans exactly them), because that is
 * what the report for that window does. The rows are read once, for the widest window the response needs, and sliced.
 *
 * ## Honesty
 *
 *  - A period with **no ledger row at all** in the currency has no data (`hasData: false`) — never a zero. A period
 *    with rows and no spend is a real zero.
 *  - **The current period is incomplete**: its figures are "so far" (`isCurrent`, `through`), the savings rate is
 *    withheld (`incomplete`: a rate mid-period swings with the day pay lands), and every comparison reads its
 *    counterpart **through the same point** (the same number of days into it, capped at its end) — "by this day last
 *    month", never this month so far against all of last month.
 *  - The **savings rate** (net ÷ income) is withheld when income is zero or less (`no_income`) or there is no data.
 *  - A **comparison** whose counterpart has no ledger row is withheld (`no_data`); the average is over the trailing
 *    periods that have data (`periodsAveraged`), withheld when none has.
 *  - **One currency** — the one with the most rows in the window (`pickCurrency`, the pace's rule); the others are
 *    named in `otherCurrencies`, never converted or summed (decision D4).
 */
import { DateOnly, hueForId, type DateOnly as DateOnlyType } from '@core/kernel';
import type { LedgerDatabase } from '@ctx/ledger';
import { loadReportAccounts, loadReportHistoryInOneRead } from './ledger-source.ts';
import { divideHalfEven, pickCurrency } from './spending-pace.ts';
import {
  categoryMonthCellsOf,
  incomeRowsOf,
  spendingRowsOf,
  type CategoryMonthCellWithLines,
  transferCategoryIdsOf,
} from './spending-income.ts';
import type { DrillThroughFilter, ReportAccount, ReportRow } from './types.ts';

export const CASH_FLOW_TIMEFRAMES = ['month', 'quarter', 'year'] as const;
export type CashFlowTimeframe = (typeof CASH_FLOW_TIMEFRAMES)[number];

/** How many trailing periods the average reads, and how many bars the chart draws (the selected one included). */
export const TRAILING_PERIODS = 12;

export interface CashFlowPeriod {
  readonly timeframe: CashFlowTimeframe;
  /** `YYYY-MM`, `YYYY-Qn` or `YYYY`. */
  readonly key: string;
  /** Inclusive. */
  readonly start: DateOnlyType;
  /** Inclusive. */
  readonly end: DateOnlyType;
}

const MONTH_KEY = /^(\d{4})-(\d{2})$/u;
const QUARTER_KEY = /^(\d{4})-Q([1-4])$/u;
const YEAR_KEY = /^(\d{4})$/u;

function monthsIn(timeframe: CashFlowTimeframe): number {
  return timeframe === 'month' ? 1 : timeframe === 'quarter' ? 3 : 12;
}

export function periodsPerYear(timeframe: CashFlowTimeframe): number {
  return 12 / monthsIn(timeframe);
}

function keyOf(timeframe: CashFlowTimeframe, start: DateOnlyType): string {
  const year = String(DateOnly.year(start)).padStart(4, '0');
  if (timeframe === 'year') return year;
  if (timeframe === 'quarter')
    return `${year}-Q${String(Math.floor((DateOnly.month(start) - 1) / 3) + 1)}`;
  return start.slice(0, 7);
}

function periodFrom(timeframe: CashFlowTimeframe, start: DateOnlyType): CashFlowPeriod {
  const end = DateOnly.addDays(DateOnly.addMonths(start, monthsIn(timeframe)), -1);
  return { timeframe, key: keyOf(timeframe, start), start, end };
}

function validYear(year: number): boolean {
  return year >= 1900 && year <= 9998;
}

/** A period key → its window; `null` for a key that is not one of `timeframe`'s. */
export function parsePeriodKey(timeframe: CashFlowTimeframe, key: string): CashFlowPeriod | null {
  if (timeframe === 'month') {
    const match = MONTH_KEY.exec(key);
    if (match === null) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (!validYear(year) || month < 1 || month > 12) return null;
    return periodFrom(timeframe, DateOnly.of(year, month, 1));
  }
  if (timeframe === 'quarter') {
    const match = QUARTER_KEY.exec(key);
    if (match === null) return null;
    const year = Number(match[1]);
    if (!validYear(year)) return null;
    return periodFrom(timeframe, DateOnly.of(year, (Number(match[2]) - 1) * 3 + 1, 1));
  }
  const match = YEAR_KEY.exec(key);
  if (match === null) return null;
  const year = Number(match[1]);
  if (!validYear(year)) return null;
  return periodFrom(timeframe, DateOnly.of(year, 1, 1));
}

/** The period of `timeframe` that contains `date`. */
export function periodContaining(timeframe: CashFlowTimeframe, date: DateOnlyType): CashFlowPeriod {
  const month = DateOnly.month(date);
  const firstMonth =
    timeframe === 'month'
      ? month
      : timeframe === 'quarter'
        ? Math.floor((month - 1) / 3) * 3 + 1
        : 1;
  return periodFrom(timeframe, DateOnly.of(DateOnly.year(date), firstMonth, 1));
}

/** `period` moved by `count` periods of its own timeframe (negative = earlier). Q1 − 1 is the previous year's Q4. */
export function shiftPeriod(period: CashFlowPeriod, count: number): CashFlowPeriod {
  return periodFrom(
    period.timeframe,
    DateOnly.addMonths(period.start, count * monthsIn(period.timeframe)),
  );
}

/** Figures for one window, in minor units of the response currency. */
export interface WindowFigures {
  /** The window actually read: a counterpart of the current period stops at the same point into it. */
  readonly from: DateOnlyType;
  readonly to: DateOnlyType;
  /** Any ledger row in the currency in the *whole* period (a transfer, a pending charge). False = no data, not zero. */
  readonly hasData: boolean;
  readonly income: bigint;
  readonly expenses: bigint;
  readonly net: bigint;
  /** Rows behind the income and expense figures (transfers and excluded rows are not counted). */
  readonly transactionCount: number;
}

export type SavingsRateWithheld = 'no_data' | 'no_income' | 'incomplete' | 'not_started';

export interface CashFlowBar extends WindowFigures {
  readonly period: string;
  /** False for the current period (its figures are so far) and any later one. */
  readonly complete: boolean;
}

export type ComparisonKind = 'previous' | 'average' | 'year_ago';

export interface CashFlowComparison {
  readonly kind: ComparisonKind;
  /** The counterpart: the previous period, the same period a year earlier, or the first..last averaged. */
  readonly periods: readonly string[];
  readonly available: boolean;
  /** Why it is withheld: the counterpart has no ledger row (`no_data`), or no trailing period has (`no_history`). */
  readonly withheld: 'no_data' | 'no_history' | null;
  /** How many periods the average is over (1 for the other two when available, 0 when withheld). */
  readonly periodsAveraged: number;
  /** The days read in each counterpart: the whole period, or as far into it as the current period has run. */
  readonly throughOffsetDays: number | null;
  readonly income: bigint | null;
  readonly expenses: bigint | null;
  readonly net: bigint | null;
}

export interface BreakdownRow {
  /** A category id, a group (top-level category) id, or a merchant id; `null` = uncategorised / no merchant. */
  readonly key: string | null;
  readonly label: string;
  readonly hue: string;
  /** This side's amount: money in for income, money out for expenses (a refund-heavy row can be negative). */
  readonly sum: bigint;
  /** `sum ÷ the side's total` when the total is positive, else null. Presentation only (a float is allowed here). */
  readonly share: number | null;
  readonly count: number;
  /** `GET /transactions`' own params; null when no filter can reach exactly this row ("No merchant"). */
  readonly drillThrough: DrillThroughFilter | null;
}

export interface Breakdowns {
  readonly category: readonly BreakdownRow[];
  readonly group: readonly BreakdownRow[];
  readonly merchant: readonly BreakdownRow[];
}

export interface CashFlowResult {
  readonly timeframe: CashFlowTimeframe;
  readonly period: CashFlowPeriod;
  readonly currentPeriod: string;
  /** The selected period is the one today is in: its figures are so far. */
  readonly isCurrent: boolean;
  /** The selected period starts after today. */
  readonly isFuture: boolean;
  /** Today, when the selected period is current. */
  readonly through: DateOnlyType | null;
  readonly currency: string | null;
  readonly otherCurrencies: readonly string[];
  readonly summary: WindowFigures & {
    readonly savingsRate: number | null;
    readonly savingsRateWithheld: SavingsRateWithheld | null;
  };
  readonly comparisons: readonly CashFlowComparison[];
  readonly bars: readonly CashFlowBar[];
  readonly breakdowns: { readonly income: Breakdowns; readonly expenses: Breakdowns };
}

export interface CategoryInfo {
  readonly id: string;
  readonly label: string;
  readonly parentId: string | null;
  readonly hue: string;
  readonly kind: string;
}

export interface CashFlowInput {
  readonly userId: string;
  readonly timeframe: CashFlowTimeframe;
  /** The selected period; `null` = the one today is in. */
  readonly periodKey: string | null;
  /** Today, in the holder's zone. */
  readonly today: DateOnlyType;
  /** Every category, archived included (a past period still names what it meant). Read beside the ledger. */
  readonly categories: Promise<readonly CategoryInfo[]>;
  /** Merchant display names for the ids asked; ids it does not know are "Unknown merchant". */
  readonly merchantNames: (ids: readonly string[]) => Promise<ReadonlyMap<string, string>>;
}

function inWindow(row: ReportRow, from: DateOnlyType, to: DateOnlyType): boolean {
  return row.date >= from && row.date <= to;
}

interface WindowCells {
  readonly spending: readonly CategoryMonthCellWithLines[];
  readonly income: readonly CategoryMonthCellWithLines[];
}

/**
 * The cells Reports would hold for `[from, to]`: the rows of that window only, through `categoryMonthCellsOf`, split by
 * the shared `spendingRowsOf` / `incomeRowsOf`. Exported for the unit test of the roll-up rule.
 */
export function cellsOfWindow(
  rows: readonly ReportRow[],
  accounts: readonly ReportAccount[],
  incomeCategoryIds: ReadonlySet<string>,
  from: DateOnlyType,
  to: DateOnlyType,
  transferCategoryIds: ReadonlySet<string>,
): WindowCells {
  const cells = categoryMonthCellsOf(
    rows.filter((row) => inWindow(row, from, to)),
    accounts,
  );
  return {
    spending: spendingRowsOf(cells, incomeCategoryIds, transferCategoryIds),
    income: incomeRowsOf(cells, incomeCategoryIds, transferCategoryIds),
  };
}

/**
 * `cellsOfWindow`, for many windows over one read, computing each month once.
 *
 * A window's cells are its months' cells: `monthActualsOf` runs `computeActuals` month by month, and the window only
 * reaches a month through two things — which of the month's rows are inside it (all of them, or for a window that
 * ends mid-month the ones up to its end) and `categoryOfPurchase`, which `computeActuals` reads only at
 * `get(refund.refundOfId)`. So a month's cells are cached by (month, last day read, which of its refunds' purchases
 * are inside the window), and computed with exactly the entries the window's own map would give those refunds. The
 * result is `cellsOfWindow`'s, cell for cell — `cash-flow.test.ts` asserts it over every window of a generated
 * ledger with cross-month refunds — at a fraction of the passes (a year timeframe reads 24 windows over two years).
 */
export function windowReader(
  rows: readonly ReportRow[],
  accounts: readonly ReportAccount[],
  incomeCategoryIds: ReadonlySet<string>,
  transferCategoryIds: ReadonlySet<string>,
) {
  const byMonth = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const month = row.date.slice(0, 7);
    const bucket = byMonth.get(month);
    if (bucket === undefined) byMonth.set(month, [row]);
    else bucket.push(row);
  }
  const rowsById = new Map(rows.map((row) => [row.id, row] as const));
  const monthCache = new Map<string, CategoryMonthCellWithLines[]>();

  const monthsOf = (from: DateOnlyType, to: DateOnlyType): string[] => {
    const months: string[] = [];
    for (
      let first = DateOnly.startOfMonth(from);
      !DateOnly.isAfter(first, to);
      first = DateOnly.addMonths(first, 1)
    ) {
      months.push(first.slice(0, 7));
    }
    return months;
  };

  const monthCells = (
    month: string,
    from: DateOnlyType,
    to: DateOnlyType,
  ): CategoryMonthCellWithLines[] => {
    const all = byMonth.get(month) ?? [];
    const whole = all.every((row) => inWindow(row, from, to));
    const inside = whole ? all : all.filter((row) => inWindow(row, from, to));
    const purchases = new Map<string, string | null>();
    for (const row of inside) {
      if (row.refundOfId === null) continue;
      const purchase = rowsById.get(row.refundOfId);
      if (purchase !== undefined && inWindow(purchase, from, to))
        purchases.set(purchase.id, purchase.categoryId);
    }
    const key = `${month}|${whole ? '' : `${from}..${to}`}|${[...purchases.keys()].sort().join(',')}`;
    const cached = monthCache.get(key);
    if (cached !== undefined) return cached;
    const cells = categoryMonthCellsOf(inside, accounts, purchases);
    monthCache.set(key, cells);
    return cells;
  };

  return {
    rowsById: rowsById as ReadonlyMap<string, ReportRow>,
    /** The cells `GET /reports/spending` + `/reports/income` hold for `[from, to]`, split into the two sides. */
    cells(from: DateOnlyType, to: DateOnlyType): WindowCells {
      const cells = monthsOf(from, to).flatMap((month) => monthCells(month, from, to));
      return {
        spending: spendingRowsOf(cells, incomeCategoryIds, transferCategoryIds),
        income: incomeRowsOf(cells, incomeCategoryIds, transferCategoryIds),
      };
    },
    /** Any row at all in `[from, to]`: a period with none has no data, which is not a zero. */
    hasRows(from: DateOnlyType, to: DateOnlyType): boolean {
      return monthsOf(from, to).some((month) =>
        (byMonth.get(month) ?? []).some((row) => inWindow(row, from, to)),
      );
    },
  };
}

function figuresOf(
  cells: WindowCells,
  from: DateOnlyType,
  to: DateOnlyType,
  hasData: boolean,
  weightOf: (lineId: string) => number = () => 1,
): WindowFigures {
  const expenses = cells.spending.reduce((sum, cell) => sum - cell.amount.minor, 0n);
  const income = cells.income.reduce((sum, cell) => sum + cell.amount.minor, 0n);
  // A summed history row counts the rows it stands for (`loadReportHistoryInOneRead`); a real row counts one.
  const transactionCount = [...cells.spending, ...cells.income].reduce(
    (sum, cell) => sum + cell.lines.reduce((lines, line) => lines + weightOf(line.id), 0),
    0,
  );
  return { from, to, hasData, income, expenses, net: income - expenses, transactionCount };
}

/** The savings rate, or why it is withheld. */
export function savingsRateOf(
  figures: Pick<WindowFigures, 'hasData' | 'income' | 'net'>,
  state: { readonly isCurrent: boolean; readonly isFuture: boolean },
): {
  readonly savingsRate: number | null;
  readonly savingsRateWithheld: SavingsRateWithheld | null;
} {
  if (state.isFuture) return { savingsRate: null, savingsRateWithheld: 'not_started' };
  if (!figures.hasData) return { savingsRate: null, savingsRateWithheld: 'no_data' };
  if (state.isCurrent) return { savingsRate: null, savingsRateWithheld: 'incomplete' };
  if (figures.income <= 0n) return { savingsRate: null, savingsRateWithheld: 'no_income' };
  // Presentation only: a ratio of two exact integers, carried as a float (docs/CONVENTIONS.md "Money").
  return { savingsRate: Number(figures.net) / Number(figures.income), savingsRateWithheld: null };
}

function byDescendingSum(a: BreakdownRow, b: BreakdownRow): number {
  if (a.sum !== b.sum) return a.sum > b.sum ? -1 : 1;
  return a.label.localeCompare(b.label);
}

function withShares(rows: Omit<BreakdownRow, 'share'>[], total: bigint): BreakdownRow[] {
  return rows
    .map((row) => ({
      ...row,
      share: total > 0n ? Number(row.sum) / Number(total) : null,
    }))
    .sort(byDescendingSum);
}

async function breakdownsOf(
  side: 'income' | 'expenses',
  cells: readonly CategoryMonthCellWithLines[],
  total: bigint,
  rowsById: ReadonlyMap<string, ReportRow>,
  input: Pick<CashFlowInput, 'merchantNames'> & { readonly categories: readonly CategoryInfo[] },
  window: { readonly from: DateOnlyType; readonly to: DateOnlyType },
  weightOf: (lineId: string) => number,
): Promise<Breakdowns> {
  const sign = side === 'income' ? 1n : -1n;
  const categoryById = new Map(
    input.categories.map((category) => [category.id, category] as const),
  );
  const childrenOf = new Map<string, string[]>();
  for (const category of input.categories) {
    if (category.parentId === null) continue;
    const list = childrenOf.get(category.parentId);
    if (list === undefined) childrenOf.set(category.parentId, [category.id]);
    else list.push(category.id);
  }

  const categorySums = new Map<string | null, { sum: bigint; count: number }>();
  const groupSums = new Map<string | null, { sum: bigint; count: number }>();
  const merchantSums = new Map<string | null, { sum: bigint; count: number }>();
  const addTo = (
    target: Map<string | null, { sum: bigint; count: number }>,
    key: string | null,
    sum: bigint,
    count: number,
  ) => {
    const current = target.get(key) ?? { sum: 0n, count: 0 };
    target.set(key, { sum: current.sum + sum, count: current.count + count });
  };

  for (const cell of cells) {
    const amount = sign * cell.amount.minor;
    // A summed line counts the rows it stands for; `transactionCount` would count it once.
    const count = cell.lines.reduce((total, line) => total + weightOf(line.id), 0);
    addTo(categorySums, cell.categoryId, amount, count);
    const groupId =
      cell.categoryId === null
        ? null
        : (categoryById.get(cell.categoryId)?.parentId ?? cell.categoryId);
    addTo(groupSums, groupId, amount, count);
    for (const line of cell.lines) {
      addTo(
        merchantSums,
        rowsById.get(line.id)?.merchantId ?? null,
        sign * line.amount.minor,
        weightOf(line.id),
      );
    }
  }

  const categoryLabel = (id: string | null) =>
    id === null ? 'Uncategorised' : (categoryById.get(id)?.label ?? 'Unknown category');
  const categoryHueOf = (id: string | null) =>
    id === null ? 'neutral' : (categoryById.get(id)?.hue ?? hueForId(id));
  const span = { from: window.from, to: window.to };

  const category = withShares(
    [...categorySums].map(([key, value]) => ({
      key,
      label: categoryLabel(key),
      hue: categoryHueOf(key),
      sum: value.sum,
      count: value.count,
      drillThrough:
        key === null ? { ...span, uncategorized: true } : { categoryIds: [key], ...span },
    })),
    total,
  );
  const group = withShares(
    [...groupSums].map(([key, value]) => ({
      key,
      label: categoryLabel(key),
      hue: categoryHueOf(key),
      sum: value.sum,
      count: value.count,
      drillThrough:
        key === null
          ? { ...span, uncategorized: true }
          : { categoryIds: [key, ...(childrenOf.get(key) ?? [])], ...span },
    })),
    total,
  );
  const names = await input.merchantNames(
    [...merchantSums.keys()].filter((key): key is string => key !== null),
  );
  const merchant = withShares(
    [...merchantSums].map(([key, value]) => ({
      key,
      label: key === null ? 'No merchant' : (names.get(key) ?? 'Unknown merchant'),
      hue: key === null ? 'neutral' : hueForId(key),
      sum: value.sum,
      count: value.count,
      drillThrough: key === null ? null : { merchantIds: [key], ...span },
    })),
    total,
  );
  return { category, group, merchant };
}

export async function computeCashFlow(
  database: LedgerDatabase,
  input: CashFlowInput,
): Promise<CashFlowResult> {
  const current = periodContaining(input.timeframe, input.today);
  const selected =
    input.periodKey === null ? current : parsePeriodKey(input.timeframe, input.periodKey);
  if (selected === null) throw new Error(`not a ${input.timeframe}: ${input.periodKey ?? ''}`);
  const isCurrent = selected.key === current.key;
  const isFuture = DateOnly.isAfter(selected.start, input.today);
  const offsetDays = isCurrent
    ? DateOnly.toEpochDay(input.today) - DateOnly.toEpochDay(selected.start)
    : null;

  // One read, summed: the twelve trailing periods (the average; the year-ago counterpart is the twelfth for a month,
  // the fourth for a quarter, the first for a year) through the selected one, as `loadReportHistoryInOneRead`'s rows —
  // refunds and the purchases they name one by one, the rest summed by every field `computeActuals` and the
  // breakdowns read (merchant included), split at the day each counterpart of the current period is read to. On a
  // busy ledger that is a few thousand rows instead of tens of thousands (`cash-flow-http-perf.test.ts`).
  const earliest = shiftPeriod(selected, -TRAILING_PERIODS);
  const cuts: DateOnlyType[] = [];
  if (offsetDays !== null) {
    for (let back = 1; back <= TRAILING_PERIODS; back += 1) {
      const period = shiftPeriod(selected, -back);
      const to = DateOnly.addDays(period.start, offsetDays);
      if (DateOnly.isBefore(to, period.end)) cuts.push(to);
    }
  }
  const [history, accounts, categories] = await Promise.all([
    loadReportHistoryInOneRead(
      database,
      { userId: input.userId, dateFrom: earliest.start, dateTo: selected.end },
      cuts,
    ),
    loadReportAccounts(database, input.userId),
    input.categories,
  ]);
  const weights = new Map(history.sums.map((sum) => [sum.row.id, sum.count] as const));
  const weightOf = (id: string) => weights.get(id) ?? 1;
  const allRows = [...history.rows, ...history.sums.map((sum) => sum.row)];
  const { currency, others } = pickCurrency(allRows, accounts, weightOf);
  const rows = currency === null ? [] : allRows.filter((row) => row.amount.currency === currency);
  const incomeIds = new Set(
    categories.filter((category) => category.kind === 'income').map((category) => category.id),
  );

  const reader = windowReader(rows, accounts, incomeIds, transferCategoryIdsOf(categories));
  const rowsById = reader.rowsById;
  const hasRowsIn = (period: CashFlowPeriod) => reader.hasRows(period.start, period.end);

  // The bars and the average overlap in eleven periods; each window is computed once.
  const memo = new Map<string, WindowFigures>();

  /** Reports over `period`, or — for a counterpart of the current period — over as far into it as today is. */
  const figuresFor = (period: CashFlowPeriod, throughOffset: number | null): WindowFigures => {
    const to =
      throughOffset === null
        ? period.end
        : DateOnly.min(DateOnly.addDays(period.start, throughOffset), period.end);
    const memoKey = `${period.start}|${to}`;
    const known = memo.get(memoKey);
    if (known !== undefined) return known;
    const figures = figuresOf(
      reader.cells(period.start, to),
      period.start,
      to,
      hasRowsIn(period),
      weightOf,
    );
    memo.set(memoKey, figures);
    return figures;
  };

  const selectedCells = reader.cells(selected.start, selected.end);
  const summaryFigures = figuresOf(
    selectedCells,
    selected.start,
    selected.end,
    hasRowsIn(selected),
    weightOf,
  );

  const single = (kind: ComparisonKind, period: CashFlowPeriod): CashFlowComparison => {
    const figures = figuresFor(period, offsetDays);
    if (!figures.hasData) {
      return {
        kind,
        periods: [period.key],
        available: false,
        withheld: 'no_data',
        periodsAveraged: 0,
        throughOffsetDays: offsetDays,
        income: null,
        expenses: null,
        net: null,
      };
    }
    return {
      kind,
      periods: [period.key],
      available: true,
      withheld: null,
      periodsAveraged: 1,
      throughOffsetDays: offsetDays,
      income: figures.income,
      expenses: figures.expenses,
      net: figures.income - figures.expenses,
    };
  };

  const trailing = Array.from({ length: TRAILING_PERIODS }, (_unused, index) =>
    shiftPeriod(selected, index - TRAILING_PERIODS),
  );
  const averaged = trailing
    .map((period) => ({ period, figures: figuresFor(period, offsetDays) }))
    .filter((entry) => entry.figures.hasData);
  const averageIncome =
    averaged.length === 0
      ? null
      : divideHalfEven(
          averaged.reduce((sum, entry) => sum + entry.figures.income, 0n),
          BigInt(averaged.length),
        );
  const averageExpenses =
    averaged.length === 0
      ? null
      : divideHalfEven(
          averaged.reduce((sum, entry) => sum + entry.figures.expenses, 0n),
          BigInt(averaged.length),
        );
  const average: CashFlowComparison = {
    kind: 'average',
    periods: averaged.map((entry) => entry.period.key),
    available: averaged.length > 0,
    withheld: averaged.length > 0 ? null : 'no_history',
    periodsAveraged: averaged.length,
    throughOffsetDays: offsetDays,
    income: averageIncome,
    expenses: averageExpenses,
    // Net from the two rounded averages, so the three figures always add up on screen.
    net:
      averageIncome === null || averageExpenses === null ? null : averageIncome - averageExpenses,
  };

  const comparisons = [
    single('previous', shiftPeriod(selected, -1)),
    average,
    single('year_ago', shiftPeriod(selected, -periodsPerYear(input.timeframe))),
  ];

  const bars: CashFlowBar[] = Array.from({ length: TRAILING_PERIODS }, (_unused, index) => {
    const period = shiftPeriod(selected, index - (TRAILING_PERIODS - 1));
    return {
      ...figuresFor(period, null),
      period: period.key,
      complete: DateOnly.isBefore(period.end, input.today),
    };
  });

  const window = { from: selected.start, to: selected.end };
  const [incomeBreakdowns, expenseBreakdowns] = await Promise.all([
    breakdownsOf(
      'income',
      selectedCells.income,
      summaryFigures.income,
      rowsById,
      { ...input, categories },
      window,
      weightOf,
    ),
    breakdownsOf(
      'expenses',
      selectedCells.spending,
      summaryFigures.expenses,
      rowsById,
      { ...input, categories },
      window,
      weightOf,
    ),
  ]);

  return {
    timeframe: input.timeframe,
    period: selected,
    currentPeriod: current.key,
    isCurrent,
    isFuture,
    through: isCurrent ? input.today : null,
    currency,
    otherCurrencies: others,
    summary: { ...summaryFigures, ...savingsRateOf(summaryFigures, { isCurrent, isFuture }) },
    comparisons,
    bars,
    breakdowns: { income: incomeBreakdowns, expenses: expenseBreakdowns },
  };
}
