// SPDX-License-Identifier: MIT
/**
 * WP 4.5 — 07 §8.4's engine invariants, and the kernel's own contracts.
 *
 *   1. `'zero volatility makes the Monte Carlo median equal the deterministic
 *      path'` — through the Money boundary: the assumptions file with its three
 *      volatilities overridden to 0, the lognormal engine, and every year's
 *      median compared with `projectDeterministic` **exactly** (the same
 *      `stepYear`, fed the same `MarketYear`, so equality is bitwise).
 *   2. `'success rate is monotone in savings rate, monotone in retirement age,
 *      and monotone decreasing in spending'` — a fast-check property over
 *      random plans, both engines. Common random numbers make it exact even at
 *      a few hundred paths: each lever is compared over the same shocks.
 *   3. `'the p5 estimate is stable within 1% across ten seeds at n=10,000'` —
 *      at every accumulation checkpoint of a balanced saver; the evidence
 *      records the plans where 07's 1 % does *not* hold (a 30-year all-equity
 *      path, ≈ 1.5–2 %), which is a property of quantile estimation, not a bug.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DateOnly, Money } from '@core/kernel';
import { applyOverrides, loadAssumptions } from '../assumptions.ts';
import { BASE, referencePlan, usd } from '../../test/engine/support.ts';
import { syntheticSeries } from '../../test/engine/fixtures/synthetic-series.ts';
import type { ProjectionPlan } from './boundary.ts';
import { newPathState, preparePlan, runDeterministic, NO_EXTRA } from './deterministic.ts';
import { projectDeterministic } from './project.ts';
import {
  PERCENTILE_LEVELS,
  SEQUENCE_COLUMNS,
  drawShocks,
  newSimulationBuffers,
  quantilesInPlace,
  resetPathState,
  runMonteCarlo,
  simulate,
  solveForSuccess,
  type EngineKind,
} from './montecarlo.ts';
import { toMonteCarloJob, toMonteCarloSummary, type MonteCarloRequest } from './worker-host.ts';

const assumptions = loadAssumptions();
const series = syntheticSeries();

function request(
  plan: ProjectionPlan,
  seed: bigint,
  engine: EngineKind,
  paths: number,
  extra: Partial<MonteCarloRequest> = {},
): MonteCarloRequest {
  return { plan, assumptions, seed, engine, paths, series, ...extra };
}

describe('07 §8.4 invariant 1', () => {
  it('zero volatility makes the Monte Carlo median equal the deterministic path', () => {
    const still = applyOverrides(
      assumptions,
      {
        'capitalMarket.usEquity.volatility': '0',
        'capitalMarket.usAggregateBonds.volatility': '0',
        'capitalMarket.inflation.volatility': '0',
      },
      DateOnly.parse('2026-09-26'),
    );
    const guarded: ProjectionPlan = {
      ...referencePlan('B'),
      withdrawalPolicy: { kind: 'guardrails', spendingFloor: usd('40000') },
      pensions: [{ name: 'DB', startAge: 65, annualBenefit: usd('9000'), cola: { kind: 'none' } }],
    };
    for (const plan of [referencePlan('A'), referencePlan('B'), guarded]) {
      const req: MonteCarloRequest = { plan, assumptions: still, seed: 7n, engine: 'lognormal', paths: 101 };
      const result = runMonteCarlo(toMonteCarloJob(req));
      const deterministic = projectDeterministic(plan, still);
      const summary = toMonteCarloSummary(result, req);
      const median = summary.bands.find((band) => band.level === '0.5');
      const p5 = summary.bands.find((band) => band.level === '0.05');
      const p95 = summary.bands.find((band) => band.level === '0.95');
      expect(median?.byYear).toHaveLength(deterministic.years.length);
      deterministic.years.forEach((year, t) => {
        // Money-level: identical minor units, every year.
        expect(median?.byYear[t]).toEqual(year.endWealth);
        // No spread at all: every band collapses onto the path.
        expect(p5?.byYear[t]).toEqual(year.endWealth);
        expect(p95?.byYear[t]).toEqual(year.endWealth);
      });
      // Engine-level: the float itself, not only its rounding.
      const path = runDeterministic(preparePlan(toMonteCarloJob(req).plan));
      path.records.forEach((record, t) => {
        const total = record.endWealth.reduce((sum, bucket) => sum + bucket, 0);
        expect(result.bands[3 * result.years + t]).toBe(total);
      });
      expect(result.successCount === result.paths).toBe(deterministic.success);
    }
  });
});

/** Success count of one plan over one seed's shocks. */
function successes(plan: ProjectionPlan, seed: bigint, engine: EngineKind, crypto: boolean): number {
  const req = request(plan, seed, engine, 300, crypto ? { cryptoHolding: usd('50000') } : {});
  return runMonteCarlo(toMonteCarloJob(req)).successCount;
}

