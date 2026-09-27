// SPDX-License-Identifier: MIT
/**
 * Phase 4 Wave C wiring batch, proved end to end over a real database.
 *
 * `apps/api/test/phase3-registration.test.ts` proves the *shape*
 * `appModules()` returns for `module.planning` now that WP 4.6 (the projection
 * service) and WP 4.5 (Monte Carlo in a `worker_thread`) are landed. This file
 * proves the shape is connected to anything, in the `phase3-wiring.test.ts`
 * pattern:
 *
 *   1. a real `planning.ProjectionCompleted` — from the real
 *      `projectionRefreshJobHandler`, over a real sealed `net_worth_daily` day
 *      and a real saved baseline — reaches `planning.goal_pace@v1` through the
 *      real `createConsumerPump`, and the real 04:30 schedule row lands
 *      through the real `upsertSchedule`;
 *   2. a second holder's refresh job is served from **that holder's own**
 *      ports, not refused by name — the WP 4.6 fix to
 *      `SnapshotJobDependencies.portsFor` / `ProjectionRefreshJobDependencies
 *      .portsFor` (`docs/evidence/phase-4/wp4.6-projection-service.md` §10.1),
 *      wired at `apps/api/src/modules.ts`'s `planningModule`;
 *   3. `apps/api/src/domain.ts`'s `createMonteCarloRunner` refuses a
 *      20,001-path request as `MonteCarloRefused` before any worker is
 *      spawned, and `apps/api/src/routes/domain-errors.ts`'s `toDomainProblem`
 *      maps it to 422;
 *   4. with no return series on disk, `createMonteCarloRunnerFromCache` binds
 *      `null` rather than throwing or silently substituting a lognormal
 *      runner, and a baseline refresh wired with that `null` records
 *      `method: 'deterministic'`;
 *   5. the same adapter, run for real through WP 4.5's worker (the return
 *      series is present in this tree's cache), echoes a seed above 2^63
 *      unsigned and regroups the seven percentile bands into one
 *      `MonteCarloPeriod` per year, each band monotone non-decreasing —
 *      the two things §10.2 of the WP 4.5/4.6 evidence warns the adapter can
 *      get wrong with no type error anywhere;
 *   6. the adapter's own concurrency semaphore admits at most `maxConcurrent`
 *      runs at a time and queues the rest, proved deterministically with an
 *      injected `spawn` this file controls the release of — no real worker
 *      needed for *this* one, only a real semaphore.
 *
 * `docs/TESTING.md`'s scratch-database-per-suite convention: this file gets
 * its own holder(s) through `createApiHarness`/`h.database.createUser`, never
 * the compose stack, against the dev Postgres at `127.0.0.1:5433`.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DateOnly, Money, money, newId, systemClock, type Money as MoneyType } from '@core/kernel';
import { createConsumerPump } from '@core/platform';
import { recordBalance, upsertAccount } from '@ctx/ledger';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import {
  assembleBaselinePlan,
  loadAssumptions,
  loadReturnSeries,
  saveBaseline,
  sealDay,
  upsertOpenDay,
  type AssumptionsLike,
  type BaselineProfile,
  type DerivedInputs,
  type NetWorthSnapshot,
} from '@ctx/planning';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createInvestmentSyncPort,
  createMonteCarloRunner,
  createMonteCarloRunnerFromCache,
  drizzleTransactionalExecutor,
} from '../../src/domain.ts';
import {
  GOAL_PACE_CONSUMER_NAME,
  NET_WORTH_SNAPSHOT_JOB_KIND,
  PROJECTION_REFRESH_CRON,
  PROJECTION_REFRESH_JOB_KIND,
  PROJECTION_REFRESH_SCHEDULE_NAME,
  appModules,
  type ModuleWiringOptions,
} from '../../src/modules.ts';
import { toDomainProblem } from '../../src/routes/domain-errors.ts';
import { createApiHarness, NO_DATABASE, type ApiHarness } from '../helpers/api-harness.ts';

const ZONE = 'UTC';

/** A `net_worth_daily` day with nothing in it — enough for a projection to start from zero. */
function emptySnapshot(asOfDate: string): NetWorthSnapshot {
  return {
    asOfDate,
    baseCurrency: 'USD',
    assetsMinor: 0n,
    liabilitiesMinor: 0n,
    netWorthMinor: 0n,
    liquidMinor: 0n,
    investableMinor: 0n,
    onBudgetMinor: 0n,
    breakdown: [],
    source: 'observed',
    stalePrice: false,
    accountsCounted: 0,
    accountsUnvalued: 0,
    unvalued: [],
  };
}

