// SPDX-License-Identifier: MIT
/**
 * G4-14 (Phase 4 gate, re-tabled to WP 9.3): goals are evaluated on write.
 *
 * Before: a goal created, re-targeted or re-funded after the day's baseline run
 * was evaluated only at the next *fresh* run (normally the next night), because
 * `runGoalEvaluation` ran only from `ProjectionCompleted`. Nothing on screen
 * said so. Now `createGoal` and `updateGoal` evaluate the goal they wrote, in
 * the writer's own transaction, against the latest sealed day, and append one
 * `planning.GoalOffTrack` if it is off track — the same verdict
 * (`evaluateGoalPace`), the same event.
 *
 * Every assertion drives the shipped `createGoal`/`updateGoal` (C5-11), never a
 * hand-called evaluator, and counts rows in `domain_events`.
 *
 * Scratch database `personalfi_wp93_goal_write`, dropped after.
 */
import { Money, fixedClock, newId, type Clock } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGoal, updateGoal, type FundingAccountsReader } from '../../src/goals.ts';
import type { BreakdownEntry, NetWorthSnapshot } from '../../src/net-worth.ts';
import type { PlanningAccount } from '../../src/ports.ts';
import { sealDay, upsertOpenDay, type PlanningExecutor } from '../../src/store.ts';
import { CORRELATION_ID, NO_DATABASE } from './harness.ts';

const ZONE = 'America/New_York';
const CLOCK: Clock = fixedClock('2026-09-26T08:30:00Z');
const SEALED_DAY = '2026-09-25';

function usd(text: string): Money {
  return Money.parseAmount(text, 'USD');
}

const ACCOUNT_ID = newId();
const ACCOUNT: PlanningAccount = {
  accountId: ACCOUNT_ID,
  name: 'Savings',
  kind: 'savings',
  side: 'asset',
  currency: 'USD',
  flags: { onBudget: false, inNetWorth: true, isLiquid: true, isInvestable: false },
  closedAt: null,
} as unknown as PlanningAccount;
const PORTS: { readonly accounts: FundingAccountsReader } = {
  accounts: { accounts: async () => [ACCOUNT] },
};

/** A sealed day in which `ACCOUNT` holds $50,000 — enough to fund a $20,000 goal outright. */
function dayWithSavings(asOfDate: string): NetWorthSnapshot {
  const entry: BreakdownEntry = {
    accountId: ACCOUNT_ID,
    currency: 'USD',
    nativeMinor: '5000000',
    baseMinor: '5000000',
    fxRate: '1',
    fxRateDate: asOfDate,
    onBudget: false,
    inNetWorth: true,
    isLiquid: true,
    isInvestable: false,
    side: 'asset',
    kind: 'savings',
    valuation: 'observed',
    stalePrice: false,
  } as unknown as BreakdownEntry;
  return {
    asOfDate,
    baseCurrency: 'USD',
    assetsMinor: 5_000_000n,
    liabilitiesMinor: 0n,
    netWorthMinor: 5_000_000n,
    liquidMinor: 5_000_000n,
    investableMinor: 0n,
    onBudgetMinor: 0n,
    breakdown: [entry],
    source: 'observed',
    stalePrice: false,
    accountsCounted: 1,
    accountsUnvalued: 0,
    unvalued: [],
  };
}

