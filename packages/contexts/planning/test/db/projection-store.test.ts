// SPDX-License-Identifier: MIT
/**
 * WP 4.6 — `projection_runs` and `projection_percentiles` (migration 0022)
 * against a real Postgres: the cache, the recorded cache-key inputs, the
 * immutable run, the once-only goal evaluation, and the sealed-day start.
 *
 * Own scratch database (`personalfi_wp46_projection_store`), per
 * docs/TESTING.md.
 *
 * The deterministic engine is the real one (WP 4.4), wrapped only to count its
 * calls. The Monte Carlo is a fake behind the `MonteCarloRunner` port — WP 4.5
 * is not landed — that derives its bands from the real deterministic path and
 * records every seed it was handed. The derived inputs (sealed balances by
 * bucket, revealed contributions and spending) come from a fake
 * `ProjectionInputsReader`, except in the sealed-day test, which drives the
 * real reader over real `net_worth_daily` rows.
 */
import { DateOnly, Money, fixedClock, type Clock } from '@core/kernel';
import { silentLogger, type EventEnvelope } from '@core/platform';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assumptionsVersion, saveOverrides } from '../../src/assumptions.ts';
import type { AssumptionsLike, ProjectionPlan } from '../../src/engine/boundary.ts';
import { ENGINE_VERSION, TAXABLE } from '../../src/engine/deterministic.ts';
import { runMonteCarlo } from '../../src/engine/montecarlo.ts';
import { toMonteCarloJob } from '../../src/engine/worker-host.ts';
import { projectDeterministic } from '../../src/engine/project.ts';
import { addContribution, createGoal } from '../../src/goals.ts';
import { createLifeEvent } from '../../src/life-events.ts';
import type { MonteCarloRequest, MonteCarloRunner } from '../../src/ports.ts';
import {
  createGoalPaceConsumer,
  createProjectionInputsReader,
  goalEvaluationStoreOf,
  runProjection,
  type DerivedInputs,
  type ProjectionInputsReader,
  type ProjectionServiceDependencies,
} from '../../src/projection-service.ts';
import {
  insertRun,
  isProjectionRefused,
  type ProjectionRefused,
} from '../../src/projection-store.ts';
import { saveBaseline, type BaselineProfile } from '../../src/scenarios.ts';
import { platformOf, sealDay, upsertOpenDay, type PlanningExecutor } from '../../src/store.ts';
import type { BreakdownEntry, NetWorthSnapshot } from '../../src/net-worth.ts';
import { account, ports as revealedPorts } from '../revealed-fixtures.ts';
import { CORRELATION_ID, NO_DATABASE, pgFailureOf } from './harness.ts';

const ZONE = 'America/New_York';
const CLOCK: Clock = fixedClock('2026-09-26T08:30:00Z');
const US_EQUITY = 'capitalMarket.usEquity.expectedReturn';

function usd(text: string): Money {
  return Money.parseAmount(text, 'USD');
}

const PROFILE: BaselineProfile = {
  birthDate: DateOnly.parse('1986-03-15'),
  retirementAge: 65,
  planEndAge: 95,
  currency: 'USD',
  glidepath: { kind: 'age_based' },
  contributionGrowth: 'wage',
  annualSpending: null,
  withdrawalPolicy: 'guardrails',
  spendingFloor: 'essential_spend',
  taxDeferredRate: '0.15',
  socialSecurity: {
    monthlyPia: usd('2800'),
    claimAge: { years: 67, months: 0 },
    stressAfter2034: false,
  },
  pensions: [],
  contributions: null,
};

function derived(revision = 1): DerivedInputs {
  return {
    currency: 'USD',
    balances: {
      asOfDate: DateOnly.parse('2026-09-25'),
      revision,
      sealed: true,
      byBucket: {
        TAXABLE: usd('100000'),
        TAX_DEFERRED: usd('250000'),
        ROTH: usd('50000'),
        HSA: usd('0'),
      },
    },
    contributions: {
      TAXABLE: usd('12000'),
      TAX_DEFERRED: usd('20000'),
      ROTH: usd('6500'),
      HSA: null,
    },
    annualIncome: usd('150000'),
    nonSavingsSpending: usd('60000'),
    essentialSpending: usd('36000'),
  };
}

function fakeInputs(state: { revision: number }): ProjectionInputsReader & { calls: number } {
  const reader = {
    calls: 0,
    async derivedInputs() {
      reader.calls += 1;
      return derived(state.revision);
    },
  };
  return reader;
}

