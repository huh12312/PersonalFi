// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';
import { describe, expect, it } from 'vitest';

import type { BudgetLine } from '../../api/generated/types.gen.ts';
import {
  fillFractionOf,
  meterFiguresOf,
  meterStateOf,
  paceOf,
  spentPercentOf,
  type PaceStatus,
} from './budget-meter.ts';

const usd = (minor: bigint) => Money.of(minor, 'USD');
const figures = (budgeted: bigint, spent: bigint) => ({
  budgeted: usd(budgeted),
  spent: usd(spent),
});
const running = (day: number, days: number): PaceStatus => ({
  kind: 'running',
  day,
  days,
  fraction: day / days,
});

describe('paceOf — the tick is today ÷ days in period, today counted', () => {
  it.each([
    ['2026-02-01', '2026-03-01', 28],
    ['2028-02-01', '2028-03-01', 29],
    ['2026-09-01', '2026-10-01', 30],
    ['2026-10-01', '2026-11-01', 31],
  ])('%s → %s is %i days: day 1, mid, last', (start, end, days) => {
    expect(paceOf(start, end, start)).toEqual({
      kind: 'running',
      day: 1,
      days,
      fraction: 1 / days,
    });
    const lastDay = new Date(`${end}T00:00:00Z`);
    lastDay.setUTCDate(lastDay.getUTCDate() - 1);
    const last = lastDay.toISOString().slice(0, 10);
    expect(paceOf(start, end, last)).toEqual({ kind: 'running', day: days, days, fraction: 1 });
    const fifteenth = `${start.slice(0, 8)}15`;
    expect(paceOf(start, end, fifteenth)).toEqual({
      kind: 'running',
      day: 15,
      days,
      fraction: 15 / days,
    });
  });

  it('the exclusive end date is "period over"; the day before the start is "not started"', () => {
    expect(paceOf('2026-09-01', '2026-10-01', '2026-10-01')).toEqual({ kind: 'over' });
    expect(paceOf('2026-09-01', '2026-10-01', '2027-01-05')).toEqual({ kind: 'over' });
    expect(paceOf('2026-09-01', '2026-10-01', '2026-08-31')).toEqual({ kind: 'not_started' });
  });
});

describe('meterStateOf — every boundary', () => {
  // A 30-day period on day 15: the tick is at exactly 50%. Budget $100.00 = 10 000 minor.
  const mid = running(15, 30);

  it('0% spent is under pace (and the fill is empty)', () => {
    expect(meterStateOf(figures(10_000n, 0n), mid)).toBe('under');
    expect(fillFractionOf(figures(10_000n, 0n))).toBe(0);
  });

  it('exactly at the tick is on pace', () => {
    expect(meterStateOf(figures(10_000n, 5_000n), mid)).toBe('on_pace');
  });

  it('the band is ±5 points, inclusive at both edges, and symmetric', () => {
    expect(meterStateOf(figures(10_000n, 5_500n), mid), 'tick + 5 exactly').toBe('on_pace');
    expect(meterStateOf(figures(10_000n, 5_501n), mid), 'tick + 5.01').toBe('ahead');
    expect(meterStateOf(figures(10_000n, 4_500n), mid), 'tick − 5 exactly').toBe('on_pace');
    expect(meterStateOf(figures(10_000n, 4_499n), mid), 'tick − 5.01').toBe('under');
  });

  it('the band is exact where floating point is not (0.55 − 0.5 > 0.05 in IEEE-754)', () => {
    expect(0.55 - 0.5 > 0.05).toBe(true);
    expect(meterStateOf(figures(100n, 55n), mid)).toBe('on_pace');
  });

  it('exactly 100% is not over: ahead mid-period, on pace on the last day', () => {
    expect(meterStateOf(figures(10_000n, 10_000n), mid)).toBe('ahead');
    expect(meterStateOf(figures(10_000n, 10_000n), running(30, 30))).toBe('on_pace');
    expect(fillFractionOf(figures(10_000n, 10_000n))).toBe(1);
  });

  it('one cent over is over budget, whatever the pace; the fill stops at full', () => {
    expect(meterStateOf(figures(10_000n, 10_001n), mid)).toBe('over');
    expect(meterStateOf(figures(10_000n, 10_001n), { kind: 'over' })).toBe('over');
    expect(fillFractionOf(figures(10_000n, 25_000n))).toBe(1);
    expect(spentPercentOf(figures(10_000n, 25_000n))).toBe(250);
  });

  it('a budget of zero is withheld, never drawn as 0%', () => {
    expect(meterStateOf(figures(0n, 0n), mid)).toBe('no_budget');
    expect(meterStateOf(figures(0n, 4_200n), mid)).toBe('no_budget');
    expect(meterStateOf(figures(-500n, 0n), mid)).toBe('no_budget');
    expect(spentPercentOf(figures(0n, 4_200n))).toBeNull();
  });

  it('a period that is over or not started has no pace: within budget, or over', () => {
    expect(meterStateOf(figures(10_000n, 9_900n), { kind: 'over' })).toBe('within');
    expect(meterStateOf(figures(10_000n, 0n), { kind: 'not_started' })).toBe('within');
  });

  it.each([28, 29, 30, 31])('the band scales with a %i-day period', (days) => {
    const pace = running(7, days);
    // spent exactly at the upper edge: 7/days + 5% of a $1,000.00 budget, when it is a whole cent.
    const budget = 100_000n * BigInt(days);
    const edge = (budget * (100n * 7n + 5n * BigInt(days))) / (100n * BigInt(days));
    expect(meterStateOf(figures(budget, edge), pace)).toBe('on_pace');
    expect(meterStateOf(figures(budget, edge + 1n), pace)).toBe('ahead');
  });

  it('a refund-positive month (negative spent) is under pace and draws nothing', () => {
    expect(meterStateOf(figures(10_000n, -2_000n), mid)).toBe('under');
    expect(fillFractionOf(figures(10_000n, -2_000n))).toBe(0);
  });
});

describe('meterFiguresOf — sums of the server fields, never a recomputed envelope', () => {
  const line = (carryover: string, assigned: string, activity: string, available: string) =>
    ({
      carryover: { minor: carryover, currency: 'USD' },
      assigned: { minor: assigned, currency: 'USD' },
      activity: { minor: activity, currency: 'USD' },
      available: { minor: available, currency: 'USD' },
    }) as unknown as BudgetLine;

  it('budgeted = carryover + assigned, spent = −activity, remaining = the server’s available', () => {
    const result = meterFiguresOf(
      [line('1000', '5000', '-2500', '3500'), line('0', '2000', '-3000', '-1000')],
      'USD',
    );
    expect(result.budgeted.minor).toBe(8_000n);
    expect(result.spent.minor).toBe(5_500n);
    expect(result.remaining.minor).toBe(2_500n);
    expect(result.rolledOver.minor).toBe(1_000n);
  });

  it('remaining is read, not derived: a server value that disagrees is shown as the server says', () => {
    expect(meterFiguresOf([line('0', '5000', '-1000', '1234')], 'USD').remaining.minor).toBe(
      1_234n,
    );
  });
});
