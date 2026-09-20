// SPDX-License-Identifier: MIT
import { mutableClock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toInstant, type TimestampValue } from '../src/instants.ts';
import { createScheduler, upsertSchedule } from '../src/jobs/scheduler.ts';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

describeWithDb('scheduler', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp03_scheduler');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
  });

  async function seedNightlySync(clock = mutableClock('2026-03-01T12:00:00Z')): Promise<void> {
    await upsertSchedule(
      database.db,
      {
        userId: database.userId,
        name: 'sync.nightly',
        cron: '15 3 * * *',
        timezone: 'America/New_York',
        jobKind: 'sync.all_connections',
      },
      clock,
    );
  }

  it('stores the next occurrence in the user timezone, not the container zone', async () => {
    await seedNightlySync();
    const rows = await database.db.execute<{ next_run_at: TimestampValue; timezone: string }>(
      sql`SELECT next_run_at, timezone FROM schedules WHERE name = 'sync.nightly'`,
    );
    expect(rows.rows[0]?.timezone).toBe('America/New_York');
    expect(toInstant(rows.rows[0]!.next_run_at).toISOString()).toBe('2026-03-02T08:15:00.000Z');
  });

  it('enqueues one job when a schedule comes due, and sets the next occurrence', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    await seedNightlySync(clock);

    clock.setTo('2026-03-02T08:20:00Z'); // five minutes after it was due
    const scheduler = createScheduler({ pool: database.pool, db: database.db, clock });
    expect(await scheduler.tick()).toBe(1);
    await scheduler.stop();

    const jobs = await database.db.execute<{ kind: string; dedupe_key: string }>(
      sql`SELECT kind, dedupe_key FROM jobs`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.kind).toBe('sync.all_connections');
    // The occurrence identity is when it was *due*, not when we got round to it.
    expect(jobs.rows[0]?.dedupe_key).toBe('schedule:sync.nightly:2026-03-02T08:15:00.000Z');

    const rows = await database.db.execute<{
      last_run_at: TimestampValue;
      next_run_at: TimestampValue;
    }>(sql`SELECT last_run_at, next_run_at FROM schedules WHERE name = 'sync.nightly'`);
    expect(toInstant(rows.rows[0]!.last_run_at).toISOString()).toBe('2026-03-02T08:20:00.000Z');
    expect(toInstant(rows.rows[0]!.next_run_at).toISOString()).toBe('2026-03-03T08:15:00.000Z');
  });

  /**
   * The container was off for two days. Coming back must produce one run, not
   * one per missed window — which is what stepping the cron forward from
   * `next_run_at` would do, and why the next occurrence is computed from *now*.
   */
  it('fires once after downtime rather than once per missed window', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    await seedNightlySync(clock);

    clock.setTo('2026-03-05T15:00:00Z'); // three missed nights
    const scheduler = createScheduler({ pool: database.pool, db: database.db, clock });
    expect(await scheduler.tick()).toBe(1);
    expect(await scheduler.tick()).toBe(0);
    await scheduler.stop();

    const jobs = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM jobs`,
    );
    expect(jobs.rows[0]?.count).toBe('1');

    const next = await database.db.execute<{ next_run_at: TimestampValue }>(
      sql`SELECT next_run_at FROM schedules WHERE name = 'sync.nightly'`,
    );
    expect(toInstant(next.rows[0]!.next_run_at).toISOString()).toBe('2026-03-06T08:15:00.000Z');
  });

  /**
   * The Phase 0 property that matters when the answer to "is the worker
   * healthy?" is "start a second one": two schedulers against one database must
   * produce one job, not two.
   */
  it('fires exactly once across two concurrent worker instances', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    await seedNightlySync(clock);
    clock.setTo('2026-03-02T08:20:00Z');

    const workerA = createScheduler({ pool: database.pool, db: database.db, clock });
    const workerB = createScheduler({ pool: database.pool, db: database.db, clock });

    const [firedA, firedB] = await Promise.all([workerA.tick(), workerB.tick()]);

    // Exactly one took leadership; the other did nothing at all.
    expect([workerA.isLeader(), workerB.isLeader()].filter(Boolean)).toHaveLength(1);
    expect(firedA + firedB).toBe(1);

    const jobs = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM jobs`,
    );
    expect(jobs.rows[0]?.count).toBe('1');

    await workerA.stop();
    await workerB.stop();
  }, 30_000);

  it('lets the second worker take over once the first releases leadership', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    await seedNightlySync(clock);
    clock.setTo('2026-03-02T08:20:00Z');

    const workerA = createScheduler({ pool: database.pool, db: database.db, clock });
    await workerA.tick();
    expect(workerA.isLeader()).toBe(true);
    await workerA.stop();

    clock.setTo('2026-03-03T08:20:00Z');
    const workerB = createScheduler({ pool: database.pool, db: database.db, clock });
    expect(await workerB.tick()).toBe(1);
    expect(workerB.isLeader()).toBe(true);
    await workerB.stop();
  }, 30_000);

  it('skips a disabled schedule and does not re-enable it on redeploy', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    await seedNightlySync(clock);
    await database.db.execute(
      sql`UPDATE schedules SET enabled = false WHERE name = 'sync.nightly'`,
    );

    // A redeploy calls upsertSchedule again. The user's choice must survive it.
    await seedNightlySync(clock);
    const rows = await database.db.execute<{ enabled: boolean }>(
      sql`SELECT enabled FROM schedules WHERE name = 'sync.nightly'`,
    );
    expect(rows.rows[0]?.enabled).toBe(false);

    clock.setTo('2026-03-05T15:00:00Z');
    const scheduler = createScheduler({ pool: database.pool, db: database.db, clock });
    expect(await scheduler.tick()).toBe(0);
    await scheduler.stop();
  });

  it('does not let one broken cron expression stop the other schedules', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    await seedNightlySync(clock);
    // Slipped past the CHECK constraint (which only tests for non-blank) and into
    // the table. cron-parser will refuse it at tick time.
    await database.db.execute(sql`
      INSERT INTO schedules (id, user_id, name, cron, timezone, job_kind, next_run_at)
      VALUES (gen_random_uuid(), ${database.userId}::uuid, 'broken.one', 'not a cron', 'UTC',
              'test.work', now() - interval '1 minute')
    `);

    clock.setTo('2026-03-02T08:20:00Z');
    const scheduler = createScheduler({ pool: database.pool, db: database.db, clock });
    expect(await scheduler.tick()).toBe(1);
    await scheduler.stop();

    const jobs = await database.db.execute<{ kind: string }>(sql`SELECT kind FROM jobs`);
    expect(jobs.rows.map((r) => r.kind)).toEqual(['sync.all_connections']);
  });

  it('applies jitter within the configured window', async () => {
    const clock = mutableClock('2026-03-01T12:00:00Z');
    await upsertSchedule(
      database.db,
      {
        userId: database.userId,
        name: 'sync.jittered',
        cron: '0 * * * *',
        timezone: 'UTC',
        jobKind: 'sync.all_connections',
        jitterSeconds: 1_200,
      },
      clock,
    );

    clock.setTo('2026-03-01T13:00:00Z');
    const scheduler = createScheduler({
      pool: database.pool,
      db: database.db,
      clock,
      random: () => 1,
    });
    await scheduler.tick();
    await scheduler.stop();

    const jobs = await database.db.execute<{ run_after: TimestampValue }>(
      sql`SELECT run_after FROM jobs`,
    );
    const delaySeconds = (toInstant(jobs.rows[0]!.run_after).getTime() - clock.nowMs()) / 1_000;
    expect(delaySeconds).toBeGreaterThan(1_100);
    expect(delaySeconds).toBeLessThanOrEqual(1_200);
  });
});

