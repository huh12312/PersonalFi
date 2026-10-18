// SPDX-License-Identifier: MIT
import type { BudgetLine } from '../../../api/generated/types.gen.ts';
import {
  fillFractionOf,
  meterFiguresOf,
  meterStateOf,
  type MeterFigures,
  type MeterState,
  type PaceStatus,
} from '../../../components/finance/budget-meter.ts';

export interface ClosestMeter {
  readonly lineId: string;
  readonly categoryId: string | null;
  readonly figures: MeterFigures;
  readonly state: MeterState;
}

/**
 * The three category envelopes closest to or over their budget (WP 10.9; WP 10.11 moved the figures and the state
 * onto the shared `BudgetMeter` arithmetic, `components/finance/budget-meter.ts`, so the widget and the Budget
 * screen can never disagree about a line). Figures are the server's own fields summed (`carryover + assigned`,
 * `−activity`, `available`); nothing is recomputed.
 *
 * Skipped: a line with nothing budgeted and nothing spent (nothing to show), income categories (not envelopes to
 * spend from) and card-payment lines. Ranked: over budget first, by how far over; then spending with no amount set,
 * by how much; then the rest by the share of the budget spent.
 */
export function closestToBudget(
  lines: readonly BudgetLine[],
  isIncome: (categoryId: string | null) => boolean,
  pace: PaceStatus,
  limit = 3,
): ClosestMeter[] {
  const meters: ClosestMeter[] = [];
  for (const line of lines) {
    if (line.kind !== 'category' || isIncome(line.categoryId)) continue;
    const figures = meterFiguresOf([line], line.assigned.currency);
    if (figures.budgeted.minor <= 0n && figures.spent.minor <= 0n) continue;
    meters.push({
      lineId: line.id,
      categoryId: line.categoryId,
      figures,
      state: meterStateOf(figures, pace),
    });
  }
  const tier = (m: ClosestMeter): number =>
    m.state === 'over' ? 2 : m.state === 'no_budget' ? 1 : 0;
  const within = (m: ClosestMeter): number =>
    m.state === 'over'
      ? -Number(m.figures.remaining.minor)
      : m.state === 'no_budget'
        ? Number(m.figures.spent.minor)
        : fillFractionOf(m.figures);
  return meters.sort((a, b) => tier(b) - tier(a) || within(b) - within(a)).slice(0, limit);
}
