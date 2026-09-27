// SPDX-License-Identifier: MIT
/**
 * WP 4.6 — `plan_scenarios` (migration 0022): a fork is lever deltas against
 * its baseline and never a copy of it (07 §5.10), and a compare runs both
 * sides under common random numbers (07 §5.4 detail 1) because a fork has no
 * seed of its own.
 *
 * Own scratch database (`personalfi_wp46_scenarios`), per docs/TESTING.md.
 *
 * The compare is proven **before WP 4.5 lands**: the Monte Carlo behind the
 * `MonteCarloRunner` port is a deterministic fake that records the seed it was
 * handed on every call, so "the two runs' seeds shown equal" is a fact about
 * what the service passed, not about what a real engine happened to do with it.
 */
import { DateOnly, Money, fixedClock, type Clock } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { projectDeterministic } from '../../src/engine/project.ts';
import type { MonteCarloRunner } from '../../src/ports.ts';
import {
  compareScenarios,
  runProjection,
  type DerivedInputs,
  type ProjectionServiceDependencies,
} from '../../src/projection-service.ts';
import type { ProjectionRefused } from '../../src/projection-store.ts';
import {
  createScenario,
  saveBaseline,
  type BaselineProfile,
  type ScenarioLevers,
} from '../../src/scenarios.ts';
import type { PlanningExecutor } from '../../src/store.ts';
import { CORRELATION_ID, NO_DATABASE, pgFailureOf } from './harness.ts';

const ZONE = 'America/New_York';
const CLOCK: Clock = fixedClock('2026-09-26T08:30:00Z');

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
  annualSpending: usd('60000'),
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

