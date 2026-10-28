// SPDX-License-Identifier: MIT
/**
 * The tornado (`leverSensitivity`'s pure core, `sensitivityOver`, WP 11.5b;
 * 07 §5.10) and the exact probability arithmetic the catalogue's plan
 * functions report.
 *
 * A fake Monte Carlo runner stands in for WP 4.5's worker: it answers with a
 * success probability that is a plain function of the plan it was handed, and
 * records the seed and path count of every run — so the tests can see common
 * random numbers (one seed for every run), the one-run-per-step bound, the
 * ranking, and what the deadline does, without a worker thread. One test runs
 * the real deterministic engine end to end.
 */
import { Money, fixedClock, mutableClock, type DateOnly } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { loadAssumptions, type ResolvedAssumptions } from '../src/assumptions.ts';
import {
  LEVER_SENSITIVITY_DEADLINE_MS,
  canonicalProbability,
  probabilityDelta,
  sensitivityOver,
  type SensitivityBase,
} from '../src/catalogue-projections.ts';
import type { ProjectionPlan } from '../src/engine/boundary.ts';
import type { MonteCarloRunner } from '../src/ports.ts';
import type { DerivedInputs } from '../src/projection-service.ts';
import type { BaselineScenario } from '../src/scenarios.ts';

const USD = 'USD';
const usd = (minor: bigint) => Money.of(minor, USD);

function baseline(overrides: Partial<BaselineScenario['profile']> = {}): BaselineScenario {
  return {
    kind: 'baseline',
    id: '01900000-0000-7000-8000-0000000000b1',
    name: 'Baseline',
    seed: 424242n,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    profile: {
      birthDate: '1986-01-15' as DateOnly,
      retirementAge: 65,
      planEndAge: 95,
      currency: USD,
      glidepath: { kind: 'age_based' },
      contributionGrowth: 'flat',
      annualSpending: usd(6_000_000n),
      withdrawalPolicy: 'constant_real',
      spendingFloor: 'none',
      taxDeferredRate: '0.15',
      socialSecurity: {
        monthlyPia: usd(250_000n),
        claimAge: { years: 67, months: 0 },
        stressAfter2034: false,
      },
      pensions: [],
      contributions: null,
      ...overrides,
    },
  };
}

function derived(annualIncome: Money | null = usd(12_000_000n)): DerivedInputs {
  return {
    currency: USD,
    balances: {
      asOfDate: '2026-10-27' as DateOnly,
      revision: 1,
      sealed: true,
      byBucket: {
        TAXABLE: usd(10_000_000n),
        TAX_DEFERRED: usd(30_000_000n),
        ROTH: usd(5_000_000n),
        HSA: usd(0n),
      },
    },
    contributions: { TAXABLE: usd(500_000n), TAX_DEFERRED: usd(2_000_000n), ROTH: null, HSA: null },
    annualIncome,
    nonSavingsSpending: usd(7_000_000n),
    essentialSpending: null,
  };
}

const RESOLVED: ResolvedAssumptions = (() => {
  const assumptions = loadAssumptions();
  return { version: assumptions.version, file: assumptions.file, overrides: [] };
})();

/**
 * A runner whose answer depends only on the plan: a later retirement, more
 * income, lower spending, more saving each move it a known amount. Records
 * every request. `tick` advances a mutable clock by that much per run.
 */
function fakeRunner(tick?: { clock: ReturnType<typeof mutableClock>; ms: number }) {
  const runs: { seed: bigint; paths: number }[] = [];
  const runner: MonteCarloRunner = {
    engineVersion: 'fake-mc/1',
    async run(request) {
      runs.push({ seed: request.seed, paths: request.paths });
      if (tick !== undefined) tick.clock.advanceMs(tick.ms);
      const plan: ProjectionPlan = request.plan;
      let micros = 600_000;
      micros += (plan.retirementAge - 65) * 70_000;
      micros += Number((6_000_000n - plan.annualSpending.minor) / 10_000n) * 200;
      const contributed = plan.buckets.reduce(
        (sum, bucket) => sum + bucket.annualContribution.minor,
        0n,
      );
      micros += Number((contributed - 2_500_000n) / 10_000n) * 150;
      micros += plan.otherIncome.length * 10_000;
      if (plan.returnShift !== undefined && plan.returnShift !== '0') micros -= 90_000;
      if (plan.socialSecurity !== null && plan.socialSecurity.claimAge.years > 67) micros += 30_000;
      micros = Math.max(0, Math.min(1_000_000, micros));
      const band = usd(1_000_000n);
      return {
        engineVersion: 'fake-mc/1',
        seed: request.seed,
        paths: request.paths,
        successProbability: `0.${String(micros).padStart(6, '0')}`.replace(/^0\.1000000$/u, '1'),
        periods: [
          {
            index: 0,
            age: 41,
            calendarYear: 2027,
            p5: band,
            p10: band,
            p25: band,
            p50: band,
            p75: band,
            p90: band,
            p95: band,
          },
        ],
      };
    },
  };
  return { runner, runs };
}

function base(
  options: { readonly income?: Money | null; readonly social?: boolean } = {},
): SensitivityBase {
  return {
    userId: '01900000-0000-7000-8000-000000000001',
    baseline: baseline(options.social === false ? { socialSecurity: null } : {}),
    derived: derived(options.income === undefined ? usd(12_000_000n) : options.income),
    lifeEvents: [],
    resolved: RESOLVED,
    method: 'monte_carlo',
    paths: 10_000,
    engineVersion: 'fake-mc/1',
    correlationId: 'test',
  };
}

