// SPDX-License-Identifier: MIT
/**
 * The "Left to budget" card's figures over the wire (WP 10.11).
 *
 * `GET /budgets/current` gains `today` (the holder's own date, what the pace tick is measured against) and three
 * period figures beside `readyToAssign`: `budgetedExpenses`, `plannedSavings` and `rolledOver`. Asserted here:
 *
 * 1. **`budgetedExpenses + plannedSavings` partitions Σ assigned of the category lines exactly**, with the
 *    savings rule as `isPlannedSavings` states it: class `SAVINGS`, or no class and a `TARGET_BY_DATE` goal; an
 *    explicit `NEED`/`WANT` class wins over the goal type.
 * 2. **`rolledOver` is Σ carryover**, and after a roll it equals the roll's own `rolledOut`.
 * 3. **`readyToAssign` is the budget's own identity**, unchanged by the new fields (the web never computes it —
 *    `apps/web/src/features/budget/LeftToBudgetCard.test.tsx` holds that side).
 * 4. **`today` is `todayIn(clock, the holder's zone)`.**
 */
import { Money, mutableClock, todayIn } from '@core/kernel';
import { getPeriod } from '@ctx/budgeting';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireMoney {
  readonly minor: string;
  readonly currency: string;
}
interface WireLine {
  readonly id: string;
  readonly kind: string;
  readonly assigned: WireMoney;
  readonly carryover: WireMoney;
}
interface WirePeriod {
  readonly id: string;
  readonly budgetId: string;
  readonly startDate: string;
  readonly readyToAssign: WireMoney;
  readonly budgetedExpenses: WireMoney;
  readonly plannedSavings: WireMoney;
  readonly rolledOver: WireMoney;
  readonly lines: readonly WireLine[];
}
interface WireCurrent {
  readonly budgetId: string;
  readonly today: string;
  readonly period: WirePeriod;
}

const sum = (values: readonly WireMoney[]): bigint =>
  values.reduce((acc, value) => acc + BigInt(value.minor), 0n);

describe.skipIf(NO_DATABASE)('GET /budgets/current — Left to budget figures (WP 10.11)', () => {
  let h: ApiHarness;
  const clock = mutableClock('2026-03-15T12:00:00.000Z');

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp1011ltb', clock });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  async function current(): Promise<WireCurrent> {
    const response = await h.request({ method: 'GET', url: '/budgets/current', session: h.stale });
    expectStatus(response, 200);
    return response.json() as WireCurrent;
  }

  async function leaves(count: number): Promise<string[]> {
    const response = await h.request({ method: 'GET', url: '/categories', session: h.stale });
    expectStatus(response, 200);
    const { categories } = response.json() as {
      categories: { id: string; assignable: boolean; kind: string }[];
    };
    const ids = categories.filter((c) => c.assignable && c.kind === 'expense').map((c) => c.id);
    if (ids.length < count) throw new Error('not enough expense leaves seeded');
    return ids.slice(0, count);
  }

  async function line(periodId: string, categoryId: string, patch: object): Promise<string> {
    const created = await h.request({
      method: 'POST',
      url: '/budgets/lines',
      session: h.stale,
      body: { periodId, categoryId },
    });
    expectStatus(created, 201);
    const id = (created.json() as { line: { id: string } }).line.id;
    const patched = await h.request({
      method: 'PATCH',
      url: `/budgets/lines/${id}`,
      session: h.stale,
      body: patch,
    });
    expectStatus(patched, 200);
    return id;
  }

  it("carries today in the holder's zone", async () => {
    const tz = await h.database.pool.query<{ display_timezone: string }>(
      'SELECT display_timezone FROM users WHERE id = $1',
      [h.userId],
    );
    const zone = tz.rows[0]?.display_timezone ?? 'UTC';
    expect((await current()).today).toBe(todayIn(clock, zone));
  });

  it('budgetedExpenses + plannedSavings partitions Σ assigned; the savings rule; RTA untouched', async () => {
    const before = await current();
    const { period } = before;
    expect(period.budgetedExpenses).toEqual({ minor: '0', currency: 'USD' });
    expect(period.plannedSavings).toEqual({ minor: '0', currency: 'USD' });
    expect(period.rolledOver).toEqual({ minor: '0', currency: 'USD' });

    const [need, savings, sinking, wantGoal] = await leaves(4);
    const usd = (minor: number) => ({ minor: String(minor), currency: 'USD' });
    await line(period.id, need as string, { assigned: usd(50_00), class: 'NEED' });
    await line(period.id, savings as string, { assigned: usd(20_00), class: 'SAVINGS' });
    await line(period.id, sinking as string, {
      assigned: usd(10_00),
      goalType: 'TARGET_BY_DATE',
      goalAmount: usd(120_00),
      goalTargetDate: '2026-12-01',
    });
    await line(period.id, wantGoal as string, {
      assigned: usd(7_00),
      class: 'WANT',
      goalType: 'TARGET_BY_DATE',
      goalAmount: usd(70_00),
      goalTargetDate: '2026-12-01',
    });

    const after = (await current()).period;
    expect(after.budgetedExpenses, 'NEED 50 + WANT-with-a-goal 7').toEqual(usd(57_00));
    expect(after.plannedSavings, 'SAVINGS 20 + unclassed TARGET_BY_DATE 10').toEqual(usd(30_00));
    const categoryAssigned = sum(
      after.lines.filter((l) => l.kind === 'category').map((l) => l.assigned),
    );
    expect(BigInt(after.budgetedExpenses.minor) + BigInt(after.plannedSavings.minor)).toBe(
      categoryAssigned,
    );
    // No cash account: RTA is the identity's −Σ available, i.e. −$87 — not income − expenses − savings by
    // construction (income is 0 here, and the two would agree only by coincidence on a cash-only ledger).
    expect(after.readyToAssign).toEqual(usd(-87_00));
    expect(after.rolledOver).toEqual(usd(0));
  });

  it('rolledOver is Σ carryover, and equals the roll’s own rolledOut in the next period', async () => {
    const { budgetId, period } = await current();
    const rolled = await h.request({
      method: 'POST',
      url: '/budgets/periods/roll',
      session: h.stale,
      body: { budgetId, periodId: period.id },
    });
    expectStatus(rolled, 200);
    const result = rolled.json() as { toPeriodId: string; rolledOut: WireMoney };

    // The next period is not "current" until April, and a month of clock would expire the test session, so it
    // is read through the same read model `GET /budgets/current` serialises (`getPeriod`).
    const next = await getPeriod(h.database.db, { userId: h.userId, periodId: result.toPeriodId });
    if (next === null) throw new Error('the rolled-to period is missing');
    const carried = next.lines
      .filter((l) => l.kind === 'category')
      .reduce((acc, l) => acc + l.carryover.minor, 0n);
    expect(next.rolledOver.minor).toBe(carried);
    expect(next.rolledOver.minor.toString()).toBe(result.rolledOut.minor);
    expect(Money.isPositive(next.rolledOver)).toBe(true);
  });
});
