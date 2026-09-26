// SPDX-License-Identifier: MIT
/**
 * Solve-for-required-savings — 09 GOAL-7's dotted gap line, deterministic.
 *
 * "What additional monthly contribution closes the gap by the target date?"
 * answered by bisection over the deterministic engine, and — the part that
 * matters — **a typed `unreachable` naming the binding constraint** when no
 * contribution the plan allows can close it. The UI draws that constraint
 * instead of a number, because a number would imply a solution exists.
 *
 * ## The two objectives
 *
 *   * `wealth_at` — real wealth at the end of the year the target date falls
 *     in reaches the target (a goal's `target Money` by its `target_date`).
 *     A nominal target is deflated by the plan's inflation first; the
 *     comparison is always in today's dollars.
 *   * `sustain_to_plan_end` — the retirement: no year to `planEndAge` has
 *     unfunded spending.
 *
 * ## The binding constraints
 *
 *   * `no_contribution_window` — there is no year left in which an extra
 *     contribution can be made before the objective is measured (retirement has
 *     started, or the target date is inside the current year). No amount helps;
 *     only a different lever (spending, retirement age, the date) can.
 *   * `monthly_ceiling` — even the caller's `maxMonthly` (what the household can
 *     actually save, WP 4.3's revealed income) leaves a gap, reported in dollars
 *     at the ceiling.
 *
 * ## Why bisection is valid, and why the answer is re-verified
 *
 * Every objective here is monotone in the extra contribution: more money in,
 * earlier, can only raise wealth at a date and can only lower a shortfall (the
 * one non-monotone lever, a guardrail *raise*, only fires when the portfolio is
 * already comfortably ahead). The loop keeps the invariant `met(hi) &&
 * !met(lo)`, halves `[lo, hi]` until it is narrower than a cent a year, and is
 * guarded at `MAX_ITERATIONS` — XIRR's house style (WP 3.3 §5). Then the
 * answer is **rounded to Money and run again through the whole boundary**; if
 * the rounded cent falls short, it is raised by a cent and checked again. The
 * number returned is one the engine has actually seen close the gap.
 */
import type { DateOnly, Money } from '@core/kernel';
import {
  annualFromMonthly,
  monthlyFromAnnual,
  nextMinorUnit,
  planCurrency,
  solverMoney,
  toEngineCeiling,
  toEnginePlan,
  toEngineTarget,
  wholeYearsFrom,
  ProjectionInputRefused,
  type AssumptionsLike,
  type ProjectionPlan,
} from './boundary.ts';
import {
  preparePlan,
  runDeterministic,
  wealthAt,
  type ExtraContribution,
  type PreparedPlan,
} from './deterministic.ts';

/** Bisection stops when the bracket is narrower than this many engine dollars per year. */
export const SOLVE_TOLERANCE = 0.01;
/** The loop guard. ~40 halvings reach a cent from $10M; 200 is never hit by a finite bracket. */
export const MAX_ITERATIONS = 200;
/** How many one-cent raises re-verification may make before it refuses to answer. */
export const MAX_VERIFY_STEPS = 3;

export type EngineObjective =
  | { readonly kind: 'wealth_at'; readonly yearIndex: number; readonly target: number }
  | { readonly kind: 'sustain' };

export interface EngineCheck {
  readonly met: boolean;
  /** Dollars short (today's): target minus wealth, or the total shortfall. ≤ 0 when met. */
  readonly gap: number;
}

export function checkObjective(
  prepared: PreparedPlan,
  objective: EngineObjective,
  extra: ExtraContribution,
): EngineCheck {
  const path = runDeterministic(prepared, extra, objective.kind === 'wealth_at');
  if (objective.kind === 'wealth_at') {
    const gap = objective.target - wealthAt(path.records, objective.yearIndex);
    return { met: gap <= 0, gap };
  }
  const gap = path.state.shortfallTotal;
  return { met: gap <= 0, gap };
}

export type EngineSolveOutcome =
  | { readonly kind: 'already_met'; readonly iterations: 0 }
  | { readonly kind: 'required'; readonly annual: number; readonly iterations: number }
  | {
      readonly kind: 'unreachable';
      readonly constraint: 'no_contribution_window';
      readonly untilAge: number;
    }
  | {
      readonly kind: 'unreachable';
      readonly constraint: 'monthly_ceiling';
      readonly ceilingAnnual: number;
      readonly gapAtCeiling: number;
    };

/** The age at which extra contributions stop for an objective. */
export function contributionWindowEnd(prepared: PreparedPlan, objective: EngineObjective): number {
  const plan = prepared.plan;
  return objective.kind === 'wealth_at'
    ? Math.min(plan.retireAge, plan.startAge + objective.yearIndex + 1)
    : plan.retireAge;
}

