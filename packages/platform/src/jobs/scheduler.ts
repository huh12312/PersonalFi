// SPDX-License-Identifier: MIT
import { newId, systemClock, type Clock } from '@core/kernel';
import { CronExpressionParser } from 'cron-parser';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { PlatformError, describeError } from '../errors.ts';
import {
  silentLogger,
  type Executor,
  type PlatformLogger,
  type TransactionalExecutor,
} from '../executor.ts';
import { toInstantOrNull, type TimestampValue } from '../instants.ts';
import {
  SCHEDULER_ADVISORY_LOCK_KEY,
  tryAcquireAdvisoryLease,
  type AdvisoryLease,
} from '../locks.ts';
import { METRIC, type Metrics } from '../metrics.ts';
import { createSleeper } from '../sleep.ts';
import { enqueueJob } from './queue.ts';

/**
 * The cron scheduler.
 *
 * Three properties, each of which is a bug this design avoids.
 *
 * **It fires once, not once per worker.** Whichever process takes the scheduler
 * advisory lock is the scheduler; the others tick, fail to take it, and wait. The
 * lock is session-scoped, so a worker that dies releases it and another takes
 * over within a tick. As a second line of defence the enqueued job carries a
 * dedupe key of `schedule:<name>:<fire time>`, so even a split-brain cannot
 * produce two runs of the same occurrence.
 *
 * **It fires once after downtime, not forty times.** `next_run_at` is state. When
 * the box comes back after two days, the row is overdue; the scheduler enqueues
 * one job and computes the next occurrence from *now*, not by stepping the cron
 * forward through every window it slept through.
 *
 * **It fires in the user's timezone.** `cron-parser` (MIT) resolves the
 * expression against the row's IANA zone, so 03:15 stays 03:15 across DST rather
 * than drifting an hour twice a year — which for the daily net-worth seal means
 * two days a year sealed against the wrong calendar date.
 */

export interface SchedulerOptions {
  readonly pool: pg.Pool;
  readonly db: TransactionalExecutor;
  readonly clock?: Clock;
  readonly logger?: PlatformLogger;
  readonly metrics?: Metrics;
  /** How often to look for due schedules. Default 30s (08 §6.2). */
  readonly tickIntervalMs?: number;
  readonly random?: () => number;
}

export interface Scheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Evaluate every due schedule once. Returns how many jobs were enqueued. */
  tick(): Promise<number>;
  isLeader(): boolean;
}

interface DueScheduleRow extends Record<string, unknown> {
  id: string;
  user_id: string;
  name: string;
  cron: string;
  timezone: string;
  job_kind: string;
  job_payload: unknown;
  jitter_seconds: number;
  next_run_at: TimestampValue | null;
}

/**
 * The next time a cron expression fires at or after `after`, in `timezone`.
 *
 * Separated out and exported because it is the part worth unit-testing: DST
 * transitions, month ends, and "every 15 minutes" all live here, and none of them
 * needs a database.
 */
export function nextCronOccurrence(cron: string, timezone: string, after: Date): Date {
  try {
    const interval = CronExpressionParser.parse(cron, { currentDate: after, tz: timezone });
    return interval.next().toDate();
  } catch (cause) {
    throw new PlatformError(
      'platform.cron_invalid',
      `cannot parse cron ${JSON.stringify(cron)} in zone ${JSON.stringify(timezone)}: ${describeError(cause)}`,
      { cause },
    );
  }
}

export interface UpsertScheduleInput {
  readonly userId: string;
  readonly name: string;
  readonly cron: string;
  readonly timezone: string;
  readonly jobKind: string;
  readonly jobPayload?: unknown;
  readonly enabled?: boolean;
  readonly jitterSeconds?: number;
}

/**
 * Declare a schedule, or update one that already exists.
 *
 * Called at boot by whichever module owns the work — and *not* called when that
 * module's feature flag is off, which is what "a disabled module registers no
 * consumers and no schedules" means in practice (08 §6.9).
 */
