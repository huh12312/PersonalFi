// SPDX-License-Identifier: MIT
/**
 * The earliest-retirement solver — WP 5.5, the engine half of the Weekly
 * Brief's "effect on your retirement date" (05 §3 WP 5.6, §5's risk row: *a
 * retirement effect is only ever an engine answer*).
 *
 * "At what whole-year age does this plan first sustain — no unfunded spending
 * to the plan's end (`solve.ts`'s `sustain` objective) — and how does one
 * action move it?" Answered by a **monotone search over whole years**, then
 * **re-verified through the engine** the way `solveRequiredSavings` re-runs its
 * rounded cent: the answer is never a number the search inferred, only one the
 * engine was seen to produce.
 *
 * ## Why a monotone search is valid here
 *
 * `solve.ts`'s header argues every objective it solves is monotone in *more
 * money in, earlier*. Retiring a year later is exactly that lever applied to
 * one year: the year at age A becomes a working year (contributions ≥ 0 go in,
 * income is saved) instead of a retired one (spending comes out), and every
 * later year starts from at least as much wealth. The deterministic engine
 * draws expected returns, so a later retirement's glidepath — which holds as
 * much equity or more at every age, and the file's equity return exceeds its
 * bond return — can only raise the path, and a Social Security benefit from an
 * earnings record can only rise with another working year. The one
 * non-monotone lever is the one `solve.ts` names: a guardrail *raise*, which
 * fires only when the portfolio is already comfortably ahead. So `sustains(A)`
 * is false below some age and true from it, and bisection over the integer
 * ages finds the boundary in ⌈log₂(range)⌉ engine runs.
 *
 * ## Why the answer is re-verified anyway
 *
 * The search runs on the prepared plan it was handed, **retargeted**: only
 * `retireAge` changes. That is cheap and it is not the whole plan — the
 * boundary derives more than one number from the retirement age (a Social
 * Security benefit from an earnings record stops accruing at retirement:
 * `boundary.ts#socialSecurityOf`'s `lastFutureYear`). So the search's answer
 * is run again through `verifyAt` — the Money-facing entry point passes a
 * rebuild through the whole `toEnginePlan` boundary — and the claim the solver
 * makes is checked as stated: **the plan sustains at the returned age and does
 * not at the year before** (or the year before is today). When the retargeted
 * search and the rebuilt plan disagree, the verification walks, a whole year at
 * a time, to the age the rebuilt plan does support. The age returned is always
 * one the rebuilt plan was run at and seen to sustain.
 *
 * ## What an action is, and what "months of spending" is
 *
 *   * `extra_annual` — an additional contribution every working year, into
 *     the plan's `extraBucket`, stopping at whichever retirement age is being
 *     tried (the contribution solver's lever).
 *   * `one_off` — a lump this year: a one-off flow at today's age (WP 5.5's
 *     `oneOffs`), so it lands in `TAXABLE` under the mid-year convention, or
 *     offsets this year's need if retirement has already begun in the plan
 *     being tried.
 *
 * Most single actions move no whole year, and **a retirement date is never
 * interpolated** — a fraction of a year is a claim no engine run stands
 * behind. What the action *is* worth is reported as **months of retirement
 * spending funded**: the engine's own real-wealth difference at the planned
 * retirement age (two runs, with the action and without, both retiring as
 * planned) divided by the plan's first-year retirement spending, ×12 — a
 * derivation, declared as one, computed from the two Money figures shown
 * (`boundary.ts#wholeMonthsFunded`).
 *
 * Interior module: `number` only, except the Money-facing function at the end,
 * which crosses through `boundary.ts` exactly as `solve.ts` does.
 */
import type { Money } from '@core/kernel';
import {
  planCurrency,
  solverMoney,
  toEngineAction,
  toEnginePlan,
  wholeMonthsFunded,
  type AssumptionsLike,
  type ProjectionPlan,
} from './boundary.ts';
import {
  ENGINE_VERSION,
  NO_EXTRA,
  preparePlan,
  runDeterministic,
  wealthAt,
  type EnginePlan,
  type ExtraContribution,
  type PreparedPlan,
} from './deterministic.ts';
import { checkObjective } from './solve.ts';

/**
 * The latest retirement age the solver will try. A plan that sustains only
 * past it answers `unreachable` with the shortfall at this age: "retire at 87"
 * is not a plan a person can act on, and the binding lever is then spending,
 * which the Brief should say. Callers may narrow or widen it per call.
 */
export const LATEST_SEARCHED_RETIREMENT_AGE = 80;

/** One action whose effect on the retirement date is asked for. Engine dollars, today's. */
export type RetirementAction =
  | { readonly kind: 'none' }
  /** An additional contribution every working year, until the retirement age being tried. */
  | { readonly kind: 'extra_annual'; readonly perYear: number }
  /** A lump this year. */
  | { readonly kind: 'one_off'; readonly lump: number };