async function sealMinimalDay(
  db: ApiHarness['database']['db'],
  userId: string,
  asOfDate: string,
): Promise<void> {
  await upsertOpenDay(db, { userId, snapshot: emptySnapshot(asOfDate), clock: systemClock });
  await sealDay(db, { userId, asOfDate, clock: systemClock });
}

/**
 * A baseline that states everything itself — no ledger, no budget, no
 * accounts required — so `derivedFromDay` (which always calls the real
 * `deriveRevealedBehavior` over the real ports) degrades to "nothing
 * observed" and the *stated* figures below are what the plan actually runs
 * on. `withdrawalPolicy: 'constant_real'` and `spendingFloor: 'none'` avoid
 * the guardrails/essential-spending path entirely, which this file has no
 * budget to feed.
 */
function statedProfile(overrides: Partial<BaselineProfile> = {}): BaselineProfile {
  return {
    birthDate: DateOnly.parse('1966-09-25'),
    retirementAge: 65,
    planEndAge: 90,
    currency: 'USD',
    glidepath: { kind: 'age_based' },
    contributionGrowth: 'flat',
    annualSpending: money(40_000_00n, 'USD'),
    withdrawalPolicy: 'constant_real',
    spendingFloor: 'none',
    taxDeferredRate: '0.15',
    socialSecurity: null,
    pensions: [],
    contributions: { TAXABLE: money(12_000_00n, 'USD') },
    ...overrides,
  };
}

/** `DerivedInputs` with a zero sealed day at `asOfDate` — paired with `sealMinimalDay`. */
function zeroDerived(asOfDate: string): DerivedInputs {
  const zero = Money.zero('USD');
  return {
    currency: 'USD',
    balances: {
      asOfDate: DateOnly.parse(asOfDate),
      revision: 1,
      sealed: true,
      byBucket: { TAXABLE: zero, TAX_DEFERRED: zero, ROTH: zero, HSA: zero },
    },
    contributions: { TAXABLE: null, TAX_DEFERRED: null, ROTH: null, HSA: null },
    annualIncome: null,
    nonSavingsSpending: null,
    essentialSpending: null,
  };
}

/** The file's own assumptions, no override — built with no database round trip. */
function fileAssumptions(): AssumptionsLike {
  const assumptions = loadAssumptions();
  return { version: assumptions.version, file: assumptions.file };
}

interface Logged {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

/** A minimal job-context logger that records every call, for asserting *which* outcome fired. */
function capturingLogger(): { readonly logger: unknown; readonly logs: Logged[] } {
  const logs: Logged[] = [];
  const record =
    (level: Logged['level']) =>
    (fields: Record<string, unknown>, message: string): void => {
      logs.push({ level, fields, message });
    };
  return { logger: { info: record('info'), warn: record('warn'), error: record('error') }, logs };
}

function jobContext(userId: string, logger: unknown): unknown {
  return { userId, correlationId: newId(), clock: systemClock, logger };
}

describe.skipIf(NO_DATABASE)(
  'Phase 4 Wave C wiring batch (apps/api/src/{modules,domain}.ts — WP 4.5/4.6)',
  () => {
    let h: ApiHarness;

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp4wwiring' });
    }, 120_000);

    afterAll(async () => {
      await h.close();
    }, 60_000);

    /** `appModules()` built the same way `worker.ts` builds it, minus market data (unused here). */
    function buildModules(
      overrides: Partial<ModuleWiringOptions> = {},
    ): ReturnType<typeof appModules> {
      const logger = pino({ level: 'silent' });
      const denyAll = createEgressPolicy({ allowedHosts: [] });
      const runtime = createDomainRuntime({
        database: h.database.db,
        clock: systemClock,
        logger,
        registry: createConnectorRegistry(),
        secretBox: h.security.requireSecretBox(),
      });
      return appModules({
        database: h.database.db,
        userId: h.userId,
        orchestrator: runtime.orchestrator,
        timezone: ZONE,
        clock: systemClock,
        notificationChannels: {
          ntfy: createNtfyChannel({ policy: denyAll }),
          smtp: createSmtpChannel({ policy: denyAll }),
        },
        secretBox: h.security.requireSecretBox(),
        investmentSyncPort: createInvestmentSyncPort(h.database.db),
        ...overrides,
      });
    }

