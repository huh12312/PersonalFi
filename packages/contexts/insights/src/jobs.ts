// SPDX-License-Identifier: MIT
/**
 * The three jobs, and the nightly schedule that starts them.
 *
 * `insights.run` runs **one** built-in advisor. `insights.run_local` runs
 * **one** `local_model` advisor (WP 5.1). `insights.run_all` enqueues one run
 * per scheduled advisor, each in its own lane, and returns.
 *
 * ## Two lanes, because a model call takes minutes
 *
 * `insights.run` has concurrency 1. A three-minute model call in it would
 * queue every built-in behind it — the nightly pass, and every event-triggered
 * rule, waiting on a narration. So a `local_model` advisor runs only as
 * `insights.run_local`, also concurrency 1, which is one slot of the runner's
 * global four (`@core/platform`'s `createJobRunner`): at most one model call
 * at a time, and the built-in lane unaffected by it. `service.ts`'s
 * `runAdvisor` refuses to execute a `local_model` advisor outside that lane;
 * an `insights.run` job that is handed one (the event consumer enqueues
 * `insights.run` for whatever a trigger names) re-queues it in its lane and
 * runs nothing. The API never executes one inline: `requestAdvisorRuns`
 * queues it and answers `queued`.
 *
 * `insights.run_local` is **declared** here and not included in
 * `insightsJobs()`: registering it is the composition root's act (W-A wiring,
 * with `assertPoolCoversLeases` re-checked for the new kind), and the exact
 * lines are in docs/evidence/phase-5/wp5.1-run-control.md.
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
import { dependenciesForHolder } from './holder.ts';
import { systemClock, type Clock } from '@core/kernel';
import {
  defineJob,
  enqueueJob,
  upsertSchedule,
  type JobContext,
  type JobHandlerRegistration,
} from '@core/platform';
import type { AdvisorKind } from './contract/scopes.ts';
import { platformOf, type InsightsContext, type InsightsDatabase } from './db.ts';
import type { AdvisorRegistry } from './registry.ts';
import {
  laneOf,
  runAdvisor,
  type InsightsDependencies,
  type RunAdvisorInput,
  type RunAdvisorResult,
} from './service.ts';
import { findAdvisor, pruneRunPayloads } from './store.ts';

export const RUN_JOB_KIND = 'insights.run';
export const RUN_ALL_JOB_KIND = 'insights.run_all';
/** The local-model lane (WP 5.1). Concurrency 1; declared here, registered by the composition root. */
export const RUN_LOCAL_JOB_KIND = 'insights.run_local';

/** The job kind that may execute an advisor of this kind. */
export function jobKindFor(kind: AdvisorKind): typeof RUN_JOB_KIND | typeof RUN_LOCAL_JOB_KIND {
  return laneOf(kind) === 'builtin' ? RUN_JOB_KIND : RUN_LOCAL_JOB_KIND;
}

/** 04:15 local. After the nightly sync, before anyone is awake. */
export const DEFAULT_ADVISOR_CRON = '15 4 * * *';
export const SCHEDULE_NAME = 'insights.nightly';