function countingDeterministic(): {
  calls: number;
  engine: (
    plan: ProjectionPlan,
    assumptions: AssumptionsLike,
  ) => ReturnType<typeof projectDeterministic>;
} {
  const counter = {
    calls: 0,
    engine: (plan: ProjectionPlan, assumptions: AssumptionsLike) => {
      counter.calls += 1;
      return projectDeterministic(plan, assumptions);
    },
  };
  return counter;
}

/** A Monte Carlo stand-in: bands around the real deterministic path, every seed recorded. */
function fakeMonteCarlo(engineVersion = 'fake.montecarlo/1'): {
  readonly seeds: bigint[];
  readonly runner: MonteCarloRunner;
} {
  const seeds: bigint[] = [];
  return {
    seeds,
    runner: {
      engineVersion,
      async run(request) {
        seeds.push(request.seed);
        const path = projectDeterministic(request.plan, request.assumptions);
        const band = (money: Money, factor: string) =>
          Money.multiplyByDecimal(money, factor, 'half-even');
        return {
          engineVersion,
          seed: request.seed,
          paths: request.paths,
          successProbability: path.success ? '0.873400' : '0.412500',
          periods: path.years.map((year) => ({
            index: year.index,
            age: year.age,
            calendarYear: year.calendarYear,
            p5: band(year.endWealth, '0.5'),
            p10: band(year.endWealth, '0.6'),
            p25: band(year.endWealth, '0.8'),
            p50: year.endWealth,
            p75: band(year.endWealth, '1.2'),
            p90: band(year.endWealth, '1.4'),
            p95: band(year.endWealth, '1.5'),
          })),
        };
      },
    },
  };
}

async function count(database: TestDatabase, query: ReturnType<typeof sql>): Promise<number> {
  const result = await database.db.execute<{ n: string }>(query);
  return Number(result.rows[0]?.n ?? 0);
}

