// SPDX-License-Identifier: MIT
/**
 * WP 4.4 — solve-for-required-savings (09 GOAL-7's dotted gap line).
 *
 * The number it returns must close the gap when run back through the engine,
 * and when nothing the household can do closes it, it must say *which*
 * constraint binds — never return a number that implies a solution.
 */
import { describe, expect, it } from 'vitest';
import { DateOnly, Money } from '@core/kernel';
import { loadAssumptions } from '../assumptions.ts';
import { ProjectionInputRefused, type ProjectionPlan } from './boundary.ts';
import { projectDeterministic } from './project.ts';
import { MAX_ITERATIONS, solveRequiredSavings, type RequiredSavingsRequest } from './solve.ts';
import { BASE, referencePlan, usd } from '../../test/engine/support.ts';

const assumptions = loadAssumptions();

const toMillionBy2056: RequiredSavingsRequest = {
  objective: {
    kind: 'wealth_at',
    targetDate: DateOnly.parse('2056-01-01'),
    target: usd('1000000'),
    basis: 'real',
  },
  maxMonthly: usd('10000'),
};

/** The plan with `monthly` added to its TAXABLE contribution (the solver's own lever, by hand). */
function withMonthly(plan: ProjectionPlan, monthly: Money): ProjectionPlan {
  return {
    ...plan,
    buckets: plan.buckets.map((bucket) =>
      bucket.bucket === 'TAXABLE'
        ? {
            ...bucket,
            annualContribution: Money.add(
              bucket.annualContribution,
              Money.multiplyByInteger(monthly, 12n),
            ),
          }
        : bucket,
    ),
  };
}

describe('the gap line', () => {
  it('returns the smallest monthly amount that, run back through the engine, closes the gap', () => {
    const plan = referencePlan('C');
    const solved = solveRequiredSavings(plan, assumptions, toMillionBy2056);
    if (solved.kind !== 'required') throw new Error(`expected required, got ${solved.kind}`);
    expect(solved.verified).toBe(true);
    expect(solved.monthly).toEqual(usd('1471.97')); // the PMT reference, to the cent
    expect(solved.iterations).toBeLessThanOrEqual(MAX_ITERATIONS);

    // Independently: add it as an ordinary contribution and project.
    const at = (monthly: Money) =>
      projectDeterministic(withMonthly(plan, monthly), assumptions).years[29]?.endWealth.minor ??
      0n;
    expect(at(solved.monthly)).toBeGreaterThanOrEqual(100_000_000n);
    // One cent a month less does not.
    expect(at(Money.subtract(solved.monthly, Money.of(1n, 'USD')))).toBeLessThan(100_000_000n);
  });

  it('a nominal target is deflated before it is compared, never compared as if real', () => {
    const plan = referencePlan('C');
    const real = solveRequiredSavings(plan, assumptions, toMillionBy2056);
    const nominal = solveRequiredSavings(plan, assumptions, {
      ...toMillionBy2056,
      objective: {
        ...toMillionBy2056.objective,
        basis: 'nominal',
      } as RequiredSavingsRequest['objective'],
    });
    if (real.kind !== 'required' || nominal.kind !== 'required') throw new Error('unsolved');
    // $1M in 2056 dollars is ~$477k today at 2.5%: far less saving needed.
    expect(nominal.monthly.minor).toBeLessThan(real.monthly.minor / 2n);
  });

  it('says already_met, with zero, when the plan already reaches the target', () => {
    const solved = solveRequiredSavings(referencePlan('A'), assumptions, {
      ...toMillionBy2056,
      objective: {
        ...toMillionBy2056.objective,
        target: usd('500000'),
      } as RequiredSavingsRequest['objective'],
    });
    expect(solved).toEqual({ kind: 'already_met', monthly: usd('0') });
  });
});

describe('unreachable', () => {
  it('a gap no contribution can close returns unreachable and names the binding constraint', () => {
    // 1. Already retired and overspending: there is no window in which saving can help.
    const retired: ProjectionPlan = {
      ...BASE,
      retirementAge: 35,
      planEndAge: 95,
      buckets: [
        { bucket: 'TAXABLE', startingBalance: usd('300000'), annualContribution: usd('0') },
      ],
      contributionGrowth: 'flat',
      glidepath: { kind: 'static', equityShare: '0.6' },
      annualSpending: usd('60000'),
    };
    const noWindow = solveRequiredSavings(retired, assumptions, {
      objective: { kind: 'sustain_to_plan_end' },
      maxMonthly: usd('1000000'),
    });
    expect(noWindow.kind).toBe('unreachable');
    if (noWindow.kind !== 'unreachable') return;
    expect(noWindow.constraint.name).toBe('no_contribution_window');
    expect(noWindow.constraint.detail).toMatch(
      /only spending, the retirement age or the target date/,
    );
    expect(noWindow).not.toHaveProperty('monthly');

    // 2. A window exists but the ceiling is too low: the gap AT the ceiling is named.
    const ceiling = solveRequiredSavings(referencePlan('C'), assumptions, {
      ...toMillionBy2056,
      maxMonthly: usd('500'),
    });
    expect(ceiling.kind).toBe('unreachable');
    if (ceiling.kind !== 'unreachable' || ceiling.constraint.name !== 'monthly_ceiling') {
      throw new Error(`expected monthly_ceiling, got ${JSON.stringify(ceiling.kind)}`);
    }
    expect(ceiling.constraint.ceiling).toEqual(usd('500'));
    expect(ceiling.constraint.gapAtCeiling.minor).toBeGreaterThan(0n);
    // …and that gap is real: $500/month really does fall short by about that much.
    const atCeiling = projectDeterministic(withMonthly(referencePlan('C'), usd('500')), assumptions)
      .years[29]?.endWealth;
    const residual =
      100_000_000n - (atCeiling?.minor ?? 0n) - ceiling.constraint.gapAtCeiling.minor;
    expect(residual >= -1n && residual <= 1n).toBe(true);

    // 3. A target date inside the current year: no whole year left to save in.
    const tooSoon = solveRequiredSavings(referencePlan('C'), assumptions, {
      ...toMillionBy2056,
      objective: {
        ...toMillionBy2056.objective,
        targetDate: DateOnly.parse('2026-06-30'),
      } as RequiredSavingsRequest['objective'],
    });
    expect(tooSoon.kind === 'unreachable' && tooSoon.constraint.name).toBe(
      'no_contribution_window',
    );
  });

  it('a target date beyond the plan is a refused input, not an unreachable gap', () => {
    expect(() =>
      solveRequiredSavings(referencePlan('C'), assumptions, {
        ...toMillionBy2056,
        objective: {
          ...toMillionBy2056.objective,
          targetDate: DateOnly.parse('2099-01-01'),
        } as RequiredSavingsRequest['objective'],
      }),
    ).toThrow(ProjectionInputRefused);
  });
});