    it(
      'module.planning: a real planning.ProjectionCompleted reaches the goal_pace consumer ' +
        'through the real pump, and the 04:30 schedule lands',
      async () => {
        // A fresh holder, not `h.userId`: `balancesDay(executor, userId, null)`
        // answers the *newest* sealed day, so a holder shared with another
        // test in this file (which seals its own, possibly later, day) would
        // make this test's cache key depend on test order. One holder per
        // test removes that coupling entirely.
        const userId = await h.database.createUser('Wave C real-pump holder');
        const asOfDate = '2026-09-25';
        await sealMinimalDay(h.database.db, userId, asOfDate);
        await saveBaseline(h.database.db, {
          userId,
          name: 'Wave C wiring baseline',
          profile: statedProfile(),
          clock: systemClock,
        });

        // No `monteCarlo` supplied: the nightly baseline runs deterministic,
        // which is enough to prove the wiring — WP 4.5's own engine is
        // exercised separately, below.
        const modules = buildModules();
        const planning = modules.find((module) => module.flagKey === 'module.planning');
        expect(planning?.consumers ?? []).toHaveLength(2);

        // --- the 04:30 schedule, through the real upsert -------------------
        await planning?.schedules?.(userId);
        const scheduled = await h.database.db.execute<{ job_kind: string; cron: string }>(
          sql`SELECT job_kind, cron FROM schedules
               WHERE user_id = ${userId}::uuid AND name = ${PROJECTION_REFRESH_SCHEDULE_NAME}`,
        );
        expect(scheduled.rows).toHaveLength(1);
        expect(scheduled.rows[0]?.job_kind).toBe(PROJECTION_REFRESH_JOB_KIND);
        expect(scheduled.rows[0]?.cron).toBe(PROJECTION_REFRESH_CRON);

        // --- the refresh job, driven directly (as the real job runner would) ---
        const refresh = planning?.jobs?.find((job) => job.kind === PROJECTION_REFRESH_JOB_KIND);
        expect(refresh).toBeDefined();
        if (refresh === undefined) return;

        const { logger, logs } = capturingLogger();
        await refresh.handler({}, jobContext(userId, logger) as never);

        const computed = logs.find((entry) => entry.message.startsWith('baseline projection'));
        expect(computed?.fields['status']).toBe('computed');
        expect(computed?.fields['method']).toBe('deterministic');

        const completedEvents = await h.database.db.execute<{ id: string }>(sql`
          SELECT id FROM domain_events
           WHERE user_id = ${userId}::uuid AND event_type = 'planning.ProjectionCompleted'
        `);
        expect(completedEvents.rows).toHaveLength(1);

        // --- the real pump, both consumers --------------------------------
        const pump = createConsumerPump({
          pool: h.database.pool,
          db: drizzleTransactionalExecutor(h.database.db),
          clock: systemClock,
          logger: pino({ level: 'silent' }),
          consumers: [...(planning?.consumers ?? [])],
        });
        await pump.drain();

        const offset = await h.database.db.execute<{
          last_seq: string;
          failed_error: string | null;
        }>(
          sql`SELECT last_seq, failed_error FROM event_consumer_offsets
               WHERE consumer_name = ${GOAL_PACE_CONSUMER_NAME}`,
        );
        expect(offset.rows).toHaveLength(1);
        expect(offset.rows[0]?.failed_error).toBeNull();
        expect(BigInt(offset.rows[0]?.last_seq ?? '0')).toBeGreaterThan(0n);

        // The claim landed on the run itself — the WP 3.2 "re-announced on
        // every redelivery" defect closed in the row, not in a receipt.
        const claimed = await h.database.db.execute<{ goals_evaluated_at: string | null }>(sql`
          SELECT goals_evaluated_at FROM projection_runs
           WHERE user_id = ${userId}::uuid AND scenario_kind = 'baseline' AND method = 'deterministic'
           ORDER BY created_at DESC LIMIT 1
        `);
        expect(claimed.rows[0]?.goals_evaluated_at).not.toBeNull();
      },
      120_000,
    );

