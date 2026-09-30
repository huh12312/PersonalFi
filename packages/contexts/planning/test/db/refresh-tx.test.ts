// SPDX-License-Identifier: MIT
/**
 * WP 5.5 — the nightly projection refresh holds no transaction while the
 * engine runs (05 §2's refresh-transaction row; wp4.6 §11 item 6).
 *
 * Until WP 5.5 `planning.projection_refresh` opened one transaction and ran the
 * whole refresh inside it — reads, a ~1 s Monte Carlo, the insert and
 * `ProjectionCompleted` — pinning a pooled connection "idle in transaction"
 * for the length of the engine run. Phase 5 adds a weekly job that runs the
 * engine per Brief item; a second transaction held across compute is how
 * Phase 3's pool-vs-lease deadlock comes back.
 *
 * Two witnesses, each taken **from inside the engine** while it runs, through
 * the production job handler over a real Postgres (own scratch database):
 *
 *   1. the job's own `database.transaction` calls, counted by a spy wrapped
 *      around the real Drizzle handle — how many are open right now;
 *   2. Postgres itself: `pg_stat_activity` for this database, read on another
 *      pooled connection — any backend with an open transaction
 *      (`xact_start IS NOT NULL`) other than the one asking.
 *
 * Both must read zero for the deterministic engine and for the Monte Carlo
 * runner. Then the run, its bands and `ProjectionCompleted` must still have
 * landed together — the split must not have cost the atomic write.
 */
import { DateOnly, Money, fixedClock, type Clock } from '@core/kernel';
import { silentLogger, type JobContext } from '@core/platform';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AssumptionsLike, ProjectionPlan } from '../../src/engine/boundary.ts';
import { projectDeterministic } from '../../src/engine/project.ts';
import { PROJECTION_REFRESH_JOB_KIND, projectionRefreshJobHandler } from '../../src/jobs.ts';
import type { BreakdownEntry } from '../../src/net-worth.ts';
import type { MonteCarloRunner } from '../../src/ports.ts';
import { saveBaseline, type BaselineProfile } from '../../src/scenarios.ts';
import {
  sealDay,
  upsertOpenDay,
  type PlanningDatabase,
  type PlanningExecutor,
} from '../../src/store.ts';
import { account, ports as revealedPorts } from '../revealed-fixtures.ts';
import { CORRELATION_ID, NO_DATABASE } from './harness.ts';

const ZONE = 'America/New_York';
const CLOCK: Clock = fixedClock('2026-09-26T08:30:00Z');
const BROKERAGE = 'a1955000-0000-7000-8000-0000000000b1';

function usd(text: string): Money {
  return Money.parseAmount(text, 'USD');
}

const PROFILE: BaselineProfile = {
  birthDate: DateOnly.parse('1986-03-15'),
  retirementAge: 65,
  planEndAge: 95,
  currency: 'USD',
  glidepath: { kind: 'age_based' },
  contributionGrowth: 'flat',
  annualSpending: usd('60000'),
  withdrawalPolicy: 'constant_real',
  spendingFloor: 'none',
  taxDeferredRate: '0.15',
  socialSecurity: null,
  pensions: [],
  contributions: null,
};

/** The real Drizzle handle, with every `transaction` it opens counted while open. */
function spiedDatabase(real: PlanningDatabase): {
  readonly database: PlanningDatabase;
  readonly open: () => number;
  readonly opened: () => number;
} {
  let open = 0;
  let opened = 0;
  const database = new Proxy(real, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return (work: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) =>
          (target.transaction as (...args: unknown[]) => Promise<unknown>)(
            async (tx: unknown) => {
              open += 1;
              opened += 1;
              try {
                return await work(tx);
              } finally {
                open -= 1;
              }
            },
            ...rest,
          );
      }
      const inner: unknown = Reflect.get(target, property, receiver);
      return typeof inner === 'function'
        ? (inner as (...a: unknown[]) => unknown).bind(target)
        : inner;
    },
  });
  return { database, open: () => open, opened: () => opened };
}

function jobContext(userId: string): JobContext {
  return {
    id: 'job-refresh-tx',
    userId,
    kind: PROJECTION_REFRESH_JOB_KIND,
    attempt: 1,
    correlationId: CORRELATION_ID,
    logger: silentLogger,
    clock: CLOCK,
    signal: new AbortController().signal,
  };
}

