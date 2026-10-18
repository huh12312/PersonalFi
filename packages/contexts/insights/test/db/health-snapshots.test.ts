// SPDX-License-Identifier: MIT
/**
 * The daily health snapshot against a real Postgres (WP 10.12; migration 0048): one row per holder per
 * day, written once by the 04:10 job or on demand, never twice, never backfilled; the schedule at 04:10
 * local; the table's CHECKs refusing a score over no scored pillar.
 */
import { mutableClock } from '@core/kernel';
import { silentLogger, type JobContext } from '@core/platform';
import { createTestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HEALTH_SNAPSHOT_CRON,
  HEALTH_SNAPSHOT_JOB_KIND,
  HEALTH_SNAPSHOT_SCHEDULE_NAME,
  createHealthSnapshotJob,
  registerHealthSnapshotSchedule,
} from '../../src/health/job.ts';
import type { LivingExpensesPort } from '../../src/health/living-expenses.ts';
import {
  ensureHealthSnapshotForToday,
  findHealthSnapshot,
  listHealthSnapshots,
} from '../../src/health/snapshots.ts';
import { NO_DATABASE, ZONE, portsFor, type TestDatabase } from './harness.ts';

// 2026-09-19 09:00 UTC is 05:00 in New York — the holder's 19 September.
const MORNING = '2026-09-19T09:00:00.000Z';
const DAY_MS = 86_400_000;

function contextFor(userId: string, clock: ReturnType<typeof mutableClock>): JobContext {
  return {
    id: '1',
    userId,
    kind: HEALTH_SNAPSHOT_JOB_KIND,
    attempt: 1,
    correlationId: '01930000-0000-7000-8000-0000000000c1',
    logger: silentLogger,
    clock,
    signal: new AbortController().signal,
  };
}

async function rowCount(database: TestDatabase, userId?: string): Promise<number> {
  const result = await database.db.execute<{ n: number }>(
    userId === undefined
      ? sql`SELECT count(*)::int AS n FROM health_score_snapshots`
      : sql`SELECT count(*)::int AS n FROM health_score_snapshots WHERE user_id = ${userId}::uuid`,
  );
  return result.rows[0]?.n ?? -1;
}

