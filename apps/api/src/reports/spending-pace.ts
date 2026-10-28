// SPDX-License-Identifier: MIT
/**
 * The spending pace (WP 10.9; docs/research/10-visual-design-notes.md §1.4): this month's
 * cumulative spend by day of month, last month's, and the trailing three-month average, every day present.
 *
 * ## What counts as spend — Reports' definition, not a second one
 *
 * `cumulative(d)` is **exactly what `GET /reports/spending` reports for the window `[month start, day d]`**,
 * negated to a positive amount spent: the same rows (`loadReportRows`' filters and mapper, read in one
 * statement by `loadReportRowsInOneRead`), the same per-month `computeActuals` split
 * (`monthActualsOf`, shared with `computeCategoryMonthActivity`: transfers excluded on both legs, refunds netted
 * into the purchase's category, user-excluded rows and off-budget accounts dropped), and the same cell filter
 * (`spendingRowsOf`: every category that is not of kind `income`, and the uncategorised bucket only while it is
 * net negative). The day-by-day walk builds the cells Reports would build for each prefix of the month and hands
 * them to `spendingRowsOf` unchanged, so the curve's last point *is* the month's Reports total — asserted by
 * `apps/api/test/db/spending-pace-routes.test.ts`.
 *
 * One deliberate difference, dispatched: **pending rows are left out by default** (`includePending=false`), and
 * how many were left out is returned, because a pending card authorisation is routinely re-stated when it posts
 * and a pace that jumps back is worse than one that is a day late. Reports counts them; `includePending=true`
 * makes the two identical.
 *
 * No category in this schema carries an "excluded from reports" flag (checked: `categories` has `kind`, `hue`,
 * `is_system`, `archived_at`); the transaction-level `user_excluded` flag is honoured by `computeActuals`.
 *
 * ## Empty days are filled
 *
 * A day with no spend repeats the previous day's total (and day 1 with none is a real 0 for a month the ledger
 * has rows in), so the curve never jumps between two days that both exist. A month with **no ledger rows at all**
 * is not a month of zero spend — it is a month with no data — and is returned empty, never as a line of zeros.
 *
 * ## The trailing average
 *
 * The three calendar months before `month`, each read at day `min(d, its length)` (February's last day stands in
 * for its 29th–31st: by then the month was over), averaged over the months that have any ledger row in the
 * selected currency (a holder who connected last month has a one-month average, labelled as such) and rounded
 * half-even to the minor unit, once.
 */
import { DateOnly, Money, type DateOnly as DateOnlyType } from '@core/kernel';
import type { LedgerDatabase } from '@ctx/ledger';
import { loadReportAccounts, loadReportRowsInOneRead } from './ledger-source.ts';
import { monthActualsOf, spendingRowsOf, type MonthActuals } from './spending-income.ts';
import type { CategoryMonthActivity, ReportAccount, ReportRow } from './types.ts';

export interface SpendingPaceInput {
  readonly userId: string;
  /** `YYYY-MM`. */
  readonly month: string;
  /** Today, in the holder's zone. Decides how far into `month` the current curve runs. */
  readonly today: DateOnlyType;
  readonly includePending: boolean;
  /** `@ctx/categorization` categories of kind `income` — the same set `GET /reports/spending` passes. */
  readonly incomeCategoryIds: ReadonlySet<string>;
  /** Categories of kind `transfer` — neither spending nor income (WP 11.2b made tier 4 effective). */
  readonly transferCategoryIds: ReadonlySet<string>;
}

export interface PaceDay {
  readonly day: number;
  /** Spent through this day, as a positive amount (a refund-heavy month can go below zero). */
  readonly cumulative: Money;
}

export interface SpendingPace {
  readonly month: string;
  /** The currency every series is in; `null` when the ledger has no row in the window at all. */
  readonly currency: string | null;
  /** Other currencies with rows in the window, not drawn (decision D4: never summed across currencies). */
  readonly otherCurrencies: readonly string[];
  readonly daysInMonth: number;
  /** Day of month of `today` when `month` is the current month; `null` for a past or a future month. */
  readonly today: number | null;
  /** 1…`throughDay`: the whole month when it is past, up to today when current, none when future. */
  readonly days: readonly PaceDay[];
  readonly lastMonthKey: string;
  /** 1…days in last month; empty when last month has no ledger row. */
  readonly lastMonth: readonly PaceDay[];
  /** The months averaged (those of the three before `month` that have any ledger row). */
  readonly trailingMonths: readonly string[];
  /** 1…`daysInMonth`; empty when none of the three months has a ledger row. */
  readonly trailingAverage: readonly PaceDay[];
  readonly includePending: boolean;
  /** Pending rows left out of the curves (0 when `includePending`). */
  readonly pendingExcludedCount: number;
}

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/u;