describe.skipIf(NO_DATABASE)('projection_runs and projection_percentiles (0022)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp46_projection_store');
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
      'goal_contributions',
      'cash_earmarks',
      'goals',
      'net_worth_daily',
      'domain_events',
    ]);
  });

  function project(
    dependencies: ProjectionServiceDependencies,
    request: Omit<Parameters<typeof runProjection>[2], 'userId' | 'correlationId'>,
  ) {
    return database.db.transaction((tx) =>
      runProjection(tx as unknown as PlanningExecutor, dependencies, {
        userId: database.userId,
        correlationId: CORRELATION_ID,
        ...request,
      }),
    );
  }

  async function baseline() {
    return database.db.transaction((tx) =>
      saveBaseline(tx as unknown as PlanningExecutor, {
        userId: database.userId,
        name: 'My plan',
        profile: PROFILE,
        clock: CLOCK,
      }),
    );
  }

  it('an identical request is served from projection_runs and does not re-run the engine', async () => {
    const plan = await baseline();
    const engine = countingDeterministic();
    const inputs = fakeInputs({ revision: 1 });
    const dependencies: ProjectionServiceDependencies = {
      inputs,
      monteCarlo: null,
      clock: CLOCK,
      timeZone: ZONE,
      deterministic: engine.engine,
    };

    const first = await project(dependencies, { scenarioId: plan.id, method: 'deterministic' });
    const second = await project(dependencies, { scenarioId: plan.id, method: 'deterministic' });

    expect(first.status).toBe('computed');
    expect(second.status).toBe('cached');
    // The engine ran once; the second answer is the first row, not a recomputation.
    expect(engine.calls).toBe(1);
    expect(second.run?.id).toBe(first.run?.id);
    expect(second.run?.cacheKey).toBe(first.run?.cacheKey);
    expect(second.percentiles).toEqual(first.percentiles);
    expect(await count(database, sql`SELECT count(*)::text AS n FROM projection_runs`)).toBe(1);
    // Announced once: a cache hit is not a new projection (the WP 3.2 lesson).
    expect(
      await count(
        database,
        sql`SELECT count(*)::text AS n FROM domain_events
             WHERE event_type = 'planning.ProjectionCompleted'`,
      ),
    ).toBe(1);

    // A deterministic run stores its median and no pretend spread.
    const bands = await database.db.execute<{ spread: string; years: string }>(sql`
      SELECT count(*) FILTER (WHERE p5_minor IS NOT NULL)::text AS spread, count(*)::text AS years
        FROM projection_percentiles
    `);
    expect(bands.rows[0]).toEqual({ spread: '0', years: String(95 - 40) });

    // Monte Carlo through the port: the same property, the runner called once.
    const mc = fakeMonteCarlo();
    const withRunner = { ...dependencies, monteCarlo: mc.runner };
    const mcFirst = await project(withRunner, {
      scenarioId: plan.id,
      method: 'monte_carlo',
      paths: 10_000,
    });
    const mcSecond = await project(withRunner, {
      scenarioId: plan.id,
      method: 'monte_carlo',
      paths: 10_000,
    });
    expect([mcFirst.status, mcSecond.status]).toEqual(['computed', 'cached']);
    expect(mc.seeds).toEqual([plan.seed]);
    expect(mcSecond.run?.id).toBe(mcFirst.run?.id);
  });

  it('each cache-key input changed alone misses, and restoring it serves the original run', async () => {
    const plan = await baseline();
    const state = { revision: 1 };
    const inputs = fakeInputs(state);
    const v1 = fakeMonteCarlo('fake.montecarlo/1');
    const v2 = fakeMonteCarlo('fake.montecarlo/2');
    const base: ProjectionServiceDependencies = {
      inputs,
      monteCarlo: v1.runner,
      clock: CLOCK,
      timeZone: ZONE,
    };
    const request = { scenarioId: plan.id, method: 'monte_carlo' as const, paths: 5_000 };
    const rows: { change: string; status: string; runId: string | undefined }[] = [];
    const record = async (change: string, dependencies = base, extra = {}) => {
      const outcome = await project(dependencies, { ...request, ...extra });
      rows.push({ change, status: outcome.status, runId: outcome.run?.id });
      return outcome;
    };

    const original = await record('first request');
    await record('identical request');

    // seed — the baseline's stored seed is the one input a holder cannot edit
    // through the service, so the test moves it directly.
    await database.db.execute(sql`
      UPDATE plan_scenarios SET seed = seed + 1 WHERE id = ${plan.id}::uuid
    `);
    await record('seed + 1');
    await database.db.execute(sql`
      UPDATE plan_scenarios SET seed = seed - 1 WHERE id = ${plan.id}::uuid
    `);
    await record('seed restored');

    // engine version
    await record('engine version fake.montecarlo/2', { ...base, monteCarlo: v2.runner });

    // assumptions: an override changes the resolved set but not the file's version
    await database.db.transaction((tx) =>
      saveOverrides(tx as unknown as PlanningExecutor, {
        userId: database.userId,
        desired: { [US_EQUITY]: '0.055' },
        clock: CLOCK,
        correlationId: CORRELATION_ID,
      }),
    );
    await record('assumptions: usEquity override 0.055');
    await database.db.transaction((tx) =>
      saveOverrides(tx as unknown as PlanningExecutor, {
        userId: database.userId,
        desired: {},
        clock: CLOCK,
        correlationId: CORRELATION_ID,
      }),
    );
    await record('assumptions: override cleared');

    // input: the balances' revision, a life event, the path count
    state.revision = 2;
    await record('input: balances revision 2');
    state.revision = 1;
    await record('input: balances revision restored');
    await record('input: paths 5000 → 6000', base, { paths: 6_000 });
    await database.db.transaction((tx) =>
      createLifeEvent(tx as unknown as PlanningExecutor, {
        userId: database.userId,
        event: {
          kind: 'inheritance',
          name: 'Inheritance',
          occursOn: '2031-06-01',
          amount: usd('80000'),
        },
        clock: CLOCK,
      }),
    );
    await record('input: life event added');

    // Printed for the evidence (§2): the hit/miss table.
    console.log(JSON.stringify(rows, null, 1));

    const statusOf = (change: string) => rows.find((row) => row.change === change);
    expect(original.status).toBe('computed');
    expect(statusOf('identical request')?.status).toBe('cached');
    for (const change of [
      'seed + 1',
      'engine version fake.montecarlo/2',
      'assumptions: usEquity override 0.055',
      'input: balances revision 2',
      'input: paths 5000 → 6000',
      'input: life event added',
    ]) {
      expect(statusOf(change)?.status, change).toBe('computed');
      expect(statusOf(change)?.runId, change).not.toBe(original.run?.id);
    }
    for (const change of [
      'seed restored',
      'assumptions: override cleared',
      'input: balances revision restored',
    ]) {
      expect(statusOf(change)?.status, change).toBe('cached');
      expect(statusOf(change)?.runId, change).toBe(original.run?.id);
    }
    // Every seed the runner saw was the baseline's, bar the one deliberate move.
    expect(v1.seeds).toEqual([
      plan.seed,
      plan.seed + 1n,
      plan.seed,
      plan.seed,
      plan.seed,
      plan.seed,
    ]);
  });

  it('a run records its seed, engine version and assumptions version, and a missing one refuses the insert', async () => {
    const plan = await baseline();
    const outcome = await project(
      { inputs: fakeInputs({ revision: 1 }), monteCarlo: null, clock: CLOCK, timeZone: ZONE },
      { scenarioId: plan.id, method: 'deterministic' },
    );
    const stored = await database.db.execute<Record<string, string>>(sql`
      SELECT seed::text AS seed, engine_version, assumptions_version, input_digest, cache_key,
             paths::text AS paths, method, balances_sealed::text AS sealed,
             success_probability::text AS success
        FROM projection_runs
    `);
    expect(stored.rows).toEqual([
      {
        seed: plan.seed.toString(),
        engine_version: ENGINE_VERSION,
        assumptions_version: assumptionsVersion(),
        input_digest: outcome.run?.inputDigest,
        cache_key: outcome.run?.cacheKey,
        paths: '1',
        method: 'deterministic',
        sealed: 'true',
        success: outcome.run?.successProbability,
      },
    ]);
    expect(stored.rows[0]?.['input_digest']).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The database refuses a run missing any one of them — NOT NULL, by column.
    const columns = {
      seed: sql`'42'::numeric`,
      engine_version: sql`'personalfi.deterministic/1'`,
      assumptions_version: sql`${assumptionsVersion()}`,
      input_digest: sql`${`sha256:${'b'.repeat(64)}`}`,
    };
    for (const missing of Object.keys(columns) as (keyof typeof columns)[]) {
      const present = Object.entries(columns).filter(([name]) => name !== missing);
      const failure = await pgFailureOf(
        database.db.execute(sql`
          INSERT INTO projection_runs (
            id, user_id, scenario_id, scenario_kind, method, cache_key, input, paths, as_of_date,
            balances_sealed, currency, success_probability, duration_ms,
            ${sql.raw(present.map(([name]) => name).join(', '))}
          ) VALUES (
            gen_random_uuid(), ${database.userId}::uuid, ${plan.id}::uuid, 'baseline',
            'deterministic', ${`sha256:${'c'.repeat(64)}`}, '{}'::jsonb, 1, '2026-09-25', true,
            'USD', 1, 0, ${sql.join(
              present.map(([, value]) => value),
              sql`, `,
            )}
          )
        `),
      );
      expect(failure.code, missing).toBe('23502');
      expect(failure.message, missing).toContain(missing);
    }
    // …and a present-but-empty one, by constraint name.
    const blank = await pgFailureOf(
      database.db.execute(sql`
        INSERT INTO projection_runs (
          id, user_id, scenario_id, scenario_kind, method, cache_key, seed, engine_version,
          assumptions_version, input_digest, input, paths, as_of_date, balances_sealed, currency,
          success_probability, duration_ms
        ) VALUES (
          gen_random_uuid(), ${database.userId}::uuid, ${plan.id}::uuid, 'baseline',
          'deterministic', ${`sha256:${'d'.repeat(64)}`}, 42, '  ', 'v1',
          ${`sha256:${'e'.repeat(64)}`}, '{}'::jsonb, 1, '2026-09-25', true, 'USD', 1, 0
        )
      `),
    );
    expect(blank.code).toBe('23514');
    expect([
      'projection_runs_engine_version_is_named',
      'projection_runs_assumptions_version_is_a_content_hash',
    ]).toContain(blank.constraint);

    // The store refuses it one layer earlier, naming the field in words.
    const refusal = await database.db
      .transaction((tx) =>
        insertRun(tx as unknown as PlanningExecutor, {
          ...(outcome.run as NonNullable<typeof outcome.run>),
          id: '01920000-0000-7000-8000-0000000000f9',
          userId: database.userId,
          cacheKey: `sha256:${'f'.repeat(64)}`,
          seed: undefined as unknown as bigint,
          percentiles: [],
        }),
      )
      .catch((error: unknown) => error);
    expect(isProjectionRefused(refusal)).toBe(true);
    expect((refusal as ProjectionRefused).code).toBe('planning.projection_run_incomplete');
    expect((refusal as ProjectionRefused).message).toMatch(/seed/);

    // A stored run never changes (D20): the numbers are refused by trigger…
    const rewrite = await pgFailureOf(
      database.db.execute(sql`UPDATE projection_runs SET success_probability = 0`),
    );
    expect(rewrite.constraint).toBe('projection_runs_are_immutable');
    const band = await pgFailureOf(
      database.db.execute(sql`UPDATE projection_percentiles SET p50_minor = 0`),
    );
    expect(band.constraint).toBe('projection_percentiles_are_immutable');
  });

  it('a redelivered ProjectionCompleted claims the goal evaluation once and appends GoalOffTrack once', async () => {
    const plan = await baseline();
    const goalsContext = {
      userId: database.userId,
      clock: CLOCK,
      timeZone: ZONE,
      correlationId: CORRELATION_ID,
    };
    await database.db.transaction(async (tx) => {
      const executor = tx as unknown as PlanningExecutor;
      const goal = await createGoal(
        executor,
        { accounts: { accounts: async () => [] } },
        goalsContext,
        {
          kind: 'emergency_fund',
          name: 'Emergency fund',
          target: usd('20000'),
          targetDate: '2027-09-30',
        },
      );
      await addContribution(executor, goalsContext, goal.id, {
        cadence: 'monthly',
        amount: usd('500'),
        startsOn: '2026-01-01',
        source: 'USER',
      });
    });
    await project(
      { inputs: fakeInputs({ revision: 1 }), monteCarlo: null, clock: CLOCK, timeZone: ZONE },
      { scenarioId: plan.id, method: 'deterministic' },
    );

    const raw = await database.db.execute<Record<string, unknown>>(sql`
      SELECT seq, id, user_id, aggregate_type, aggregate_id, event_type, event_version, payload,
             occurred_at, recorded_at, correlation_id, causation_id, redaction
        FROM domain_events WHERE event_type = 'planning.ProjectionCompleted'
    `);
    const row = raw.rows[0] as Record<string, unknown>;
    const envelope = {
      seq: BigInt(String(row['seq'])),
      id: row['id'],
      userId: row['user_id'],
      aggregateType: row['aggregate_type'],
      aggregateId: row['aggregate_id'],
      eventType: row['event_type'],
      eventVersion: Number(row['event_version']),
      payload: row['payload'],
      occurredAt: new Date(String(row['occurred_at'])),
      recordedAt: new Date(String(row['recorded_at'])),
      correlationId: row['correlation_id'],
      causationId: row['causation_id'],
      redaction: row['redaction'],
    } as EventEnvelope;

    const consumer = createGoalPaceConsumer({
      storeFor: (context) =>
        goalEvaluationStoreOf(context.tx as unknown as PlanningExecutor, context.clock),
      outboxFor: (context) => context.tx,
    });
    const offTrack = () =>
      count(
        database,
        sql`SELECT count(*)::text AS n FROM domain_events WHERE event_type = 'planning.GoalOffTrack'`,
      );
    const deliver = () =>
      database.db.transaction(async (tx) => {
        await consumer.handler(envelope, {
          tx: platformOf(tx as unknown as PlanningExecutor),
          logger: silentLogger,
          clock: CLOCK,
        });
      });

    const before = await offTrack();
    await deliver();
    const afterFirst = await offTrack();
    await deliver();
    const afterRedelivery = await offTrack();
    console.log(JSON.stringify({ before, afterFirst, afterRedelivery }));

    expect([before, afterFirst, afterRedelivery]).toEqual([0, 1, 1]);
    const stamped = await database.db.execute<{ stamped: boolean }>(sql`
      SELECT goals_evaluated_at IS NOT NULL AS stamped FROM projection_runs
    `);
    expect(stamped.rows).toEqual([{ stamped: true }]);
    // The stamp is one-way: moving it again is refused by the same trigger.
    const restamp = await pgFailureOf(
      database.db.execute(sql`UPDATE projection_runs SET goals_evaluated_at = now()`),
    );
    expect(restamp.constraint).toBe('projection_runs_are_immutable');
  });

  it('a projection dated to a sealed day reproduces byte-identically after a re-sync changes today', async () => {
    const brokerage = 'a1946000-0000-7000-8000-0000000000b1';
    const k401 = 'a1946000-0000-7000-8000-0000000000b2';
    const entry = (accountId: string, minor: string): BreakdownEntry => ({
      accountId,
      currency: 'USD',
      nativeMinor: minor,
      baseMinor: minor,
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
    });
    const day = (asOfDate: string, taxable: string, deferred: string): NetWorthSnapshot => {
      const total = BigInt(taxable) + BigInt(deferred);
      return {
        asOfDate,
        baseCurrency: 'USD',
        assetsMinor: total,
        liabilitiesMinor: 0n,
        netWorthMinor: total,
        liquidMinor: 0n,
        investableMinor: total,
        onBudgetMinor: 0n,
        breakdown: [entry(brokerage, taxable), entry(k401, deferred)],
        source: 'observed',
        stalePrice: false,
        accountsCounted: 2,
        accountsUnvalued: 0,
        unvalued: [],
      };
    };
    await database.db.transaction(async (tx) => {
      const executor = tx as unknown as PlanningExecutor;
      await upsertOpenDay(executor, {
        userId: database.userId,
        snapshot: day('2026-09-24', '10000000', '25000000'),
        clock: CLOCK,
      });
      await sealDay(executor, { userId: database.userId, asOfDate: '2026-09-24', clock: CLOCK });
      await upsertOpenDay(executor, {
        userId: database.userId,
        snapshot: day('2026-09-25', '10100000', '25100000'),
        clock: CLOCK,
      });
    });
    const plan = await database.db.transaction((tx) =>
      saveBaseline(tx as unknown as PlanningExecutor, {
        userId: database.userId,
        name: 'My plan',
        profile: {
          ...PROFILE,
          annualSpending: usd('60000'),
          withdrawalPolicy: 'constant_real',
          spendingFloor: 'none',
        },
        clock: CLOCK,
      }),
    );
    const revealed = revealedPorts(
      [
        account(brokerage, 'Brokerage', 'investment'),
        account(k401, '401(k)', 'investment', '401k'),
      ],
      [],
    );
    const run = () =>
      database.db.transaction((tx) => {
        const executor = tx as unknown as PlanningExecutor;
        return runProjection(
          executor,
          {
            inputs: createProjectionInputsReader(executor, revealed),
            monteCarlo: null,
            clock: CLOCK,
            timeZone: ZONE,
          },
          {
            userId: database.userId,
            scenarioId: plan.id,
            method: 'deterministic',
            correlationId: CORRELATION_ID,
          },
        );
      });
    const dump = async () => {
      const rows = await database.db.execute<Record<string, unknown>>(sql`
        SELECT r.id, r.seed::text AS seed, r.input_digest, r.cache_key, r.input::text AS input,
               r.as_of_date::text AS as_of, r.balances_sealed,
               (SELECT string_agg(p.period_index || ':' || p.p50_minor, ',' ORDER BY p.period_index)
                  FROM projection_percentiles p WHERE p.run_id = r.id) AS bands
          FROM projection_runs r ORDER BY r.created_at, r.id
      `);
      return JSON.stringify(rows.rows);
    };

    const first = await run();
    const before = await dump();
    expect(first.status).toBe('computed');
    expect(first.run?.asOfDate).toBe('2026-09-24');
    expect(first.run?.balancesSealed).toBe(true);
    // The sealed day's buckets, not today's: $100,000 taxable, $250,000 tax-deferred.
    const input = first.run?.input as {
      plan: { buckets: { bucket: string; startingBalance: unknown }[] };
    };
    expect(input.plan.buckets.map((bucket) => [bucket.bucket, bucket.startingBalance])).toEqual([
      ['TAXABLE', { minor: '10000000', currency: 'USD' }],
      ['TAX_DEFERRED', { minor: '25000000', currency: 'USD' }],
    ]);

    // A re-sync moves today (the open day) — twice.
    await database.db.transaction(async (tx) => {
      await upsertOpenDay(tx as unknown as PlanningExecutor, {
        userId: database.userId,
        snapshot: day('2026-09-25', '9000000', '30000000'),
        clock: CLOCK,
      });
    });
    const second = await run();
    expect(second.status).toBe('cached');
    expect(second.run?.id).toBe(first.run?.id);
    expect(await dump()).toBe(before);

    // The open day is usable only when asked for, and the run says so.
    const refused = await database.db
      .transaction((tx) => {
        const executor = tx as unknown as PlanningExecutor;
        return runProjection(
          executor,
          {
            inputs: createProjectionInputsReader(executor, revealed),
            monteCarlo: null,
            clock: CLOCK,
            timeZone: ZONE,
          },
          {
            userId: database.userId,
            scenarioId: plan.id,
            method: 'deterministic',
            asOf: DateOnly.parse('2026-09-25'),
            correlationId: CORRELATION_ID,
          },
        );
      })
      .catch((error: unknown) => error);
    expect((refused as ProjectionRefused).code).toBe('planning.projection_balances_unsealed');
  });
  it('a stored negative life event is applied and no longer listed as unapplied', async () => {
    // WP 5.5 (wp4.6 §11 item 1, on wp4.5 §10 item 10's design): an outflow in the plan's range is a
    // dated one-off, drawn in its year; before WP 5.5 it was stored, named `outflow_not_modelled`,
    // and left out of the number.
    const plan = await baseline();
    const engine = countingDeterministic();
    const dependencies: ProjectionServiceDependencies = {
      inputs: fakeInputs({ revision: 1 }),
      monteCarlo: null,
      clock: CLOCK,
      timeZone: ZONE,
      deterministic: engine.engine,
    };
    const without = await project(dependencies, { scenarioId: plan.id, method: 'deterministic' });
    const addEvent = (event: { kind: string; name: string; occursOn: string; amount: Money }) =>
      database.db.transaction((tx) =>
        createLifeEvent(tx as unknown as PlanningExecutor, {
          userId: database.userId,
          event,
          clock: CLOCK,
        }),
      );
    const house = await addEvent({
      kind: 'home_purchase',
      name: 'Home purchase',
      occursOn: '2029-04-01',
      amount: usd('-60000'),
    });
    // Already happened: its effect is in the sealed balances, so it stays set aside, named.
    const past = await addEvent({
      kind: 'college',
      name: 'Last term',
      occursOn: '2026-01-15',
      amount: usd('-8000'),
    });
    const withIt = await project(dependencies, { scenarioId: plan.id, method: 'deterministic' });
    expect(withIt.status).toBe('computed');
    expect(withIt.run?.id).not.toBe(without.run?.id);

    const input = withIt.run?.input as {
      lifeEvents: { applied: unknown[]; unapplied: unknown[] };
      plan: { oneOffs?: unknown[] };
    };
    console.log(JSON.stringify({ lifeEvents: input.lifeEvents, oneOffs: input.plan.oneOffs }));
    // Applied, at the holder's age on its date (born 1986-03-15: 43 on 2029-04-01)…
    expect(input.lifeEvents.applied).toEqual([{ id: house.id, age: '43' }]);
    // …and no longer listed as unapplied; only the dated-before-the-plan one is.
    expect(input.lifeEvents.unapplied).toEqual([{ id: past.id, reason: 'before_as_of' }]);
    expect(JSON.stringify(input.lifeEvents)).not.toContain('outflow_not_modelled');
    expect(input.plan.oneOffs).toEqual([
      {
        name: `life_event:${house.id}`,
        occursOn: '2029-04-01',
        amount: { minor: '-6000000', currency: 'USD' },
      },
    ]);

    // The engine drew it: every year before 2029 is the same, and from 2029 on the plan holds less.
    const before = without.percentiles;
    const after = withIt.percentiles;
    expect(after).toHaveLength(before.length);
    for (const [index, year] of after.entries()) {
      const was = before[index];
      if (was === undefined || year.p50 === null || was.p50 === null) throw new Error('no band');
      if (year.calendarYear < 2029) expect(year.p50, String(year.calendarYear)).toEqual(was.p50);
      else expect(Money.compare(year.p50, was.p50), String(year.calendarYear)).toBeLessThan(0);
    }
    // In the 2029 year-end, by more than the $60,000 itself (it was drawn at mid-year and would have
    // grown half a year) and by less than it plus a whole year's growth at any plausible rate.
    const at2029 = (rows: typeof after) => rows.find((row) => row.calendarYear === 2029)?.p50;
    const gap = Money.subtract(at2029(before) ?? usd('0'), at2029(after) ?? usd('0'));
    expect(gap.minor).toBeGreaterThan(6_000_000n);
    expect(gap.minor).toBeLessThan(6_300_000n);
  });

  it('a crypto holding reaches the Monte Carlo as its own sleeve', async () => {
    // WP 5.5 (wp4.6 §11 item 4): the bucket split in `derivedFromDay` and the port field. Real
    // `net_worth_daily` rows through the real reader; a Monte Carlo runner that records what it is
    // asked and answers through WP 4.5's own kernel, in-process.
    const brokerage = 'a1946000-0000-7000-8000-0000000000c1';
    const exchange = 'a1946000-0000-7000-8000-0000000000c2';
    const entry = (accountId: string, minor: string): BreakdownEntry => ({
      accountId,
      currency: 'USD',
      nativeMinor: minor,
      baseMinor: minor,
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
    });
    await database.db.transaction(async (tx) => {
      const executor = tx as unknown as PlanningExecutor;
      await upsertOpenDay(executor, {
        userId: database.userId,
        snapshot: {
          asOfDate: '2026-09-24',
          baseCurrency: 'USD',
          assetsMinor: 12_000_000n,
          liabilitiesMinor: 0n,
          netWorthMinor: 12_000_000n,
          liquidMinor: 0n,
          investableMinor: 12_000_000n,
          onBudgetMinor: 0n,
          breakdown: [entry(brokerage, '10000000'), entry(exchange, '2000000')],
          source: 'observed',
          stalePrice: false,
          accountsCounted: 2,
          accountsUnvalued: 0,
          unvalued: [],
        },
        clock: CLOCK,
      });
      await sealDay(executor, { userId: database.userId, asOfDate: '2026-09-24', clock: CLOCK });
    });
    const plan = await database.db.transaction((tx) =>
      saveBaseline(tx as unknown as PlanningExecutor, {
        userId: database.userId,
        name: 'My plan',
        profile: { ...PROFILE, annualSpending: usd('60000'), spendingFloor: 'none' },
        clock: CLOCK,
      }),
    );
    // Ledger's `crypto` account type reaches Planning as `investment` (so `TAXABLE`); the
    // composition root marks it `sleeve: 'crypto'`, and that is what splits it out.
    const revealed = revealedPorts(
      [
        account(brokerage, 'Brokerage', 'investment'),
        { ...account(exchange, 'Exchange', 'investment'), sleeve: 'crypto' },
      ],
      [],
    );
    const asked: MonteCarloRequest[] = [];
    const engineVersion = 'kernel.inprocess/1';
    const runner: MonteCarloRunner = {
      engineVersion,
      async run(request) {
        asked.push(request);
        const job = toMonteCarloJob({
          plan: request.plan,
          assumptions: request.assumptions,
          seed: request.seed,
          paths: request.paths,
          engine: 'lognormal',
          cryptoHolding: request.cryptoHolding ?? null,
        });
        const result = runMonteCarlo(job);
        const mark = fakeMonteCarlo(engineVersion).runner;
        return {
          ...(await mark.run(request)),
          successProbability: (result.successCount / result.paths).toFixed(6),
        };
      },
    };
    const outcome = await database.db.transaction((tx) => {
      const executor = tx as unknown as PlanningExecutor;
      return runProjection(
        executor,
        {
          inputs: createProjectionInputsReader(executor, revealed),
          monteCarlo: runner,
          clock: CLOCK,
          timeZone: ZONE,
        },
        {
          userId: database.userId,
          scenarioId: plan.id,
          method: 'monte_carlo',
          paths: 500,
          correlationId: CORRELATION_ID,
        },
      );
    });
    expect(outcome.status).toBe('computed');
    const [request] = asked;
    if (request === undefined) throw new Error('the runner was never asked');
    // The sleeve, through the port: $20,000 of crypto, and TAXABLE without it.
    expect(request.cryptoHolding).toEqual(usd('20000'));
    expect(request.plan.buckets.map((bucket) => [bucket.bucket, bucket.startingBalance])).toEqual([
      ['TAXABLE', usd('100000')],
    ]);
    // …and through WP 4.5's own conversion into its own sleeve: a crypto draw, never a bucket.
    const job = toMonteCarloJob({
      ...request,
      engine: 'lognormal',
      cryptoHolding: request.cryptoHolding ?? null,
    });
    expect(job.crypto.holding).toBe(20_000);
    expect(job.plan.wealth0[TAXABLE]).toBe(100_000);
    const result = runMonteCarlo(job);
    expect(result.withoutCrypto).not.toBeNull();
    // The stored input says what each engine did with it, so the digest describes the run.
    const input = outcome.run?.input as { crypto?: unknown };
    expect(input.crypto).toEqual({
      holding: { minor: '2000000', currency: 'USD' },
      monteCarlo: 'own_sleeve',
      deterministic: 'valued_at_zero',
    });
    console.log(
      JSON.stringify({
        cryptoHolding: request.cryptoHolding?.minor.toString(),
        taxable: request.plan.buckets[0]?.startingBalance.minor.toString(),
        jobCrypto: job.crypto,
        withCryptoSuccess: result.successCount,
        withoutCryptoSuccess: result.withoutCrypto?.successCount,
      }),
    );
  });
});