    it("a second holder's refresh job is served, not refused by name", async () => {
      const holderA = await h.database.createUser('Wave C First Holder');
      const holderB = await h.database.createUser('Wave C Second Holder');
      const asOfDate = '2026-09-24';

      await sealMinimalDay(h.database.db, holderA, asOfDate);
      await saveBaseline(h.database.db, {
        userId: holderA,
        name: 'Wave C second-holder-test baseline (holder A)',
        profile: statedProfile(),
        clock: systemClock,
      });
      // Holder B deliberately gets no sealed day and no baseline: the honest
      // answer for B is `no_baseline`, and getting that answer — rather than
      // A's, and rather than the old "was enqueued for a user these modules
      // were not built for" throw — is exactly what "served, not refused by
      // name" means.
      const modules = buildModules();
      const planning = modules.find((module) => module.flagKey === 'module.planning');
      const refresh = planning?.jobs?.find((job) => job.kind === PROJECTION_REFRESH_JOB_KIND);
      expect(refresh).toBeDefined();
      if (refresh === undefined) return;

      const a = capturingLogger();
      await expect(
        refresh.handler({}, jobContext(holderA, a.logger) as never),
      ).resolves.toBeUndefined();
      const aResult = a.logs.find((entry) => entry.message.startsWith('baseline'));
      expect(aResult?.fields['status']).toBe('computed');

      const b = capturingLogger();
      await expect(
        refresh.handler({}, jobContext(holderB, b.logger) as never),
      ).resolves.toBeUndefined();
      const bResult = b.logs.find((entry) => entry.message.startsWith('baseline'));
      expect(bResult?.fields['status']).toBe('no_baseline');

      // And nothing was written for B: the ports really were B's, not A's.
      const bRuns = await h.database.db.execute<{ id: string }>(
        sql`SELECT id FROM projection_runs WHERE user_id = ${holderB}::uuid`,
      );
      expect(bRuns.rows).toHaveLength(0);
    });

    it(
      "module.planning: the net-worth snapshot job's price/FX readers are built from the job's " +
        "own userId — a second holder's rate is not read through the first holder's binding",
      async () => {
        // `RevealedPorts` (the refresh job's ports, driven above) never
        // actually closes over `PlanningPortOptions.userId` — every method on
        // `CashflowReader`/`SpendingReader` takes `userId` as an explicit,
        // per-call argument, so the previous test cannot see a mis-threaded
        // closure even if there were one. `SnapshotPorts.prices`/`.fx` are
        // different: `createPriceReader`/`createFxReader` bind `userId` once,
        // with no per-call override (`ports.ts`'s own doc, D4) — which is
        // exactly the WP 3.8 shape the D6 refusal-by-name wrapper existed to
        // protect and WP 4.6 fixed by threading the job's userId into
        // `planningPortsFor` on every run. This is the test that can actually
        // see `portOptions` in `modules.ts`'s `planningModule` get it wrong.
        const holderA = await h.database.createUser('Wave C snapshot holder A');
        const holderB = await h.database.createUser('Wave C snapshot holder B');
        const asOfDate = '2026-09-19';

        async function eurAccount(userId: string): Promise<void> {
          const { accountId } = await upsertAccount(
            h.database.db,
            {
              userId,
              provider: 'manual',
              providerAccountId: `wp4w-snapshot-eur-${userId}`,
              name: 'Wave C EUR account',
              type: 'manual',
              currency: 'EUR',
              includeInNetWorth: true,
            },
            { clock: systemClock, correlationId: newId() },
          );
          await recordBalance(
            h.database.db,
            {
              userId,
              accountId,
              current: money(100_00n, 'EUR'),
              available: null,
              limit: null,
              asOf: new Date(`${asOfDate}T12:00:00.000Z`),
              source: 'manual',
            },
            { clock: systemClock, correlationId: newId() },
          );
        }
        await eurAccount(holderA);
        await eurAccount(holderB);

        // Only holder B gets a rate. D4/§6.6: an unknown pair is never
        // defaulted to 1.0, so the *only* way holder B's snapshot seals
        // cleanly is if the price/FX readers actually queried `fx_rates`
        // under holder B's own `user_id`.
        await h.database.db.execute(sql`
          INSERT INTO fx_rates (id, user_id, base_currency, quote_currency, rate_date, source, rate, observed_at)
          VALUES (${newId()}::uuid, ${holderB}::uuid, 'EUR', 'USD', ${asOfDate}::date, 'fred',
                  '1.1000000000', now())
        `);

        const modules = buildModules();
        const planning = modules.find((module) => module.flagKey === 'module.planning');
        const snapshot = planning?.jobs?.find((job) => job.kind === NET_WORTH_SNAPSHOT_JOB_KIND);
        expect(snapshot).toBeDefined();
        if (snapshot === undefined) return;

        // `runSnapshot` computes *today* (never sealed on the run that
        // creates it — "the only day still allowed to move") and seals only
        // pre-existing open days past the boundary, of which there are none
        // here; the meaningful assertion is that it completes at all (an FX
        // failure rolls the whole transaction back, so no row would exist),
        // and that the EUR account actually converted rather than being
        // silently valued at zero.
        await expect(
          snapshot.handler({}, jobContext(holderB, capturingLogger().logger) as never),
        ).resolves.toBeUndefined();
        const rowB = await h.database.db.execute<{ assets_minor: string }>(
          sql`SELECT assets_minor FROM net_worth_daily WHERE user_id = ${holderB}::uuid`,
        );
        expect(rowB.rows).toHaveLength(1);
        expect(BigInt(rowB.rows[0]?.assets_minor ?? '0')).toBeGreaterThan(0n);

        // Holder A has no rate of their own and must be refused — never
        // silently sealed at an invented 1.0, and never silently sealed
        // using holder B's rate either.
        await expect(
          snapshot.handler({}, jobContext(holderA, capturingLogger().logger) as never),
        ).rejects.toThrow();
      },
      60_000,
    );

