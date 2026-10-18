// SPDX-License-Identifier: MIT
import { Money as MoneyKernel, type Money } from '@core/kernel';

import type {
  GetRecurringUpcomingResponse,
  RecurringProjectedCharge,
} from '../../../api/generated/types.gen.ts';
import { parseWireMoney } from '../../../lib/money.ts';

export interface UpcomingCharge {
  readonly date: string;
  readonly charge: RecurringProjectedCharge;
}

/** The charges due on the first `days` days of the calendar (both directions), in date order. */
export function chargesWithin(
  calendar: GetRecurringUpcomingResponse,
  days: number,
): UpcomingCharge[] {
  return calendar.days
    .slice(0, days)
    .flatMap((day) => day.charges.map((charge) => ({ date: day.date, charge })));
}

export interface LowestBalance {
  readonly balance: Money;
  readonly date: string;
}

/**
 * The lowest the cash balance is projected to go over the calendar's window: today's cash (the same figure Safe
 * to spend starts from, `availableCash`) plus each day's expected outflows and inflows, in order . `null` when the calendar is in another currency
 * than the cash (never converted) or has no day.
 */
export function lowestBalance(
  availableCash: Money,
  calendar: GetRecurringUpcomingResponse,
): LowestBalance | null {
  if (calendar.currency !== availableCash.currency || calendar.days.length === 0) return null;
  let running = availableCash;
  let lowest: LowestBalance | null = null;
  for (const day of calendar.days) {
    running = MoneyKernel.add(
      running,
      MoneyKernel.add(parseWireMoney(day.outflow), parseWireMoney(day.inflow)),
    );
    if (lowest === null || MoneyKernel.compare(running, lowest.balance) < 0) {
      lowest = { balance: running, date: day.date };
    }
  }
  return lowest;
}
