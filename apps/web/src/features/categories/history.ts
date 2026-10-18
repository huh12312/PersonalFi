// SPDX-License-Identifier: MIT
import { formatDateOnly } from '../../lib/date.ts';
import { formatMoney, parseWireMoney } from '../../lib/money.ts';

/**
 * The category detail screen's arithmetic and words (WP 10.14, V7; with "This month vs. average month (last 12 months)"). Pure, so the honesty rules are tested
 * without a chart:
 *
 *  - every month of the 13 is a bar: a month **with no spend is a zero**, drawn as a zero stub and listed as
 *    "No spend" — never silently missing; a month before the ledger's first row has no bar and says so;
 *  - the average is the server's (`GET /reports/category-history`): the 12-complete-month mean, zero months
 *    included, the current month never in it; and it is **withheld with its reason** when fewer than two
 *    complete months are in the ledger's history — the web re-checks that count rather than trusting a flag;
 *  - the comparison is a sentence in money with a direction word and both amounts, never a bare percentage.
 */

export type HistorySide = 'spending' | 'income';
export type HistoryWithheld = 'insufficient_history' | 'no_data';

export interface HistoryMonth {
  /** `YYYY-MM`. */
  readonly month: string;
  readonly start: string;
  readonly end: string;
  /** Positive = spent (spending side) or received (income side); a refund-heavy month can be negative. */
  readonly amountMinor: bigint;
  readonly transactionCount: number;
  readonly hasActivity: boolean;
  readonly complete: boolean;
  readonly isCurrent: boolean;
  readonly inHistory: boolean;
}

export interface HistoryView {
  readonly side: HistorySide;
  readonly currency: string | null;
  readonly otherCurrencies: readonly string[];
  readonly currentMonth: string;
  readonly through: string;
  readonly months: readonly HistoryMonth[];
  readonly average: {
    readonly available: boolean;
    readonly withheld: HistoryWithheld | null;
    readonly amountMinor: bigint | null;
    readonly monthsAveraged: number;
  };
  readonly comparison: {
    readonly thisMonthMinor: bigint;
    readonly differenceMinor: bigint | null;
    readonly direction: 'more' | 'less' | 'same' | null;
  };
}

/** The wire shape (`CategoryHistory`), structurally — minor units as strings. */
export interface HistoryWire {
  readonly side: HistorySide;
  readonly currency: string | null;
  readonly otherCurrencies: readonly string[];
  readonly currentMonth: string;
  readonly through: string;
  readonly months: readonly {
    readonly month: string;
    readonly start: string;
    readonly end: string;
    readonly amountMinor: string;
    readonly transactionCount: number;
    readonly hasActivity: boolean;
    readonly complete: boolean;
    readonly isCurrent: boolean;
    readonly inHistory: boolean;
  }[];
  readonly average: {
    readonly available: boolean;
    readonly withheld: HistoryWithheld | null;
    readonly amountMinor: string | null;
    readonly monthsAveraged: number;
  };
  readonly comparison: {
    readonly thisMonthMinor: string;
    readonly differenceMinor: string | null;
    readonly direction: 'more' | 'less' | 'same' | null;
  };
}

export function historyOf(wire: HistoryWire): HistoryView {
  return {
    side: wire.side,
    currency: wire.currency,
    otherCurrencies: wire.otherCurrencies,
    currentMonth: wire.currentMonth,
    through: wire.through,
    months: wire.months.map((month) => ({ ...month, amountMinor: BigInt(month.amountMinor) })),
    average: {
      available: wire.average.available,
      withheld: wire.average.withheld,
      amountMinor: wire.average.amountMinor === null ? null : BigInt(wire.average.amountMinor),
      monthsAveraged: wire.average.monthsAveraged,
    },
    comparison: {
      thisMonthMinor: BigInt(wire.comparison.thisMonthMinor),
      differenceMinor:
        wire.comparison.differenceMinor === null ? null : BigInt(wire.comparison.differenceMinor),
      direction: wire.comparison.direction,
    },
  };
}

/** The fewest complete months an average may be drawn from. One month is not an average; it is that month. */
export const MIN_MONTHS_FOR_AVERAGE = 2;

/** Complete months inside the ledger's history: what the average may be over. */
export function averageableMonths(view: HistoryView): readonly HistoryMonth[] {
  return view.months.filter((month) => month.complete && month.inHistory && !month.isCurrent);
}

/**
 * The average to draw and say, or null when it must be withheld: the server's figure, but only when the server
 * says it is available **and** there are at least two complete months in history to stand behind it.
 */
export function shownAverage(view: HistoryView): bigint | null {
  if (!view.average.available || view.average.amountMinor === null) return null;
  if (view.average.monthsAveraged < MIN_MONTHS_FOR_AVERAGE) return null;
  if (averageableMonths(view).length < MIN_MONTHS_FOR_AVERAGE) return null;
  return view.average.amountMinor;
}