    it(
      'the Monte Carlo binding refuses a 20,001-path request as MonteCarloRefused before any ' +
        'worker spawns, and the route mapping is 422',
      async () => {
        const asOfDate = '2026-09-23';
        const { plan } = assembleBaselinePlan(statedProfile(), zeroDerived(asOfDate));
        const assumptions = fileAssumptions();

        let spawnCount = 0;
        const runner = createMonteCarloRunner({
          // A minimal, structurally valid series — the envelope's `paths`
          // check is the *first* one `assertWithinEnvelope` makes and fires
          // before the series is ever inspected, so its content does not
          // matter for this test.
          series: {
            id: 'wp4w-fixture',
            sha256: 'a'.repeat(64),
            firstMonth: '2000-01',
            equityReal: new Float64Array(24),
            bondReal: new Float64Array(24),
            inflation: new Float64Array(24),
          },
          spawn: (url, options) => {
            spawnCount += 1;
            throw new Error(
              `spawn must not be called; asked for ${url.toString()}, ${String(options)}`,
            );
          },
        });

        let caught: unknown;
        try {
          await runner.run({ plan, assumptions, seed: 123n, paths: 20_001 });
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as { name: string }).name).toBe('MonteCarloRefused');
        expect((caught as { code: string }).code).toBe(
          'planning.montecarlo_paths_outside_envelope',
        );
        expect(spawnCount).toBe(0);

        const problem = toDomainProblem(caught) as {
          status: number;
          code: string;
          family: string;
        };
        expect(problem.status).toBe(422);
        expect(problem.code).toBe('planning.montecarlo_paths_outside_envelope');
        expect(problem.family).toBe('domain');
      },
    );

    it(
      'with no return series on disk the runner is bound as null and a projection records it, ' +
        'never a silent lognormal',
      async () => {
        const { logger, logs } = capturingLogger();
        const missingCacheDir = `/tmp/personalfi-wp4w-no-such-cache-${newId()}`;
        const runner = createMonteCarloRunnerFromCache({
          cacheDir: missingCacheDir,
          logger: logger as never,
        });
        expect(runner).toBeNull();
        const warned = logs.find((entry) => entry.level === 'warn');
        expect(warned?.fields['code']).toBe('planning.returns_series_unavailable');
        expect(warned?.message).toContain('Monte Carlo is bound to null');
        expect(warned?.message).toContain('deterministic');

        // Wired with that `null`, exactly as `worker.ts` would when the cache
        // is absent, the nightly baseline still completes — deterministic,
        // and the run says so.
        const userId = await h.database.createUser('Wave C null-Monte-Carlo holder');
        const asOfDate = '2026-09-22';
        await sealMinimalDay(h.database.db, userId, asOfDate);
        await saveBaseline(h.database.db, {
          userId,
          name: 'Wave C null-Monte-Carlo baseline',
          profile: statedProfile(),
          clock: systemClock,
        });
        const modules = buildModules({ monteCarlo: runner });
        const planning = modules.find((module) => module.flagKey === 'module.planning');
        const refresh = planning?.jobs?.find((job) => job.kind === PROJECTION_REFRESH_JOB_KIND);
        expect(refresh).toBeDefined();
        if (refresh === undefined) return;

        const job = capturingLogger();
        await refresh.handler({}, jobContext(userId, job.logger) as never);
        const result = job.logs.find((entry) => entry.message.startsWith('baseline'));
        expect(result?.fields['status']).toBe('computed');
        expect(result?.fields['method']).toBe('deterministic');
      },
      60_000,
    );

    it(
      "createMonteCarloRunner runs a real Monte Carlo through WP 4.5's real worker, echoes a " +
        'seed above 2^63 unsigned, and regroups the seven bands into one monotone period per year',
      async () => {
        // This tree's `data/returns/cache/shiller-monthly.csv` is present
        // (fetched during WP 4.5's own work), so this is the real bootstrap
        // engine, not a fake — the one test in this file that actually spawns
        // a `worker_thread`.
        const series = loadReturnSeries();
        const runner = createMonteCarloRunner({ series });

        const asOfDate = '2026-09-25';
        const profile = statedProfile({ retirementAge: 66, planEndAge: 68 }); // ~3 years, fast
        const { plan } = assembleBaselinePlan(profile, zeroDerived(asOfDate));
        const assumptions = fileAssumptions();

        // Above the signed 64-bit range: exactly the half of all baselines
        // WP 4.6 §10.2 originally worried an `asIntN`/`asUintN` dance would
        // mishandle on the way out.
        const seed = 2n ** 63n + 777n;
        const outcome = await runner.run({ plan, assumptions, seed, paths: 200 });

        expect(outcome.seed).toBe(seed);
        expect(outcome.engineVersion).toBe(runner.engineVersion);
        expect(outcome.periods.length).toBeGreaterThan(0);

        outcome.periods.forEach((period, index) => {
          expect(period.index).toBe(index);
          const ordered: MoneyType[] = [
            period.p5,
            period.p10,
            period.p25,
            period.p50,
            period.p75,
            period.p90,
            period.p95,
          ];
          for (let i = 1; i < ordered.length; i += 1) {
            const prev = ordered[i - 1];
            const next = ordered[i];
            if (prev === undefined || next === undefined) throw new Error('unreachable');
            expect(
              Money.compare(prev, next),
              `period ${String(index)}: level ${String(i - 1)} > level ${String(i)}`,
            ).toBeLessThanOrEqual(0);
          }
        });
      },
      30_000,
    );

    it(
      "the adapter's own semaphore admits at most maxConcurrent runs and queues the rest " +
        '(WP 4.5 §4.5/§10: ~30–45 MB per worker, ten concurrent exhausts a 512 MB container)',
      async () => {
        // A fake `Worker`: `EventEmitter` gives `once('message'|'error'|
        // 'exit', …)`, which is all `inWorker` ever calls; nothing here
        // constructs a `MonteCarloResult`, because releasing a run via an
        // `'error'` event (→ `MonteCarloWorkerFailed`, caught below) proves
        // the same admission-and-queueing property without needing one.
        let concurrent = 0;
        let maxConcurrentSeen = 0;
        const releases: (() => void)[] = [];
        const spawn = (): unknown => {
          concurrent += 1;
          maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrent);
          const worker = new EventEmitter() as EventEmitter & { terminate: () => Promise<number> };
          worker.terminate = () => Promise.resolve(0);
          releases.push(() => {
            concurrent -= 1;
            worker.emit(
              'error',
              Object.assign(new Error('fixture: released'), { code: 'FIXTURE' }),
            );
          });
          return worker;
        };

        const series = {
          id: 'wp4w-semaphore-fixture',
          sha256: 'b'.repeat(64),
          firstMonth: '2000-01',
          equityReal: new Float64Array(24),
          bondReal: new Float64Array(24),
          inflation: new Float64Array(24),
        };
        const runner = createMonteCarloRunner({
          series,
          maxConcurrent: 2,
          spawn: spawn as never,
        });
        const { plan } = assembleBaselinePlan(statedProfile(), zeroDerived('2026-09-20'));
        const assumptions = fileAssumptions();

        const sleep = (ms: number): Promise<void> =>
          new Promise((resolve) => {
            setTimeout(resolve, ms);
          });

        const runs = Array.from({ length: 5 }, (_unused, i) =>
          runner.run({ plan, assumptions, seed: BigInt(i + 1), paths: 50 }).then(
            () => 'resolved',
            () => 'rejected',
          ),
        );

        // Let every admitted call's synchronous-through-`acquire()` path
        // reach `spawn`; the other three are parked at `await
        // semaphore.acquire()` and cannot call `spawn` until released.
        await sleep(20);
        expect(releases.length).toBe(2);
        expect(concurrent).toBe(2);

        while (releases.length > 0) {
          releases.shift()?.();
          await sleep(10);
        }
        const settled = await Promise.all(runs);

        expect(maxConcurrentSeen).toBe(2);
        expect(settled).toEqual(['rejected', 'rejected', 'rejected', 'rejected', 'rejected']);
      },
      10_000,
    );

    it(
      "worker.ts's own boot path binds a non-null Monte Carlo runner when a return series is " +
        'present and null when it is not (WP 4.12b, the Wave C wiring handover §4.2/§4.4)',
      () => {
        // Source-shape half, the same style `worker-account-holder-poll.test.ts`
        // uses for C-1: proves the *wiring line* exists in `worker.ts` rather
        // than only that `createMonteCarloRunnerFromCache` behaves correctly in
        // isolation (already proven above, and again below). Before this WP,
        // `worker.ts` never called `createMonteCarloRunnerFromCache` at all —
        // `domain.ts` only exported it — so `ModuleWiringOptions.monteCarlo`
        // was always `undefined` in production and the nightly baseline never
        // ran a real Monte Carlo, silently.
        const worker = readFileSync(
          fileURLToPath(new URL('../../src/worker.ts', import.meta.url)),
          'utf8',
        );
        expect(
          worker.includes('createMonteCarloRunnerFromCache('),
          'worker.ts must construct the runner itself — it is the one process with a job runner.',
        ).toBe(true);
        expect(
          worker.includes('config.planning.returnsCacheDir'),
          'the cache directory must come from @core/config, not a hardcoded or missing default.',
        ).toBe(true);
        // The constructed value must actually reach `appModules`, not just be
        // constructed and dropped — a `const monteCarlo = …` with no consumer
        // would pass the two assertions above and still leave the nightly
        // baseline deterministic-only.
        const appModulesCall = /appModules\(\{[\s\S]*?\n {12}\}\),/u.exec(worker)?.[0];
        expect(appModulesCall, 'no appModules({...}) call found to inspect').toBeDefined();
        expect(
          (appModulesCall ?? '').includes('monteCarlo,') ||
            (appModulesCall ?? '').includes('monteCarlo:'),
          'the constructed `monteCarlo` value must be passed into appModules({...}).',
        ).toBe(true);

        // Behavioural half: the exact function worker.ts calls, fed the exact
        // shape `config.planning.returnsCacheDir` has (`string | undefined`).
        // This tree's `packages/contexts/planning/data/returns/cache/` already
        // carries WP 4.5's fetched-once series (`loadReturnSeries()` above, at
        // line ~558, already relies on this), so the *default* — `undefined`,
        // exactly as an operator who has not set `PLANNING_RETURNS_CACHE_DIR`
        // gets — resolves to a real, present series.
        const bound = createMonteCarloRunnerFromCache({
          logger: capturingLogger().logger as never,
        });
        expect(bound, 'a present return series must bind a non-null runner').not.toBeNull();

        // And the null half: an explicit path that does not exist, the same
        // shape an operator's un-fetched cache volume has on a fresh install.
        const missing = createMonteCarloRunnerFromCache({
          cacheDir: `/tmp/personalfi-wp4.12b-c-wiring-no-such-cache-${newId()}`,
          logger: capturingLogger().logger as never,
        });
        expect(
          missing,
          'an absent return series must bind null, never a silent lognormal',
        ).toBeNull();
      },
    );
  },
);
