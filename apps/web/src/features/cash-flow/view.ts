// SPDX-License-Identifier: MIT
import { z } from 'zod';

/**
 * The Cash Flow hub's URL state (WP 10.10): which tab, how it is displayed, the timeframe and the period, the
 * breakdown and the comparison — so a link to "Spending, by merchant, Q1 2026" is shareable inside the app and the
 * back button walks the holder's own steps. Every field is optional and **defaults are left out of the URL**, so
 * `/cash-flow` is the default view and a hand-edited bad value falls back to the default instead of failing the route.
 *
 * The period is a key (`YYYY-MM`, `YYYY-Qn`, `YYYY`); an absent one means "the period today is in", which only the
 * server knows (today is the holder's zone, never the browser's — docs/CONVENTIONS.md "Time"). Stepping is key
 * arithmetic from the period the server resolved, so it needs no clock.
 */

export const CASH_FLOW_TABS = ['cash-flow', 'income', 'spending'] as const;
export type CashFlowTab = (typeof CASH_FLOW_TABS)[number];
export const TIMEFRAMES = ['month', 'quarter', 'year'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];
export const DISPLAYS = ['flow', 'bars', 'categories'] as const;
export type Display = (typeof DISPLAYS)[number];
export const BREAKDOWNS = ['category', 'group', 'merchant'] as const;
export type Breakdown = (typeof BREAKDOWNS)[number];
export const COMPARISONS = ['previous', 'average', 'year_ago'] as const;
export type Comparison = (typeof COMPARISONS)[number];

const PERIOD_PATTERN = /^\d{4}(-(0[1-9]|1[0-2]|Q[1-4]))?$/u;

export const cashFlowSearchSchema = z.object({
  tab: z.enum(CASH_FLOW_TABS).optional().catch(undefined),
  display: z.enum(DISPLAYS).optional().catch(undefined),
  timeframe: z.enum(TIMEFRAMES).optional().catch(undefined),
  period: z.string().regex(PERIOD_PATTERN).optional().catch(undefined),
  breakdown: z.enum(BREAKDOWNS).optional().catch(undefined),
  compare: z.enum(COMPARISONS).optional().catch(undefined),
});

export type CashFlowSearch = z.infer<typeof cashFlowSearchSchema>;

export interface CashFlowView {
  readonly tab: CashFlowTab;
  readonly display: Display;
  readonly timeframe: Timeframe;
  /** `null` = the period today is in. */
  readonly period: string | null;
  readonly breakdown: Breakdown;
  readonly compare: Comparison;
}

/** The two ways each tab can draw: the Sankey is the Cash flow tab's; the categories chart is a side's. */
export function displaysFor(tab: CashFlowTab): readonly Display[] {
  return tab === 'cash-flow' ? ['flow', 'bars'] : ['bars', 'categories'];
}

export function defaultDisplay(tab: CashFlowTab): Display {
  return displaysFor(tab)[0] ?? 'bars';
}

/** Does `key` name a period of `timeframe`? */
export function isPeriodOf(timeframe: Timeframe, key: string): boolean {
  if (timeframe === 'year') return /^\d{4}$/u.test(key);
  if (timeframe === 'quarter') return /^\d{4}-Q[1-4]$/u.test(key);
  return /^\d{4}-(0[1-9]|1[0-2])$/u.test(key);
}

/** URL search → the view, every gap a default; a display the tab does not offer, or a period of another timeframe, is ignored. */
export function viewOf(search: CashFlowSearch): CashFlowView {
  const tab = search.tab ?? 'cash-flow';
  const timeframe = search.timeframe ?? 'month';
  const display =
    search.display !== undefined && displaysFor(tab).includes(search.display)
      ? search.display
      : defaultDisplay(tab);
  const period =
    search.period !== undefined && isPeriodOf(timeframe, search.period) ? search.period : null;
  return {
    tab,
    display,
    timeframe,
    period,
    breakdown: search.breakdown ?? 'category',
    compare: search.compare ?? 'previous',
  };
}