/** Interior bisection. `ceilingAnnual` is the most the plan may add per year. */
export function solveExtraContribution(
  prepared: PreparedPlan,
  objective: EngineObjective,
  ceilingAnnual: number,
): EngineSolveOutcome {
  const untilAge = contributionWindowEnd(prepared, objective);
  const at = (annual: number) => checkObjective(prepared, objective, { annual, untilAge });

  if (at(0).met) return { kind: 'already_met', iterations: 0 };
  if (untilAge <= prepared.plan.startAge) {
    return { kind: 'unreachable', constraint: 'no_contribution_window', untilAge };
  }
  const atCeiling = at(ceilingAnnual);
  if (!atCeiling.met) {
    return {
      kind: 'unreachable',
      constraint: 'monthly_ceiling',
      ceilingAnnual,
      gapAtCeiling: atCeiling.gap,
    };
  }
  let lo = 0;
  let hi = ceilingAnnual;
  let iterations = 0;
  while (hi - lo > SOLVE_TOLERANCE && iterations < MAX_ITERATIONS) {
    const mid = (lo + hi) / 2;
    if (at(mid).met) hi = mid;
    else lo = mid;
    iterations += 1;
  }
  return { kind: 'required', annual: hi, iterations };
}

// ---------------------------------------------------------------------------
// The Money-facing API
// ---------------------------------------------------------------------------

export type RequiredSavingsObjective =
  | {
      readonly kind: 'wealth_at';
      readonly targetDate: DateOnly;
      readonly target: Money;
      /** `nominal`: the goal's target is in that year's dollars and is deflated first. */
      readonly basis: 'real' | 'nominal';
    }
  | { readonly kind: 'sustain_to_plan_end' };

export interface RequiredSavingsRequest {
  readonly objective: RequiredSavingsObjective;
  /** The most the household can add per month (WP 4.3's revealed income bounds it). */
  readonly maxMonthly: Money;
}

export type BindingConstraint =
  | {
      readonly name: 'no_contribution_window';
      readonly detail: string;
      /** The age contributions would have had to stop by. */
      readonly contributionsEndAge: number;
    }
  | {
      readonly name: 'monthly_ceiling';
      readonly detail: string;
      readonly ceiling: Money;
      /** Still short at the ceiling, today's dollars. */
      readonly gapAtCeiling: Money;
    };

export type RequiredSavingsResult =
  | { readonly kind: 'already_met'; readonly monthly: Money }
  | {
      readonly kind: 'required';
      readonly monthly: Money;
      readonly iterations: number;
      /** Always true: the rounded amount was run through the engine and closed the gap. */
      readonly verified: true;
    }
  | { readonly kind: 'unreachable'; readonly constraint: BindingConstraint };

/** The additional monthly contribution that closes the gap, or the constraint that stops it. */
export function solveRequiredSavings(
  plan: ProjectionPlan,
  assumptions: AssumptionsLike,
  request: RequiredSavingsRequest,
): RequiredSavingsResult {
  const code = planCurrency(plan);
  const engine = toEnginePlan(plan, assumptions);
  const prepared = preparePlan(engine);

  let objective: EngineObjective;
  if (request.objective.kind === 'wealth_at') {
    const years = wholeYearsFrom(plan.asOf, request.objective.targetDate);
    if (years > prepared.years) {
      throw new ProjectionInputRefused(
        'planning.projection_target_outside_plan',
        'objective.targetDate',
        `is ${String(years)} years out; the plan runs ${String(prepared.years)}`,
      );
    }
    if (years < 1) {
      return {
        kind: 'unreachable',
        constraint: {
          name: 'no_contribution_window',
          detail:
            'the target date is less than a year away: there is no whole year left in which an ' +
            'additional contribution could be made and grow',
          contributionsEndAge: engine.startAge,
        },
      };
    }
    objective = {
      kind: 'wealth_at',
      yearIndex: years - 1,
      target: toEngineTarget(
        request.objective.target,
        code,
        request.objective.basis,
        years,
        engine.inflation,
      ),
    };
  } else {
    objective = { kind: 'sustain' };
  }

  const outcome = solveExtraContribution(
    prepared,
    objective,
    toEngineCeiling(request.maxMonthly, code),
  );
  switch (outcome.kind) {
    case 'already_met':
      return { kind: 'already_met', monthly: solverMoney(0, code, 'requiredMonthly') };
    case 'unreachable':
      if (outcome.constraint === 'no_contribution_window') {
        return {
          kind: 'unreachable',
          constraint: {
            name: 'no_contribution_window',
            detail:
              `contributions stop at age ${String(outcome.untilAge)}, which is not after today's age ` +
              `${String(engine.startAge)}: no additional saving can reach this objective — only ` +
              'spending, the retirement age or the target date can',
            contributionsEndAge: outcome.untilAge,
          },
        };
      }
      return {
        kind: 'unreachable',
        constraint: {
          name: 'monthly_ceiling',
          detail:
            'even the most this household can add each month leaves a gap; the gap at that ceiling ' +
            'is shown in today’s dollars',
          ceiling: request.maxMonthly,
          gapAtCeiling: solverMoney(outcome.gapAtCeiling, code, 'gapAtCeiling'),
        },
      };
    case 'required': {
      const untilAge = contributionWindowEnd(prepared, objective);
      let monthly = monthlyFromAnnual(outcome.annual, code);
      for (let step = 0; step <= MAX_VERIFY_STEPS; step += 1) {
        const check = checkObjective(prepared, objective, {
          annual: annualFromMonthly(monthly, code),
          untilAge,
        });
        if (check.met) {
          return { kind: 'required', monthly, iterations: outcome.iterations, verified: true };
        }
        monthly = nextMinorUnit(monthly);
      }
      throw new Error(
        'solveRequiredSavings: the bisected amount did not verify after rounding; refusing to ' +
          'return a number that does not close the gap',
      );
    }
  }
}
