// SPDX-License-Identifier: MIT
import type {
  CashFlow,
  CashFlowBreakdownRow,
  CashFlowComparison,
} from '../../api/generated/types.gen.ts';
import { formatMoney, parseWireMoney } from '../../lib/money.ts';
import { periodLabel, type CashFlowTab, type Comparison, type Timeframe } from './view.ts';

/**
 * The Cash Flow hub's words and arithmetic (WP 10.10), apart from React so each rule is tested on its own: the
 * strip's figures, the savings rate or the reason it is withheld, the comparison sentences (money and a direction
 * word, never a bare percentage), and the breakdown tail folded into "Other" without losing a cent.
 */

export type Figure = 'income' | 'expenses' | 'net';

export function money(
  minor: string | bigint,
  currency: string,
  signDisplay: 'auto' | 'never' | 'exceptZero' = 'never',
): string {
  return formatMoney(parseWireMoney({ minor: String(minor), currency }), { signDisplay });
}

export function figureMinor(
  figures: Pick<CashFlow['summary'], 'incomeMinor' | 'expensesMinor' | 'netMinor'>,
  figure: Figure,
): bigint {
  return BigInt(
    figure === 'income'
      ? figures.incomeMinor
      : figure === 'expenses'
        ? figures.expensesMinor
        : figures.netMinor,
  );
}

/** The figures a tab leads with: all three and the rate on Cash flow; the one side on Income and Spending. */
export function figuresFor(tab: CashFlowTab): readonly Figure[] {
  if (tab === 'income') return ['income'];
  if (tab === 'spending') return ['expenses'];
  return ['income', 'expenses', 'net'];
}

export function figureName(figure: Figure): string {
  return figure === 'income' ? 'Income' : figure === 'expenses' ? 'Expenses' : 'Net cash flow';
}

/** The signed amount a strip tile shows: money in positive, money out negative (docs/CONVENTIONS.md's sign rule). */
export function signedFigureMinor(
  figures: Pick<CashFlow['summary'], 'incomeMinor' | 'expensesMinor' | 'netMinor'>,
  figure: Figure,
): bigint {
  const value = figureMinor(figures, figure);
  return figure === 'expenses' ? -value : value;
}

const PERCENT = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

export type SavingsRate =
  | { readonly kind: 'shown'; readonly text: string; readonly rate: number }
  | { readonly kind: 'withheld'; readonly reason: string };

/** The savings rate as a percentage, or the sentence that says why there is none. */
export function savingsRateOf(summary: CashFlow['summary'], timeframe: Timeframe): SavingsRate {
  const unit = timeframe;
  switch (summary.savingsRateWithheld) {
    case 'incomplete':
      return {
        kind: 'withheld',
        reason: `Shown once the ${unit} is over: pay lands unevenly, so a rate so far would mislead.`,
      };
    case 'no_income':
      return {
        kind: 'withheld',
        reason: `No income this ${unit}, so there is no rate to work out.`,
      };
    case 'no_data':
      return { kind: 'withheld', reason: `No transactions this ${unit}.` };
    case 'not_started':
      return { kind: 'withheld', reason: `This ${unit} hasn't started.` };
    case null:
      break;
  }
  // The server withholds at zero income; this guard keeps a malformed body from dividing by zero on screen.
  if (summary.savingsRate === null || BigInt(summary.incomeMinor) <= 0n) {
    return { kind: 'withheld', reason: `No income this ${unit}, so there is no rate to work out.` };
  }
  return { kind: 'shown', rate: summary.savingsRate, text: PERCENT.format(summary.savingsRate) };
}

export const COMPARISON_LABELS: Readonly<Record<Comparison, (timeframe: Timeframe) => string>> = {
  previous: (timeframe) => `vs last ${timeframe}`,
  average: (timeframe) => `vs 12-${timeframe} average`,
  year_ago: (timeframe) =>
    timeframe === 'year' ? 'vs last year' : `vs same ${timeframe} last year`,
};

export type Tone = 'good' | 'bad' | 'neutral';
export type Direction = 'up' | 'down' | 'same';

export interface ComparisonLine {
  readonly figure: Figure;
  readonly direction: Direction;
  readonly tone: Tone;
  /** The whole sentence, money in it: "Expenses: $40.00 less than last month at this point ($10.00 against $50.00)." */
  readonly text: string;
}

export type ComparisonResult =
  | { readonly kind: 'withheld'; readonly reason: string }
  | {
      readonly kind: 'shown';
      readonly counterpart: string;
      readonly lines: readonly ComparisonLine[];
    };

