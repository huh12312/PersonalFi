// SPDX-License-Identifier: MIT
/**
 * The 04:00 job and the schedule that fires it.
 *
 * Shaped exactly like `@ctx/categorization`'s `schedule.ts` and
 * `@ctx/connections`' `jobHandler()`, because `apps/api/src/modules.ts` — the
 * composition root's module registry, the orchestrator's file and not this work
 * package's — expects that shape from `ModuleRegistration.jobs` and
 * `.schedules`. The registration lines are written out in
 * `docs/evidence/phase-3/wp3.8-net-worth.md` §8.
 *
 * ## 04:00 local, and why that number
 *
 * The nightly sync runs at 03:15 (`@ctx/connections`) and the price refresh at
 * 03:45 (`integrations.price_refresh`, wp3.w-wiring.md §2). 04:00 is after both,
 * so the day the snapshotter seals is a day whose balances and prices have
 * already landed. It is also comfortably past 08 §3.5's 02:00 seal boundary, so
 * every day that closed overnight is sealable by the time this runs — the job
 * never has to leave one open for another twenty-four hours because it fired
 * ninety seconds early.
 *
 * ## The name
 *
 * `planning.net_worth_snapshot`, matching `SCHEDULE_NAME_PATTERN`
 * (`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`) and `schedules.name`'s identical CHECK in
 * 0003_platform.sql. The Phase 2 cold boot found a context registering
 * `notifications.deliver:<uuid>`: every unit test passed because the fake
 * scheduler never applied the constraint, and the real worker crash-looped from
 * its first start. `upsertSchedule` calls `assertScheduleName` for us, and
 * `test/schedule-name.test.ts` asserts the constant against the pattern read out
 * of the platform rather than against a copy of it.
 */
import { systemClock, type Clock } from '@core/kernel';
import { defineJob, upsertSchedule, type JobHandlerRegistration } from '@core/platform';
import { isProjectionInputRefused } from './engine/boundary.ts';
import type { AssumptionsRegistry } from './assumptions.ts';
import type { MonteCarloRunner, RevealedPorts, SnapshotPorts } from './ports.ts';
import {
  computeProjection,
  createProjectionInputsReader,
  prepareBaselineRefresh,
  storeProjection,
  type ProjectionServiceDependencies,
  type RefreshOutcome,
} from './projection-service.ts';
import { isProjectionRefused } from './projection-store.ts';
import { runSnapshot, type SnapshotContext } from './snapshot.ts';
import { platformOf, type PlanningDatabase, type PlanningExecutor } from './store.ts';

export const SNAPSHOT_JOB_KIND = 'planning.net_worth_snapshot';
export const SNAPSHOT_SCHEDULE_NAME = 'planning.net_worth_snapshot';
/** 04:00 local — after the 03:15 sync and the 03:45 price refresh. */
export const SNAPSHOT_CRON = '0 4 * * *';

export interface SnapshotJobDependencies {
  readonly database: PlanningDatabase;
  /**
   * Built per run rather than closed over once, so the readers see the job's own
   * transaction. The composition root supplies the adapters
   * (`apps/api/src/domain.ts`); this context never learns what is behind them.
   *
   * **Takes the job's `userId`** (WP 4.6; wp3.w-wiring.md §10 item 7). Two of
   * the four ports — `PriceReader.price` and `FxReader.rate` — take no user id
   * per call, so the holder has to be bound when the ports are built; until
   * this signature carried it, the composition root bound *one* holder for the
   * process and `planningModule` refused, by name, a job for anyone else. A
   * second Planning job (`planning.projection_refresh`) inheriting that binding
   * would have been a multi-user bug D6 says must be additive, not structural.
   */
  readonly portsFor: (executor: PlanningExecutor, userId: string) => SnapshotPorts;
  readonly timeZone: string;
  readonly baseCurrency: string;
}

/**
 * One `runSnapshot` per fan-out job.
 *
 * Runs inside a transaction so the seals, the open day's row and
 * `planning.NetWorthSnapshotTaken` are one atomic fact: an event announcing a
 * snapshot whose row rolled back would tell a notification rule something that
 * is not true, which is the failure mode `appendEvent`-in-the-same-transaction
 * exists to prevent.
 *
 * Uses the runner's own `context.clock` — real wall clock in production,
 * injectable in a test — and never a clock closed over at registration time.
 * That matters more here than in most jobs: every seal decision in
 * `src/seal.ts` is a comparison against it.
 */
