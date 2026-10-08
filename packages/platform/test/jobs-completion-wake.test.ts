// SPDX-License-Identifier: MIT
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enqueueJob } from '../src/jobs/queue.ts';
import { createJobRunner, defineJob } from '../src/jobs/runner.ts';
import { ADMIN_URL, createTestDatabase, waitFor, type TestDatabase } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

/**
 * WP 9.14 / P-1 (WP 9.9 `wp9.9-perf.md` §9). A job runner whose kind is at its
 * cap — or whose process is at its global cap — used to sleep the whole
 * `pollIntervalMs` after a job FINISHED, because only an enqueue notifies the
 * listener. A capped kind then ran one job per poll interval however short the
 * job was: the nightly insights fan-out (40 jobs, per-kind cap 1) spent 198 of
 * its 243 s waiting for the clock. A completion frees capacity, so it must wake
 * the claim loop.
 *
 * Every job here is instant and every poll interval is two seconds, so a runner
 * that only wakes on the clock drains one job per two seconds and these budgets
 * cannot be met.
 */
describeWithDb('job runner: a completion wakes the claim loop', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp914_jobs_wake');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
  });

  async function enqueueMany(kind: string, count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await enqueueJob(database.db, {
        userId: database.userId,
        kind,
        correlationId: newId(),
        payload: { index },
      });
    }
  }

  async function succeeded(): Promise<number> {
    const rows = await database.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM jobs WHERE status = 'succeeded'`,
    );
    return rows.rows[0]?.n ?? 0;
  }

  it('drains a kind capped at one far faster than one job per poll interval', async () => {
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      pollIntervalMs: 2_000,
      handlers: [defineJob('test.capped', () => undefined, { concurrency: 1 })],
    });
    await enqueueMany('test.capped', 6);

    const startedAt = Date.now();
    await runner.start();
    try {
      await waitFor(async () => (await succeeded()) === 6, {
        timeoutMs: 1_500,
        intervalMs: 20,
        what: 'six instant jobs of a capped kind to finish inside one poll interval',
      });
    } finally {
      await runner.stop();
    }
    expect(Date.now() - startedAt).toBeLessThan(1_800);
  }, 20_000);

  it('drains a process capped at one job in flight the same way', async () => {
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      concurrency: 1,
      pollIntervalMs: 2_000,
      handlers: [defineJob('test.global', () => undefined)],
    });
    await enqueueMany('test.global', 6);

    await runner.start();
    try {
      await waitFor(async () => (await succeeded()) === 6, {
        timeoutMs: 1_500,
        intervalMs: 20,
        what: 'six instant jobs to finish inside one poll interval at a global cap of one',
      });
    } finally {
      await runner.stop();
    }
  }, 20_000);

  it('still polls on the clock when nothing finishes: the wake is not a busy loop', async () => {
    let polls = 0;
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      pollIntervalMs: 2_000,
      onPoll: () => {
        polls += 1;
      },
      handlers: [defineJob('test.idle', () => undefined, { concurrency: 1 })],
    });
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 900));
    await runner.stop();
    // One pass at start; the next is due at 2 s. A loop spinning on itself would
    // report hundreds.
    expect(polls).toBeLessThanOrEqual(2);
  }, 20_000);

  it('a failing job does not spin the loop while its retry is backing off', async () => {
    let attempts = 0;
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      pollIntervalMs: 2_000,
      handlers: [
        defineJob(
          'test.failing',
          () => {
            attempts += 1;
            throw new Error('boom');
          },
          { backoff: { baseMs: 60_000, maxMs: 60_000, jitter: 'none' } },
        ),
      ],
    });
    await enqueueMany('test.failing', 1);
    await runner.start();
    await new Promise((resolve) => setTimeout(resolve, 900));
    await runner.stop();
    // Run once, then parked for the backoff: a wake that re-claimed it would
    // be a retry storm.
    expect(attempts).toBe(1);
  }, 20_000);
});