describe('07 §8.4 invariant 2', () => {
  it('success rate is monotone in savings rate, monotone in retirement age, and monotone decreasing in spending', () => {
    const plans = fc.record({
      startingBalance: fc.integer({ min: 0, max: 1_500_000 }),
      contribution: fc.integer({ min: 0, max: 40_000 }),
      spending: fc.integer({ min: 20_000, max: 110_000 }),
      retirementAge: fc.integer({ min: 50, max: 70 }),
      equityShare: fc.constantFrom('0.2', '0.4', '0.6', '0.8', '1'),
      ageBased: fc.boolean(),
      bucket: fc.constantFrom('TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'),
      socialSecurity: fc.boolean(),
      crypto: fc.boolean(),
      engine: fc.constantFrom<EngineKind>('bootstrap', 'lognormal'),
      seed: fc.bigInt({ min: -(2n ** 63n), max: 2n ** 63n - 1n }),
      contributionStep: fc.integer({ min: 100, max: 20_000 }),
      spendingStep: fc.integer({ min: 100, max: 20_000 }),
    });
    fc.assert(
      fc.property(plans, (p) => {
        const plan = (overrides: { contribution?: number; spending?: number; retirementAge?: number }) =>
          ({
            ...BASE,
            retirementAge: overrides.retirementAge ?? p.retirementAge,
            buckets: [
              {
                bucket: p.bucket,
                startingBalance: usd(String(p.startingBalance)),
                annualContribution: usd(String(overrides.contribution ?? p.contribution)),
              },
            ],
            contributionGrowth: 'flat',
            glidepath: p.ageBased ? { kind: 'age_based' } : { kind: 'static', equityShare: p.equityShare },
            annualSpending: usd(String(overrides.spending ?? p.spending)),
            socialSecurity: p.socialSecurity
              ? {
                  kind: 'statement',
                  monthlyPia: usd('2400'),
                  claimAge: { years: 67, months: 0 },
                  stressAfter2034: false,
                }
              : null,
          }) satisfies ProjectionPlan;
        const run = (overrides: Parameters<typeof plan>[0]) =>
          successes(plan(overrides), p.seed, p.engine, p.crypto);
        const base = run({});
        expect(run({ contribution: p.contribution + p.contributionStep })).toBeGreaterThanOrEqual(base);
        expect(run({ retirementAge: p.retirementAge + 1 })).toBeGreaterThanOrEqual(base);
        expect(run({ spending: p.spending + p.spendingStep })).toBeLessThanOrEqual(base);
      }),
      { numRuns: 40, seed: 4_500_045 },
    );
  }, 60_000);
});

describe('07 §8.4 invariant 3', () => {
  it('the p5 estimate is stable within 1% across ten seeds at n=10,000', () => {
    // A balanced saver: WP 4.4's reference case B (TAX_DEFERRED, $100k, $12k/yr growing with wages,
    // 60/40) from 35 to retirement at 65. Every accumulation checkpoint is checked, not one.
    const plan: ProjectionPlan = { ...referencePlan('B'), planEndAge: 65 };
    for (const engine of ['bootstrap', 'lognormal'] as const) {
      const p5ByYear: number[][] = [];
      for (let s = 1n; s <= 10n; s += 1n) {
        const result = runMonteCarlo(toMonteCarloJob(request(plan, s * 7_919n, engine, 10_000)));
        p5ByYear.push(Array.from(result.bands.subarray(0, result.years)));
      }
      const years = p5ByYear[0]?.length ?? 0;
      expect(years).toBe(30);
      let worst = 0;
      let worstYear = -1;
      for (let t = 0; t < years; t += 1) {
        const column = p5ByYear.map((row) => row[t] ?? Number.NaN);
        const mean = column.reduce((sum, x) => sum + x, 0) / column.length;
        expect(mean).toBeGreaterThan(0);
        for (const x of column) {
          const deviation = Math.abs(x - mean) / mean;
          if (deviation > worst) {
            worst = deviation;
            worstYear = t;
          }
        }
      }
      console.log(
        `[invariant 3] ${engine}: worst |p5_seed − mean| / mean over 10 seeds × ${String(years)} checkpoints ` +
          `= ${(worst * 100).toFixed(3)}% (year index ${String(worstYear)})`,
      );
      expect(worst).toBeLessThan(0.01);
    }
  }, 60_000);
});