export function netWorthSnapshotJobHandler(
  dependencies: SnapshotJobDependencies,
): JobHandlerRegistration {
  return defineJob(
    SNAPSHOT_JOB_KIND,
    async (_payload, context) => {
      await dependencies.database.transaction(async (tx) => {
        const executor = tx as unknown as PlanningExecutor;
        const snapshotContext: SnapshotContext = {
          userId: context.userId,
          clock: context.clock,
          timeZone: dependencies.timeZone,
          baseCurrency: dependencies.baseCurrency,
          correlationId: context.correlationId,
        };
        await runSnapshot(
          executor,
          dependencies.portsFor(executor, context.userId),
          snapshotContext,
        );
      });
    },
    // One snapshot in flight at a time. Two concurrent runs would both try to
    // seal the same day; the `sealed_at IS NULL` guard makes the loser's UPDATE
    // a typed refusal rather than a corruption, but a job that predictably
    // throws is not a design, it is a race with a safety net.
    { concurrency: 1 },
  );
}

/**
 * Declare the daily schedule.
 *
 * Called at boot by whichever module owns the work — `apps/api/src/modules.ts` —
 * and **not** called when `module.planning` is off, same as every other module's
 * schedule (docs/CONVENTIONS.md, "a disabled module registers no consumers and
 * no schedules").
 *
 * The timezone is the row's, and `cron-parser` resolves 04:00 against it, so the
 * job stays at 04:00 across a DST transition rather than drifting an hour twice
 * a year — which for a *daily* seal would mean two days a year sealed against
 * the wrong calendar date.
 */
export function registerNetWorthSnapshotSchedule(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    platformOf(executor),
    {
      userId: input.userId,
      name: SNAPSHOT_SCHEDULE_NAME,
      cron: input.cron ?? SNAPSHOT_CRON,
      timezone: input.timezone,
      jobKind: SNAPSHOT_JOB_KIND,
      jobPayload: {},
      enabled: true,
      // Ten minutes. Smaller than the retrain's half hour because this job has a
      // deadline the user can see — the chart should be right when they open the
      // app in the morning — and larger than zero for 08 §3.7's reason: one
      // install firing at exactly 04:00:00 looks like a cron job, and every
      // install doing it looks like a botnet to whatever they are all calling.
      jitterSeconds: 10 * 60,
    },
    clock,
  );
}

// ===========================================================================
// WP 4.6 — the 04:30 baseline projection refresh
// ===========================================================================
//
// ## 04:30 local, and why that number
//
// After `planning.net_worth_snapshot` at 04:00 and the 02:00 seal (08 §3.5),
// so the day the snapshotter just sealed is the day the baseline starts from.
// The projection reads its starting balances from the newest **sealed**
// `net_worth_daily` row, never the open day; firing before the snapshot would
// start from the day before yesterday for no reason.
//
// ## The name
//
// `planning.projection_refresh`, matching `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`
// — the Phase 2 worker crash-loop, again. `test/ports.test.ts` asserts it
// against the CHECK read out of 0003_platform.sql.
//
// ## Recomputes the baseline and nothing else
//
// A fork is recomputed when it is opened (the dispatch's rule): recomputing
// every what-if a holder ever saved, every night, is Monte Carlo work nobody
// looks at. An unchanged baseline over an unchanged day is a cache hit, which
// runs no engine and announces nothing.

export const PROJECTION_REFRESH_JOB_KIND = 'planning.projection_refresh';
export const PROJECTION_REFRESH_SCHEDULE_NAME = 'planning.projection_refresh';
/** 04:30 local — after the 04:00 snapshot and the 02:00 seal. */
export const PROJECTION_REFRESH_CRON = '30 4 * * *';

export interface ProjectionRefreshJobDependencies {
  readonly database: PlanningDatabase;
  /**
   * The revealed-behaviour ports for **this job's holder**, over the job's own
   * transaction — `planningRevealedPortsFor(executor, { userId, timeZone })` at
   * the composition root (WP 4.3's binding). Same signature as the snapshot's
   * `portsFor`, for the same reason.
   */
  readonly portsFor: (executor: PlanningExecutor, userId: string) => RevealedPorts;
  /** WP 4.5's worker host once bound; `null` runs the deterministic baseline and says so. */
  readonly monteCarlo: MonteCarloRunner | null;
  readonly timeZone: string;
  /** Monte Carlo path count for the nightly baseline. Default 10,000 (08 §7.2). */
  readonly paths?: number;
  /** Assumption versions this build resolves. Default: the checked-in file and its retained predecessors. */
  readonly registry?: () => AssumptionsRegistry;
  /** The deterministic engine. Injectable so a test can observe what is open while it runs. */
  readonly deterministic?: ProjectionServiceDependencies['deterministic'];
}

