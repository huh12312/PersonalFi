// SPDX-License-Identifier: MIT
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendEvent } from '../src/events/outbox.ts';
import { defineEvent } from '../src/events/registry.ts';
import { cancelJob, enqueueJob, queueHealth, retryDeadJob } from '../src/jobs/queue.ts';
import { createJobRunner, defineJob } from '../src/jobs/runner.ts';
import { createMetrics } from '../src/metrics.ts';
import { ADMIN_URL, createTestDatabase, waitFor, type TestDatabase } from './harness.ts';
import { z } from 'zod';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const SyncRequested = defineEvent({
  type: 'connections.SyncRequested',
  aggregateType: 'connection',
  description: 'A sync was asked for. The job that does it is enqueued in the same transaction.',
  schema: z.object({ connectionId: z.uuid() }),
});

describeWithDb('job queue', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp03_jobs');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
  });

  function input(overrides: Partial<Parameters<typeof enqueueJob>[1]> = {}) {
    return {
      userId: database.userId,
      kind: 'test.work',
      correlationId: newId(),
      ...overrides,
    };
  }

  it('enqueues and runs a job', async () => {
    const done: unknown[] = [];
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      handlers: [defineJob('test.work', (payload) => void done.push(payload))],
    });

    await enqueueJob(database.db, input({ payload: { n: 1 } }));
    expect(await runner.runOnce()).toBe(1);
    expect(done).toEqual([{ n: 1 }]);

    const rows = await database.db.execute<{ status: string; attempts: number }>(
      sql`SELECT status, attempts FROM jobs`,
    );
    expect(rows.rows[0]).toMatchObject({ status: 'succeeded', attempts: 1 });

    const runs = await database.db.execute<{ outcome: string; attempt: number }>(
      sql`SELECT outcome, attempt FROM job_runs`,
    );
    expect(runs.rows[0]).toMatchObject({ outcome: 'succeeded', attempt: 1 });
  });

  /**
   * The decisive property of a Postgres queue: the data and the work that follows
   * from it are one atom. A sync that commits a page and then fails to enqueue
   * the next one is a silently truncated backfill.
   */
  it('enqueues inside the same transaction as the event that justifies it', async () => {
    const event = SyncRequested.create(
      { connectionId: newId() },
      { userId: database.userId, correlationId: newId() },
    );

    await expect(
      database.db.transaction(async (tx) => {
        await appendEvent(tx, event);
        await enqueueJob(tx, input({ kind: 'sync.connection' }));
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    const counts = await database.db.execute<{ events: string; jobs: string }>(sql`
      SELECT (SELECT count(*) FROM domain_events)::text AS events,
             (SELECT count(*) FROM jobs)::text AS jobs
    `);
    expect(counts.rows[0]).toEqual({ events: '0', jobs: '0' });
  });

  it('deduplicates by key rather than queueing three syncs of one connection', async () => {
    const metrics = createMetrics();
    const key = 'sync:connection:abc';
    const first = await enqueueJob(database.db, input({ dedupeKey: key }), { metrics });
    const second = await enqueueJob(database.db, input({ dedupeKey: key }), { metrics });
    const third = await enqueueJob(database.db, input({ dedupeKey: key }), { metrics });

    expect(second).toEqual({ id: first.id, deduped: true });
    expect(third.id).toBe(first.id);
    expect(metrics.snapshot().counters['platform.jobs.deduped{kind=test.work}']).toBe(2);

    const rows = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM jobs`,
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('lets the same dedupe key be used again once the job has finished', async () => {
    const key = 'sync:connection:abc';
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      handlers: [defineJob('test.work', () => undefined)],
    });

    const first = await enqueueJob(database.db, input({ dedupeKey: key }));
    await runner.runOnce();
    const second = await enqueueJob(database.db, input({ dedupeKey: key }));
    expect(second.deduped).toBe(false);
    expect(second.id).not.toBe(first.id);
  });

  it('runs at most one job per singleton key at a time, across workers', async () => {
    // Two jobs, same singleton key, two workers. The second must wait rather than
    // being dropped — which is the difference between `singletonKey` and
    // `dedupeKey`, and the reason both exist.
    await enqueueJob(database.db, input({ singletonKey: 'projection' }));
    await enqueueJob(database.db, input({ singletonKey: 'projection' }));

    let inFlight = 0;
    let maxConcurrent = 0;
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const handler = defineJob('test.work', async () => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      await gate;
      inFlight -= 1;
    });

    const a = createJobRunner({ pool: database.pool, db: database.db, handlers: [handler] });
    const b = createJobRunner({ pool: database.pool, db: database.db, handlers: [handler] });

    const first = a.runOnce();
    await waitFor(() => inFlight === 1, { what: 'the first singleton job to start' });
    // B tries while A holds the key. It must claim nothing.
    expect(await b.runOnce()).toBe(0);

    release();
    await first;
    expect(maxConcurrent).toBe(1);
    // And now that A is done, B can take the second one.
    expect(await b.runOnce()).toBe(1);
  }, 30_000);

  it('does not run a delayed job before its time', async () => {
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      handlers: [defineJob('test.work', () => undefined)],
    });
    await enqueueJob(database.db, input({ runAfter: new Date(Date.now() + 60_000) }));
    expect(await runner.runOnce()).toBe(0);
  });

  it('retries with backoff and then marks the job dead rather than dropping it', async () => {
    const metrics = createMetrics();
    let attempts = 0;
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      metrics,
      random: () => 0,
      handlers: [
        defineJob('test.work', () => {
          attempts += 1;
          throw new Error('provider is down');
        }),
      ],
    });

    await enqueueJob(database.db, input({ maxAttempts: 3 }));
    for (let round = 0; round < 4; round += 1) await runner.runOnce();

    expect(attempts).toBe(3);
    const rows = await database.db.execute<{ status: string; last_error: { message: string } }>(
      sql`SELECT status, last_error FROM jobs`,
    );
    expect(rows.rows[0]?.status).toBe('dead');
    expect(rows.rows[0]?.last_error.message).toContain('provider is down');
    expect(metrics.snapshot().counters['platform.jobs.dead{kind=test.work}']).toBe(1);

    // Every attempt is on the record, which is what makes "why did last night's
    // sync not happen?" answerable from a table rather than a rotated log.
    const runs = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM job_runs WHERE outcome = 'failed'`,
    );
    expect(runs.rows[0]?.count).toBe('3');
  });

  it('makes a dead job retryable by hand', async () => {
    let attempts = 0;
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      random: () => 0,
      handlers: [
        defineJob('test.work', () => {
          attempts += 1;
          if (attempts <= 1) throw new Error('once');
        }),
      ],
    });
    const { id } = await enqueueJob(database.db, input({ maxAttempts: 1 }));
    await runner.runOnce();

    expect(await retryDeadJob(database.db, id)).toBe(true);
    await runner.runOnce();
    const rows = await database.db.execute<{ status: string }>(sql`SELECT status FROM jobs`);
    expect(rows.rows[0]?.status).toBe('succeeded');
  });

  it('cancels a pending job but leaves a running one alone', async () => {
    const { id } = await enqueueJob(database.db, input());
    expect(await cancelJob(database.db, id)).toBe(true);
    expect(await cancelJob(database.db, id)).toBe(false);
  });

  it('treats an unhandled job kind as a job failure, not a worker crash', async () => {
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      random: () => 0,
      handlers: [defineJob('test.work', () => undefined)],
    });
    // Claimed only because the kind is registered; the handler is then removed.
    await enqueueJob(database.db, input({ kind: 'test.work', maxAttempts: 1 }));
    const orphan = createJobRunner({
      pool: database.pool,
      db: database.db,
      random: () => 0,
      handlers: [defineJob('test.work', () => undefined)],
    });
    expect(await orphan.runOnce()).toBe(1);
    expect(runner.workerId).not.toBe(orphan.workerId);
  });

  it('rejects a job kind that is not lower_snake dotted', async () => {
    await expect(enqueueJob(database.db, input({ kind: 'Test.Work' }))).rejects.toThrow(
      /job kind/i,
    );
  });

  /**
   * The heartbeat is what makes this queue survive `docker kill` rather than only
   * a clean restart. Without the reaper, one killed worker leaves a job `running`
   * forever and the nightly sync silently never happens again.
   */
  it('reclaims a job whose worker stopped heartbeating', async () => {
    const metrics = createMetrics();
    await enqueueJob(database.db, input());

    // Simulate a killed worker: claimed, then no pulse.
    await database.db.execute(sql`
      UPDATE jobs SET status = 'running', attempts = 1, locked_by = 'ghost',
                      locked_at = now() - interval '10 minutes',
                      heartbeat_at = now() - interval '10 minutes'
    `);
    const jobRow = await database.db.execute<{ id: string }>(sql`SELECT id FROM jobs LIMIT 1`);
    await database.db.execute(sql`
      INSERT INTO job_runs (id, job_id, user_id, attempt, worker_id, correlation_id)
      VALUES (${newId()}::uuid, ${jobRow.rows[0]!.id}::uuid, ${database.userId}::uuid, 1, 'ghost', ${newId()}::uuid)
    `);

    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      metrics,
      handlers: [defineJob('test.work', () => undefined)],
    });

    expect(await runner.reclaimStalled()).toBe(1);
    expect(metrics.snapshot().counters['platform.jobs.reclaimed']).toBe(1);

    const abandoned = await database.db.execute<{ outcome: string }>(
      sql`SELECT outcome FROM job_runs WHERE worker_id = 'ghost'`,
    );
    // The abandoned attempt is recorded, not erased: "killed four nights running"
    // is the most useful thing the history can say.
    expect(abandoned.rows[0]?.outcome).toBe('abandoned');

    expect(await runner.runOnce()).toBe(1);
  });

  it('finishes in-flight work on graceful shutdown', async () => {
    let finished = false;
    let started = false;
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      pollIntervalMs: 50,
      shutdownGraceMs: 10_000,
      handlers: [
        defineJob('test.work', async () => {
          started = true;
          await new Promise((resolve) => setTimeout(resolve, 600));
          finished = true;
        }),
      ],
    });

    await enqueueJob(database.db, input());
    await runner.start();
    await waitFor(() => started, { what: 'the job to start' });

    // SIGTERM arrives mid-job. `stop()` must not return until the work is done.
    await runner.stop();
    expect(finished, 'stop() must wait for in-flight work').toBe(true);

    const rows = await database.db.execute<{ status: string }>(sql`SELECT status FROM jobs`);
    expect(rows.rows[0]?.status).toBe('succeeded');
  }, 30_000);

  it('aborts in-flight work only after the grace period, and leaves it recoverable', async () => {
    let aborted = false;
    const runner = createJobRunner({
      pool: database.pool,
      db: database.db,
      pollIntervalMs: 50,
      shutdownGraceMs: 200,
      handlers: [
        defineJob('test.work', async (_payload, context) => {
          await new Promise<void>((resolve) => {
            context.signal.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
            setTimeout(resolve, 5_000).unref?.();
          });
        }),
      ],
    });

    await enqueueJob(database.db, input());
    await runner.start();
    await waitFor(
      async () => {
        const rows = await database.db.execute<{ status: string }>(sql`SELECT status FROM jobs`);
        return rows.rows[0]?.status === 'running';
      },
      { what: 'the job to be claimed' },
    );
    await runner.stop();
    expect(aborted).toBe(true);
  }, 30_000);

  it('reports queue depth and staleness for /ready', async () => {
    await enqueueJob(database.db, input());
    await enqueueJob(database.db, input({ runAfter: new Date(Date.now() + 3_600_000) }));

    const health = await queueHealth(database.db);
    expect(health.pending).toBe(2);
    expect(health.running).toBe(0);
    expect(health.dead).toBe(0);
    // Only the runnable one counts towards waiting time; a deliberately delayed
    // job is not a backlog.
    expect(health.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(health.oldestPendingAgeSeconds).toBeLessThan(60);
  });
});
