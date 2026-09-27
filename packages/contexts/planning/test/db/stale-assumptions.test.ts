// SPDX-License-Identifier: MIT
/**
 * WP 4.6 — a run whose `assumptions_version` no longer resolves is shown
 * **stale with its version named**, and is never silently recomputed against
 * today's defaults (the dispatch's §3 rule; the §5 risk row "an assumption
 * changes silently").
 *
 * Own scratch database (`personalfi_wp46_stale_assumptions`), per
 * docs/TESTING.md.
 *
 * "Retired" is modelled exactly as it happens in production: a build that
 * shipped assumptions file X is replaced by a build whose registry holds only
 * file Y. Here X is the checked-in file with one cited number changed (so it
 * hashes differently, as a real edit would), and the two builds are two
 * `AssumptionsRegistry` values handed to the same service.
 */
import { DateOnly, Money, fixedClock, type Clock } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ASSUMPTIONS_FILE } from '../../data/assumptions.ts';
import {
  currentRegistry,
  loadAssumptions,
  parseAssumptions,
  saveOverrides,
  type AssumptionsRegistry,
} from '../../src/assumptions.ts';
import type { AssumptionsLike, ProjectionPlan } from '../../src/engine/boundary.ts';
import { projectDeterministic } from '../../src/engine/project.ts';
import {
  readProjection,
  refreshBaseline,
  runProjection,
  type DerivedInputs,
  type ProjectionServiceDependencies,
} from '../../src/projection-service.ts';
import { saveBaseline, type BaselineProfile } from '../../src/scenarios.ts';
import type { PlanningExecutor } from '../../src/store.ts';
import { CORRELATION_ID, NO_DATABASE } from './harness.ts';

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
  annualSpending: usd('60000'),
  withdrawalPolicy: 'constant_real',
  spendingFloor: 'none',
  taxDeferredRate: '0.15',
  socialSecurity: null,
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
      ROTH: usd('0'),
      HSA: usd('0'),
    },
  },
  contributions: { TAXABLE: usd('12000'), TAX_DEFERRED: usd('20000'), ROTH: null, HSA: null },
  annualIncome: usd('150000'),
  nonSavingsSpending: usd('58000'),
  essentialSpending: usd('36000'),
};

/** Last year's build: the same file with one cited number changed. */
function retiredFile() {
  const copy = structuredClone(ASSUMPTIONS_FILE) as unknown as {
    capitalMarket: { inflation: { mean: { value: string } } };
  };
  copy.capitalMarket.inflation.mean.value = '0.03';
  return parseAssumptions(copy);
}