export function money(minor: bigint, currency: string): string {
  return formatMoney(parseWireMoney({ minor: minor.toString(), currency }), {
    signDisplay: 'auto',
  });
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/** "spent" / "received": what the amount is, in a verb. */
export function verbOf(side: HistorySide): string {
  return side === 'income' ? 'received' : 'spent';
}

/** The month as words: "March 2026". */
export function monthLabel(month: HistoryMonth | string): string {
  const key = typeof month === 'string' ? month : month.month;
  return formatDateOnly(`${key}-01`, 'MMMM yyyy');
}

/** The tick under a bar: "Mar". January also carries its year, so a year boundary is visible. */
export function tickLabel(month: HistoryMonth): string {
  return month.month.endsWith('-01')
    ? formatDateOnly(`${month.month}-01`, "MMM ''yy")
    : formatDateOnly(`${month.month}-01`, 'MMM');
}

/** `amount` against `average`, as a phrase: "$52.10 more than your average month of $412.30". */
export function versusAverage(amount: bigint, average: bigint, currency: string): string {
  const difference = amount - average;
  if (difference === 0n) return `the same as your average month of ${money(average, currency)}`;
  const word = difference > 0n ? 'more' : 'less';
  return `${money(absolute(difference), currency)} ${word} than your average month of ${money(average, currency)}`;
}

export interface ComparisonSentence {
  /** "This month vs. average month (last 12 months)" — the heading the sentence answers. */
  readonly heading: string;
  readonly text: string;
  readonly withheld: boolean;
}

export const COMPARISON_HEADING = 'This month vs. average month (last 12 months)';

/**
 * The hero's sentence: this month so far against the 12-complete-month average, in money with a direction word
 * and both amounts; or, withheld, why.
 */
export function comparisonSentence(view: HistoryView): ComparisonSentence {
  if (view.currency === null) {
    return {
      heading: COMPARISON_HEADING,
      text: 'No transactions in this category yet, so there is nothing to compare.',
      withheld: true,
    };
  }
  const average = shownAverage(view);
  if (average === null) {
    const complete = averageableMonths(view).length;
    return {
      heading: COMPARISON_HEADING,
      text:
        `Not enough history for an average yet: it needs at least ${String(MIN_MONTHS_FOR_AVERAGE)} complete ` +
        `months, and your ledger has ${String(complete)}.`,
      withheld: true,
    };
  }
  const current = view.months.find((month) => month.isCurrent);
  const thisMonth = current?.amountMinor ?? view.comparison.thisMonthMinor;
  return {
    heading: COMPARISON_HEADING,
    text: `So far this month, ${versusAverage(thisMonth, average, view.currency)}.`,
    withheld: false,
  };
}

/** One month in words: the readout's text, the slider's value text and the keyboard announcement. */
export function monthSentence(view: HistoryView, index: number): string {
  const month = view.months[index];
  if (month === undefined || view.currency === null) return '';
  const label = `${monthLabel(month)}${month.isCurrent ? ' (so far)' : ''}`;
  if (!month.inHistory) return `${label}: before your ledger's first transaction.`;
  const amount = month.hasActivity
    ? `${money(month.amountMinor, view.currency)} ${verbOf(view.side)}`
    : `no ${view.side === 'income' ? 'income' : 'spend'}`;
  const average = shownAverage(view);
  const versus =
    average === null ? '' : `; ${versusAverage(month.amountMinor, average, view.currency)}`;
  return `${label}: ${amount}${versus}.`;
}

/** What a table cell says for a month's amount: the money, "No spend", or "Before your history". */
export function tableAmount(view: HistoryView, month: HistoryMonth): string {
  if (!month.inHistory) return "Before your ledger's first transaction";
  if (!month.hasActivity) return view.side === 'income' ? 'No income' : 'No spend';
  return money(month.amountMinor, view.currency ?? 'USD');
}

/** Arrow keys over the 13 months: ← ↓ back, → ↑ forward, Home the oldest, End the current. Null = not ours. */
export function moveSelection(count: number, current: number, key: string): number | null {
  if (count === 0) return null;
  switch (key) {
    case 'ArrowLeft':
    case 'ArrowDown':
      return Math.max(0, current - 1);
    case 'ArrowRight':
    case 'ArrowUp':
      return Math.min(count - 1, current + 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** The index of `month` (`YYYY-MM`) in the series, else the current month's, else the last. */
export function indexOfMonth(view: HistoryView, month: string | undefined): number {
  if (month !== undefined) {
    const found = view.months.findIndex((entry) => entry.month === month);
    if (found >= 0) return found;
  }
  const current = view.months.findIndex((entry) => entry.isCurrent);
  return current >= 0 ? current : view.months.length - 1;
}

/** The y-domain in minor units: zero always in it, every bar and the average inside it. */
export function domainOf(view: HistoryView): readonly [number, number] {
  let lo = 0;
  let hi = 0;
  for (const month of view.months) {
    if (!month.inHistory) continue;
    const value = Number(month.amountMinor);
    lo = Math.min(lo, value);
    hi = Math.max(hi, value);
  }
  const average = shownAverage(view);
  if (average !== null) {
    hi = Math.max(hi, Number(average));
    lo = Math.min(lo, Number(average));
  }
  if (hi === lo) hi = lo + 10_000;
  return [lo, hi];
}

/** The `/transactions`-shaped filter for one month of this category: its ids and the month's first and last day. */
export function monthFilter(
  categoryIds: readonly string[],
  month: HistoryMonth,
): { readonly categoryIds: string[]; readonly from: string; readonly to: string } {
  return { categoryIds: [...categoryIds], from: month.start, to: month.end };
}
