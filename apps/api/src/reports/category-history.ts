// SPDX-License-Identifier: MIT
/**
 * One category's last thirteen months (WP 10.14, V7; docs/research/10-visual-design-notes.md §1.4,
 * Monarch's category detail screen): each month's amount, the average of the complete months, and this month so far
 * against that average.
 *
 * ## A month's amount is the Cash Flow hub's, never a second predicate
 *
 * The rows are `loadReportHistoryInOneRead`'s over the window (no cuts: every window here ends on a month end), and a
 * month's cells are `windowReader(...).cells(month start, month end)` — exactly the cells `GET /reports/cash-flow`
 * breaks a month down by and `GET /reports/spending` / `GET /reports/income` report for that month: transfers out on
 * both legs, refunds netted into the purchase's category (when the purchase is in the same month, as the month's own
 * report nets it), holder-excluded rows and off-budget accounts dropped, pending rows counted. The spending side's
 * amount is −Σ of the category's spending cells (money out as a positive amount; a refund-heavy month can be
 * negative), the income side's is Σ of its income cells. A heading sums its children (archived included), as the
 * hub's group breakdown does.
 *
 * ## Honesty
 *
 *  - **History starts at the holder's first ledger row** (any category, any currency). A month before it is not in
 *    history and is never averaged as a zero; a month in history with no spend in this category **is** a zero and is
 *    averaged as one, because "nothing spent" is a fact about that month.
 *  - **The current month is so far.** It is never in the average, and the comparison reads it as "this month so far".
 *  - **The average needs two complete months in history** (`insufficient_history` below that), and is withheld as
 *    `no_data` when the ledger has no row at all.
 *  - **One currency** — the one this category's rows are mostly in (`pickCurrency`, weighted by the rows a summed row
 *    stands for), else the one the whole window is mostly in; the others are named, never converted (decision D4).
 */
import { DateOnly, type DateOnly as DateOnlyType } from '@core/kernel';
import { listTransactions, type LedgerDatabase } from '@ctx/ledger';
import { windowReader, type CategoryInfo } from './cash-flow.ts';
import { loadReportAccounts, loadReportHistoryInOneRead } from './ledger-source.ts';
import { divideHalfEven, pickCurrency } from './spending-pace.ts';
import type { DrillThroughFilter, ReportRow } from './types.ts';

/** The window: twelve complete months before the current one, plus the current one. */
export const HISTORY_MONTHS = 13;

/** Fewer complete months in history than this and the average is withheld. */
export const MIN_AVERAGED_MONTHS = 2;

export type HistoryWithheld = 'insufficient_history' | 'no_data';

export interface WindowMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  /** Inclusive. */
  readonly start: DateOnlyType;
  /** Inclusive. */
  readonly end: DateOnlyType;
}

export interface CategoryHistoryMonth extends WindowMonth {
  /** This side's amount: money out for spending (as a positive amount), money in for income. */
  readonly amount: bigint;
  /** Rows behind `amount` (a summed history row counts the rows it stands for). */
  readonly transactionCount: number;
  /** Any cell for the category (or its children) that month. False with `amount` 0 is a real zero. */
  readonly hasActivity: boolean;
  /** The month has ended (every month but the current one). */
  readonly complete: boolean;
  readonly isCurrent: boolean;
  /** On or after the month of the holder's first ledger row. */
  readonly inHistory: boolean;
}

export interface HistoryAverage {
  readonly available: boolean;
  readonly withheld: HistoryWithheld | null;
  readonly amount: bigint | null;
  readonly monthsAveraged: number;
  /** The months averaged, oldest first. */
  readonly months: readonly string[];
}

export interface HistoryComparison {
  readonly available: boolean;
  readonly withheld: HistoryWithheld | null;
  /** The current month so far. Always present: it is a fact even when there is nothing to compare it with. */
  readonly thisMonth: bigint;
  readonly average: bigint | null;
  /** `thisMonth − average`, signed. */
  readonly difference: bigint | null;
  readonly direction: 'more' | 'less' | 'same' | null;
}

