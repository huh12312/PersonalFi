// SPDX-License-Identifier: MIT
import { newId, systemClock, type Clock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { DEFAULT_JOB_BACKOFF, backoffDelayMs, type BackoffOptions } from '../backoff.ts';
import { PlatformError, describeError, serializeError } from '../errors.ts';
import { silentLogger, type PlatformLogger, type TransactionalExecutor } from '../executor.ts';
import {
  JOB_REAPER_ADVISORY_LOCK_KEY,
  tryAcquireAdvisoryLease,
  type AdvisoryLease,
} from '../locks.ts';
import { METRIC, type Metrics } from '../metrics.ts';
import { CHANNEL, createNotifyListener, type NotifyListener } from '../notify.ts';
import { createSleeper } from '../sleep.ts';

/**
 * The execute side of the job queue.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED` against `jobs`: two workers never see the
 * same row, no lock is held across the work itself, and there is no broker to
 * lose. What makes it survive a `docker kill` rather than merely a clean restart
 * is the heartbeat — a claimed job records a pulse every few seconds, and a
 * reaper returns anything whose pulse has stopped to `pending`. Without that, one
 * killed worker leaves a job `running` forever and the nightly sync silently
 * never happens again.
 */

export interface JobContext {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly attempt: number;
  readonly correlationId: string;
  readonly logger: PlatformLogger;
  readonly clock: Clock;
  /**
   * Aborts when the process is shutting down *and* the grace period has expired.
   * A long handler should poll this and checkpoint; a short one may ignore it.
   */
  readonly signal: AbortSignal;
}

export type JobHandler<TPayload = unknown> = (
  payload: TPayload,
  context: JobContext,
) => Promise<void> | void;

export interface JobHandlerRegistration {
  readonly kind: string;
  readonly handler: JobHandler;
  /** In-process cap for this kind. `projection` is 1; `notification` is 4. */
  readonly concurrency?: number;
  readonly backoff?: BackoffOptions;
}

export function defineJob<TPayload = unknown>(
  kind: string,
  handler: JobHandler<TPayload>,
  options: Omit<JobHandlerRegistration, 'kind' | 'handler'> = {},
): JobHandlerRegistration {
  return { kind, handler: handler as JobHandler, ...options };
}

export interface JobRunnerOptions {
  readonly pool: pg.Pool;
  readonly db: TransactionalExecutor;
  readonly handlers: readonly JobHandlerRegistration[];
  /** Identifies this process in `jobs.locked_by`. Default: a fresh uuid. */
  readonly workerId?: string;
  readonly clock?: Clock;
  readonly logger?: PlatformLogger;
  readonly metrics?: Metrics;
  /** Jobs in flight in this process, across all kinds. Default 4. */
  readonly concurrency?: number;
  readonly pollIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  /**
   * A job whose heartbeat is this stale is reclaimed. Default 3x the heartbeat
   * interval, which tolerates one missed pulse and a slow query.
   */
  readonly reclaimAfterMs?: number;
  /** How long `stop()` waits for in-flight work before aborting it. Default 30s. */
  readonly shutdownGraceMs?: number;
  readonly random?: () => number;
}

export interface JobRunner {
  readonly workerId: string;
  start(): Promise<void>;
  /** Stop claiming, let in-flight work finish, then release everything. */
  stop(): Promise<void>;
  /** Claim and run at most `limit` jobs, then return. The test entry point. */
  runOnce(limit?: number): Promise<number>;
  /** Return abandoned jobs to the queue. Runs on a timer once started. */
  reclaimStalled(): Promise<number>;
  inFlight(): number;
}

interface ClaimedJobRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  max_attempts: number;
  correlation_id: string;
}