const DERIVED: DerivedInputs = {
  currency: 'USD',
  balances: {
    asOfDate: DateOnly.parse('2026-09-25'),
    revision: 1,
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
  nonSavingsSpending: usd('58000'),
  essentialSpending: usd('36000'),
};

/**
 * A deterministic Monte Carlo stand-in. Success rises three points per year of
 * later retirement — a shape, not a claim — so the compare has a delta to
 * report; the bands are the real deterministic path spread either side.
 * Every seed it is handed is recorded.
 */
function recordingRunner(): { readonly seeds: bigint[]; readonly runner: MonteCarloRunner } {
  const seeds: bigint[] = [];
  return {
    seeds,
    runner: {
      engineVersion: 'fake.montecarlo/1',
      async run(request) {
        seeds.push(request.seed);
        const path = projectDeterministic(request.plan, request.assumptions);
        const points = 50 + 3 * (request.plan.retirementAge - 60);
        const band = (money: Money, factor: string) => Money.multiplyByDecimal(money, factor);
        return {
          engineVersion: 'fake.montecarlo/1',
          seed: request.seed,
          paths: request.paths,
          successProbability: `0.${String(points).padStart(2, '0')}`,
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

describe.skipIf(NO_DATABASE)('plan_scenarios (0022)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp46_scenarios');
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
      'domain_events',
    ]);
  });

  function tx<T>(work: (executor: PlanningExecutor) => Promise<T>): Promise<T> {
    return database.db.transaction((handle) => work(handle as unknown as PlanningExecutor));
  }

  const baseline = (profile: BaselineProfile = PROFILE) =>
    tx((executor) =>
      saveBaseline(executor, { userId: database.userId, name: 'My plan', profile, clock: CLOCK }),
    );
  const fork = (name: string, levers: ScenarioLevers) =>
    tx((executor) =>
      createScenario(executor, { userId: database.userId, name, levers, clock: CLOCK }),
    );

  it('a scenario stores lever deltas and never a copy of the baseline', async () => {
    const plan = await baseline();
    const later = await fork('Retire at 67 on less', {
      retireAge: 67,
      annualSpending: usd('55000'),
      // These three restate the baseline and must not be stored.
      glidepath: { kind: 'age_based' },
      ssClaimAge: { years: 67, months: 0 },
      expectedReturnShift: '0.000',
    });

    const rows = await database.db.execute<{
      kind: string;
      baseline_id: string | null;
      profile: unknown;
      levers: unknown;
      seed: string | null;
    }>(sql`
      SELECT kind, baseline_id, profile, levers, seed::text AS seed
        FROM plan_scenarios WHERE id = ${later.id}::uuid
    `);
    // Exactly the two levers that differ — no profile, no seed, no restated default.
    expect(rows.rows).toEqual([
      {
        kind: 'fork',
        baseline_id: plan.id,
        profile: null,
        seed: null,
        levers: { retire_age: '67', annual_spending: { minor: '5500000', currency: 'USD' } },
      },
    ]);

    // A fork that changes nothing is a copy, and a copy is never stored.
    const empty = await fork('Same again', {
      retireAge: 65,
      annualSpending: usd('60000'),
      glidepath: { kind: 'age_based' },
    }).catch((error: unknown) => error);
    expect((empty as ProjectionRefused).code).toBe('planning.scenario_levers_empty');

    // A fork of a fork would be a delta against a delta.
    const nested = await tx((executor) =>
      createScenario(executor, {
        userId: database.userId,
        name: 'Nested',
        baselineId: later.id,
        levers: { retireAge: 70 },
        clock: CLOCK,
      }),
    ).catch((error: unknown) => error);
    expect((nested as ProjectionRefused).code).toBe('planning.scenario_fork_of_fork');

    // Below the service, the column cannot hold a copy at all.
    const insertFork = (profile: string | null, levers: string, seed: string | null) =>
      pgFailureOf(
        database.db.execute(sql`
          INSERT INTO plan_scenarios (id, user_id, kind, baseline_id, name, profile, levers, seed)
          VALUES (gen_random_uuid(), ${database.userId}::uuid, 'fork', ${plan.id}::uuid, 'copy',
                  ${profile}::jsonb, ${levers}::jsonb, ${seed}::numeric)
        `),
      );
    const withBuckets = await insertFork(null, '{"retire_age": "66", "buckets": []}', null);
    expect(withBuckets.constraint).toBe('plan_scenarios_levers_are_deltas');
    const withNumber = await insertFork(null, '{"retire_age": 66}', null);
    expect(withNumber.constraint).toBe('plan_scenarios_levers_are_deltas');
    const withProfile = await insertFork(
      '{"birthDate": "1986-03-15"}',
      '{"retire_age": "66"}',
      null,
    );
    expect(withProfile.constraint).toBe('plan_scenarios_shape');
    const withSeed = await insertFork(null, '{"retire_age": "66"}', '7');
    expect(withSeed.constraint).toBe('plan_scenarios_seed_is_the_baselines');

    // Because the fork holds only deltas, restating the baseline reaches it:
    // the fork never set a tax rate, so its next run uses the new one.
    await baseline({ ...PROFILE, taxDeferredRate: '0.22' });
    const outcome = await tx((executor) =>
      runProjection(
        executor,
        {
          inputs: { derivedInputs: async () => DERIVED },
          monteCarlo: null,
          clock: CLOCK,
          timeZone: ZONE,
        },
        {
          userId: database.userId,
          scenarioId: later.id,
          method: 'deterministic',
          correlationId: CORRELATION_ID,
        },
      ),
    );
    const input = outcome.run?.input as {
      plan: { taxDeferredRate: string; retirementAge: string; annualSpending: unknown };
    };
    expect(input.plan.taxDeferredRate).toBe('0.22');
    expect(input.plan.retirementAge).toBe('67');
    expect(input.plan.annualSpending).toEqual({ minor: '5500000', currency: 'USD' });
  });

  it('a scenario compare reports the delta in success probability and in retirement date, computed under common random numbers', async () => {
    const plan = await baseline();
    const later = await fork('Retire at 67', { retireAge: 67 });
    const mc = recordingRunner();
    const dependencies: ProjectionServiceDependencies = {
      inputs: { derivedInputs: async () => DERIVED },
      monteCarlo: mc.runner,
      clock: CLOCK,
      timeZone: ZONE,
    };
    const compare = () =>
      tx((executor) =>
        compareScenarios(executor, dependencies, {
          userId: database.userId,
          scenarioA: plan.id,
          scenarioB: later.id,
          method: 'monte_carlo',
          paths: 10_000,
          correlationId: CORRELATION_ID,
        }),
      );

    const result = await compare();

    // The runner was handed one seed, twice: the baseline's.
    expect(mc.seeds).toEqual([plan.seed, plan.seed]);
    expect(result.seed).toBe(plan.seed);
    expect(result.a.run?.seed).toBe(result.b.run?.seed);
    const stored = await database.db.execute<{ seed: string; scenario_kind: string }>(sql`
      SELECT seed::text AS seed, scenario_kind FROM projection_runs ORDER BY scenario_kind
    `);
    expect(stored.rows).toEqual([
      { seed: plan.seed.toString(), scenario_kind: 'baseline' },
      { seed: plan.seed.toString(), scenario_kind: 'fork' },
    ]);

    // The two deltas the compare screen leads with.
    expect(result.a.run?.successProbability).toBe('0.650000');
    expect(result.b.run?.successProbability).toBe('0.710000');
    expect(result.successProbabilityDelta).toBe('0.06');
    expect(result.retirementDate).toEqual({ a: '2051-03-15', b: '2053-03-15' });
    expect(result.retirementDeltaMonths).toBe(24);

    // Printed for the evidence (§3).
    console.log(
      JSON.stringify({
        seeds: mc.seeds.map(String),
        a: { runId: result.a.run?.id, success: result.a.run?.successProbability },
        b: { runId: result.b.run?.id, success: result.b.run?.successProbability },
        delta: result.successProbabilityDelta,
        retirementDate: result.retirementDate,
        retirementDeltaMonths: result.retirementDeltaMonths,
      }),
    );

    // Server-authoritative (D20): re-opening the compare serves both stored runs.
    const again = await compare();
    expect([again.a.status, again.b.status]).toEqual(['cached', 'cached']);
    expect(mc.seeds).toHaveLength(2);
  });
});
