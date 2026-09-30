// SPDX-License-Identifier: MIT
/**
 * WP 5.5 — the earliest-retirement solver (05 §3 WP 5.5's three exit tests).
 *
 * Every claim is checked against the engine's own Money-facing projection
 * (`projectDeterministic`), run independently of the solver: the solver's age
 * is only right if a plain projection retiring at that age succeeds and one
 * retiring a year earlier does not.
 *
 * The plan in the first test takes its Social Security from an **earnings
 * record**, on purpose: the boundary derives the benefit from the retirement
 * age (future covered earnings stop at retirement), so the search's cheap
 * retargeting — which moves only `retireAge` — overstates the benefit of an
 * early retirement. The retargeted search alone answers two years too early;
 * the re-verification through `toEnginePlan` is what makes the answer right,
 * and the test pins both halves so removing the re-verification goes red.
 */
import { readFileSync } from 'node:fs';
import { DateOnly } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { loadAssumptions } from '../assumptions.ts';
import { toEnginePlan, type ProjectionPlan } from './boundary.ts';
import { preparePlan } from './deterministic.ts';
import { projectDeterministic } from './project.ts';
import {
  MONTHS_OF_SPENDING_DERIVATION,
  NO_ACTION,
  earliestAgeFor,
  earliestRetirementAge,
  solveRetirementImpact,
  type RetirementImpact,
} from './retirement-date.ts';
import { FIXTURES, referencePlan, usd } from '../../test/engine/support.ts';

const assumptions = loadAssumptions();
const ssa = JSON.parse(readFileSync(`${FIXTURES}/ssa-2026-examples.json`, 'utf8')) as {
  readonly averageWageIndex: readonly { readonly year: number; readonly index: string }[];
};

/** Age 40 on 2026-01-01, planning to retire at 67; Social Security from an earnings record. */
function earner(spending: string): ProjectionPlan {
  return {
    currency: 'USD',
    asOf: DateOnly.parse('2026-01-01'),
    birthDate: DateOnly.parse('1986-01-01'),
    retirementAge: 67,
    planEndAge: 95,
    withdrawalPolicy: { kind: 'constant_real' },
    taxDeferredRate: '0.15',
    pensions: [],
    otherIncome: [],
    buckets: [
      { bucket: 'TAXABLE', startingBalance: usd('150000'), annualContribution: usd('15000') },
    ],
    contributionGrowth: 'flat',
    glidepath: { kind: 'static', equityShare: '0.6' },
    annualSpending: usd(spending),
    socialSecurity: {
      kind: 'earnings',
      history: Array.from({ length: 10 }, (_, i) => ({ year: 2016 + i, earnings: usd('50000') })),
      averageWageIndex: ssa.averageWageIndex,
      futureAnnualEarnings: usd('150000'),
      claimAge: { years: 67, months: 0 },
      stressAfter2034: false,
    },
  };
}

function sustainsRetiringAt(plan: ProjectionPlan, age: number): boolean {
  return projectDeterministic({ ...plan, retirementAge: age }, assumptions).success;
}