export interface RunJobPayload {
  readonly advisorId: string;
  readonly trigger: 'schedule' | 'event' | 'manual' | 'backfill';
  readonly triggerEventType?: string | null;
  /**
   * WP 9.5 (C5-2, G5-15): for a narrator run, the built-in insights to
   * narrate — the Brief enqueues one job per item it chose, each carrying that
   * item's id. Absent ⇒ the feed's first finding (`advisors/local/findings.ts`).
   */
  readonly narrateInsightIds?: readonly string[];
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
      // WP 10.6: the holder's own narrator decides which lane local.narrator is in.
      const registered = (
        await dependenciesForHolder(input.dependencies, context.userId)
      ).registry.get(payload.advisorId);
      if (registered !== undefined && laneOf(registered.manifest.kind) !== 'builtin') {
        // Not this lane's to run. Re-queue it where it belongs and return: the
        // built-in lane never waits on a model call.
        const queued = await enqueueJob(platformOf(input.database), {
          kind: RUN_LOCAL_JOB_KIND,
          userId: context.userId,
          payload,
          dedupeKey: `${RUN_LOCAL_JOB_KIND}:${payload.advisorId}`,
          correlationId: context.correlationId,
        });
        context.logger.info(
          {
            job: RUN_JOB_KIND,
            advisorId: payload.advisorId,
            rerouted: RUN_LOCAL_JOB_KIND,
            jobId: queued.id,
          },
          'advisor belongs to the local-model lane; re-queued there',
        );
        return;
      }
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
 * `insights.run_local` — one `local_model` advisor, one run, in its own lane.
 *
 * `concurrency: 1`: one model call at a time on this host, and one slot of the
 * runner's four, so the built-in lane always has the other three. Before each
 * run it deletes retained payloads past their 30-day bound — the retention is
 * enforced by the lane that creates it, not by a schedule somebody has to
 * remember to register.
 *
 * A `builtin` advisor handed to this lane is refused by `runAdvisor`
 * (`LaneViolation`), which fails the job: that is a wiring bug and should be
 * loud.
 */
export function createRunLocalJob(input: JobDependencies): JobHandlerRegistration {
  return defineJob<RunJobPayload>(
    RUN_LOCAL_JOB_KIND,
    async (payload: RunJobPayload, context: JobContext) => {
      const clock = input.clock ?? systemClock;
      const pruned = await pruneRunPayloads(input.database, context.userId, clock.now());
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
          lane: 'local',
          ...(Array.isArray(payload.narrateInsightIds)
            ? {
                narrateInsightIds: payload.narrateInsightIds.filter(
                  (id): id is string => typeof id === 'string',
                ),
              }
            : {}),
        },
      );

      context.logger.info(
        {
          job: RUN_LOCAL_JOB_KIND,
          advisorId: result.advisorId,
          runId: result.runId,
          status: result.status,
          refusal: result.refusal,
          cancelReason: result.cancelReason,
          proposed: result.proposed,
          accepted: result.accepted,
          rejected: result.rejected,
          quarantined: result.quarantined,
          prunedPayloads: pruned,
        },
        'local-model advisor run finished',
      );

      // WP 9.5 (Phase 5 gate C5-2, G5-7): **no job-level retry in this lane.**
      // A failed local-model run — a `model_timeout`, an unreachable model, a
      // reply the validator refused at steps 1–3 — has already written its
      // `advisor_runs` row and advanced the breaker (`failRun`), which is the
      // count that quarantines a failing model. Re-queueing it would spend
      // another full deadline of all four cores on the same prompt (observed:
      // a 180 s timeout retried, then a third trip of the breaker) and, for a
      // refused reply, would be re-asking until the validator agrees. The job
      // completes; the run's own row says it failed. A refusal or a
      // cancellation is the ladder working, as before.
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
        // Each advisor in its own lane: a local model never joins the
        // built-in queue, even for one hop.
        const kind = jobKindFor(entry.manifest.kind);
        // The pool, not a transaction: a job handler is not given one, and the
        // fan-out is idempotent by dedupe key — a crash halfway re-enqueues the
        // same keys on retry and the queue returns the existing ids.
        await enqueueJob(platformOf(input.database), {
          kind,
          userId: context.userId,
          payload,
          dedupeKey: `${kind}:${entry.manifest.advisor_id}`,
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

/** A run the API queued in its lane rather than executing inline. */
export interface QueuedAdvisorRun {
  readonly advisorId: string;
  readonly status: 'queued';
  readonly jobKind: typeof RUN_LOCAL_JOB_KIND;
  readonly jobId: string;
}

export type RequestedAdvisorRun = RunAdvisorResult | QueuedAdvisorRun;

/**
 * The on-demand entry point — the API's "run advisors" button.
 *
 * Built-ins run inline, sequentially, as `runAdvisors` does. Every other kind
 * is **queued** in its lane and answered `queued`: a request handler never
 * waits on a model, and a model call never runs outside `insights.run_local`.
 * An id this process has no advisor for is queued in the local lane when its
 * `advisors` row says it is not a built-in (the worker, which registers the
 * local model, will run it) and is otherwise a wiring bug, as before.
 */
export async function requestAdvisorRuns(
  database: InsightsDatabase,
  context: InsightsContext,
  dependencies: InsightsDependencies,
  input: {
    readonly advisorIds: readonly string[];
    readonly trigger: RunAdvisorInput['trigger'];
  },
): Promise<readonly RequestedAdvisorRun[]> {
  const results: RequestedAdvisorRun[] = [];
  for (const advisorId of input.advisorIds) {
    const registered = dependencies.registry.get(advisorId);
    const kind =
      registered?.manifest.kind ?? (await findAdvisor(database, context.userId, advisorId))?.kind;
    if (kind !== undefined && laneOf(kind) !== 'builtin') {
      const payload: RunJobPayload = { advisorId, trigger: input.trigger };
      const queued = await enqueueJob(platformOf(database), {
        kind: RUN_LOCAL_JOB_KIND,
        userId: context.userId,
        payload,
        dedupeKey: `${RUN_LOCAL_JOB_KIND}:${advisorId}`,
        correlationId: context.correlationId,
      });
      results.push({ advisorId, status: 'queued', jobKind: RUN_LOCAL_JOB_KIND, jobId: queued.id });
      continue;
    }
    results.push(
      await runAdvisor(database, context, dependencies, { advisorId, trigger: input.trigger }),
    );
  }
  return results;
}

/**
 * `insights.run` and `insights.run_all`, for the composition root's
 * `appModules` entry. `insights.run_local` is deliberately not here — see this
 * file's header: the composition root adds `createRunLocalJob` itself.
 */
export function insightsJobs(input: JobDependencies): readonly JobHandlerRegistration[] {
  return [
    createRunJob(input),
    createRunAllJob({ database: input.database, registry: input.dependencies.registry }),
  ];
}