export function createJobRunner(options: JobRunnerOptions): JobRunner {
  const {
    pool,
    db,
    handlers,
    clock = systemClock,
    logger = silentLogger,
    metrics,
    concurrency = 4,
    pollIntervalMs = 5_000,
    heartbeatIntervalMs = 15_000,
    shutdownGraceMs = 30_000,
    random = Math.random,
  } = options;

  const workerId = options.workerId ?? newId();
  const reclaimAfterMs = options.reclaimAfterMs ?? heartbeatIntervalMs * 3;
  const byKind = new Map(handlers.map((registration) => [registration.kind, registration]));
  const kinds = [...byKind.keys()];
  const perKindInFlight = new Map<string, number>();

  let running = false;
  let listener: NotifyListener | null = null;
  let loopPromise: Promise<void> | null = null;
  let reaperPromise: Promise<void> | null = null;
  let reaperLease: AdvisoryLease | null = null;
  const inFlight = new Set<Promise<void>>();
  const shutdown = new AbortController();
  const sleeper = createSleeper();

  if (kinds.length === 0) {
    throw new PlatformError(
      'platform.job_runner_empty',
      'a job runner with no handlers would claim nothing and hide the misconfiguration',
    );
  }

  function kindsWithCapacity(): string[] {
    return kinds.filter((kind) => {
      const cap = byKind.get(kind)?.concurrency;
      if (cap === undefined) return true;
      return (perKindInFlight.get(kind) ?? 0) < cap;
    });
  }

  /**
   * Claim one job.
   *
   * `FOR UPDATE SKIP LOCKED` on the candidate select is what lets N workers share
   * one table without a coordinator. The `singleton_key` subquery is the part
   * worth reading twice: it excludes a candidate whose key is already running
   * *anywhere*, which is a cross-process guarantee that an in-process semaphore
   * cannot give.
   */
  async function claim(): Promise<ClaimedJobRow | null> {
    const eligible = kindsWithCapacity();
    if (eligible.length === 0) return null;

    const result = await db.execute<ClaimedJobRow>(sql`
      WITH candidate AS (
        SELECT j.id
        FROM jobs j
        WHERE j.status = 'pending'
          AND j.run_after <= now()
          AND j.kind = ANY(${sql.param(eligible)}::text[])
          AND (
            j.singleton_key IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM jobs running
              WHERE running.status = 'running'
                AND running.singleton_key = j.singleton_key
            )
          )
        ORDER BY j.priority, j.run_after, j.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE jobs
      SET status = 'running',
          attempts = jobs.attempts + 1,
          locked_by = ${workerId},
          locked_at = now(),
          heartbeat_at = now(),
          updated_at = now()
      FROM candidate
      WHERE jobs.id = candidate.id
      RETURNING jobs.id, jobs.user_id, jobs.kind, jobs.payload, jobs.attempts,
                jobs.max_attempts, jobs.correlation_id
    `);

    return result.rows[0] ?? null;
  }

  async function execute(job: ClaimedJobRow): Promise<void> {
    const registration = byKind.get(job.kind);
    const runId = newId();
    const startedAtMs = clock.nowMs();
    perKindInFlight.set(job.kind, (perKindInFlight.get(job.kind) ?? 0) + 1);
    metrics?.increment(METRIC.jobsStarted, { kind: job.kind });
    metrics?.gauge(METRIC.jobsInFlight, inFlight.size);

    await db.execute(sql`
      INSERT INTO job_runs (id, job_id, user_id, attempt, worker_id, correlation_id)
      VALUES (${runId}::uuid, ${job.id}::uuid, ${job.user_id}::uuid, ${job.attempts},
              ${workerId}, ${job.correlation_id}::uuid)
      ON CONFLICT (job_id, attempt) DO NOTHING
    `);

    const heartbeat = setInterval(() => {
      void db
        .execute(
          sql`
          UPDATE jobs SET heartbeat_at = now() WHERE id = ${job.id}::uuid AND locked_by = ${workerId}
        `,
        )
        .catch((cause: unknown) => {
          logger.warn({ jobId: job.id, err: describeError(cause) }, 'heartbeat failed');
        });
    }, heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      if (registration === undefined) {
        throw new PlatformError(
          'platform.job_kind_unhandled',
          `no handler registered for job kind ${job.kind}`,
        );
      }
      await registration.handler(job.payload, {
        id: job.id,
        userId: job.user_id,
        kind: job.kind,
        attempt: job.attempts,
        correlationId: job.correlation_id,
        logger,
        clock,
        signal: shutdown.signal,
      });
      await finish(job, runId, startedAtMs, 'succeeded', null);
    } catch (cause) {
      await finish(job, runId, startedAtMs, 'failed', cause, registration?.backoff);
    } finally {
      clearInterval(heartbeat);
      perKindInFlight.set(job.kind, Math.max(0, (perKindInFlight.get(job.kind) ?? 1) - 1));
    }
  }

  /**
   * Record the outcome of an attempt, and decide the job's fate.
   *
   * One transaction for the job row and its run row: "the job says succeeded but
   * there is no run" and "the run says failed but the job is pending" are both
   * states a maintenance page cannot explain, and both are avoidable for free.
   *
   * Exhausted retries mean `dead`, never a silent drop. A dead job is visible,
   * explains itself through `last_error`, and is retryable by hand.
   */
  async function finish(
    job: ClaimedJobRow,
    runId: string,
    startedAtMs: number,
    outcome: 'succeeded' | 'failed',
    cause: unknown,
    backoff: BackoffOptions = DEFAULT_JOB_BACKOFF,
  ): Promise<void> {
    const durationMs = Math.max(0, clock.nowMs() - startedAtMs);
    const exhausted = job.attempts >= job.max_attempts;
    const delayMs = outcome === 'failed' ? backoffDelayMs(job.attempts, backoff, random) : 0;

    await db.transaction(async (tx) => {
      await tx.execute(sql`
        UPDATE job_runs
        SET finished_at = now(),
            outcome = ${outcome},
            duration_ms = ${durationMs},
            error = ${cause === null ? null : JSON.stringify(serializeError(cause))}::jsonb
        WHERE id = ${runId}::uuid
      `);

      if (outcome === 'succeeded') {
        await tx.execute(sql`
          UPDATE jobs
          SET status = 'succeeded', completed_at = now(), locked_by = NULL,
              locked_at = NULL, heartbeat_at = NULL, last_error = NULL, updated_at = now()
          WHERE id = ${job.id}::uuid
        `);
        return;
      }

      if (exhausted) {
        await tx.execute(sql`
          UPDATE jobs
          SET status = 'dead', completed_at = now(), locked_by = NULL, locked_at = NULL,
              heartbeat_at = NULL, last_error = ${JSON.stringify(serializeError(cause))}::jsonb,
              updated_at = now()
          WHERE id = ${job.id}::uuid
        `);
        return;
      }

      await tx.execute(sql`
        UPDATE jobs
        SET status = 'pending',
            run_after = now() + make_interval(secs => ${delayMs / 1_000}),
            locked_by = NULL, locked_at = NULL, heartbeat_at = NULL,
            last_error = ${JSON.stringify(serializeError(cause))}::jsonb,
            updated_at = now()
        WHERE id = ${job.id}::uuid
      `);
    });

    if (outcome === 'succeeded') {
      metrics?.increment(METRIC.jobsSucceeded, { kind: job.kind });
      logger.debug({ jobId: job.id, kind: job.kind, durationMs }, 'job succeeded');
      return;
    }
    metrics?.increment(exhausted ? METRIC.jobsDead : METRIC.jobsFailed, { kind: job.kind });
    logger[exhausted ? 'error' : 'warn'](
      {
        jobId: job.id,
        kind: job.kind,
        attempt: job.attempts,
        maxAttempts: job.max_attempts,
        ...(exhausted ? {} : { retryInMs: delayMs }),
        err: describeError(cause),
      },
      exhausted ? 'job exhausted its retries and is dead' : 'job failed; retrying with backoff',
    );
  }

  /**
   * Return jobs whose worker died to the queue.
   *
   * Under an advisory lock so one worker reaps and the others do not fight over
   * the same rows. The abandoned attempt is recorded rather than erased, because
   * "this job has been killed by the OOM killer four nights running" is the
   * single most useful thing the job history can tell an operator.
   */
  async function reclaimStalled(): Promise<number> {
    const result = await db.transaction(async (tx) => {
      const stalled = await tx.execute<{ id: string; attempts: number }>(sql`
        UPDATE jobs
        SET status = 'pending',
            run_after = now(),
            locked_by = NULL,
            locked_at = NULL,
            heartbeat_at = NULL,
            updated_at = now()
        WHERE status = 'running'
          AND heartbeat_at < now() - make_interval(secs => ${reclaimAfterMs / 1_000})
        RETURNING id, attempts
      `);

      for (const row of stalled.rows) {
        await tx.execute(sql`
          UPDATE job_runs
          SET finished_at = now(), outcome = 'abandoned',
              error = ${JSON.stringify({ name: 'WorkerAbandoned', message: 'heartbeat stopped; the worker was killed or partitioned' })}::jsonb
          WHERE job_id = ${row.id}::uuid AND attempt = ${row.attempts} AND outcome IS NULL
        `);
      }
      return stalled.rows.length;
    });

    if (result > 0) {
      metrics?.increment(METRIC.jobsReclaimed, undefined, result);
      logger.warn({ count: result }, 'reclaimed jobs abandoned by a dead worker');
    }
    return result;
  }

  async function claimLoop(): Promise<void> {
    while (running) {
      let claimedAny = false;
      while (running && inFlight.size < concurrency) {
        const job = await claim();
        if (job === null) break;
        claimedAny = true;
        const promise = execute(job).finally(() => {
          inFlight.delete(promise);
          metrics?.gauge(METRIC.jobsInFlight, inFlight.size);
        });
        inFlight.add(promise);
      }
      if (!running) break;
      // A full sweep that claimed work probably has more waiting; go straight
      // round again rather than sleeping on a notification that already fired.
      if (claimedAny && inFlight.size < concurrency) continue;
      await (listener?.wait(pollIntervalMs) ?? sleeper.sleep(pollIntervalMs));
    }
  }

  /**
   * The reaper's own loop.
   *
   * Every step is inside the `try`, including taking the lease. Acquiring it
   * needs a connection, and the case that matters is the pool going away
   * underneath a loop that is still marked `running` — a `stop()` racing the
   * sleep, or a test harness calling `pool.end()`. Left uncaught that becomes an
   * unhandled rejection that kills the worker process during shutdown, which is
   * the one moment it must not die noisily. Dropping the lease and trying again
   * next pass is always safe: another worker reaping instead is the design.
   */
  async function reaperLoop(): Promise<void> {
    while (running) {
      try {
        reaperLease ??= await tryAcquireAdvisoryLease(pool, JOB_REAPER_ADVISORY_LOCK_KEY);
        if (reaperLease !== null) await reclaimStalled();
      } catch (cause) {
        reaperLease = null;
        logger.warn({ err: describeError(cause) }, 'reaper pass failed; retrying');
      }
      await sleeper.sleep(Math.max(1_000, reclaimAfterMs / 2));
    }
  }

  return {
    workerId,

    async start() {
      if (running) return;
      running = true;
      listener = await createNotifyListener(pool, CHANNEL.jobs, logger);
      loopPromise = claimLoop();
      reaperPromise = reaperLoop();
      logger.info({ workerId, kinds, concurrency }, 'job runner started');
    },

    /**
     * Graceful shutdown, in the only order that is safe: stop taking new work
     * *first*, then wait for what is already running.
     *
     * A worker that drops an in-flight sync on SIGTERM leaves a half-written
     * cursor and a job row that only the reaper will notice ninety seconds later.
     * Waiting costs a few seconds of deploy time and removes that entirely.
     */
    async stop() {
      if (!running) return;
      running = false;
      // Wake both loops out of their poll/reaper sleeps before waiting on them,
      // or `stop()` inherits the longest interval as its floor.
      sleeper.wake();
      await listener?.close();
      listener = null;

      const grace = new Promise<'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), shutdownGraceMs);
        timer.unref?.();
      });
      const drained = Promise.allSettled([...inFlight]).then(() => 'drained' as const);
      const outcome = await Promise.race([drained, grace]);

      if (outcome === 'timeout' && inFlight.size > 0) {
        // The grace period is over. Tell handlers that poll the signal to stop,
        // then leave the rest to the reaper: an abandoned job is recoverable, a
        // job we lied about having finished is not.
        logger.warn({ workerId, inFlight: inFlight.size }, 'shutdown grace expired; aborting');
        shutdown.abort();
        await Promise.allSettled([...inFlight]);
      }

      await Promise.allSettled([loopPromise, reaperPromise]);
      loopPromise = null;
      reaperPromise = null;
      await reaperLease?.release();
      reaperLease = null;
      logger.info({ workerId }, 'job runner stopped');
    },

    async runOnce(limit = 1) {
      let executed = 0;
      for (let index = 0; index < limit; index += 1) {
        const job = await claim();
        if (job === null) break;
        await execute(job);
        executed += 1;
      }
      return executed;
    },

    reclaimStalled,
    inFlight: () => inFlight.size,
  };
}
