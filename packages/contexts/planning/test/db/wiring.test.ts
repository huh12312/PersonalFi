// SPDX-License-Identifier: MIT
/**
 * The three things the composition root will register, proved against the real
 * database rather than against a fake that never applies a constraint.
 *
 * That distinction is not academic here. The Phase 2 cold boot found a context
 * registering `notifications.deliver:<uuid>`: every unit test passed because the
 * fake scheduler never applied `schedules.name`'s CHECK, and the real worker
 * crash-looped from its first start. So the schedule is inserted through the
 * real `upsertSchedule` into a real `schedules` table here.
 */
import { fixedClock } from '@core/kernel';
import { recordingLogger, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeNetWorth } from '../../src/net-worth.ts';
import { createNetWorthConsumer, CONSUMER_NAME } from '../../src/consumer.ts';
import {
  SNAPSHOT_CRON,
  SNAPSHOT_JOB_KIND,
  SNAPSHOT_SCHEDULE_NAME,
  registerNetWorthSnapshotSchedule,
} from '../../src/jobs.ts';
import { runSnapshot } from '../../src/snapshot.ts';
import { currentRow, markDirty, sealDay, upsertOpenDay } from '../../src/store.ts';
import type { PlanningExecutor } from '../../src/store.ts';
import { portsOf, type FakeWorld } from '../fakes.ts';
import { CORRELATION_ID, NO_DATABASE, planningDatabase } from './harness.ts';
import fixture from '../fixtures/hand-computation.json' with { type: 'json' };

const NEW_YORK = 'America/New_York';
const world = fixture.world as unknown as FakeWorld;

function worldOn(date: string): FakeWorld {
  return {
    ...world,
    balances: world.balances.map((row) => ({ ...row, date })),
    holdings: (world.holdings ?? []).map((row) => ({ ...row, asOfDate: date })),
    prices: (world.prices ?? []).map((row) => ({ ...row, date })),
    fxRates: (world.fxRates ?? []).map((row) => ({ ...row, date })),
  };
}