/** Every `number` anywhere in a result: the solver's output may hold no fraction at all. */
function numbersIn(value: unknown, path = '$'): { path: string; n: number }[] {
  if (typeof value === 'number') return [{ path, n: value }];
  if (Array.isArray(value))
    return value.flatMap((item, i) => numbersIn(item, `${path}[${String(i)}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => numbersIn(item, `${path}.${key}`));
  }
  return [];
}

function jsonOf(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'bigint' ? inner.toString() : inner,
  );
}

describe('WP 5.5 — the earliest retirement age', () => {
  it('the earliest retirement age is the first whole year the plan sustains, and the year before it does not', () => {
    const plan = earner('50000');
    const impact = solveRetirementImpact(plan, assumptions, {
      kind: 'extra_annual',
      annual: usd('1000'),
    });
    console.error('PROBE earner', jsonOf(impact));

    for (const [label, answer] of [
      ['baseline', impact.baseline],
      ['with the action', impact.withAction],
    ] as const) {
      if (answer.kind !== 'earliest')
        throw new Error(`${label}: expected an age, got ${jsonOf(answer)}`);
      expect(answer.verified).toBe(true);
      expect(Number.isInteger(answer.age), label).toBe(true);
    }
    if (impact.baseline.kind !== 'earliest') throw new Error('unreachable');
    const age = impact.baseline.age;
    // The claim, checked by the plain projection and nothing of the solver's.
    expect(sustainsRetiringAt(plan, age), `retiring at ${String(age)} sustains`).toBe(true);
    expect(sustainsRetiringAt(plan, age - 1), `retiring at ${String(age - 1)} does not`).toBe(
      false,
    );
    // …and it is the first in range: nothing earlier sustains either (the monotone claim, by brute force).
    for (let earlier = 40; earlier < age; earlier += 1) {
      expect(sustainsRetiringAt(plan, earlier), `retiring at ${String(earlier)}`).toBe(false);
    }

    // The retargeted search alone, without the rebuild through the boundary, answers earlier —
    // and that age does not sustain once Social Security is re-derived for it. This is what the
    // re-verification is for; removing it returns this wrong age (the sabotage in the evidence).
    const retargetedOnly = earliestAgeFor(preparePlan(toEnginePlan(plan, assumptions)), NO_ACTION);
    if (retargetedOnly.kind !== 'earliest') throw new Error('expected an age');
    expect(retargetedOnly.age).toBeLessThan(age);
    expect(sustainsRetiringAt(plan, retargetedOnly.age)).toBe(false);

    // The search itself is a bisection: every probe sits inside its bracket, and there are at most
    // ⌈log₂(range)⌉ + 2 of them (the two ends, then the halvings).
    const reference = referencePlan('B'); // Social Security from a statement: nothing to re-derive
    const run = earliestRetirementAge(preparePlan(toEnginePlan(reference, assumptions)), NO_ACTION);
    if (run.baseline.kind !== 'earliest') throw new Error('reference B: expected an age');
    console.error('PROBE referenceB', jsonOf(run.baseline));
    const range = 80 - 35;
    expect(run.baseline.probes.length).toBeLessThanOrEqual(Math.ceil(Math.log2(range)) + 2);
    for (const step of run.baseline.probes) {
      expect(step.age).toBeGreaterThanOrEqual(step.lo);
      expect(step.age).toBeLessThanOrEqual(step.hi);
    }
    expect(sustainsRetiringAt(reference, run.baseline.age)).toBe(true);
    expect(sustainsRetiringAt(reference, run.baseline.age - 1)).toBe(false);
  });

  it('an action too small to move a whole year reports no change and never an interpolated fraction', () => {
    const plan = earner('60000');
    const small = solveRetirementImpact(plan, assumptions, {
      kind: 'extra_annual',
      annual: usd('100'),
    });
    console.error('PROBE small', jsonOf(small));
    expect(small.baseline.kind).toBe('earliest');
    expect(small.withAction.kind).toBe('earliest');
    if (small.baseline.kind !== 'earliest' || small.withAction.kind !== 'earliest') return;
    expect(small.withAction.age).toBe(small.baseline.age);
    expect(small.yearsEarlier).toBe(0);
    // No fraction of a year, anywhere: every number in the answer is whole (ages, the year delta,
    // whole months, run counts). Money is bigint minor units and is not a number here.
    for (const { path, n } of numbersIn(small)) {
      expect(Number.isInteger(n), `${path} = ${String(n)}`).toBe(true);
    }
    // What the action *is* worth is stated as months of spending — a derivation, not a date.
    expect(small.monthsOfSpending.months).not.toBeNull();
    expect(Object.keys(small)).toEqual([
      'engineVersion',
      'assumptionsVersion',
      'plannedRetirementAge',
      'baseline',
      'withAction',
      'yearsEarlier',
      'monthsOfSpending',
    ]);

    // A large enough action does move whole years — and still only whole years.
    const large = solveRetirementImpact(plan, assumptions, {
      kind: 'one_off',
      lump: usd('150000'),
    });
    console.error('PROBE large', jsonOf(large));
    expect(large.yearsEarlier).not.toBeNull();
    expect(large.yearsEarlier ?? 0).toBeGreaterThanOrEqual(1);
    for (const { path, n } of numbersIn(large)) {
      expect(Number.isInteger(n), `${path} = ${String(n)}`).toBe(true);
    }
    if (large.withAction.kind !== 'earliest') throw new Error('expected an age');
    const withLump: ProjectionPlan = {
      ...plan,
      oneOffs: [{ name: 'lump', occursOn: plan.asOf, amount: usd('150000') }],
    };
    expect(sustainsRetiringAt(withLump, large.withAction.age)).toBe(true);
    expect(sustainsRetiringAt(withLump, large.withAction.age - 1)).toBe(false);
  });

  it("months of spending is the engine's own wealth difference over planned spending, declared as a derivation", () => {
    const plan = earner('60000');
    const planned = plan.retirementAge; // 67
    const lastWorkingYear = planned - 40 - 1;
    const endOf = (projected: ReturnType<typeof projectDeterministic>) => {
      const year = projected.years[lastWorkingYear];
      if (year === undefined || year.age !== planned - 1) throw new Error('wrong year');
      return year.endWealth;
    };
    const without = projectDeterministic(plan, assumptions);
    const firstRetired = without.years[lastWorkingYear + 1];
    if (firstRetired?.phase !== 'retirement') throw new Error('expected the first retired year');

    const check = (impact: RetirementImpact, withIt: ReturnType<typeof projectDeterministic>) => {
      const months = impact.monthsOfSpending;
      if (months.months === null) throw new Error(`expected months, got ${jsonOf(months)}`);
      const difference = endOf(withIt).minor - endOf(without).minor;
      // Two plain projections, both retiring as planned; the solver's figures must be theirs.
      expect(months.atAge).toBe(planned);
      expect(months.wealthDifference.minor).toBe(difference);
      expect(months.firstYearSpending).toEqual(firstRetired.spending);
      expect(months.firstYearSpending).toEqual(usd('60000'));
      // ⌊12 × difference ÷ spending⌋, in exact minor units — checkable from the two figures shown.
      expect(BigInt(months.months)).toBe((12n * difference) / firstRetired.spending.minor);
      expect(months.derivation).toBe(MONTHS_OF_SPENDING_DERIVATION);
      expect(months.derivation).toContain('not a change to the retirement date');
      return months.months;
    };

    // A one-off this year: the plain plan carries it as a dated one-off on today's date.
    const lump = solveRetirementImpact(plan, assumptions, { kind: 'one_off', lump: usd('25000') });
    const withLump = projectDeterministic(
      { ...plan, oneOffs: [{ name: 'lump', occursOn: plan.asOf, amount: usd('25000') }] },
      assumptions,
    );
    const lumpMonths = check(lump, withLump);

    // An extra $1,000 a year into TAXABLE, stopping at retirement: on this flat-contribution plan,
    // exactly the plan with TAXABLE's own contribution raised by $1,000.
    const annual = solveRetirementImpact(plan, assumptions, {
      kind: 'extra_annual',
      annual: usd('1000'),
    });
    const withAnnual = projectDeterministic(
      {
        ...plan,
        buckets: [
          { bucket: 'TAXABLE', startingBalance: usd('150000'), annualContribution: usd('16000') },
        ],
      },
      assumptions,
    );
    const annualMonths = check(annual, withAnnual);
    console.error('PROBE months', {
      lumpMonths,
      annualMonths,
      lump: jsonOf(lump.monthsOfSpending),
    });

    // A plan already in retirement has no planned date to measure at, and says so.
    const retired = solveRetirementImpact({ ...plan, retirementAge: 40 }, assumptions, {
      kind: 'one_off',
      lump: usd('25000'),
    });
    expect(retired.monthsOfSpending).toEqual({ months: null, reason: 'retirement_started' });
    expect(retired.baseline).toMatchObject({
      kind: 'unreachable',
      constraint: { name: 'retirement_started', retiredAtAge: 40 },
    });
  });
});