export const NO_ACTION: RetirementAction = Object.freeze({ kind: 'none' });

/** One probe of the search: the bracket it was taken in, the age tried, and what the engine said. */
export interface RetirementProbe {
  readonly lo: number;
  readonly hi: number;
  readonly age: number;
  readonly sustains: boolean;
  /** Total unfunded spending to the plan's end, today's dollars; 0 when it sustains. */
  readonly shortfall: number;
}

/** One re-verification run: the age, rebuilt by `verifyAt`, and whether it sustains. */
export interface RetirementCheck {
  readonly age: number;
  readonly sustains: boolean;
  readonly shortfall: number;
}

export type RetirementAgeOutcome =
  | {
      readonly kind: 'earliest';
      readonly age: number;
      readonly probes: readonly RetirementProbe[];
      readonly checks: readonly RetirementCheck[];
      /** Always true: `age` was rebuilt, run and seen to sustain, and `age − 1` was seen not to. */
      readonly verified: true;
    }
  | {
      readonly kind: 'unreachable';
      /** The plan's retirement has already begun: no action moves a date in the past. */
      readonly constraint: 'retirement_started';
      readonly retiredAtAge: number;
    }
  | {
      readonly kind: 'unreachable';
      /** Even retiring at the latest age tried leaves unfunded spending. */
      readonly constraint: 'latest_age';
      readonly latestAge: number;
      readonly shortfallAtLatest: number;
      readonly probes: readonly RetirementProbe[];
      readonly checks: readonly RetirementCheck[];
    };

export interface RetirementSearchOptions {
  /** Default `LATEST_SEARCHED_RETIREMENT_AGE`, and never past the plan's last year. */
  readonly latestAge?: number;
  /**
   * The plan at a candidate age, with the action applied, **rebuilt** — the
   * Money-facing entry point passes a rebuild through `toEnginePlan`. Default:
   * the same retargeting the search uses, re-prepared from scratch.
   */
  readonly verifyAt?: (age: number, action: RetirementAction) => PreparedPlan;
}

/** The whole answer, in engine units. The Money-facing `solveRetirementImpact` converts it. */
export interface RetirementImpactRun {
  /** The plan's own retirement age: where months of spending are measured. */
  readonly plannedAge: number;
  readonly baseline: RetirementAgeOutcome;
  readonly withAction: RetirementAgeOutcome;
  /** `baseline.age − withAction.age`, whole years (positive = earlier); null if either is unreachable. */
  readonly yearsEarlier: number | null;
  /**
   * Real wealth at the planned retirement age with the action, less without it —
   * both runs retiring as planned. `null` when retirement has already begun.
   */
  readonly wealthDifference: number | null;
  /** The engine's own spending in the first retired year of the run without the action. */
  readonly firstYearSpending: number | null;
}

/** The plan as it would be retiring at `age`, with `action` applied. Only `retireAge` and `oneOffs` move. */
export function planRetiringAt(
  base: EnginePlan,
  age: number,
  action: RetirementAction,
): EnginePlan {
  const oneOffs =
    action.kind === 'one_off'
      ? [...(base.oneOffs ?? []), { age: base.startAge, real: action.lump }]
      : base.oneOffs;
  return { ...base, retireAge: age, ...(oneOffs === undefined ? {} : { oneOffs }) };
}

/** The solver's extra contribution for `action` when retiring at `age`. */
export function extraFor(action: RetirementAction, age: number): ExtraContribution {
  return action.kind === 'extra_annual' ? { annual: action.perYear, untilAge: age } : NO_EXTRA;
}

function sustainsAt(
  prepared: PreparedPlan,
  action: RetirementAction,
  age: number,
): { readonly sustains: boolean; readonly shortfall: number } {
  const check = checkObjective(prepared, { kind: 'sustain' }, extraFor(action, age));
  return { sustains: check.met, shortfall: Math.max(0, check.gap) };
}

/**
 * The earliest whole-year age at which the plan sustains under `action` — the
 * bisection, then the walk that re-verifies it. `prepared` is the plan as the
 * holder has it; its `retireAge` is only where months are measured.
 */