export function parseMonth(text: string): { readonly year: number; readonly month: number } | null {
  const match = MONTH_PATTERN.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || year < 1900 || year > 9999) return null;
  return { year, month };
}

function monthKey(date: DateOnlyType): string {
  return date.slice(0, 7);
}

function firstOf(month: string): DateOnlyType {
  const parsed = parseMonth(month);
  if (parsed === null) throw new Error(`not a month: ${month}`);
  return DateOnly.of(parsed.year, parsed.month, 1);
}

function lengthOf(first: DateOnlyType): number {
  return DateOnly.daysInMonth(DateOnly.year(first), DateOnly.month(first));
}

/** Half-even division of exact integers; `denominator > 0`. */
export function divideHalfEven(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;
  if (remainder === 0n) return quotient;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const away = numerator < 0n ? quotient - 1n : quotient + 1n;
  if (twice > denominator) return away;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : away;
}

/**
 * Spent through each day 1…`length` of one month, from that month's `computeActuals` split: for every day, the
 * cells Reports would hold for `[month start, d]` (each line's transactions up to `d`, summed), through
 * `spendingRowsOf`, summed and negated. Days with nothing new repeat the day before (`fillEmptyValues`).
 */
export function cumulativeSpendByDay(
  actuals: MonthActuals,
  length: number,
  incomeCategoryIds: ReadonlySet<string>,
  transferCategoryIds: ReadonlySet<string>,
): bigint[] {
  const lines = [...actuals.byCategory.values()].map((activity) => {
    const daily = new Array<bigint>(length).fill(0n);
    for (const transaction of activity.transactions) {
      const day = DateOnly.day(DateOnly.parse(transaction.budgetDate));
      if (day >= 1 && day <= length)
        daily[day - 1] = (daily[day - 1] ?? 0n) + transaction.amount.minor;
    }
    return { activity, daily };
  });
  const running = new Array<bigint>(lines.length).fill(0n);
  const out: bigint[] = [];
  for (let d = 0; d < length; d += 1) {
    const cells: CategoryMonthActivity[] = lines.map((line, index) => {
      running[index] = (running[index] ?? 0n) + (line.daily[d] ?? 0n);
      return {
        month: actuals.month,
        categoryId: line.activity.categoryId,
        currency: actuals.currency,
        amount: Money.of(running[index] ?? 0n, actuals.currency),
        transactionCount: line.activity.transactionCount,
        transferExcludedCount: line.activity.transferExcludedCount,
        refundNettedCount: line.activity.refundNettedCount,
      };
    });
    const spent = spendingRowsOf(cells, incomeCategoryIds, transferCategoryIds).reduce(
      (total, cell) => total - cell.amount.minor,
      0n,
    );
    out.push(spent);
  }
  return out;
}

export function pickCurrency(
  rows: readonly ReportRow[],
  accounts: readonly ReportAccount[],
  weightOf: (id: string) => number = () => 1,
): { readonly currency: string | null; readonly others: string[] } {
  const counts = new Map<string, number>();
  for (const row of rows)
    counts.set(row.amount.currency, (counts.get(row.amount.currency) ?? 0) + weightOf(row.id));
  if (counts.size === 0) {
    // No row anywhere in the window: name the currency the holder's budgeted accounts are in, if any, so the
    // empty response still says what it would have been in.
    const onBudget = accounts.filter((account) => account.role !== 'OFF_BUDGET');
    const first = [...new Set(onBudget.map((account) => account.currency))].sort()[0];
    return { currency: first ?? null, others: [] };
  }
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return {
    currency: ordered[0]![0],
    others: ordered
      .slice(1)
      .map(([code]) => code)
      .sort(),
  };
}

function toDays(values: readonly bigint[], currency: string): PaceDay[] {
  return values.map((minor, index) => ({ day: index + 1, cumulative: Money.of(minor, currency) }));
}