export interface CategoryHistoryResult {
  readonly categoryId: string;
  readonly side: 'spending' | 'income';
  readonly includesChildren: boolean;
  readonly categoryIds: readonly string[];
  readonly currency: string | null;
  readonly otherCurrencies: readonly string[];
  readonly currentMonth: string;
  readonly through: DateOnlyType;
  readonly historyStart: string | null;
  readonly months: readonly CategoryHistoryMonth[];
  readonly average: HistoryAverage;
  readonly comparison: HistoryComparison;
  readonly drillThrough: DrillThroughFilter;
}

/** The thirteen months ending with the one `today` is in, oldest first. */
export function windowMonths(today: DateOnlyType): WindowMonth[] {
  const current = DateOnly.startOfMonth(today);
  return Array.from({ length: HISTORY_MONTHS }, (_unused, index) => {
    const start = DateOnly.addMonths(current, index - (HISTORY_MONTHS - 1));
    return { month: start.slice(0, 7), start, end: DateOnly.endOfMonth(start) };
  });
}

/**
 * The first window month that is in history: the window's first month when the ledger has a row before the window,
 * else the month of the earliest row inside it, else `null` (no row at all).
 */
export function historyStartOf(
  window: readonly WindowMonth[],
  anyRowBeforeWindow: boolean,
  earliestRowInWindow: DateOnlyType | null,
): string | null {
  const first = window[0];
  if (first === undefined) return null;
  if (anyRowBeforeWindow) return first.month;
  return earliestRowInWindow === null ? null : earliestRowInWindow.slice(0, 7);
}

/**
 * The average and the comparison over `months` (pure; `apps/api/test/category-history.test.ts`).
 *
 * The average is over every month that is **complete and in history** — a zero month included, the current month
 * never — rounded half-even to a minor unit, and withheld below `MIN_AVERAGED_MONTHS` (`insufficient_history`) or
 * when the ledger has no row at all (`noData`, `no_data`). The comparison is the current month so far against it,
 * withheld for the same reason.
 */
export function historyFigures(
  months: readonly CategoryHistoryMonth[],
  noData: boolean,
): { readonly average: HistoryAverage; readonly comparison: HistoryComparison } {
  const thisMonth = months.find((month) => month.isCurrent)?.amount ?? 0n;
  const averaged = months.filter((month) => month.complete && month.inHistory);
  const withheld: HistoryWithheld | null = noData
    ? 'no_data'
    : averaged.length < MIN_AVERAGED_MONTHS
      ? 'insufficient_history'
      : null;

  if (withheld !== null) {
    return {
      average: {
        available: false,
        withheld,
        amount: null,
        monthsAveraged: 0,
        months: [],
      },
      comparison: {
        available: false,
        withheld,
        thisMonth,
        average: null,
        difference: null,
        direction: null,
      },
    };
  }

  const amount = divideHalfEven(
    averaged.reduce((sum, month) => sum + month.amount, 0n),
    BigInt(averaged.length),
  );
  const difference = thisMonth - amount;
  return {
    average: {
      available: true,
      withheld: null,
      amount,
      monthsAveraged: averaged.length,
      months: averaged.map((month) => month.month),
    },
    comparison: {
      available: true,
      withheld: null,
      thisMonth,
      average: amount,
      difference,
      direction: difference > 0n ? 'more' : difference < 0n ? 'less' : 'same',
    },
  };
}

export interface CategoryHistoryInput {
  readonly userId: string;
  readonly categoryId: string;
  /** Today, in the holder's zone. */
  readonly today: DateOnlyType;
  /** Every category the holder has, archived included (a heading's archived child still counts). */
  readonly categories: readonly CategoryInfo[];
}

