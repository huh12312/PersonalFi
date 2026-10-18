// SPDX-License-Identifier: MIT
import { Money as MoneyKernel, type Money } from '@core/kernel';

import type { BudgetLine } from '../../../api/generated/types.gen.ts';
import { parseWireMoney } from '../../../lib/money.ts';

export type MeterState = 'under' | 'near' | 'over';

export interface BudgetMeter {
  readonly lineId: string;
  readonly categoryId: string | null;
  /** Carryover + assigned: what the envelope had to spend this period. */
  readonly funded: Money;
  /** Money out of the envelope this period, as a positive amount (−activity). */
  readonly spent: Money;
  /** The envelope's `available` as the server computed it: negative means over. */
  readonly available: Money;
  /** spent ÷ funded, for the bar only (a float from exact minor units); `null` when nothing was funded. */
  readonly ratio: number | null;
  readonly state: MeterState;
}

/** A line at or past this share of its funding is "near". */
export const NEAR_RATIO = 0.9;

/**
 * The three category envelopes closest to or over their budget (WP 10.9), from `GET /budgets/current`'s own
 * figures — no envelope arithmetic is redone here: `available` is the server's, `funded` is the sum of the two
 * fields the server says make it up (`carryover + assigned`), and `spent` is `activity` with its sign turned. A
 * line with nothing funded and nothing spent has nothing to show and is skipped; an envelope the server says is
 * negative is over, whatever the ratio; the rest rank by how much of the funding is gone. Income categories are
 * not envelopes to spend from and are left out (`isIncome`).
 */
export function closestToBudget(
  lines: readonly BudgetLine[],
  isIncome: (categoryId: string | null) => boolean,
  limit = 3,
): BudgetMeter[] {
  const meters: BudgetMeter[] = [];
  for (const line of lines) {
    if (line.kind !== 'category' || isIncome(line.categoryId)) continue;
    const funded = MoneyKernel.add(parseWireMoney(line.carryover), parseWireMoney(line.assigned));
    const spent = MoneyKernel.negate(parseWireMoney(line.activity));
    const available = parseWireMoney(line.available);
    if (!MoneyKernel.isPositive(funded) && !MoneyKernel.isPositive(spent)) continue;
    // Presentation only: the bar's length, from exact minor units.
    const ratio = MoneyKernel.isPositive(funded)
      ? Number(spent.minor) / Number(funded.minor)
      : null;
    const state: MeterState = MoneyKernel.isNegative(available)
      ? 'over'
      : ratio !== null && ratio >= NEAR_RATIO
        ? 'near'
        : 'under';
    meters.push({
      lineId: line.id,
      categoryId: line.categoryId,
      funded,
      spent,
      available,
      ratio,
      state,
    });
  }
  const rank = (meter: BudgetMeter): number =>
    meter.state === 'over' ? 2 + -Number(meter.available.minor) : (meter.ratio ?? 0);
  return meters.sort((a, b) => rank(b) - rank(a)).slice(0, limit);
}