export function earliestAgeFor(
  prepared: PreparedPlan,
  action: RetirementAction,
  options: RetirementSearchOptions = {},
): RetirementAgeOutcome {
  const base = prepared.plan;
  if (base.retireAge <= base.startAge) {
    return { kind: 'unreachable', constraint: 'retirement_started', retiredAtAge: base.retireAge };
  }
  const first = base.startAge;
  const last = Math.max(
    first,
    Math.min(options.latestAge ?? LATEST_SEARCHED_RETIREMENT_AGE, base.endAge - 1),
  );
  const retargeted = (age: number) => preparePlan(planRetiringAt(base, age, action));
  const verifyAt = options.verifyAt ?? ((age: number) => retargeted(age));

  // 1. The monotone search, on the retargeted plan. Invariant: !sustains(lo) && sustains(hi).
  const probes: RetirementProbe[] = [];
  const probe = (lo: number, hi: number, age: number) => {
    const result = sustainsAt(retargeted(age), action, age);
    probes.push({ lo, hi, age, ...result });
    return result;
  };
  let answer: number;
  if (probe(first, last, first).sustains) {
    answer = first;
  } else {
    let lo = first;
    let hi = last;
    const atLast = probe(first, last, last);
    if (!atLast.sustains) {
      answer = last + 1; // nothing in range sustains on the search's plan; the walk below confirms
    } else {
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (probe(lo, hi, mid).sustains) hi = mid;
        else lo = mid;
      }
      answer = hi;
    }
  }

  // 2. Re-verification on the rebuilt plan: the claim is "sustains at `answer`, and not the year
  //    before". Where the rebuild disagrees with the search, walk a whole year at a time.
  const checks: RetirementCheck[] = [];
  const check = (age: number) => {
    const result = sustainsAt(verifyAt(age, action), action, age);
    checks.push({ age, ...result });
    return result;
  };
  let age = Math.min(answer, last);
  let atAge = check(age);
  while (!atAge.sustains) {
    if (age >= last) {
      return {
        kind: 'unreachable',
        constraint: 'latest_age',
        latestAge: last,
        shortfallAtLatest: atAge.shortfall,
        probes,
        checks,
      };
    }
    age += 1;
    atAge = check(age);
  }
  while (age > first && check(age - 1).sustains) age -= 1;
  return { kind: 'earliest', age, probes, checks, verified: true };
}

/**
 * The named entry point (05 §3 WP 5.5): the baseline's earliest retirement age,
 * the age with the action, the delta in whole years, and the two engine figures
 * months of spending are derived from.
 */
export function earliestRetirementAge(
  prepared: PreparedPlan,
  action: RetirementAction,
  options: RetirementSearchOptions = {},
): RetirementImpactRun {
  const base = prepared.plan;
  const baseline = earliestAgeFor(prepared, NO_ACTION, options);
  const withAction = earliestAgeFor(prepared, action, options);
  const yearsEarlier =
    baseline.kind === 'earliest' && withAction.kind === 'earliest'
      ? baseline.age - withAction.age
      : null;

  const planned = base.retireAge;
  if (planned <= base.startAge) {
    return {
      plannedAge: planned,
      baseline,
      withAction,
      yearsEarlier,
      wealthDifference: null,
      firstYearSpending: null,
    };
  }
  // Months of spending: two engine runs, both retiring as planned, measured at the start of the
  // planned retirement year (the end of the year before). The rebuild is the verifier's, so the
  // Money-facing path measures through the whole boundary too.
  const rebuild =
    options.verifyAt ??
    ((age: number, act: RetirementAction) => preparePlan(planRetiringAt(base, age, act)));
  const without = runDeterministic(rebuild(planned, NO_ACTION), extraFor(NO_ACTION, planned));
  const withIt = runDeterministic(rebuild(planned, action), extraFor(action, planned));
  const lastWorkingYear = planned - base.startAge - 1;
  const firstRetired = without.records[planned - base.startAge];
  return {
    plannedAge: planned,
    baseline,
    withAction,
    yearsEarlier,
    wealthDifference:
      wealthAt(withIt.records, lastWorkingYear) - wealthAt(without.records, lastWorkingYear),
    firstYearSpending: firstRetired === undefined ? null : firstRetired.spending,
  };
}

// ---------------------------------------------------------------------------
// The Money-facing API (what WP 5.6's RetirementImpactPort binds)
// ---------------------------------------------------------------------------

/** One catalogue action, as the Brief states it: Money, today's dollars. */
export type RetirementImpactAction =
  | { readonly kind: 'extra_annual'; readonly annual: Money }
  | { readonly kind: 'one_off'; readonly lump: Money };

export type RetirementAgeAnswer =
  | {
      readonly kind: 'earliest';
      /** A whole year of age. Never a fraction: no engine run stands behind one. */
      readonly age: number;
      /** Always true: this age was rebuilt through the boundary and run, and so was the year before. */
      readonly verified: true;
      readonly engineRuns: number;
    }
  | {
      readonly kind: 'unreachable';
      readonly constraint:
        | {
            readonly name: 'retirement_started';
            readonly detail: string;
            readonly retiredAtAge: number;
          }
        | {
            readonly name: 'latest_age';
            readonly detail: string;
            readonly latestAge: number;
            /** Unfunded spending to the plan's end even retiring at `latestAge`, today's dollars. */
            readonly shortfallAtLatest: Money;
          };
    };