/** `null` when `categoryId` is not one of `categories` (the route's 404). */
export async function computeCategoryHistory(
  database: LedgerDatabase,
  input: CategoryHistoryInput,
): Promise<CategoryHistoryResult | null> {
  const category = input.categories.find((candidate) => candidate.id === input.categoryId);
  if (category === undefined) return null;
  const children = input.categories
    .filter((candidate) => candidate.parentId === category.id)
    .map((candidate) => candidate.id);
  const ids = [category.id, ...children];
  const idSet = new Set(ids);
  const side = category.kind === 'income' ? 'income' : 'spending';

  const window = windowMonths(input.today);
  const first = window[0]!;
  const last = window[window.length - 1]!;

  const [history, accounts, before] = await Promise.all([
    loadReportHistoryInOneRead(
      database,
      { userId: input.userId, dateFrom: first.start, dateTo: last.end },
      [],
    ),
    loadReportAccounts(database, input.userId),
    // "Is there any ledger row before the window?" — one bounded read, the report filters' own (transfers and
    // excluded rows in, duplicates out).
    listTransactions(database, {
      userId: input.userId,
      filters: {
        dateTo: DateOnly.addDays(first.start, -1),
        transfers: 'include',
        includeDuplicates: false,
      },
      limit: 1,
    }),
  ]);

  const weights = new Map(history.sums.map((sum) => [sum.row.id, sum.count] as const));
  const weightOf = (id: string) => weights.get(id) ?? 1;
  const allRows: ReportRow[] = [...history.rows, ...history.sums.map((sum) => sum.row)];
  const own = allRows.filter((row) => row.categoryId !== null && idSet.has(row.categoryId));
  const picked =
    own.length > 0
      ? pickCurrency(own, accounts, weightOf)
      : pickCurrency(allRows, accounts, weightOf);
  const currency = picked.currency;
  const otherCurrencies = picked.others;
  const rows = currency === null ? [] : allRows.filter((row) => row.amount.currency === currency);

  let earliest: DateOnlyType | null = null;
  for (const row of allRows) {
    if (earliest === null || DateOnly.isBefore(row.date, earliest)) earliest = row.date;
  }
  const historyStart = historyStartOf(window, before.items.length > 0, earliest);

  const incomeIds = new Set(
    input.categories
      .filter((candidate) => candidate.kind === 'income')
      .map((candidate) => candidate.id),
  );
  const reader = windowReader(rows, accounts, incomeIds);
  const currentMonth = last.month;

  const months: CategoryHistoryMonth[] = window.map((month) => {
    const cells = reader.cells(month.start, month.end);
    const spending = cells.spending.filter(
      (cell) => cell.categoryId !== null && idSet.has(cell.categoryId),
    );
    const income = cells.income.filter(
      (cell) => cell.categoryId !== null && idSet.has(cell.categoryId),
    );
    const sideCells = side === 'income' ? income : spending;
    const amount =
      side === 'income'
        ? sideCells.reduce((sum, cell) => sum + cell.amount.minor, 0n)
        : sideCells.reduce((sum, cell) => sum - cell.amount.minor, 0n);
    const transactionCount = sideCells.reduce(
      (sum, cell) => sum + cell.lines.reduce((lines, line) => lines + weightOf(line.id), 0),
      0,
    );
    const isCurrent = month.month === currentMonth;
    return {
      ...month,
      amount,
      transactionCount,
      hasActivity: spending.length + income.length > 0,
      complete: !isCurrent,
      isCurrent,
      inHistory: historyStart !== null && month.month >= historyStart,
    };
  });

  const { average, comparison } = historyFigures(
    months,
    currency === null || historyStart === null,
  );

  return {
    categoryId: category.id,
    side,
    includesChildren: children.length > 0,
    categoryIds: ids,
    currency,
    otherCurrencies,
    currentMonth,
    through: input.today,
    historyStart,
    months,
    average,
    comparison,
    drillThrough: { categoryIds: [...ids], from: first.start, to: last.end },
  };
}