describe.skipIf(NO_DATABASE)('the daily health snapshot', () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database ??= await createTestDatabase('wp1012_ins_health_snapshots');
    await database.truncate();
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 60_000);

  function deps(clock: ReturnType<typeof mutableClock>, living?: LivingExpensesPort) {
    return {
      database: database.db,
      snapshotPorts: portsFor(),
      tokenSecret: 'test-secret',
      currencyCode: 'USD',
      clock,
      timeZone: ZONE,
      ...(living === undefined ? {} : { livingExpenses: living }),
    };
  }

  it('the job writes one row per holder per day: a second tick the same day writes nothing', async () => {
    const clock = mutableClock(MORNING);
    const job = createHealthSnapshotJob(deps(clock));
    await job.handler({}, contextFor(database.userId, clock));
    await job.handler({}, contextFor(database.userId, clock));
    clock.advanceMs(6 * 3_600_000); // later the same local day
    await job.handler({}, contextFor(database.userId, clock));
    expect(await rowCount(database, database.userId)).toBe(1);
    const row = await findHealthSnapshot(database.db, database.userId, '2026-09-19' as never);
    expect(row?.asOfDate).toBe('2026-09-19');
    expect(row?.pillars).toHaveLength(6);
  });

  it('per holder: a second holder the same day gets their own row, and neither sees the other', async () => {
    const clock = mutableClock(MORNING);
    const other = await database.createUser('Second Holder');
    const job = createHealthSnapshotJob(deps(clock));
    await job.handler({}, contextFor(database.userId, clock));
    await job.handler({}, contextFor(other, clock));
    await job.handler({}, contextFor(other, clock));
    expect(await rowCount(database, database.userId)).toBe(1);
    expect(await rowCount(database, other)).toBe(1);
    expect(await rowCount(database)).toBe(2);
  });

  it('the on-demand write and the job share one row: whichever comes first writes, the other reads it', async () => {
    const clock = mutableClock(MORNING);
    const onDemand = await ensureHealthSnapshotForToday(deps(clock), {
      userId: database.userId,
      timeZone: ZONE,
    });
    expect(onDemand.written).toBe(true);
    await createHealthSnapshotJob(deps(clock)).handler({}, contextFor(database.userId, clock));
    const again = await ensureHealthSnapshotForToday(deps(clock), {
      userId: database.userId,
      timeZone: ZONE,
    });
    expect(again.written).toBe(false);
    expect(again.snapshot.id).toBe(onDemand.snapshot.id);
    expect(await rowCount(database, database.userId)).toBe(1);
  });

  it('two concurrent on-demand writes for the same day leave one row', async () => {
    const clock = mutableClock(MORNING);
    const [a, b] = await Promise.all([
      ensureHealthSnapshotForToday(deps(clock), { userId: database.userId, timeZone: ZONE }),
      ensureHealthSnapshotForToday(deps(clock), { userId: database.userId, timeZone: ZONE }),
    ]);
    expect(a.snapshot.id).toBe(b.snapshot.id);
    expect(await rowCount(database, database.userId)).toBe(1);
  });

  it('the next day is a new row; a day nobody computed is never backfilled', async () => {
    const clock = mutableClock(MORNING);
    const job = createHealthSnapshotJob(deps(clock));
    await job.handler({}, contextFor(database.userId, clock));
    clock.advanceMs(3 * DAY_MS); // the worker was down for two days
    await job.handler({}, contextFor(database.userId, clock));
    const rows = await listHealthSnapshots(database.db, database.userId, {
      from: '2026-09-01' as never,
      to: '2026-09-30' as never,
    });
    expect(rows.map((row) => row.asOfDate)).toEqual(['2026-09-19', '2026-09-22']);
  });

  it("'today' is the holder's day, not UTC's: 02:00 UTC on the 20th is still the 19th in New York", async () => {
    const clock = mutableClock('2026-09-20T02:00:00.000Z');
    await createHealthSnapshotJob(deps(clock)).handler({}, contextFor(database.userId, clock));
    const rows = await listHealthSnapshots(database.db, database.userId, {
      from: '2026-09-01' as never,
      to: '2026-09-30' as never,
    });
    expect(rows.map((row) => row.asOfDate)).toEqual(['2026-09-19']);
  });

  it('the living-expenses port is read over the twelve complete months, and its result lands on the emergency-fund pillar', async () => {
    const clock = mutableClock(MORNING);
    const windows: unknown[] = [];
    const living: LivingExpensesPort = async (input) => {
      windows.push(input.window);
      return { currency: 'USD', categories: [{ id: 'rent', variability: null }], cells: [] };
    };
    const { snapshot } = await ensureHealthSnapshotForToday(deps(clock, living), {
      userId: database.userId,
      timeZone: ZONE,
    });
    expect(windows).toEqual([{ from: '2025-09-01', to: '2026-08-31' }]);
    const emergency = snapshot.pillars.find((p) => p.component === 'emergency_fund_months');
    expect(emergency?.livingCover).toMatchObject({
      status: 'withheld',
      unlock: 'Classify your categories on the Budget screen.',
    });
    // Read back from Postgres, not from the write's return value.
    const stored = await findHealthSnapshot(database.db, database.userId, snapshot.asOfDate);
    expect(
      stored?.pillars.find((p) => p.component === 'emergency_fund_months')?.livingCover,
    ).toEqual(emergency?.livingCover);
  });

  it('the table refuses a score over no scored pillar, a missing score beside one, and a seventh pillar', async () => {
    const withheld = JSON.stringify(
      Array.from({ length: 6 }, () => ({ status: 'withheld', component: 'fee_drag' })),
    );
    const scored = JSON.stringify([
      { status: 'scored' },
      ...Array.from({ length: 5 }, () => ({ status: 'withheld' })),
    ]);
    const insert = (score: string | null, pillars: string) =>
      database.db.execute(sql`
        INSERT INTO health_score_snapshots (id, user_id, as_of_date, score, pillars, computed_at)
        VALUES ('01930000-0000-7000-8000-00000000f001', ${database.userId}::uuid, '2026-09-19',
                ${score}::numeric, ${pillars}::jsonb, now())`);
    const constraintOf = async (attempt: Promise<unknown>): Promise<string | null> => {
      try {
        await attempt;
        return null;
      } catch (error) {
        return (error as { cause?: { constraint?: string } }).cause?.constraint ?? String(error);
      }
    };
    expect(await constraintOf(insert('50.00', withheld))).toBe(
      'health_score_snapshots_score_requires_pillar',
    );
    expect(await constraintOf(insert(null, scored))).toBe(
      'health_score_snapshots_score_requires_pillar',
    );
    expect(
      await constraintOf(
        insert(null, JSON.stringify(Array.from({ length: 7 }, () => ({ status: 'withheld' })))),
      ),
    ).toBe('health_score_snapshots_six_pillars');
    await insert(null, withheld); // all withheld, no score: legal
    expect(await rowCount(database)).toBe(1);
  });

  it('the schedule is 04:10 in the holder’s zone, every day, for job insights.health_snapshot', async () => {
    const clock = mutableClock(MORNING);
    await registerHealthSnapshotSchedule(
      database.db,
      { userId: database.userId, timezone: ZONE },
      clock,
    );
    await registerHealthSnapshotSchedule(
      database.db,
      { userId: database.userId, timezone: ZONE },
      clock,
    );
    const rows = await database.db.execute<{
      cron: string;
      timezone: string;
      job_kind: string;
    }>(sql`
      SELECT cron, timezone, job_kind FROM schedules
      WHERE user_id = ${database.userId}::uuid AND name = ${HEALTH_SNAPSHOT_SCHEDULE_NAME}`);
    expect(rows.rows).toEqual([
      { cron: DEFAULT_HEALTH_SNAPSHOT_CRON, timezone: ZONE, job_kind: HEALTH_SNAPSHOT_JOB_KIND },
    ]);
    expect(DEFAULT_HEALTH_SNAPSHOT_CRON).toBe('10 4 * * *');
  });
});