describe.skipIf(NO_DATABASE)('goals are evaluated on write (G4-14)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp93_goal_write');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 60_000);

  beforeEach(async () => {
    await database.db.execute(
      sql`DELETE FROM domain_events WHERE event_type = 'planning.GoalOffTrack'`,
    );
    await database.db.execute(sql`DELETE FROM goals`);
    await database.db.execute(sql`DELETE FROM net_worth_daily`);
  }, 30_000);

  const context = () => ({
    userId: database.userId,
    clock: CLOCK,
    timeZone: ZONE,
    correlationId: CORRELATION_ID,
  });

  async function sealSavingsDay(): Promise<void> {
    await database.db.transaction(async (tx) => {
      const executor = tx as unknown as PlanningExecutor;
      await upsertOpenDay(executor, {
        userId: database.userId,
        snapshot: dayWithSavings(SEALED_DAY),
        clock: CLOCK,
      });
      await sealDay(executor, { userId: database.userId, asOfDate: SEALED_DAY, clock: CLOCK });
    });
  }

  async function offTrackEvents(): Promise<readonly Record<string, unknown>[]> {
    const result = await database.db.execute<{ payload: Record<string, unknown> }>(
      sql`SELECT payload FROM domain_events WHERE event_type = 'planning.GoalOffTrack' ORDER BY seq`,
    );
    return result.rows.map((row) => row.payload);
  }

  function inTransaction<T>(work: (executor: PlanningExecutor) => Promise<T>): Promise<T> {
    return database.db.transaction((tx) => work(tx as unknown as PlanningExecutor));
  }

  it('a goal created after the day was sealed, already off pace, announces itself at once', async () => {
    await sealSavingsDay();
    const goal = await inTransaction((executor) =>
      createGoal(executor, PORTS, context(), {
        kind: 'emergency_fund',
        name: 'Emergency fund',
        target: usd('20000'),
        targetDate: '2027-09-30',
      }),
    );

    const events = await offTrackEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      goalId: goal.id,
      asOfDate: SEALED_DAY,
      fundedSource: 'none',
    });
    expect(String(events[0]?.['evaluationId'])).toMatch(/^[0-9a-f-]{36}$/);
  }, 60_000);

  it('a goal that is on pace when it is written announces nothing', async () => {
    await sealSavingsDay();
    await inTransaction((executor) =>
      createGoal(executor, PORTS, context(), {
        kind: 'emergency_fund',
        name: 'Emergency fund',
        target: usd('20000'),
        targetDate: '2027-09-30',
        fundedFromAccountIds: [ACCOUNT_ID],
      }),
    );
    expect(await offTrackEvents()).toHaveLength(0);
  }, 60_000);

  it('re-targeting an on-pace goal past what its funding covers announces it; an edit that moves no input does not', async () => {
    await sealSavingsDay();
    const goal = await inTransaction((executor) =>
      createGoal(executor, PORTS, context(), {
        kind: 'emergency_fund',
        name: 'Emergency fund',
        target: usd('20000'),
        targetDate: '2027-09-30',
        fundedFromAccountIds: [ACCOUNT_ID],
      }),
    );
    expect(await offTrackEvents()).toHaveLength(0);

    // Not a pace input: a rename, a priority, and the same target restated.
    await inTransaction((executor) =>
      updateGoal(executor, PORTS, context(), goal.id, {
        name: 'Rainy day',
        priority: 1,
        target: usd('20000'),
      }),
    );
    expect(await offTrackEvents()).toHaveLength(0);

    // A pace input: the target is now more than the $50,000 held.
    await inTransaction((executor) =>
      updateGoal(executor, PORTS, context(), goal.id, { target: usd('80000') }),
    );
    const events = await offTrackEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ goalId: goal.id, fundedSource: 'funding_accounts' });
  }, 60_000);

  it('re-funding a goal (dropping its funding account) announces it', async () => {
    await sealSavingsDay();
    const goal = await inTransaction((executor) =>
      createGoal(executor, PORTS, context(), {
        kind: 'emergency_fund',
        name: 'Emergency fund',
        target: usd('20000'),
        targetDate: '2027-09-30',
        fundedFromAccountIds: [ACCOUNT_ID],
      }),
    );
    await inTransaction((executor) =>
      updateGoal(executor, PORTS, context(), goal.id, { fundedFromAccountIds: [] }),
    );
    expect(await offTrackEvents()).toHaveLength(1);
  }, 60_000);

  it('an off-pace goal is announced when written and again only when a pace input moves, not on a rename', async () => {
    await sealSavingsDay();
    const goal = await inTransaction((executor) =>
      createGoal(executor, PORTS, context(), {
        kind: 'emergency_fund',
        name: 'Emergency fund',
        target: usd('20000'),
        targetDate: '2027-09-30',
      }),
    );
    expect(await offTrackEvents()).toHaveLength(1);

    await inTransaction((executor) =>
      updateGoal(executor, PORTS, context(), goal.id, { name: 'Rainy day', priority: 2 }),
    );
    expect(await offTrackEvents()).toHaveLength(1);

    await inTransaction((executor) =>
      updateGoal(executor, PORTS, context(), goal.id, { targetDate: '2028-03-31' }),
    );
    expect(await offTrackEvents()).toHaveLength(2);
  }, 60_000);

  it('a paused goal is not evaluated when edited', async () => {
    await sealSavingsDay();
    const goal = await inTransaction((executor) =>
      createGoal(executor, PORTS, context(), {
        kind: 'emergency_fund',
        name: 'Emergency fund',
        target: usd('20000'),
        targetDate: '2027-09-30',
        fundedFromAccountIds: [ACCOUNT_ID],
      }),
    );
    await inTransaction((executor) =>
      updateGoal(executor, PORTS, context(), goal.id, { status: 'paused', target: usd('80000') }),
    );
    expect(await offTrackEvents()).toHaveLength(0);
  }, 60_000);

  it('with no sealed day there is nothing to evaluate against: no event, and the write still succeeds', async () => {
    const goal = await inTransaction((executor) =>
      createGoal(executor, PORTS, context(), {
        kind: 'emergency_fund',
        name: 'Emergency fund',
        target: usd('20000'),
        targetDate: '2027-09-30',
      }),
    );
    expect(goal.name).toBe('Emergency fund');
    expect(await offTrackEvents()).toHaveLength(0);
  }, 60_000);
});