describe.skipIf(NO_DATABASE)('registration, against Postgres', () => {
  let database: TestDatabase;
  let executor: PlanningExecutor;

  beforeAll(async () => {
    database = await planningDatabase('wiring');
    executor = database.db;
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  it('lands the schedule row through the real upsertSchedule', async () => {
    const clock = fixedClock(new Date('2026-06-15T18:00:00Z'));
    await registerNetWorthSnapshotSchedule(
      executor,
      { userId: database.userId, timezone: NEW_YORK },
      clock,
    );

    const result = await database.db.execute<{
      name: string;
      cron: string;
      timezone: string;
      job_kind: string;
      enabled: boolean;
      jitter_seconds: number;
      // A raw `execute` returns `timestamptz` as a **string**, not a `Date` —
      // the same trap the wiring batch hit with `sync_runs.started_at`
      // (wp3.w-wiring.md §4, "second defect"). Typed honestly here so the
      // conversion below is deliberate rather than a `.toISOString()` that
      // throws the first time it meets a real row.
      next_run_at: string | Date;
    }>(sql`
      SELECT name, cron, timezone, job_kind, enabled, jitter_seconds, next_run_at
        FROM schedules WHERE user_id = ${database.userId}::uuid
    `);

    const row = result.rows[0];
    expect(row?.name).toBe(SNAPSHOT_SCHEDULE_NAME);
    expect(row?.job_kind).toBe(SNAPSHOT_JOB_KIND);
    expect(row?.cron).toBe(SNAPSHOT_CRON);
    expect(row?.timezone).toBe(NEW_YORK);
    expect(row?.enabled).toBe(true);
    expect(row?.jitter_seconds).toBe(600);

    // 04:00 *local* on the 16th, which is 08:00Z while New York is on EDT. The
    // cron is resolved against the row's zone, so this is the assertion that
    // would fail if the schedule were being computed in UTC.
    expect(new Date(row?.next_run_at ?? 0).toISOString()).toBe('2026-06-16T08:00:00.000Z');
  });

  it('is idempotent: re-registering at boot does not create a second row', async () => {
    const clock = fixedClock(new Date('2026-06-15T19:00:00Z'));
    await registerNetWorthSnapshotSchedule(
      executor,
      { userId: database.userId, timezone: NEW_YORK },
      clock,
    );
    const result = await database.db.execute(sql`
      SELECT id FROM schedules WHERE user_id = ${database.userId}::uuid
    `);
    expect(result.rows).toHaveLength(1);
  });

  it('marks the open day dirty and leaves a sealed day alone', async () => {
    const userId = await database.createUser('Dirty Holder');
    const clock = fixedClock(new Date('2026-06-15T18:00:00Z'));

    const open = await computeNetWorth(portsOf(worldOn('2026-06-15')), {
      userId,
      asOfDate: '2026-06-15',
      baseCurrency: 'USD',
    });
    await upsertOpenDay(executor, { userId, snapshot: open, clock });

    expect(await markDirty(executor, { userId, asOfDate: '2026-06-15', clock })).toBe(1);
    expect((await currentRow(executor, userId, '2026-06-15'))?.dirty).toBe(true);

    // Idempotent: the `AND NOT dirty` means a replay writes no rows at all.
    expect(await markDirty(executor, { userId, asOfDate: '2026-06-15', clock })).toBe(0);

    // A sealed day has nothing left to redo, and marking it would be an UPDATE
    // on a sealed row — which the trigger would refuse. The guard means the
    // consumer never issues it.
    const past = await computeNetWorth(portsOf(worldOn('2026-06-10')), {
      userId,
      asOfDate: '2026-06-10',
      baseCurrency: 'USD',
    });
    await upsertOpenDay(executor, { userId, snapshot: past, clock });
    await sealDay(executor, { userId, asOfDate: '2026-06-10', clock });
    expect(await markDirty(executor, { userId, asOfDate: '2026-06-10', clock })).toBe(0);
  });

  it('marks nothing, without failing, when the day has no row yet', async () => {
    // A fresh install. Not a gap: the snapshotter computes today from scratch,
    // and inserting a placeholder so the flag had somewhere to live would put a
    // point on the chart claiming a net worth of zero.
    const userId = await database.createUser('Fresh Holder');
    const clock = fixedClock(new Date('2026-06-15T18:00:00Z'));
    expect(await markDirty(executor, { userId, asOfDate: '2026-06-15', clock })).toBe(0);
  });

  it('drives the consumer over a real envelope and clears the flag on the next snapshot', async () => {
    const userId = await database.createUser('Consumer Holder');
    const clock = fixedClock(new Date('2026-06-15T18:00:00Z'));

    const snapshot = await computeNetWorth(portsOf(worldOn('2026-06-15')), {
      userId,
      asOfDate: '2026-06-15',
      baseCurrency: 'USD',
    });
    await upsertOpenDay(executor, { userId, snapshot, clock });

    const consumer = createNetWorthConsumer({
      database: executor,
      options: { timeZone: NEW_YORK },
    });
    expect(consumer.name).toBe(CONSUMER_NAME);

    const logger = recordingLogger();
    await consumer.handler(
      {
        id: '01920000-0000-7000-8000-0000000000e1',
        userId,
        aggregateType: 'account',
        aggregateId: null,
        eventType: 'ledger.BalanceRecorded',
        eventVersion: 1,
        payload: { accountId: null, asOf: '2026-06-15T17:00:00.000Z', source: 'provider' },
        occurredAt: clock.now(),
        correlationId: CORRELATION_ID,
        causationId: null,
        redaction: 'none',
        seq: 1n,
      } as never,
      { clock, logger, userId, correlationId: CORRELATION_ID } as never,
    );

    expect((await currentRow(executor, userId, '2026-06-15'))?.dirty).toBe(true);

    // And the next snapshot clears it: the row now reflects everything known at
    // `computed_at`, which is precisely what the flag means.
    await runSnapshot(executor, portsOf(worldOn('2026-06-15')), {
      userId,
      clock,
      timeZone: NEW_YORK,
      baseCurrency: 'USD',
      correlationId: CORRELATION_ID,
    });
    expect((await currentRow(executor, userId, '2026-06-15'))?.dirty).toBe(false);
  });

  it('appends planning.NetWorthSnapshotTaken in the same transaction as the row', async () => {
    const userId = await database.createUser('Event Holder');
    const clock = fixedClock(new Date('2026-06-15T18:00:00Z'));

    await runSnapshot(executor, portsOf(worldOn('2026-06-15')), {
      userId,
      clock,
      timeZone: NEW_YORK,
      baseCurrency: 'USD',
      correlationId: CORRELATION_ID,
    });

    const events = await database.db.execute<{
      event_type: string;
      payload: Record<string, unknown>;
    }>(sql`
      SELECT event_type, payload FROM domain_events
       WHERE user_id = ${userId}::uuid ORDER BY seq
    `);

    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.event_type).toBe('planning.NetWorthSnapshotTaken');
    const payload = events.rows[0]?.payload ?? {};
    expect(payload['asOfDate']).toBe('2026-06-15');
    expect(payload['revision']).toBe(1);
    expect(payload['sealed']).toBe(false);
    // Minor units as a string on the wire, never a JSON number.
    expect(typeof payload['netWorthMinor']).toBe('string');
    expect(payload['netWorthMinor']).toBe(fixture.expected.netWorthMinor);
  });

  it('rolls the event back with the row when the snapshot fails', async () => {
    // The reason `appendEvent` runs on the same handle as the write: an event
    // announcing a snapshot whose row rolled back has told a notification rule
    // something untrue.
    const userId = await database.createUser('Rollback Holder');
    const clock = fixedClock(new Date('2026-06-15T18:00:00Z'));

    // A CAD account with the rate removed — `FxRateUnavailable`, mid-run.
    const broken: FakeWorld = { ...worldOn('2026-06-15'), fxRates: [] };

    await expect(
      database.db.transaction(async (tx) => {
        await runSnapshot(tx as unknown as PlanningExecutor, portsOf(broken), {
          userId,
          clock,
          timeZone: NEW_YORK,
          baseCurrency: 'USD',
          correlationId: CORRELATION_ID,
        });
      }),
    ).rejects.toThrow();

    const rows = await database.db.execute(sql`
      SELECT id FROM net_worth_daily WHERE user_id = ${userId}::uuid
    `);
    const events = await database.db.execute(sql`
      SELECT id FROM domain_events WHERE user_id = ${userId}::uuid
    `);
    expect(rows.rows).toHaveLength(0);
    expect(events.rows).toHaveLength(0);
  });
});