describe.skipIf(NO_DATABASE)('planning.projection_refresh and its transactions (WP 5.5)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp55_refresh_tx');
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.truncate([
      'projection_percentiles',
      'projection_runs',
      'plan_life_events',
      'plan_scenarios',
      'plan_assumptions',
      'net_worth_daily',
      'domain_events',
    ]);
  });

  /** Backends of this database with an open transaction, other than the one asking. */
  async function transactionsOpenInPostgres(): Promise<number> {
    const result = await database.db.execute<{ n: string }>(sql`
      SELECT count(*)::text AS n FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
    `);
    return Number(result.rows[0]?.n ?? '-1');
  }

  async function seed(): Promise<void> {
    const entry: BreakdownEntry = {
      accountId: BROKERAGE,
      currency: 'USD',
      nativeMinor: '40000000',
      baseMinor: '40000000',
      fxRate: '1',
      fxRateDate: '2026-09-24',
      onBudget: false,
      inNetWorth: true,
      isLiquid: false,
      isInvestable: true,
      side: 'asset',
      kind: 'investment',
      valuation: 'quantity_times_price',
      stalePrice: false,
    };
    await database.db.transaction(async (tx) => {
      const executor = tx as unknown as PlanningExecutor;
      await upsertOpenDay(executor, {
        userId: database.userId,
        snapshot: {
          asOfDate: '2026-09-24',
          baseCurrency: 'USD',
          assetsMinor: 40_000_000n,
          liabilitiesMinor: 0n,
          netWorthMinor: 40_000_000n,
          liquidMinor: 0n,
          investableMinor: 40_000_000n,
          onBudgetMinor: 0n,
          breakdown: [entry],
          source: 'observed',
          stalePrice: false,
          accountsCounted: 1,
          accountsUnvalued: 0,
          unvalued: [],
        },
        clock: CLOCK,
      });
      await sealDay(executor, { userId: database.userId, asOfDate: '2026-09-24', clock: CLOCK });
      await saveBaseline(executor, {
        userId: database.userId,
        name: 'My plan',
        profile: PROFILE,
        clock: CLOCK,
      });
    });
  }

  const revealed = revealedPorts([account(BROKERAGE, 'Brokerage', 'investment')], []);

  it('the refresh job holds no transaction while the engine runs', async () => {
    await seed();
    const spy = spiedDatabase(database.db as unknown as PlanningDatabase);

    // 1. The deterministic engine (no Monte Carlo bound). It is synchronous, so the spy is its
    //    witness; the Monte Carlo below is asynchronous and asks Postgres as well.
    const deterministicSaw: number[] = [];
    const deterministic = (plan: ProjectionPlan, assumptions: AssumptionsLike) => {
      deterministicSaw.push(spy.open());
      return projectDeterministic(plan, assumptions);
    };
    await projectionRefreshJobHandler({
      database: spy.database,
      portsFor: () => revealed,
      monteCarlo: null,
      timeZone: ZONE,
      deterministic,
    }).handler({}, jobContext(database.userId));
    expect(deterministicSaw).toEqual([0]);
    expect(spy.opened()).toBe(2); // one to read, one to write — and none around the engine

    // 2. The Monte Carlo runner, asynchronous like WP 4.5's worker: while it "runs" (a real await,
    //    so a held transaction would sit idle-in-transaction in Postgres), it asks both witnesses.
    const runnerSaw: { spy: number; postgres: number }[] = [];
    const engineVersion = 'probe.montecarlo/1';
    const runner: MonteCarloRunner = {
      engineVersion,
      async run(request) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        runnerSaw.push({ spy: spy.open(), postgres: await transactionsOpenInPostgres() });
        const path = projectDeterministic(request.plan, request.assumptions);
        return {
          engineVersion,
          seed: request.seed,
          paths: request.paths,
          successProbability: '0.5',
          periods: path.years.map((year) => ({
            index: year.index,
            age: year.age,
            calendarYear: year.calendarYear,
            p5: year.endWealth,
            p10: year.endWealth,
            p25: year.endWealth,
            p50: year.endWealth,
            p75: year.endWealth,
            p90: year.endWealth,
            p95: year.endWealth,
          })),
        };
      },
    };
    await projectionRefreshJobHandler({
      database: spy.database,
      portsFor: () => revealed,
      monteCarlo: runner,
      timeZone: ZONE,
      paths: 2_000,
    }).handler({}, jobContext(database.userId));
    console.log(JSON.stringify({ deterministicSaw, runnerSaw, opened: spy.opened() }));
    expect(runnerSaw).toEqual([{ spy: 0, postgres: 0 }]);
    expect(spy.opened()).toBe(4);

    // The split cost nothing in atomicity: each run landed with its bands and exactly one
    // ProjectionCompleted, and nothing is left open.
    const landed = await database.db.execute<{ method: string; bands: string; events: string }>(sql`
      SELECT r.method,
             (SELECT count(*) FROM projection_percentiles p WHERE p.run_id = r.id)::text AS bands,
             (SELECT count(*) FROM domain_events e
               WHERE e.event_type = 'planning.ProjectionCompleted'
                 AND e.aggregate_id = r.id)::text AS events
        FROM projection_runs r ORDER BY r.method
    `);
    expect(landed.rows).toEqual([
      { method: 'deterministic', bands: String(95 - 40), events: '1' },
      { method: 'monte_carlo', bands: String(95 - 40), events: '1' },
    ]);
    expect(spy.open()).toBe(0);
    expect(await transactionsOpenInPostgres()).toBe(0);
  }, 30_000);
});
