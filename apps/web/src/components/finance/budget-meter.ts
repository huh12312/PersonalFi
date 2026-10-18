// SPDX-License-Identifier: MIT
import { DateOnly, Money as MoneyKernel, type Money } from '@core/kernel';

import type { BudgetLine } from '../../api/generated/types.gen.ts';
import { parseWireMoney } from '../../lib/money.ts';

/**
 * The budget meter's arithmetic and state machine (WP 10.11; Monarch's equivalent with a `tickPercent`,
 * docs/research/10-visual-design-notes.md §1.4). Pure, so every boundary is a unit test
 * (`budget-meter.test.ts`) rather than a screenshot.
 *
 * **No envelope arithmetic is redone here.** Each figure is a sum of the server's own fields: `budgeted` is
 * `carryover + assigned` (what the envelope had to spend this period — the same "funded" WP 10.9's widget showed),
 * `spent` is `activity` with its sign turned, `remaining` is the server's `available` (which *is* `budgeted − spent`,
 * 07 §1.2). A group's figures are those sums over its lines. Ready to Assign is never computed in the web.
 *
 * **The pace** is the fraction of the period elapsed, counting today: on day `d` of an `N`-day period the tick sits
 * at `d / N` (the 1st of a 30-day month is 1/30, the last day 30/30). "Today" is the server's — `GET
 * /budgets/current` carries it in the holder's own zone — so the browser's clock never moves the tick. A period
 * that has ended or not yet started has no tick; it says so instead.
 */

export type PaceStatus =
  | {
      readonly kind: 'running';
      /** 1-based day of the period, today included. */
      readonly day: number;
      readonly days: number;
      /** `day / days`, for drawing only. */
      readonly fraction: number;
    }
  | { readonly kind: 'over' }
  | { readonly kind: 'not_started' };

/** `endDate` is exclusive, as `BudgetPeriod.endDate` is. */
export function paceOf(startDate: string, endDate: string, today: string): PaceStatus {
  const start = DateOnly.parse(startDate);
  const end = DateOnly.parse(endDate);
  const now = DateOnly.parse(today);
  if (DateOnly.isBefore(now, start)) return { kind: 'not_started' };
  if (!DateOnly.isBefore(now, end)) return { kind: 'over' };
  const days = DateOnly.differenceInDays(start, end);
  const day = DateOnly.differenceInDays(start, now) + 1;
  return { kind: 'running', day, days, fraction: day / days };
}

/** The on-pace band, either side of the tick, in percentage points of the budget. Symmetric by definition. */
export const ON_PACE_BAND_PERCENT = 5n;

export type MeterState =
  /** Budget of zero: the meter is withheld ("no amount set"). */
  | 'no_budget'
  /** Spent more than budgeted. */
  | 'over'
  /** Spent share > elapsed share + 5 points, still within the budget. */
  | 'ahead'
  /** Within ±5 points of the tick, inclusive. */
  | 'on_pace'
  /** Spent share < elapsed share − 5 points. */
  | 'under'
  /** Within budget, and there is no pace to compare against (the period is over or has not started). */
  | 'within';

export interface MeterFigures {
  readonly budgeted: Money;
  readonly spent: Money;
  readonly remaining: Money;
  /** Σ carryover — non-zero means the meter shows the rollover glyph. */
  readonly rolledOver: Money;
}

/**
 * The state, decided in exact integer arithmetic so a boundary is a boundary (`0.55 − 0.5` is
 * `0.050000000000000044` in floating point; here "spent / budgeted ≤ day / days + 5 / 100" is
 * `100 · days · spent ≤ budgeted · (100 · day + 5 · days)`).
 */
export function meterStateOf(
  figures: Pick<MeterFigures, 'budgeted' | 'spent'>,
  pace: PaceStatus,
): MeterState {
  const budgeted = figures.budgeted.minor;
  const spent = figures.spent.minor;
  if (budgeted <= 0n) return 'no_budget';
  if (spent > budgeted) return 'over';
  if (pace.kind !== 'running') return 'within';
  const days = BigInt(pace.days);
  const day = BigInt(pace.day);
  const spentScaled = 100n * days * spent;
  const upper = budgeted * (100n * day + ON_PACE_BAND_PERCENT * days);
  const lower = budgeted * (100n * day - ON_PACE_BAND_PERCENT * days);
  if (spentScaled > upper) return 'ahead';
  if (spentScaled < lower) return 'under';
  return 'on_pace';
}

/** The fill's length, 0..1, for drawing only: spent ÷ budgeted, clamped; a refund-positive month is 0, over is 1. */
export function fillFractionOf(figures: Pick<MeterFigures, 'budgeted' | 'spent'>): number {
  const budgeted = figures.budgeted.minor;
  const spent = figures.spent.minor;
  if (budgeted <= 0n) return 0;
  if (spent <= 0n) return 0;
  if (spent >= budgeted) return 1;
  return Number(spent) / Number(budgeted);
}

/** Spent as a whole percentage of the budget, for words and the table (may exceed 100). `null` with no budget. */
export function spentPercentOf(figures: Pick<MeterFigures, 'budgeted' | 'spent'>): number | null {
  if (figures.budgeted.minor <= 0n) return null;
  return Math.round((Number(figures.spent.minor) / Number(figures.budgeted.minor)) * 100);
}

/** The figures of a set of lines: sums of the server's fields, never a recomputed envelope. */
export function meterFiguresOf(lines: readonly BudgetLine[], currency: string): MeterFigures {
  const sum = (pick: (line: BudgetLine) => Money): Money =>
    MoneyKernel.sum(lines.map(pick), currency);
  return {
    budgeted: sum((l) => MoneyKernel.add(parseWireMoney(l.carryover), parseWireMoney(l.assigned))),
    spent: sum((l) => MoneyKernel.negate(parseWireMoney(l.activity))),
    remaining: sum((l) => parseWireMoney(l.available)),
    rolledOver: sum((l) => parseWireMoney(l.carryover)),
  };
}

/** The words a state is read as — always shown beside its colour, never colour alone. */
export const METER_STATE_WORDS: Record<MeterState, string> = {
  no_budget: 'No amount set',
  over: 'Over budget',
  ahead: 'Ahead of pace',
  on_pace: 'On pace',
  under: 'Under pace',
  within: 'Within budget',
};

/** The V1 status quartet a state wears. `no_budget` wears none: the meter is withheld. */
export const METER_STATE_STATUS: Record<
  Exclude<MeterState, 'no_budget'>,
  'success' | 'info' | 'warning' | 'danger'
> = {
  under: 'success',
  within: 'success',
  on_pace: 'info',
  ahead: 'warning',
  over: 'danger',
};

/** What the pace is, in words: "day 15 of 30", "period over", "not started". */
export function paceWordsOf(pace: PaceStatus): string {
  switch (pace.kind) {
    case 'running':
      return `day ${String(pace.day)} of ${String(pace.days)}`;
    case 'over':
      return 'period over';
    case 'not_started':
      return 'not started';
  }
}
