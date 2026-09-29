// SPDX-License-Identifier: MIT
/**
 * The local-model lane (WP 5.1; 05-phase-5-dispatch.md §5's risk row "a local
 * model run blocks the worker's job loop").
 *
 * A `local_model` advisor runs only as `insights.run_local` (concurrency 1),
 * never through `insights.run` (concurrency 1, which would queue every
 * built-in behind a three-minute model call) and never inline in the API.
 * These cases drive `@core/platform`'s **real** job runner — the global cap of
 * four, the per-kind caps, the claim loop — with the two handlers from
 * `jobs.ts`, and enqueue the local run the way production does
 * (`requestAdvisorRuns`, which picks the lane), so collapsing the lane back
 * into `insights.run` is a red here rather than a line in a review.
 *
 * **Sabotage record** (docs/evidence/phase-5/wp5.1-run-control.md §5): the
 * lane collapsed into `insights.run` → the first case red.
 */
import { systemClock } from '@core/kernel';
import {
  createJobRunner,
  enqueueJob,
  platformExecutor,
  silentLogger,
  type FlagService,
  type JobContext,
  type JobRunner,
} from '@core/platform';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advisorRuns } from '../../schema/index.ts';
import type { InsightsContext } from '../../src/db.ts';
import {
  RUN_JOB_KIND,
  RUN_LOCAL_JOB_KIND,
  createRunAllJob,
  createRunJob,
  createRunLocalJob,
  requestAdvisorRuns,
} from '../../src/jobs.ts';
import type { Advisor } from '../../src/registry.ts';
import { LaneViolation, runAdvisor, type InsightsDependencies } from '../../src/service.ts';
import { NO_DATABASE, contextFor, insightsDatabase, type TestDatabase } from './harness.ts';
import {
  BUILTIN_ID,
  LOCAL_ID,
  answerFor,
  armAdvisor,
  blockingAdvisor,
  builtinManifest,
  dependenciesFor,
  flagsFor,
  liveSwitches,
  localManifest,
  wallMs,
  type BlockingAdvisor,
} from './run-control-harness.ts';