describe('exact probabilities', () => {
  it('renders every form as six places and subtracts exactly', () => {
    expect(canonicalProbability('1')).toBe('1.000000');
    expect(canonicalProbability('0.713')).toBe('0.713000');
    expect(probabilityDelta('0.713000', '0.783000')).toBe('0.070000');
    expect(probabilityDelta('0.8', '0.7')).toBe('-0.100000');
    expect(probabilityDelta('0.1', '0.3')).toBe('0.200000'); // 0.3 − 0.1 is 0.19999… in floats
  });
});

describe('the tornado', () => {
  it('runs the base and one run per lever step, every one on the baseline’s seed and the same paths', async () => {
    const { runner, runs } = fakeRunner();
    const result = await sensitivityOver(base(), {
      monteCarlo: runner,
      clock: fixedClock('2026-10-28T15:00:00Z'),
    });
    expect(runs).toHaveLength(8); // base + seven levers; glidepath is not a magnitude
    expect(new Set(runs.map((run) => run.seed))).toEqual(new Set([424242n]));
    expect(new Set(runs.map((run) => run.paths))).toEqual(new Set([10_000]));
    expect(result.seed).toBe(424242n);
    expect(result.base.successProbability).toBe('0.600000');
    expect(result.levers.find((lever) => lever.lever === 'glidepath')).toMatchObject({
      status: 'skipped',
      reason: 'not_a_magnitude',
    });
  });

  it('ranks by the size of the move, largest first, the skipped after', async () => {
    const { runner } = fakeRunner();
    const result = await sensitivityOver(base(), {
      monteCarlo: runner,
      clock: fixedClock('2026-10-28T15:00:00Z'),
    });
    const computed = result.levers.filter((lever) => lever.status === 'computed');
    expect(
      computed.map((lever) => [lever.lever, lever.status === 'computed' ? lever.delta : null]),
    ).toEqual([
      ['expected_return_shift', '-0.090000'],
      ['retire_age', '0.070000'],
      ['ss_claim_age', '0.030000'],
      ['annual_spending', '0.012000'], // $6,000 less a year: 600,000 minor ÷ 10,000 × 200 micros
      ['part_time_income', '0.010000'],
      ['one_time_windfall', '0.010000'], // a tie keeps 07 §5.10's order
      ['savings_rate', '0.003600'], // 2% of $120,000 = $2,400 more saved: 24 × 150 micros
    ]);
    expect(result.levers.at(-1)?.lever).toBe('glidepath');
  });

  it('skips a lever the plan cannot move, and says why', async () => {
    const { runner } = fakeRunner();
    const result = await sensitivityOver(base({ income: null, social: false }), {
      monteCarlo: runner,
      clock: fixedClock('2026-10-28T15:00:00Z'),
    });
    const skipped = Object.fromEntries(
      result.levers
        .filter((lever) => lever.status === 'skipped')
        .map((lever) => [lever.lever, lever]),
    );
    expect(skipped['savings_rate']).toMatchObject({ reason: 'not_applicable' });
    expect(skipped['ss_claim_age']).toMatchObject({ reason: 'not_applicable' });
  });

  it('stops at the deadline: the levers not reached are reported skipped with reason deadline', async () => {
    const clock = mutableClock('2026-10-28T15:00:00Z');
    const { runner, runs } = fakeRunner({ clock, ms: 6_000 });
    const result = await sensitivityOver(
      base(),
      { monteCarlo: runner, clock },
      { deadlineMs: 20_000 },
    );
    // base ends at 6 s; levers start at 6, 12, 18 s; the fourth would start at 24 s ≥ 20 s.
    expect(runs).toHaveLength(4);
    expect(result.deadlineMs).toBe(20_000);
    const deadline = result.levers.filter(
      (lever) => lever.status === 'skipped' && lever.reason === 'deadline',
    );
    expect(deadline.map((lever) => lever.lever)).toEqual([
      'expected_return_shift',
      'ss_claim_age',
      'part_time_income',
      'one_time_windfall',
    ]);
    expect(result.levers.filter((lever) => lever.status === 'computed')).toHaveLength(3);
    expect(LEVER_SENSITIVITY_DEADLINE_MS).toBe(20_000);
  });

  it('is deterministic: the same base gives the same tornado', async () => {
    const run = async () =>
      sensitivityOver(base(), {
        monteCarlo: fakeRunner().runner,
        clock: fixedClock('2026-10-28T15:00:00Z'),
      });
    expect(await run()).toEqual(await run());
  });

  it('runs on the real deterministic engine when no Monte Carlo is bound', async () => {
    const result = await sensitivityOver(
      { ...base(), method: 'deterministic', paths: 1, engineVersion: 'deterministic' },
      { monteCarlo: null, clock: fixedClock('2026-10-28T15:00:00Z') },
    );
    expect(result.method).toBe('deterministic');
    expect(['0.000000', '1.000000']).toContain(result.base.successProbability);
    for (const lever of result.levers) {
      if (lever.status === 'computed')
        expect(['-1.000000', '0.000000', '1.000000']).toContain(lever.delta);
    }
  });
});
