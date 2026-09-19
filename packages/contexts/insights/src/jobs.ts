// SPDX-License-Identifier: MIT
/**
 * The two jobs, and the nightly schedule that starts them.
 *
 * `insights.run` runs **one** advisor. `insights.run_all` enqueues one
 * `insights.run` per scheduled advisor and returns.
 *
 * That split is the same one `@ctx/connections` makes between `sync.connection`
 * and `sync.all`, and for the same reason: a schedule row per advisor means the
 * scheduler table grows with the catalogue and a newly registered advisor does
 * not run until something remembers to add a row. One schedule, one fan-out job,
 * and the catalogue is read at fan-out time.
 *
 * It also bounds the blast radius. An advisor that hangs until its deadline
 * consumes one job slot; the other nineteen runs are separate rows with their
 * own retries, their own `job_runs` history, and their own backoff. A single
 * job that looped over the catalogue would let one bad advisor delay every
 * other one by five minutes and would retry the whole catalogue when it failed.
 *
 * ## The schedule fires in the user's zone
 *
 * 08 §3.7, and the same figure `@ctx/connections` uses: a nightly job at 03:15
 * **local**, never the container's `TZ`. The default cron below is 04:15 rather
 * than 03:15 so the advisors run *after* the nightly sync has landed and the
 * budget actuals consumer has caught up — advice computed from a snapshot taken
 * before the night's transactions arrived is advice about yesterday.
 *
 * ## Retries are the queue's, not ours
 *
 * A failed run already wrote its `advisor_runs` row, advanced the failure
 * streak and possibly tripped the breaker before the exception reached here
 * (`service.ts`'s `failRun`). Rethrowing is what makes the *job* fail so the
 * queue retries it with backoff; the `advisor_runs` history then shows one row
 * per attempt, which is the honest record — "it failed four times tonight" and
 * "it failed once" are different facts and the breaker counts them differently.
 */
import { systemClock, type Clock } from '@core/kernel';
import {
  defineJob,
  enqueueJob,
  upsertSchedule,
  type JobContext,
  type JobHandlerRegistration,
} from '@core/platform';
import { platformOf, type InsightsDatabase } from './db.ts';
import type { AdvisorRegistry } from './registry.ts';
import { runAdvisor, type InsightsDependencies } from './service.ts';

export const RUN_JOB_KIND = 'insights.run';
export const RUN_ALL_JOB_KIND = 'insights.run_all';

/** 04:15 local. After the nightly sync, before anyone is awake. */
export const DEFAULT_ADVISOR_CRON = '15 4 * * *';
export const SCHEDULE_NAME = 'insights.nightly';

export interface RunJobPayload {
  readonly advisorId: string;
  readonly trigger: 'schedule' | 'event' | 'manual' | 'backfill';
  readonly triggerEventType?: string | null;
}

export interface JobDependencies {
  readonly database: InsightsDatabase;
  readonly dependencies: InsightsDependencies;
  readonly clock?: Clock;
}

/**
 * `insights.run` — one advisor, one run.
 *
 * `concurrency: 1`. Two runs of the same advisor for the same user would both
 * assemble the snapshot, both upsert, and produce an `advisor_runs` pair
 * indistinguishable from a retry. The queue's `dedupeKey` already stops the
 * common case; this stops the case where a schedule-triggered run and an
 * event-triggered one arrive with different dedupe keys.
 */
export function createRunJob(input: JobDependencies): JobHandlerRegistration {
  return defineJob<RunJobPayload>(
    RUN_JOB_KIND,
    async (payload: RunJobPayload, context: JobContext) => {
      const clock = input.clock ?? systemClock;
      const result = await runAdvisor(
        input.database,
        {
          userId: context.userId,
          clock,
          correlationId: context.correlationId,
          causationId: null,
        },
        input.dependencies,
        {
          advisorId: payload.advisorId,
          trigger: payload.trigger,
          triggerEventType: payload.triggerEventType ?? null,
        },
      );

      context.logger.info(
        {
          job: RUN_JOB_KIND,
          advisorId: result.advisorId,
          runId: result.runId,
          status: result.status,
          refusal: result.refusal,
          proposed: result.proposed,
          accepted: result.accepted,
          rejected: result.rejected,
          suppressed: result.suppressed,
          inserted: result.inserted,
          quarantined: result.quarantined,
        },
        'advisor run finished',
      );

      // A failed run has already recorded itself; rethrowing is what makes the
      // *job* fail so the queue retries with backoff. A refused run is not a
      // failure — the kill switch working is the system behaving.
      if (result.status === 'failed') {
        throw new Error(`advisor ${result.advisorId} run failed`);
      }
    },
    { concurrency: 1 },
  );
}

/**
 * `insights.run_all` — the fan-out.
 *
 * Reads the registry, not the database: the catalogue is what this process can
 * actually invoke, and an `advisors` row for something no longer registered
 * would enqueue a job whose handler throws. The kill switches are still checked
 * per run, so a disabled or quarantined advisor gets an `advisor_runs` row
 * saying so rather than being silently skipped here — "advisors are off" must
 * be observable, and an absence of rows is also what a broken scheduler looks
 * like.
 */
export function createRunAllJob(input: {
  readonly database: InsightsDatabase;
  readonly registry: AdvisorRegistry;
}): JobHandlerRegistration {
  return defineJob(
    RUN_ALL_JOB_KIND,
    async (_payload: unknown, context: JobContext) => {
      const scheduled = input.registry.scheduled();
      for (const entry of scheduled) {
        const payload: RunJobPayload = {
          advisorId: entry.manifest.advisor_id,
          trigger: 'schedule',
        };
        // The pool, not a transaction: a job handler is not given one, and the
        // fan-out is idempotent by dedupe key — a crash halfway re-enqueues the
        // same keys on retry and the queue returns the existing ids.
        await enqueueJob(platformOf(input.database), {
          kind: RUN_JOB_KIND,
          userId: context.userId,
          payload,
          dedupeKey: `${RUN_JOB_KIND}:${entry.manifest.advisor_id}`,
          correlationId: context.correlationId,
        });
      }
      context.logger.info(
        { job: RUN_ALL_JOB_KIND, advisors: scheduled.length },
        'queued the nightly advisor fan-out',
      );
    },
    { concurrency: 1 },
  );
}

/**
 * Declare the nightly schedule. Called at boot, and only when
 * `module.insights` is on — a disabled module registers no schedules (08 §6.9).
 */
export async function registerNightlySchedule(
  database: InsightsDatabase,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    platformOf(database),
    {
      userId: input.userId,
      name: SCHEDULE_NAME,
      cron: input.cron ?? DEFAULT_ADVISOR_CRON,
      timezone: input.timezone,
      jobKind: RUN_ALL_JOB_KIND,
      enabled: true,
      // A few minutes of jitter so a fleet of installs does not all wake at
      // 04:15:00. Harmless here (one user) and free to have right.
      jitterSeconds: 180,
    },
    clock,
  );
}

/** Both handlers, for the composition root's `appModules` entry. */
export function insightsJobs(input: JobDependencies): readonly JobHandlerRegistration[] {
  return [
    createRunJob(input),
    createRunAllJob({ database: input.database, registry: input.dependencies.registry }),
  ];
}
