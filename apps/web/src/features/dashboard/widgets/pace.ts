// SPDX-License-Identifier: MIT
import { Money as MoneyKernel, type Money } from '@core/kernel';

import type { SpendingPace } from '../../../api/generated/types.gen.ts';

/**
 * The spending pace widget's arithmetic (WP 10.9), kept out of the component so every number in the sentence is
 * pinned by `pace.test.ts`: which day is "this day", which day of last month it is compared with (a shorter
 * last month is read at its last day — by then it was over), and the difference in money, never a bare percentage.
 */

export type PaceDirection = 'under' | 'over' | 'same';

export interface PaceComparison {
  readonly currency: string;
  /** The day of this month the sentence speaks of: today, or the last day of a past month. */
  readonly day: number;
  readonly spent: Money;
  /** `null` when last month has no ledger row (no data is not a zero). */
  readonly lastMonth: {
    readonly day: number;
    readonly spent: Money;
    readonly difference: Money;
    readonly direction: PaceDirection;
  } | null;
}

/** What the widget can draw: nothing (and why), or the comparison. */
export type PaceState =
  | { readonly kind: 'no-data' }
  | { readonly kind: 'future' }
  | { readonly kind: 'ready'; readonly comparison: PaceComparison };

function minorOf(text: string): bigint {
  return BigInt(text);
}

export function paceState(pace: SpendingPace): PaceState {
  if (pace.currency === null) return { kind: 'no-data' };
  if (pace.days.length === 0 && pace.lastMonth.length === 0 && pace.trailingAverage.length === 0) {
    return { kind: 'no-data' };
  }
  if (pace.days.length === 0) return { kind: 'future' };
  return { kind: 'ready', comparison: comparePace(pace, pace.currency) };
}

export function comparePace(pace: SpendingPace, currency: string): PaceComparison {
  const latest = pace.days.at(-1)!;
  const day = latest.day;
  const spent = MoneyKernel.of(minorOf(latest.cumulativeMinor), currency);
  if (pace.lastMonth.length === 0) return { currency, day, spent, lastMonth: null };
  const compareDay = Math.min(day, pace.lastMonth.length);
  const point = pace.lastMonth[compareDay - 1]!;
  const lastSpent = MoneyKernel.of(minorOf(point.cumulativeMinor), currency);
  const difference = MoneyKernel.subtract(spent, lastSpent);
  const direction: PaceDirection = MoneyKernel.isZero(difference)
    ? 'same'
    : MoneyKernel.isNegative(difference)
      ? 'under'
      : 'over';
  return {
    currency,
    day,
    spent,
    lastMonth: {
      day: compareDay,
      spent: lastSpent,
      difference: MoneyKernel.absolute(difference),
      direction,
    },
  };
}

/** `Money` → the wire shape the `<Money>` component takes. */
export function wire(value: Money): { minor: string; currency: string } {
  return { minor: value.minor.toString(), currency: value.currency };
}

const MONTHS = [
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

/** `'2026-03'` → `'March'`. */
export function monthName(key: string): string {
  const month = Number(key.slice(5, 7));
  return MONTHS[month - 1] ?? key;
}

/** One row of the accessible table: day, this month, last month, the average (each `null` where there is no data). */
export interface PaceRow {
  readonly day: number;
  readonly thisMonth: bigint | null;
  readonly lastMonth: bigint | null;
  readonly average: bigint | null;
}

export function paceRows(pace: SpendingPace): PaceRow[] {
  const length = Math.max(pace.daysInMonth, pace.lastMonth.length);
  const at = (series: SpendingPace['days'], day: number): bigint | null => {
    const point = series[day - 1];
    return point === undefined ? null : minorOf(point.cumulativeMinor);
  };
  return Array.from({ length }, (_unused, index) => ({
    day: index + 1,
    thisMonth: at(pace.days, index + 1),
    lastMonth: at(pace.lastMonth, index + 1),
    average: at(pace.trailingAverage, index + 1),
  }));
}