/** Poll until `check` is true, or fail loudly after `timeoutMs`. */
async function until(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = wallMs() + timeoutMs;
  while (wallMs() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

async function runStatus(database: TestDatabase, advisorId: string): Promise<string | null> {
  const rows = await database.db
    .select({ status: advisorRuns.status })
    .from(advisorRuns)
    .where(eq(advisorRuns.advisorId, advisorId))
    .orderBy(sql`${advisorRuns.startedAt} DESC, ${advisorRuns.id} DESC`)
    .limit(1);
  return rows[0]?.status ?? null;
}

async function queuedJobs(
  database: TestDatabase,
): Promise<readonly { kind: string; advisorId: string }[]> {
  const rows = await database.db.execute<{ kind: string; advisor_id: string }>(
    sql`SELECT kind, payload->>'advisorId' AS advisor_id FROM jobs ORDER BY kind, advisor_id`,
  );
  return rows.rows.map((row) => ({ kind: row.kind, advisorId: row.advisor_id }));
}

function jobContext(userId: string, kind: string): JobContext {
  return {
    id: '01930000-0000-7000-8000-00000000j0b1',
    userId,
    kind,
    attempt: 1,
    correlationId: '01930000-0000-7000-8000-0000000000c1',
    logger: silentLogger,
    clock: systemClock,
    signal: new AbortController().signal,
  };
}

describe.skipIf(NO_DATABASE)('the local-model lane', () => {
  let database: TestDatabase;
  let flags: FlagService;
  let context: InsightsContext;
  let runner: JobRunner | null = null;

  beforeEach(async () => {
    database ??= await insightsDatabase('local_lane');
    await database.truncate();
    flags = flagsFor(database);
    // The system clock: the job runner and the queue stamp with it.
    context = contextFor(database.userId, systemClock);
  }, 30_000);

  afterEach(async () => {
    await runner?.stop();
    runner = null;
  }, 30_000);

  afterAll(async () => {
    await database?.drop();
  }, 30_000);

  async function world(): Promise<{
    readonly local: BlockingAdvisor;
    readonly builtin: Advisor & { readonly calls: () => number };
    readonly dependencies: InsightsDependencies;
  }> {
    const local = blockingAdvisor(localManifest());
    let builtinCalls = 0;
    const manifest = builtinManifest();
    const builtin = {
      manifest,
      calls: () => builtinCalls,
      run: (request: Parameters<Advisor['run']>[0]) => {
        builtinCalls += 1;
        return Promise.resolve(answerFor(request, 'builtin'));
      },
    };
    const dependencies = dependenciesFor([local, builtin], liveSwitches(flags));
    await armAdvisor(database, context, dependencies, flags, local.manifest);
    await armAdvisor(database, context, dependencies, flags, builtin.manifest);
    return { local, builtin, dependencies };
  }

  function startRunner(dependencies: InsightsDependencies): JobRunner {
    const input = { database: database.db, dependencies, clock: systemClock };
    runner = createJobRunner({
      pool: database.pool,
      db: platformExecutor(database.db),
      handlers: [createRunJob(input), createRunLocalJob(input)],
      // The runner's real global cap. The lane is one slot of these four.
      concurrency: 4,
      pollIntervalMs: 25,
      logger: silentLogger,
    });
    return runner;
  }

  it('a local-model run in flight does not delay a builtin run', async () => {
    const { local, dependencies } = await world();
    const started = startRunner(dependencies);
    await started.start();
    const t0 = wallMs();
    const at = (label: string) => `${label} +${(wallMs() - t0).toFixed(0)} ms`;
    const timeline: string[] = [];

    // A builtin alone first: the baseline its latency is compared with.
    await enqueueJob(platformExecutor(database.db), {
      kind: RUN_JOB_KIND,
      userId: database.userId,
      payload: { advisorId: BUILTIN_ID, trigger: 'event' },
      correlationId: context.correlationId,
    });
    const aloneFrom = wallMs();
    await until(
      async () => (await runStatus(database, BUILTIN_ID)) === 'completed',
      10_000,
      'the lone builtin',
    );
    const aloneMs = wallMs() - aloneFrom;
    timeline.push(at(`builtin alone completed (${aloneMs.toFixed(0)} ms)`));

    // The local model, queued the way the API and the fan-out queue it.
    const queued = await requestAdvisorRuns(database.db, context, dependencies, {
      advisorIds: [LOCAL_ID],
      trigger: 'manual',
    });
    expect(queued).toEqual([
      expect.objectContaining({ status: 'queued', jobKind: RUN_LOCAL_JOB_KIND }),
    ]);
    timeline.push(at('local queued (insights.run_local)'));
    await local.started;
    timeline.push(at('local model call started, now blocking'));

    // A builtin, while the model call is in flight.
    const beside = await enqueueJob(platformExecutor(database.db), {
      kind: RUN_JOB_KIND,
      userId: database.userId,
      payload: { advisorId: BUILTIN_ID, trigger: 'event' },
      correlationId: context.correlationId,
    });
    expect(beside.deduped).toBe(false);
    timeline.push(at('builtin queued (insights.run)'));
    const besideFrom = wallMs();
    await until(
      async () => {
        const rows = await database.db
          .select({ n: sql<string>`count(*)::text` })
          .from(advisorRuns)
          .where(and(eq(advisorRuns.advisorId, BUILTIN_ID), eq(advisorRuns.status, 'completed')));
        return rows[0]?.n === '2';
      },
      10_000,
      'the builtin beside the local model',
    );
    const besideMs = wallMs() - besideFrom;
    timeline.push(at(`builtin completed (${besideMs.toFixed(0)} ms)`));

    // The model call is still in flight — the builtin did not wait for it.
    expect(await runStatus(database, LOCAL_ID)).toBe('started');
    expect(local.calls()).toBe(1);
    expect(besideMs).toBeLessThan(5_000);

    local.release();
    await until(
      async () => (await runStatus(database, LOCAL_ID)) === 'completed',
      10_000,
      'the local run',
    );
    timeline.push(at('local released and completed'));
    console.info(`[local-lane] timeline:\n  ${timeline.join('\n  ')}`);
  }, 60_000);

  it('a local_model advisor is never executed by insights.run or inline by the API', async () => {
    const { local, builtin, dependencies } = await world();
    const input = { database: database.db, dependencies, clock: systemClock };

    // (1) `insights.run` handed a local advisor (the event consumer enqueues
    //     `insights.run` for whatever a trigger names): it re-queues, runs nothing.
    await createRunJob(input).handler(
      { advisorId: LOCAL_ID, trigger: 'event' },
      jobContext(database.userId, RUN_JOB_KIND),
    );
    expect(local.calls()).toBe(0);
    expect(await runStatus(database, LOCAL_ID)).toBeNull();
    expect(await queuedJobs(database)).toEqual([{ kind: RUN_LOCAL_JOB_KIND, advisorId: LOCAL_ID }]);
    await database.db.execute(sql`DELETE FROM jobs`);

    // (2) The API's entry point: built-ins inline, the local model queued.
    const results = await requestAdvisorRuns(database.db, context, dependencies, {
      advisorIds: [BUILTIN_ID, LOCAL_ID],
      trigger: 'manual',
    });
    expect(results.map((r) => [r.advisorId, r.status])).toEqual([
      [BUILTIN_ID, 'completed'],
      [LOCAL_ID, 'queued'],
    ]);
    expect(builtin.calls()).toBe(1);
    expect(local.calls()).toBe(0);
    expect(await queuedJobs(database)).toEqual([{ kind: RUN_LOCAL_JOB_KIND, advisorId: LOCAL_ID }]);
    await database.db.execute(sql`DELETE FROM jobs`);

    // (3) The nightly fan-out puts each advisor in its own lane.
    await createRunAllJob({ database: database.db, registry: dependencies.registry }).handler(
      {},
      jobContext(database.userId, 'insights.run_all'),
    );
    expect(await queuedJobs(database)).toEqual([
      { kind: RUN_JOB_KIND, advisorId: BUILTIN_ID },
      { kind: RUN_LOCAL_JOB_KIND, advisorId: LOCAL_ID },
    ]);

    // (4) The service refuses outright outside the lane, before opening a run.
    await expect(
      runAdvisor(database.db, context, dependencies, { advisorId: LOCAL_ID, trigger: 'manual' }),
    ).rejects.toBeInstanceOf(LaneViolation);
    // …and a builtin handed to the local lane is the same wiring bug.
    await expect(
      createRunLocalJob(input).handler(
        { advisorId: BUILTIN_ID, trigger: 'manual' },
        jobContext(database.userId, RUN_LOCAL_JOB_KIND),
      ),
    ).rejects.toBeInstanceOf(LaneViolation);
    expect(local.calls()).toBe(0);
    expect(await runStatus(database, LOCAL_ID)).toBeNull();
  }, 60_000);

  it('the lane holds no database connection while the model is called', async () => {
    const { local, dependencies } = await world();

    // Every checkout of the suite's pool, with how long it was held.
    // `pg` is not an import this layer allows; the pool's own type is enough.
    const pool = database.pool;
    const heldSince = new Map<unknown, number>();
    const holds: { from: number; to: number }[] = [];
    const onAcquire = (client: unknown) => heldSince.set(client, wallMs());
    const onRelease = (_error: Error | undefined, client: unknown) => {
      const from = heldSince.get(client);
      if (from !== undefined) holds.push({ from, to: wallMs() });
      heldSince.delete(client);
    };
    pool.on('acquire', onAcquire);
    pool.on('release', onRelease);
    try {
      const running = createRunLocalJob({
        database: database.db,
        dependencies,
        clock: systemClock,
      }).handler(
        { advisorId: LOCAL_ID, trigger: 'manual' },
        jobContext(database.userId, RUN_LOCAL_JOB_KIND),
      );
      await local.started;
      const callFrom = wallMs();
      // Long enough for the watcher to tick twice (it borrows and returns).
      await new Promise((resolve) => setTimeout(resolve, 2_600));
      const now = wallMs();

      // Nothing checked out now that was checked out when the call began, and
      // nothing held for longer than a probe takes.
      const stillHeld = [...heldSince.values()];
      expect(stillHeld.filter((from) => from <= callFrom)).toEqual([]);
      const during = holds.filter((hold) => hold.to >= callFrom && hold.from <= now);
      const longest = Math.max(0, ...during.map((hold) => hold.to - hold.from));
      console.info(
        `[local-lane] during the model call: ${during.length} short checkouts (watcher ticks), longest ${longest.toFixed(1)} ms, held now ${stillHeld.length}`,
      );
      expect(during.length).toBeGreaterThanOrEqual(2);
      expect(longest).toBeLessThan(250);

      // And Postgres agrees: no session of this database is sitting in an
      // open transaction while the model thinks.
      const open = await database.db.execute<{ n: string }>(
        sql`SELECT count(*)::text AS n FROM pg_stat_activity
             WHERE datname = current_database() AND pid <> pg_backend_pid()
               AND state = 'idle in transaction'`,
      );
      expect(open.rows[0]?.n).toBe('0');

      local.release();
      await running;
      expect(await runStatus(database, LOCAL_ID)).toBe('completed');
    } finally {
      pool.off('acquire', onAcquire);
      pool.off('release', onRelease);
    }
  }, 60_000);
});