describe.skipIf(NO_DATABASE)('stale assumptions (0021 × 0022)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp46_stale_assumptions');
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

  it('a run against a retired assumptions version reads back as stale and is never silently recomputed', async () => {
    const retired = retiredFile();
    const current = loadAssumptions();
    expect(retired.version).not.toBe(current.version);
    const lastYearsBuild: AssumptionsRegistry = new Map([
      [retired.version, retired],
      [current.version, current],
    ]);
    const thisYearsBuild = currentRegistry();
    expect(thisYearsBuild.has(retired.version)).toBe(false);

    let engineCalls = 0;
    const dependencies = (registry: AssumptionsRegistry): ProjectionServiceDependencies => ({
      inputs: { derivedInputs: async () => DERIVED },
      monteCarlo: null,
      clock: CLOCK,
      timeZone: ZONE,
      registry,
      deterministic: (plan: ProjectionPlan, assumptions: AssumptionsLike) => {
        engineCalls += 1;
        return projectDeterministic(plan, assumptions);
      },
    });
    const tx = <T>(work: (executor: PlanningExecutor) => Promise<T>) =>
      database.db.transaction((handle) => work(handle as unknown as PlanningExecutor));

    // Last year: the holder overrode one assumption against file X, and saved a run.
    const plan = await tx((executor) =>
      saveBaseline(executor, {
        userId: database.userId,
        name: 'My plan',
        profile: PROFILE,
        clock: CLOCK,
      }),
    );
    await tx((executor) =>
      saveOverrides(
        executor,
        {
          userId: database.userId,
          desired: { [US_EQUITY]: '0.06' },
          clock: CLOCK,
          correlationId: CORRELATION_ID,
        },
        retired,
      ),
    );
    const saved = await tx((executor) =>
      runProjection(executor, dependencies(lastYearsBuild), {
        userId: database.userId,
        scenarioId: plan.id,
        method: 'deterministic',
        correlationId: CORRELATION_ID,
      }),
    );
    expect(saved.status).toBe('computed');
    expect(saved.run?.assumptionsVersion).toBe(retired.version);
    expect(saved.run?.assumptionsOverrides).toEqual({ [US_EQUITY]: '0.06' });
    expect(engineCalls).toBe(1);
    const freshRead = await tx((executor) =>
      readProjection(executor, {
        userId: database.userId,
        runId: saved.run?.id ?? '',
        timeZone: ZONE,
        registry: lastYearsBuild,
      }),
    );
    expect(freshRead.staleness).toBeNull();
    const dump = async () =>
      JSON.stringify(
        (
          await database.db.execute(sql`
            SELECT r.*, r.seed::text AS seed_text,
                   (SELECT json_agg(p ORDER BY p.period_index) FROM projection_percentiles p
                     WHERE p.run_id = r.id) AS bands
              FROM projection_runs r ORDER BY r.created_at
          `)
        ).rows,
        (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
      );
    const before = await dump();

    // This year's build no longer holds file X.
    // 1. Re-opening the saved run: the stored bytes, labelled stale, version named.
    const reopened = await tx((executor) =>
      readProjection(executor, {
        userId: database.userId,
        runId: saved.run?.id ?? '',
        timeZone: ZONE,
        registry: thisYearsBuild,
      }),
    );
    expect(reopened.staleness).toEqual({
      reason: 'assumptions_version_retired',
      assumptionsVersion: retired.version,
      known: [current.version],
    });
    expect(reopened.run).toEqual(saved.run);
    expect(reopened.percentiles).toEqual(saved.percentiles);

    // 2. Opening the scenario (which would normally recompute it) and the nightly
    //    refresh: both answer stale with the old run, and neither computes.
    const opened = await tx((executor) =>
      runProjection(executor, dependencies(thisYearsBuild), {
        userId: database.userId,
        scenarioId: plan.id,
        method: 'deterministic',
        correlationId: CORRELATION_ID,
      }),
    );
    const nightly = await tx((executor) =>
      refreshBaseline(executor, dependencies(thisYearsBuild), {
        userId: database.userId,
        correlationId: CORRELATION_ID,
      }),
    );
    for (const outcome of [opened, nightly]) {
      if (outcome.status !== 'stale') throw new Error(`expected stale, got ${outcome.status}`);
      expect(outcome.staleness).toEqual({
        reason: 'assumptions_version_retired',
        assumptionsVersion: retired.version,
        known: [current.version],
      });
      expect(outcome.run?.id).toBe(saved.run?.id);
    }

    // Never silently recomputed: no engine call, no new row, no new event, and
    // the stored run is byte-identical.
    expect(engineCalls).toBe(1);
    const counts = await database.db.execute<{ runs: string; completed: string }>(sql`
      SELECT (SELECT count(*) FROM projection_runs)::text AS runs,
             (SELECT count(*) FROM domain_events
               WHERE event_type = 'planning.ProjectionCompleted')::text AS completed
    `);
    expect(counts.rows).toEqual([{ runs: '1', completed: '1' }]);
    expect(await dump()).toBe(before);
    console.log(
      JSON.stringify({
        runId: saved.run?.id,
        storedVersion: saved.run?.assumptionsVersion,
        buildHolds: [...thisYearsBuild.keys()],
        reopened: reopened.staleness,
        opened: opened.status,
        nightly: nightly.status,
        engineCalls,
      }),
    );
  });
});