export async function computeSpendingPace(
  database: LedgerDatabase,
  input: SpendingPaceInput,
): Promise<SpendingPace> {
  const first = firstOf(input.month);
  const length = lengthOf(first);
  const last = DateOnly.addDays(first, length - 1);
  const trailingFirst = DateOnly.addMonths(first, -3);
  const lastMonthFirst = DateOnly.addMonths(first, -1);
  const lastMonthKey = monthKey(lastMonthFirst);
  const trailingKeys = [-3, -2, -1].map((offset) => monthKey(DateOnly.addMonths(first, offset)));

  // One read per series: this month, and the three months before it (last month is the newest of those). Each is
  // Reports' own filters and row mapper (`loadReportRowsInOneRead`), one statement over the feed index
  // `(user_id, effective_date, id)`.
  const [currentRows, trailingRows, accounts] = await Promise.all([
    loadReportRowsInOneRead(database, { userId: input.userId, dateFrom: first, dateTo: last }),
    loadReportRowsInOneRead(database, {
      userId: input.userId,
      dateFrom: trailingFirst,
      dateTo: DateOnly.addDays(first, -1),
    }),
    loadReportAccounts(database, input.userId),
  ]);

  const { currency, others } = pickCurrency([...currentRows, ...trailingRows], accounts);

  const todayInMonth = monthKey(input.today) === input.month;
  const throughDay = todayInMonth
    ? DateOnly.day(input.today)
    : DateOnly.isBefore(input.today, first)
      ? 0
      : length;

  const base = {
    month: input.month,
    otherCurrencies: others,
    daysInMonth: length,
    today: todayInMonth ? DateOnly.day(input.today) : null,
    lastMonthKey,
    includePending: input.includePending,
  };

  if (currency === null) {
    return {
      ...base,
      currency: null,
      days: [],
      lastMonth: [],
      trailingMonths: [],
      trailingAverage: [],
      pendingExcludedCount: 0,
    };
  }

  const inCurrency = (row: ReportRow) => row.amount.currency === currency;
  const counted = (row: ReportRow) => input.includePending || !row.pending;
  const pendingExcludedCount = input.includePending
    ? 0
    : [...currentRows, ...trailingRows].filter((row) => inCurrency(row) && row.pending).length;

  // A month "has data" when the ledger holds any row for it in this currency — a transfer, an income, a pending
  // charge. Such a month with no spend is a real zero; a month with no row at all is no data and is not drawn.
  const monthsWithRows = new Set(
    [...currentRows, ...trailingRows].filter(inCurrency).map((row) => monthKey(row.date)),
  );

  const actualsByMonth = new Map<string, MonthActuals>();
  for (const actuals of monthActualsOf(
    currentRows.filter((row) => inCurrency(row) && counted(row)),
    accounts,
  )) {
    actualsByMonth.set(actuals.month, actuals);
  }
  for (const actuals of monthActualsOf(
    trailingRows.filter((row) => inCurrency(row) && counted(row)),
    accounts,
  )) {
    actualsByMonth.set(actuals.month, actuals);
  }

  const curveOf = (key: string, monthLength: number): bigint[] => {
    const actuals = actualsByMonth.get(key);
    if (actuals === undefined) return new Array<bigint>(monthLength).fill(0n);
    return cumulativeSpendByDay(
      actuals,
      monthLength,
      input.incomeCategoryIds,
      input.transferCategoryIds,
    );
  };

  const currentCurve =
    monthsWithRows.has(input.month) || throughDay > 0 ? curveOf(input.month, length) : [];
  const days = monthsWithRows.size === 0 ? [] : toDays(currentCurve.slice(0, throughDay), currency);

  const lastMonthLength = lengthOf(lastMonthFirst);
  const lastMonth = monthsWithRows.has(lastMonthKey)
    ? toDays(curveOf(lastMonthKey, lastMonthLength), currency)
    : [];

  const trailingMonths = trailingKeys.filter((key) => monthsWithRows.has(key));
  const trailingCurves = trailingMonths.map((key) => {
    const monthLength = lengthOf(firstOf(key));
    return { monthLength, curve: curveOf(key, monthLength) };
  });
  const trailingAverage =
    trailingCurves.length === 0
      ? []
      : toDays(
          Array.from({ length }, (_unused, index) => {
            const total = trailingCurves.reduce(
              (sum, { monthLength, curve }) =>
                sum + (curve[Math.min(index, monthLength - 1)] ?? 0n),
              0n,
            );
            return divideHalfEven(total, BigInt(trailingCurves.length));
          }),
          currency,
        );

  return {
    ...base,
    currency,
    days,
    lastMonth,
    trailingMonths,
    trailingAverage,
    pendingExcludedCount,
  };
}