/**
 * One baseline refresh per fan-out job, in **three steps, and the engine in
 * none of them holding a transaction** (WP 5.5; wp4.6 §11 item 6):
 *
 *   1. **read** — one transaction: the baseline, the holder's resolved
 *      assumptions, the sealed day, the revealed behaviour, the life events,
 *      the cache lookup (`prepareBaselineRefresh`). A cache hit or a stale
 *      answer ends the job here.
 *   2. **compute** — no transaction, no connection: `computeProjection` takes
 *      no executor. A 10,000-path Monte Carlo is ~1 s; held inside a
 *      transaction it pins a pooled connection for that second, and Phase 5
 *      adds a weekly job that runs the engine per Brief item — a second
 *      transaction held across compute is how Phase 3's pool-vs-lease deadlock
 *      comes back.
 *   3. **write** — one transaction: the run, its bands and
 *      `planning.ProjectionCompleted` land together or not at all
 *      (`storeProjection`). A concurrent identical run between 1 and 3 wins the
 *      cache key and is served; nothing is announced twice.
 *
 * A **domain** refusal — no sealed day yet, no spending to plan against, the
 * holder's overrides against a retired assumptions version — is logged and the
 * job completes. Retrying it five times with backoff would change nothing and
 * dead-letter a job that did exactly what it should: decline to invent a
 * number. Anything else propagates and retries.
 */
export function projectionRefreshJobHandler(
  dependencies: ProjectionRefreshJobDependencies,
): JobHandlerRegistration {
  return defineJob(
    PROJECTION_REFRESH_JOB_KIND,
    async (_payload, context) => {
      const service = (executor: PlanningExecutor): ProjectionServiceDependencies => ({
        inputs: createProjectionInputsReader(
          executor,
          dependencies.portsFor(executor, context.userId),
        ),
        monteCarlo: dependencies.monteCarlo,
        clock: context.clock,
        timeZone: dependencies.timeZone,
        ...(dependencies.registry === undefined ? {} : { registry: dependencies.registry() }),
        ...(dependencies.deterministic === undefined
          ? {}
          : { deterministic: dependencies.deterministic }),
      });
      const request = {
        userId: context.userId,
        correlationId: context.correlationId,
        ...(dependencies.paths === undefined ? {} : { paths: dependencies.paths }),
      };
      try {
        // 1. read
        const prepared = await dependencies.database.transaction((tx) => {
          const executor = tx as unknown as PlanningExecutor;
          return prepareBaselineRefresh(executor, service(executor), request);
        });
        let outcome: RefreshOutcome;
        if (prepared.status !== 'ready') {
          outcome = prepared;
        } else {
          // 2. compute — outside any transaction
          const computed = await computeProjection(
            {
              monteCarlo: dependencies.monteCarlo,
              clock: context.clock,
              ...(dependencies.deterministic === undefined
                ? {}
                : { deterministic: dependencies.deterministic }),
            },
            prepared,
          );
          // 3. write
          outcome = await dependencies.database.transaction((tx) =>
            storeProjection(
              tx as unknown as PlanningExecutor,
              { clock: context.clock },
              prepared,
              computed,
            ),
          );
        }
        context.logger.info(
          {
            job: PROJECTION_REFRESH_JOB_KIND,
            status: outcome.status,
            ...('run' in outcome && outcome.run !== null
              ? { runId: outcome.run.id, method: outcome.run.method }
              : {}),
            ...(outcome.status === 'stale' ? { staleness: outcome.staleness } : {}),
          },
          outcome.status === 'stale'
            ? 'baseline not recomputed: its assumptions version no longer resolves'
            : `baseline projection ${outcome.status}`,
        );
      } catch (error) {
        const refused =
          (isProjectionRefused(error) && error.family === 'domain') ||
          isProjectionInputRefused(error);
        if (!refused) throw error;
        context.logger.warn(
          { job: PROJECTION_REFRESH_JOB_KIND, code: (error as { code: string }).code },
          `baseline projection refused: ${(error as Error).message}`,
        );
      }
    },
    // One refresh in flight: a Monte Carlo run is the most expensive thing this
    // process does, and two for one holder would race for one cache key.
    { concurrency: 1 },
  );
}

/** Declare the 04:30 schedule. Not called when `module.planning` is off. */
export function registerProjectionRefreshSchedule(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly timezone: string; readonly cron?: string },
  clock: Clock = systemClock,
): Promise<string> {
  return upsertSchedule(
    platformOf(executor),
    {
      userId: input.userId,
      name: PROJECTION_REFRESH_SCHEDULE_NAME,
      cron: input.cron ?? PROJECTION_REFRESH_CRON,
      timezone: input.timezone,
      jobKind: PROJECTION_REFRESH_JOB_KIND,
      jobPayload: {},
      enabled: true,
      // Ten minutes, 08 §3.7's reason: every install firing at 04:30:00 sharp is
      // a thundering herd for nobody's benefit. Up to 04:40 still lands well
      // before the morning the fan chart is opened.
      jitterSeconds: 10 * 60,
    },
    clock,
  );
}