/** The declared derivation, word for word, so a reader never mistakes it for a date. */
export const MONTHS_OF_SPENDING_DERIVATION =
  'months = ⌊12 × (real wealth at the planned retirement age with the action − without it) ÷ ' +
  'the first retired year’s spending⌋: two deterministic engine runs, both retiring as planned, ' +
  'in today’s dollars — a measure of what the action funds, not a change to the retirement date';

export type MonthsOfSpending =
  | {
      readonly months: number;
      readonly atAge: number;
      readonly wealthDifference: Money;
      readonly firstYearSpending: Money;
      readonly derivation: typeof MONTHS_OF_SPENDING_DERIVATION;
    }
  | { readonly months: null; readonly reason: 'retirement_started' | 'no_retirement_spending' };

export interface RetirementImpact {
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  readonly plannedRetirementAge: number;
  readonly baseline: RetirementAgeAnswer;
  readonly withAction: RetirementAgeAnswer;
  /** Whole years earlier with the action (0 = no whole year moved). `null` if either side is unreachable. */
  readonly yearsEarlier: number | null;
  readonly monthsOfSpending: MonthsOfSpending;
}

function answerOf(
  outcome: RetirementAgeOutcome,
  code: ReturnType<typeof planCurrency>,
): RetirementAgeAnswer {
  if (outcome.kind === 'earliest') {
    return {
      kind: 'earliest',
      age: outcome.age,
      verified: true,
      engineRuns: outcome.probes.length + outcome.checks.length,
    };
  }
  if (outcome.constraint === 'retirement_started') {
    return {
      kind: 'unreachable',
      constraint: {
        name: 'retirement_started',
        detail:
          `retirement began at ${String(outcome.retiredAtAge)} in this plan: no action moves a ` +
          'retirement date that has already passed',
        retiredAtAge: outcome.retiredAtAge,
      },
    };
  }
  return {
    kind: 'unreachable',
    constraint: {
      name: 'latest_age',
      detail:
        `even retiring at ${String(outcome.latestAge)} leaves spending the plan cannot fund; the ` +
        'lever that moves this is spending, not the date',
      latestAge: outcome.latestAge,
      shortfallAtLatest: solverMoney(outcome.shortfallAtLatest, code, 'shortfallAtLatest'),
    },
  };
}

/**
 * The Brief's retirement effect for one action: the earliest whole-year
 * retirement age with and without it, verified through the boundary, and the
 * months of retirement spending it funds, declared as a derivation.
 */
export function solveRetirementImpact(
  plan: ProjectionPlan,
  assumptions: AssumptionsLike,
  action: RetirementImpactAction,
  options: { readonly latestAge?: number } = {},
): RetirementImpact {
  const code = planCurrency(plan);
  const engineAction: RetirementAction =
    action.kind === 'extra_annual'
      ? { kind: 'extra_annual', perYear: toEngineAction(action.annual, code, 'action.annual') }
      : { kind: 'one_off', lump: toEngineAction(action.lump, code, 'action.lump') };
  const prepared = preparePlan(toEnginePlan(plan, assumptions));
  // The verifier rebuilds the whole plan at each age through `toEnginePlan`, so every number the
  // boundary derives from the retirement age is re-derived; the one-off enters as the engine's own.
  const verifyAt = (age: number, act: RetirementAction): PreparedPlan =>
    preparePlan(
      planRetiringAt(toEnginePlan({ ...plan, retirementAge: age }, assumptions), age, act),
    );
  const run = earliestRetirementAge(prepared, engineAction, {
    verifyAt,
    ...(options.latestAge === undefined ? {} : { latestAge: options.latestAge }),
  });

  let monthsOfSpending: MonthsOfSpending;
  if (run.wealthDifference === null) {
    monthsOfSpending = { months: null, reason: 'retirement_started' };
  } else {
    const wealthDifference = solverMoney(run.wealthDifference, code, 'wealthDifference');
    const firstYearSpending = solverMoney(run.firstYearSpending ?? 0, code, 'firstYearSpending');
    const months = wholeMonthsFunded(wealthDifference, firstYearSpending);
    monthsOfSpending =
      months === null
        ? { months: null, reason: 'no_retirement_spending' }
        : {
            months,
            atAge: run.plannedAge,
            wealthDifference,
            firstYearSpending,
            derivation: MONTHS_OF_SPENDING_DERIVATION,
          };
  }
  return {
    engineVersion: ENGINE_VERSION,
    assumptionsVersion: assumptions.version,
    plannedRetirementAge: run.plannedAge,
    baseline: answerOf(run.baseline, code),
    withAction: answerOf(run.withAction, code),
    yearsEarlier: run.yearsEarlier,
    monthsOfSpending,
  };
}