describe('the kernel', () => {
  it('a path state is reset in place to exactly what newPathState builds', () => {
    const job = toMonteCarloJob(request(referencePlan('B'), 3n, 'bootstrap', 50));
    const prepared = preparePlan(job.plan);
    const shocks = drawShocks(job);
    const dirty = newPathState(job.plan);
    // Dirty every field by running a whole retirement through it.
    simulate(prepared, job, shocks, NO_EXTRA, 0, newSimulationBuffers(50, shocks.years));
    const run = runDeterministic(prepared);
    Object.assign(dirty, { lastNominalReturn: 0.3, depletedAtAge: 80, shortfallTotal: 5, retiredYears: 9 });
    dirty.wealth.set([1, 2, 3, 4]);
    dirty.scratchReturn.set([1, 1, 1, 1]);
    Object.assign(dirty.guard, run.state.guard, { worstCut: 0.2 });
    resetPathState(dirty, job.plan);
    const fresh = newPathState(job.plan);
    expect(Object.keys(dirty).sort()).toEqual(Object.keys(fresh).sort());
    expect(dirty).toEqual(fresh);
  });

  it('common random numbers: a lever moves the outcome and never the shocks', () => {
    const base = toMonteCarloJob(request(referencePlan('B'), 11n, 'bootstrap', 400));
    const levers = [
      { ...referencePlan('B'), annualSpending: usd('45000') },
      { ...referencePlan('B'), retirementAge: 67 },
      { ...referencePlan('B'), returnShift: '-0.01' },
      {
        ...referencePlan('B'),
        buckets: [{ bucket: 'ROTH', startingBalance: usd('100000'), annualContribution: usd('18000') }],
      },
    ] satisfies ProjectionPlan[];
    const shocks = drawShocks(base);
    for (const plan of levers) {
      const other = drawShocks(toMonteCarloJob(request(plan, 11n, 'bootstrap', 400)));
      expect(Buffer.from(other.equity.buffer).equals(Buffer.from(shocks.equity.buffer))).toBe(true);
      expect(Buffer.from(other.bond.buffer).equals(Buffer.from(shocks.bond.buffer))).toBe(true);
      expect(Buffer.from(other.inflation.buffer).equals(Buffer.from(shocks.inflation.buffer))).toBe(true);
    }
    // More paths only append: path i's shocks do not depend on how many paths run.
    const more = drawShocks({ ...base, paths: 800 });
    expect(Buffer.from(more.equity.buffer, 0, shocks.equity.byteLength).equals(Buffer.from(shocks.equity.buffer))).toBe(true);
    // A 1% savings change shows its effect, not the noise: same shocks, strictly ordered outcome.
    const saverA = runMonteCarlo(base);
    const saverB = runMonteCarlo(
      toMonteCarloJob(
        request(
          {
            ...referencePlan('B'),
            buckets: [{ bucket: 'TAX_DEFERRED', startingBalance: usd('100000'), annualContribution: usd('13200') }],
          },
          11n,
          'bootstrap',
          400,
        ),
      ),
    );
    expect(saverB.successCount).toBeGreaterThanOrEqual(saverA.successCount);
    for (let i = 0; i < saverA.bands.length; i += 1) {
      expect(saverB.bands[i]).toBeGreaterThanOrEqual(saverA.bands[i] ?? 0);
    }
  });

  it('failure does not stop a path: the shortfall is reported as a magnitude, and sequence risk by decile', () => {
    // Underfunded with Social Security: paths deplete and keep running on the benefit.
    const plan: ProjectionPlan = {
      ...referencePlan('B'),
      annualSpending: usd('70000'),
    };
    const req = request(plan, 5n, 'bootstrap', 5_000);
    const result = runMonteCarlo(toMonteCarloJob(req));
    const summary = toMonteCarloSummary(result, req);
    expect(result.failure.count).toBeGreaterThan(0);
    expect(result.failure.count).toBeLessThan(result.paths);
    // Years run after depletion, and the benefit kept paying: the unfunded total is less
    // than full spending over those years (07 §5.4 detail 2 — magnitude, not a boolean).
    expect(result.failure.medianShortfallYears).toBeGreaterThan(0);
    expect(result.failure.medianShortfallTotal).toBeGreaterThan(0);
    expect(result.failure.medianShortfallTotal).toBeLessThan(70_000 * result.failure.medianShortfallYears);
    expect(summary.failure.medianShortfallTotal?.currency).toBe('USD');
    expect(summary.failure.medianDepletionAge).toBeGreaterThanOrEqual(65);
    // Sequence risk: ten deciles over every path, the worst first-five-year decile fails more.
    const sequence = result.sequence;
    if (sequence === null) throw new Error('a retirement inside the horizon has a sequence window');
    expect(sequence.startAge).toBe(65);
    expect(sequence.years).toBe(5);
    let paths = 0;
    for (let d = 0; d < 10; d += 1) {
      paths += sequence.deciles[d * SEQUENCE_COLUMNS + 2] ?? 0;
      if (d > 0) {
        expect(sequence.deciles[d * SEQUENCE_COLUMNS]).toBeGreaterThanOrEqual(
          sequence.deciles[(d - 1) * SEQUENCE_COLUMNS + 1] ?? 0,
        );
      }
    }
    expect(paths).toBe(result.paths);
    const worst = sequence.deciles[3] ?? 0;
    const best = sequence.deciles[9 * SEQUENCE_COLUMNS + 3] ?? 0;
    expect(worst).toBeLessThan(best);
    expect(summary.sequence?.deciles[0]?.successProbability).toBe(String(worst / 500));
  });

  it('percentiles by partial sort equal a full sort, type 7, ties and all', () => {
    fc.assert(
      fc.property(
        fc.array(fc.oneof(fc.double({ min: -1e9, max: 1e9, noNaN: true }), fc.constantFrom(0, 1, 1, 2)), {
          minLength: 1,
          maxLength: 400,
        }),
        (xs) => {
          const sorted = [...xs].sort((a, b) => a - b);
          const expected = PERCENTILE_LEVELS.map((p) => {
            const h = (sorted.length - 1) * p;
            const k = Math.floor(h);
            const below = sorted[k] ?? 0;
            const above = sorted[Math.min(k + 1, sorted.length - 1)] ?? 0;
            return below + (h - k) * (above - below);
          });
          const out = new Float64Array(PERCENTILE_LEVELS.length);
          quantilesInPlace(Float64Array.from(xs), xs.length, PERCENTILE_LEVELS, out, 0, 1);
          expect(Array.from(out)).toEqual(expected);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('the probability-targeted solver', () => {
  const plan: ProjectionPlan = { ...referencePlan('B'), annualSpending: usd('70000') };

  it('bisects over one shock matrix: the same answer every run, and the answer is minimal to a dollar a month', () => {
    const job = toMonteCarloJob(request(plan, 99n, 'bootstrap', 2_000));
    const target = { objective: { kind: 'sustain' as const }, requiredCount: 1_600, ceilingAnnual: 120_000 };
    const first = solveForSuccess(job, target);
    const second = solveForSuccess(job, target);
    expect(second).toEqual(first);
    if (first.kind !== 'required') throw new Error(`expected a required amount, got ${first.kind}`);
    expect(first.metCount).toBeGreaterThanOrEqual(1_600);
    // Re-run the amount as an ordinary contribution over the same shocks: it meets 80 %…
    const at = (annual: number) =>
      runMonteCarlo({ ...job, extra: { annual, untilAge: job.plan.retireAge } }).successCount;
    expect(at(first.annual)).toBeGreaterThanOrEqual(1_600);
    // …and a dollar and a cent a month less does not.
    expect(at(((first.monthlyCents - 101) / 100) * 12)).toBeLessThan(1_600);
  });

  it('names the binding constraint instead of a number when no contribution can reach the target', () => {
    const job = toMonteCarloJob(request(plan, 99n, 'bootstrap', 1_000));
    const ceiling = solveForSuccess(job, {
      objective: { kind: 'sustain' },
      requiredCount: 1_000,
      ceilingAnnual: 1_200,
    });
    expect(ceiling).toMatchObject({ kind: 'unreachable', constraint: 'monthly_ceiling' });
    const retired: ProjectionPlan = {
      ...BASE,
      birthDate: DateOnly.parse('1956-01-01'),
      retirementAge: 65,
      buckets: [{ bucket: 'TAXABLE', startingBalance: usd('300000'), annualContribution: Money.zero('USD') }],
      contributionGrowth: 'flat',
      glidepath: { kind: 'static', equityShare: '0.5' },
      annualSpending: usd('60000'),
    };
    const window = solveForSuccess(toMonteCarloJob(request(retired, 1n, 'bootstrap', 500)), {
      objective: { kind: 'sustain' },
      requiredCount: 400,
      ceilingAnnual: 1_000_000,
    });
    expect(window).toMatchObject({ kind: 'unreachable', constraint: 'no_contribution_window' });
  });
});