export async function upsertSchedule(
  executor: Executor,
  input: UpsertScheduleInput,
  clock: Clock = systemClock,
): Promise<string> {
  const id = newId();
  const nextRunAt = nextCronOccurrence(input.cron, input.timezone, clock.now());
  const result = await executor.execute<{ id: string }>(sql`
    INSERT INTO schedules (
      id, user_id, name, cron, timezone, job_kind, job_payload, enabled, jitter_seconds, next_run_at
    ) VALUES (
      ${id}::uuid, ${input.userId}::uuid, ${input.name}, ${input.cron}, ${input.timezone},
      ${input.jobKind}, ${JSON.stringify(input.jobPayload ?? {})}::jsonb,
      ${input.enabled ?? true}, ${input.jitterSeconds ?? 0},
      ${nextRunAt.toISOString()}::timestamptz
    )
    ON CONFLICT (name) DO UPDATE SET
      cron = EXCLUDED.cron,
      timezone = EXCLUDED.timezone,
      job_kind = EXCLUDED.job_kind,
      job_payload = EXCLUDED.job_payload,
      jitter_seconds = EXCLUDED.jitter_seconds,
      -- enabled and next_run_at are deliberately NOT overwritten: the user may
      -- have turned this schedule off in Settings, and a redeploy must not turn
      -- it back on or reset a pending occurrence.
      updated_at = now()
    RETURNING id
  `);
  return result.rows[0]?.id ?? id;
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const {
    pool,
    db,
    clock = systemClock,
    logger = silentLogger,
    metrics,
    tickIntervalMs = 30_000,
    random = Math.random,
  } = options;

  let running = false;
  let lease: AdvisoryLease | null = null;
  let loopPromise: Promise<void> | null = null;
  const sleeper = createSleeper();

  async function tick(): Promise<number> {
    const now = clock.now();
    const due = await db.execute<DueScheduleRow>(sql`
      SELECT id, user_id, name, cron, timezone, job_kind, job_payload, jitter_seconds, next_run_at
      FROM schedules
      WHERE enabled AND (next_run_at IS NULL OR next_run_at <= ${now.toISOString()}::timestamptz)
      ORDER BY next_run_at NULLS FIRST
    `);

    let fired = 0;
    for (const row of due.rows) {
      try {
        // The occurrence identity is the time it was *due*, not the time we got
        // round to it. Two workers a second apart therefore compute the same
        // dedupe key and the second one enqueues nothing.
        const firedFor = toInstantOrNull(row.next_run_at) ?? now;
        const jitterMs =
          row.jitter_seconds > 0 ? Math.floor(random() * row.jitter_seconds * 1_000) : 0;

        await db.transaction(async (tx) => {
          const result = await enqueueJob(
            tx,
            {
              userId: row.user_id,
              kind: row.job_kind,
              payload: row.job_payload,
              dedupeKey: `schedule:${row.name}:${firedFor.toISOString()}`,
              runAfter: new Date(clock.nowMs() + jitterMs),
              correlationId: newId(),
            },
            { clock, ...(metrics === undefined ? {} : { metrics }) },
          );

          // Computed from `now`, never by stepping the cron forward from
          // `next_run_at`: a box that was off for two days must produce one run,
          // not one per missed window.
          const nextRunAt = nextCronOccurrence(row.cron, row.timezone, now);
          await tx.execute(sql`
            UPDATE schedules
            SET last_run_at = ${now.toISOString()}::timestamptz,
                next_run_at = ${nextRunAt.toISOString()}::timestamptz,
                updated_at = now()
            WHERE id = ${row.id}::uuid
          `);

          if (!result.deduped) fired += 1;
        });

        metrics?.increment(METRIC.schedulerFired, { schedule: row.name });
      } catch (cause) {
        // One bad cron expression must not stop the other schedules.
        logger.error(
          { schedule: row.name, err: describeError(cause) },
          'schedule failed to fire; the others are unaffected',
        );
      }
    }

    metrics?.increment(METRIC.schedulerTicks);
    return fired;
  }

  async function loop(): Promise<void> {
    while (running) {
      if (lease === null) {
        lease = await tryAcquireAdvisoryLease(pool, SCHEDULER_ADVISORY_LOCK_KEY);
        metrics?.gauge(METRIC.schedulerIsLeader, lease === null ? 0 : 1);
        if (lease !== null) logger.info({}, 'scheduler leadership acquired');
      }
      if (lease !== null) {
        try {
          await tick();
        } catch (cause) {
          logger.error({ err: describeError(cause) }, 'scheduler tick failed');
        }
      }
      await sleeper.sleep(tickIntervalMs);
    }
  }

  return {
    async start() {
      if (running) return;
      running = true;
      loopPromise = loop();
      logger.info({ tickIntervalMs }, 'scheduler started');
    },

    async stop() {
      running = false;
      sleeper.wake();
      await Promise.allSettled([loopPromise]);
      loopPromise = null;
      await lease?.release();
      lease = null;
      metrics?.gauge(METRIC.schedulerIsLeader, 0);
      logger.info({}, 'scheduler stopped');
    },

    /**
     * A single evaluation, taking leadership first.
     *
     * Tests use this to prove that two schedulers pointed at one database produce
     * one job, which is the property that matters when the answer to "is the
     * worker healthy?" is "start a second one".
     */
    async tick() {
      if (lease === null) {
        lease = await tryAcquireAdvisoryLease(pool, SCHEDULER_ADVISORY_LOCK_KEY);
      }
      if (lease === null) return 0;
      return await tick();
    },

    isLeader: () => lease !== null,
  };
}