function counterpartName(
  comparison: CashFlowComparison,
  timeframe: Timeframe,
  soFar: boolean,
): string {
  const atThisPoint = soFar ? ' at this point' : '';
  if (comparison.kind === 'previous') return `last ${timeframe}${atThisPoint}`;
  if (comparison.kind === 'average') {
    const n = comparison.periodsAveraged;
    return n >= 12
      ? `your 12-${timeframe} average${atThisPoint}`
      : `your average over the ${String(n)} ${timeframe}${n === 1 ? '' : 's'} with transactions${atThisPoint}`;
  }
  const key = comparison.periods[0];
  return `${key === undefined ? `last ${timeframe}` : periodLabel(timeframe, key)}${atThisPoint}`;
}

const WORDS: Readonly<Record<Figure, { up: string; down: string; upTone: Tone; downTone: Tone }>> =
  {
    income: { up: 'more', down: 'less', upTone: 'good', downTone: 'bad' },
    expenses: { up: 'more', down: 'less', upTone: 'bad', downTone: 'good' },
    net: { up: 'higher', down: 'lower', upTone: 'good', downTone: 'bad' },
  };

/** One comparison, as sentences per figure — or withheld, with what is missing. */
export function comparisonOf(
  data: Pick<CashFlow, 'summary' | 'currency' | 'isCurrent' | 'period'>,
  comparison: CashFlowComparison,
  figures: readonly Figure[],
  timeframe: Timeframe,
): ComparisonResult {
  if (!comparison.available) {
    if (comparison.withheld === 'no_history') {
      return {
        kind: 'withheld',
        reason: `No average yet: none of the 12 ${timeframe}s before ${periodLabel(timeframe, data.period)} has transactions.`,
      };
    }
    const key = comparison.periods[0];
    return {
      kind: 'withheld',
      reason: `No comparison: ${key === undefined ? `the other ${timeframe}` : periodLabel(timeframe, key)} has no transactions.`,
    };
  }
  const currency = data.currency ?? 'USD';
  const counterpart = counterpartName(comparison, timeframe, data.isCurrent);
  const lines = figures.map((figure): ComparisonLine => {
    const current = figureMinor(data.summary, figure);
    const otherText =
      figure === 'income'
        ? comparison.incomeMinor
        : figure === 'expenses'
          ? comparison.expensesMinor
          : comparison.netMinor;
    const other = BigInt(otherText ?? '0');
    const delta = current - other;
    const words = WORDS[figure];
    const sign = figure === 'net' ? 'auto' : 'never';
    const pair = `${money(current, currency, sign)} against ${money(other, currency, sign)}`;
    if (delta === 0n) {
      return {
        figure,
        direction: 'same',
        tone: 'neutral',
        text: `${figureName(figure)}: the same as ${counterpart} (${money(current, currency, sign)}).`,
      };
    }
    const up = delta > 0n;
    return {
      figure,
      direction: up ? 'up' : 'down',
      tone: up ? words.upTone : words.downTone,
      text: `${figureName(figure)}: ${money(up ? delta : -delta, currency)} ${up ? words.up : words.down} than ${counterpart} (${pair}).`,
    };
  });
  return { kind: 'shown', counterpart, lines };
}

export interface FoldedRow extends CashFlowBreakdownRow {
  /** Set on the "Other" row: how many rows it folds. */
  readonly folded?: number;
}

/** How many rows a breakdown lists before the rest fold into "Other". */
export const BREAKDOWN_LIMIT = 12;

/**
 * The first `limit` rows (already sorted, largest first), and the rest as one "Other" row whose amount, share and
 * count are the sums of what it folds — so the list always adds up to the side's total.
 */
export function foldTail(
  rows: readonly CashFlowBreakdownRow[],
  limit: number = BREAKDOWN_LIMIT,
  noun = 'rows',
): FoldedRow[] {
  if (rows.length <= limit) return [...rows];
  const head = rows.slice(0, limit);
  const tail = rows.slice(limit);
  const sum = tail.reduce((total, row) => total + BigInt(row.sumMinor), 0n);
  const shares = tail.map((row) => row.share);
  const share = shares.some((value) => value === null)
    ? null
    : shares.reduce((total: number, value) => total + (value ?? 0), 0);
  return [
    ...head,
    {
      key: 'other',
      label: `Other (${String(tail.length)} ${noun})`,
      hue: 'neutral',
      sumMinor: sum.toString(),
      share,
      count: tail.reduce((total, row) => total + row.count, 0),
      drillThrough: null,
      folded: tail.length,
    },
  ];
}

/** Two-letter initials for a row's avatar — moved to `components/finance/category-icon.ts` (WP 10.14). */
export { initialsOf } from '../../components/finance/category-icon.ts';