// ---------------------------------------------------------------------------
// Names are checked in code, not only by the CHECK constraint
// ---------------------------------------------------------------------------
//
// wp2.w-wiring.md: a context registered `notifications.deliver:<uuid>`, every
// unit test passed against a fake, and the real worker crash-looped from its
// first boot. `upsertSchedule` now refuses such a name before touching the
// database, so the failure is a unit-test failure with the name in it.
describe('schedule names', () => {
  it('refuses a name the database would refuse, before the insert', async () => {
    const { assertScheduleName, SCHEDULE_NAME_PATTERN } = await import('../src/jobs/scheduler.ts');
    for (const bad of [
      'notifications.deliver:6f1d2c0e-1b2a-4c3d-8e9f-0a1b2c3d4e5f',
      'Nightly',
      'sync-all',
      '.leading',
      'trailing.',
      'a..b',
    ]) {
      expect(() => assertScheduleName(bad), bad).toThrow(/schedule_name_invalid|must match/);
    }
    for (const good of [
      'sync.nightly',
      'notifications.deliver.6f1d2c0e_1b2a_4c3d_8e9f_0a1b2c3d4e5f',
      'a',
      'a1.b2_c3',
    ]) {
      expect(SCHEDULE_NAME_PATTERN.test(good), good).toBe(true);
      expect(() => assertScheduleName(good), good).not.toThrow();
    }
  });
});
