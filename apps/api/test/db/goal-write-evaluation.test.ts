// SPDX-License-Identifier: MIT
/**
 * G4-14 through the shipped routes (C5-11): `POST /goals` and `PATCH /goals/{id}`
 * evaluate the goal they wrote against the latest sealed day and append
 * `planning.GoalOffTrack`. The package-level proof is
 * `packages/contexts/planning/test/db/goal-write-evaluation.test.ts`; this is
 * the same claim through the real route, `createGoal` and the real database.
 */
import { systemClock } from '@core/kernel';
import { sealDay, upsertOpenDay, type NetWorthSnapshot } from '@ctx/planning';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

function emptyDay(asOfDate: string): NetWorthSnapshot {
  return {
    asOfDate,
    baseCurrency: 'USD',
    assetsMinor: 0n,
    liabilitiesMinor: 0n,
    netWorthMinor: 0n,
    liquidMinor: 0n,
    investableMinor: 0n,
    onBudgetMinor: 0n,
    breakdown: [],
    source: 'observed',
    stalePrice: false,
    accountsCounted: 0,
    accountsUnvalued: 0,
    unvalued: [],
  };
}

describe.skipIf(NO_DATABASE)('goals are evaluated on write, through the routes (G4-14)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp93goalwrite' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  async function offTrackFor(goalId: string): Promise<number> {
    const result = await h.database.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM domain_events
       WHERE event_type = 'planning.GoalOffTrack' AND payload->>'goalId' = ${goalId}
    `);
    return Number(result.rows[0]?.n ?? 0);
  }

  it('a goal created after the day was sealed is judged at once; moving its date judges it again', async () => {
    const day = new Date(systemClock.now().getTime() - 86_400_000).toISOString().slice(0, 10);
    await upsertOpenDay(h.database.db, {
      userId: h.userId,
      snapshot: emptyDay(day),
      clock: systemClock,
    });
    await sealDay(h.database.db, { userId: h.userId, asOfDate: day, clock: systemClock });

    const created = await h.request({
      method: 'POST',
      url: '/goals',
      session: h.stale,
      body: {
        kind: 'purchase',
        name: 'House deposit',
        target: { minor: '2000000', currency: 'USD' },
        targetDate: '2099-01-01',
      },
    });
    expectStatus(created, 201);
    const goalId = (created.json() as { id: string }).id;
    expect(await offTrackFor(goalId)).toBe(1);

    const patched = await h.request({
      method: 'PATCH',
      url: `/goals/${goalId}`,
      session: h.stale,
      body: { targetDate: '2098-01-01' },
    });
    expectStatus(patched, 200);
    expect(await offTrackFor(goalId)).toBe(2);

    const renamed = await h.request({
      method: 'PATCH',
      url: `/goals/${goalId}`,
      session: h.stale,
      body: { name: 'Deposit' },
    });
    expectStatus(renamed, 200);
    expect(await offTrackFor(goalId)).toBe(2);
  }, 60_000);
});