/** The view → URL search, defaults left out (so the default view is a bare `/cash-flow`). */
export function searchOf(view: CashFlowView): CashFlowSearch {
  return {
    ...(view.tab === 'cash-flow' ? {} : { tab: view.tab }),
    ...(view.display === defaultDisplay(view.tab) ? {} : { display: view.display }),
    ...(view.timeframe === 'month' ? {} : { timeframe: view.timeframe }),
    ...(view.period === null ? {} : { period: view.period }),
    ...(view.breakdown === 'category' ? {} : { breakdown: view.breakdown }),
    ...(view.compare === 'previous' ? {} : { compare: view.compare }),
  };
}

/** A change to the view, with the rules that keep it coherent: a new tab keeps a display it offers, a new timeframe starts at today. */
export function withChange(view: CashFlowView, change: Partial<CashFlowView>): CashFlowView {
  const next = { ...view, ...change };
  if (change.tab !== undefined && !displaysFor(next.tab).includes(next.display)) {
    next.display = defaultDisplay(next.tab);
  }
  if (
    change.timeframe !== undefined &&
    change.timeframe !== view.timeframe &&
    change.period === undefined
  ) {
    next.period = null;
  }
  return next;
}

interface ParsedKey {
  readonly year: number;
  /** 0-based index of the period inside its year (month 0–11, quarter 0–3, year 0). */
  readonly index: number;
}

function parseKey(timeframe: Timeframe, key: string): ParsedKey | null {
  if (!isPeriodOf(timeframe, key)) return null;
  const year = Number(key.slice(0, 4));
  if (timeframe === 'year') return { year, index: 0 };
  if (timeframe === 'quarter') return { year, index: Number(key.slice(6)) - 1 };
  return { year, index: Number(key.slice(5, 7)) - 1 };
}

const PER_YEAR: Readonly<Record<Timeframe, number>> = { month: 12, quarter: 4, year: 1 };

/** `key` moved `count` periods (negative = earlier): Q1 2026 − 1 is Q4 2025; January − 1 is last December. */
export function shiftPeriodKey(timeframe: Timeframe, key: string, count: number): string {
  const parsed = parseKey(timeframe, key);
  if (parsed === null) throw new Error(`not a ${timeframe}: ${key}`);
  const perYear = PER_YEAR[timeframe];
  const absolute = parsed.year * perYear + parsed.index + count;
  const year = Math.floor(absolute / perYear);
  const index = absolute - year * perYear;
  const yyyy = String(year).padStart(4, '0');
  if (timeframe === 'year') return yyyy;
  if (timeframe === 'quarter') return `${yyyy}-Q${String(index + 1)}`;
  return `${yyyy}-${String(index + 1).padStart(2, '0')}`;
}

/** `a` before `b`, both of `timeframe`. */
export function comparePeriodKeys(timeframe: Timeframe, a: string, b: string): number {
  const pa = parseKey(timeframe, a);
  const pb = parseKey(timeframe, b);
  if (pa === null || pb === null) return 0;
  return pa.year * PER_YEAR[timeframe] + pa.index - (pb.year * PER_YEAR[timeframe] + pb.index);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** "March 2026", "Q1 2026", "2026". */
export function periodLabel(timeframe: Timeframe, key: string): string {
  const parsed = parseKey(timeframe, key);
  if (parsed === null) return key;
  if (timeframe === 'year') return String(parsed.year);
  if (timeframe === 'quarter') return `Q${String(parsed.index + 1)} ${String(parsed.year)}`;
  return `${MONTH_NAMES[parsed.index] ?? ''} ${String(parsed.year)}`;
}

/** A short axis label: "Mar", "Q1 '26", "2026"; January (and every Q1) carries its year so the axis never loses it. */
export function periodTickLabel(timeframe: Timeframe, key: string): string {
  const parsed = parseKey(timeframe, key);
  if (parsed === null) return key;
  if (timeframe === 'year') return String(parsed.year);
  const yy = String(parsed.year).slice(2);
  if (timeframe === 'quarter') return `Q${String(parsed.index + 1)} '${yy}`;
  const short = (MONTH_NAMES[parsed.index] ?? '').slice(0, 3);
  return parsed.index === 0 ? `${short} '${yy}` : short;
}

/** "month" / "quarter" / "year" — the unit a sentence names. */
export function unitOf(timeframe: Timeframe): string {
  return timeframe;
}

/** "This month" / "This quarter" / "This year". */
export function thisPeriodLabel(timeframe: Timeframe): string {
  return `This ${timeframe}`;
}
