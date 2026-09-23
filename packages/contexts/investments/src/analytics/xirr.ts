// SPDX-License-Identifier: MIT
/**
 * XIRR: the rate that makes a dated cash-flow series net to zero — Newton
 * with a bisection fallback, and a typed `n/a` rather than a number when the
 * question has no answer.
 *
 * 07 §4.2 supplies the algorithm and, more usefully, the reason for the second
 * half of it: *"Newton with bisection fallback — **Newton alone diverges on
 * sign-flipping flows**"*. Newton's method follows the tangent, and on a series
 * whose NPV curve flattens near the guess the tangent points a very long way
 * from the root — off the end of the bracket, or past `1 + r = 0`, where the
 * discount function is not defined at all. The committed fixture in
 * `xirr.test.ts` does exactly that on the first iteration, and
 * {@link newtonOnly} is the diagnostic that shows it failing rather than
 * asserting that it would.
 *
 * ## The three ways this returns no number
 *
 *   * **`single_flow`** — one flow (or none) cannot define a rate of return.
 *   * **`no_sign_change_in_flows`** — every flow points the same way. 07 §4.2:
 *     *"no sign change: undefined, show 'n/a'"*. Money that only ever went in
 *     and never came back out, and has no terminal value, has no IRR; a `0`
 *     here would read as "you broke even", which is the opposite of the truth.
 *   * **`no_bracket`** — the flows change sign but the NPV does not cross zero
 *     anywhere in `[-99.99%, +10,000%]`. Multiple sign changes can produce two
 *     roots or none; reporting one of several roots as *the* return would be
 *     arbitrary, so this too is `n/a`.
 *
 * ## Period basis, and why it is a parameter
 *
 * An XIRR is by construction an **annual** rate: discounting on `days/365`
 * makes it one. That is precisely the trap 07 §4.2 names for a young account,
 * so `periodDays` lets the caller discount on the *period* instead, producing
 * the un-annualised return of that period. `mwr.ts` is the only caller that
 * sets it, and it sets it exactly when the span is under a year.
 *
 * Everything here is decimal strings over `@core/kernel`'s `Quantity`. There
 * is no `Math.pow`, no `number` in the arithmetic, and no float anywhere on
 * the path from a cash flow to a reported rate.
 */
import {
  DateOnly,
  Money,
  Quantity,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import {
  AnalyticsInputError,
  DAYS_PER_YEAR,
  decimalPow,
  ratio,
  roundDecimalString,
  type MwrUnavailableReason,
  type Ratio,
  type XirrDiagnostics,
  type XirrSolver,
} from './types.ts';

/** A dated cash flow in the XIRR sign convention: **contributions negative.** */
export interface DatedCashFlow {
  readonly date: DateOnlyType;
  readonly amount: MoneyType;
}

/** 07 §4.2's bracket, verbatim: `lo, hi = Decimal("-0.9999"), Decimal("100")`. */
export const XIRR_BRACKET_LOW = '-0.9999';
export const XIRR_BRACKET_HIGH = '100';
/** 07 §4.2: `if abs(r_new - r) < Decimal("1e-9"): return r_new`. */
export const XIRR_TOLERANCE = '0.000000001';
/** 07 §4.2: `for _ in range(100)`. */
export const XIRR_MAX_ITERATIONS = 100;
/** Bisection needs ~40 halvings to pass the tolerance across this bracket. */
export const XIRR_MAX_BISECTION_ITERATIONS = 200;
/** 07 §4.2's finite-difference step: `(npv(r + 1e-6) - f) / 1e-6`. */
export const XIRR_DERIVATIVE_STEP = '0.000001';
/** 07 §4.2's starting point: `guess=0.1`. */
export const XIRR_DEFAULT_GUESS = '0.1';

export interface XirrOptions {
  /**
   * Days in one discounting period. Defaults to 365 (ACT/365), which makes the
   * answer an annual rate. `mwr.ts` passes the span for sub-year periods so the
   * answer is a *period* rate and nothing annualises a nine-month return.
   */
  readonly periodDays?: number;
  readonly guess?: string;
}

export type XirrOutcome =
  | { readonly status: 'solved'; readonly rate: Ratio; readonly diagnostics: XirrDiagnostics }
  | {
      readonly status: 'unavailable';
      readonly reason: MwrUnavailableReason;
      readonly detail: string;
    };

/**
 * Net present value of `flows` at `rate`, in whole currency units, as a
 * decimal string.
 *
 * `Σ cf_i · (1 + r)^(-t_i)`, `t_i` in periods. Discounting is computed as
 * `exp(-t·ln(1+r))` rather than as a power of a large base, so a deeply
 * negative rate produces a very large *positive* factor without ever
 * overflowing `NUMERIC(38,18)` — see `MAX_DECIMAL_EXPONENT` in `types.ts`,
 * where the saturation and why only the sign matters at that endpoint are
 * written down.
 */
export function npvOf(
  flows: readonly DatedCashFlow[],
  rate: string,
  options: XirrOptions = {},
): string {
  const periodDays = options.periodDays ?? DAYS_PER_YEAR;
  const first = flows[0];
  if (first === undefined) throw new AnalyticsInputError('an NPV needs at least one cash flow');
  const onePlusRate = Quantity.add(Quantity.of('1'), Quantity.of(rate));
  if (Quantity.isNegative(onePlusRate) || Quantity.isZero(onePlusRate)) {
    throw new AnalyticsInputError(`a rate of ${rate} leaves no discount factor to compute`);
  }

  let total = Quantity.zero;
  for (const flow of flows) {
    const periods = Quantity.divide(
      Quantity.of(String(DateOnly.differenceInDays(first.date, flow.date))),
      String(periodDays),
    );
    const discount = decimalPow(onePlusRate, Quantity.negate(periods));
    total = Quantity.add(
      total,
      Quantity.multiply(Quantity.of(Money.formatAmount(flow.amount)), discount),
    );
  }
  return total;
}

/**
 * Solve for the rate, Newton first, bisection whenever Newton leaves the
 * bracket — 07 §4.2's loop, transcribed.
 *
 * The diagnostics are not decoration: `newtonDiverged` and `solver` are what
 * `'Newton diverges and bisection converges on the sign-flipping fixture'`
 * asserts, and what the convergence table in the evidence note is built from.
 */
export function xirr(flows: readonly DatedCashFlow[], options: XirrOptions = {}): XirrOutcome {
  const ordered = orderedFlows(flows);
  const nonZero = ordered.filter((flow) => !Money.isZero(flow.amount));
  if (nonZero.length < 2) {
    return {
      status: 'unavailable',
      reason: 'single_flow',
      detail: 'a rate of return needs at least two non-zero cash flows',
    };
  }
  const positives = nonZero.filter((flow) => Money.isPositive(flow.amount)).length;
  if (positives === 0 || positives === nonZero.length) {
    return {
      status: 'unavailable',
      reason: 'no_sign_change_in_flows',
      detail:
        'every cash flow points the same way, so no rate makes them net to zero; the answer is n/a, not 0',
    };
  }

  const npvAt = (rate: string): string => npvOf(ordered, rate, options);
  let lo = XIRR_BRACKET_LOW;
  let hi = XIRR_BRACKET_HIGH;
  const npvLo = npvAt(lo);
  const npvHi = npvAt(hi);
  if (!straddlesZero(npvLo, npvHi)) {
    return {
      status: 'unavailable',
      reason: 'no_bracket',
      detail: `NPV does not cross zero between ${lo} and ${hi} (${npvLo} and ${npvHi}); with several sign changes there may be no rate, or several`,
    };
  }
  const signLo = signOf(npvLo);

  let rate = options.guess ?? XIRR_DEFAULT_GUESS;
  let newtonSteps = 0;
  let bisectionSteps = 0;
  let newtonDiverged = false;

  for (let iteration = 0; iteration < XIRR_MAX_ITERATIONS; iteration += 1) {
    // Closed interval, deliberately — and this is the one place this loop
    // departs from 07 §4.2's pseudocode. Accepting an iterate narrows the
    // bracket *to* that iterate, so the next pass finds `r === lo` and a
    // strict `lo < r < hi` test reports divergence on a series where Newton
    // is converging perfectly well. The reference implementation has the same
    // quirk and still returns the right number via its bisection tail, but
    // `newtonDiverged` is a claim this package makes in a test name, so it has
    // to mean what it says. The strict test still governs the *new* iterate
    // below, which is where real divergence shows up.
    if (!insideOrOnBracket(rate, lo, hi)) {
      newtonDiverged = true;
      break;
    }
    const value = npvAt(rate);
    const shifted = npvAt(Quantity.add(Quantity.of(rate), Quantity.of(XIRR_DERIVATIVE_STEP)));
    const derivative = Quantity.divide(
      Quantity.subtract(Quantity.of(shifted), Quantity.of(value)),
      XIRR_DERIVATIVE_STEP,
    );
    if (Quantity.isZero(derivative)) {
      newtonDiverged = true;
      break;
    }

    const tangent = Quantity.subtract(
      Quantity.of(rate),
      Quantity.divide(Quantity.of(value), derivative),
    ) as string;
    // The tangent pointing outside the bracket *is* the divergence 07 §4.2
    // warns about; the step that replaces it is a bisection, and which of the
    // two produced the accepted iterate is reported rather than inferred.
    const tangentUsable = insideBracket(tangent, lo, hi);
    const solver: XirrSolver = tangentUsable ? 'newton' : 'bisection';
    const next = tangentUsable ? tangent : midpoint(lo, hi);
    if (tangentUsable) {
      newtonSteps += 1;
    } else {
      newtonDiverged = true;
      bisectionSteps += 1;
    }

    const npvNext = npvAt(next);
    if (signOf(npvNext) === 0) {
      return solved(next, npvNext, { solver, newtonSteps, bisectionSteps, newtonDiverged });
    }
    // Maintain the invariant the bisection tail depends on: `lo` and `hi`
    // always straddle a root, whichever end the new iterate replaces.
    if (signOf(npvNext) === signLo) {
      lo = next;
    } else {
      hi = next;
    }

    if (withinTolerance(rate, next)) {
      return solved(next, npvNext, { solver, newtonSteps, bisectionSteps, newtonDiverged });
    }
    rate = next;
  }

  // Newton gave up or wandered out. Bisection cannot: the bracket is
  // maintained as an invariant, so halving it always converges.
  let low = lo;
  let high = hi;
  let signLow = signOf(npvAt(low));
  for (let iteration = 0; iteration < XIRR_MAX_BISECTION_ITERATIONS; iteration += 1) {
    const middle = midpoint(low, high);
    bisectionSteps += 1;
    const value = npvAt(middle);
    if (signOf(value) === 0 || withinTolerance(low, high)) {
      return solved(middle, value, {
        solver: 'bisection',
        newtonSteps,
        bisectionSteps,
        newtonDiverged,
      });
    }
    if (signOf(value) === signLow) {
      low = middle;
      signLow = signOf(value);
    } else {
      high = middle;
    }
  }

  return {
    status: 'unavailable',
    reason: 'did_not_converge',
    detail: `neither Newton (${newtonSteps} steps) nor bisection (${bisectionSteps} steps) reached ${XIRR_TOLERANCE}`,
  };
}

export interface NewtonOnlyResult {
  readonly converged: boolean;
  /** Why unclamped Newton stopped. `null` when it converged. */
  readonly failure: 'left_bracket' | 'left_domain' | 'flat_derivative' | 'iteration_cap' | null;
  readonly iterations: number;
  /** Every iterate, so the evidence note can show the step that left the bracket. */
  readonly trace: readonly string[];
  readonly rate: string | null;
}

/**
 * Unclamped Newton, with no bisection anywhere — the diagnostic that makes
 * *"Newton alone diverges"* an observation rather than a claim.
 *
 * Not used by {@link xirr}. It exists so the test and the evidence note can
 * run the same fixture through plain Newton, watch it leave the bracket (or
 * leave the domain, where `1 + r ≤ 0` and there is no discount factor at all),
 * and then watch the production solver answer.
 */
export function newtonOnly(
  flows: readonly DatedCashFlow[],
  options: XirrOptions = {},
): NewtonOnlyResult {
  const ordered = orderedFlows(flows);
  let rate = options.guess ?? XIRR_DEFAULT_GUESS;
  const trace: string[] = [rate];

  for (let iteration = 1; iteration <= XIRR_MAX_ITERATIONS; iteration += 1) {
    let value: string;
    let shifted: string;
    try {
      value = npvOf(ordered, rate, options);
      shifted = npvOf(
        ordered,
        Quantity.add(Quantity.of(rate), Quantity.of(XIRR_DERIVATIVE_STEP)),
        options,
      );
    } catch {
      return { converged: false, failure: 'left_domain', iterations: iteration, trace, rate: null };
    }
    const derivative = Quantity.divide(
      Quantity.subtract(Quantity.of(shifted), Quantity.of(value)),
      XIRR_DERIVATIVE_STEP,
    );
    if (Quantity.isZero(derivative)) {
      return {
        converged: false,
        failure: 'flat_derivative',
        iterations: iteration,
        trace,
        rate: null,
      };
    }
    const next = Quantity.subtract(
      Quantity.of(rate),
      Quantity.divide(Quantity.of(value), derivative),
    ) as string;
    trace.push(next);

    if (Quantity.compare(Quantity.of(next), Quantity.of('-1')) <= 0) {
      return { converged: false, failure: 'left_domain', iterations: iteration, trace, rate: null };
    }
    if (!insideBracket(next, XIRR_BRACKET_LOW, XIRR_BRACKET_HIGH)) {
      return {
        converged: false,
        failure: 'left_bracket',
        iterations: iteration,
        trace,
        rate: null,
      };
    }
    if (withinTolerance(rate, next)) {
      return { converged: true, failure: null, iterations: iteration, trace, rate: next };
    }
    rate = next;
  }
  return {
    converged: false,
    failure: 'iteration_cap',
    iterations: XIRR_MAX_ITERATIONS,
    trace,
    rate: null,
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function solved(
  rate: string,
  npv: string,
  diagnostics: Omit<XirrDiagnostics, 'residual'>,
): XirrOutcome {
  return {
    status: 'solved',
    rate: ratio(rate),
    diagnostics: {
      ...diagnostics,
      residual: roundDecimalString(absolute(npv), 6),
    },
  };
}

function orderedFlows(flows: readonly DatedCashFlow[]): readonly DatedCashFlow[] {
  if (flows.length === 0) throw new AnalyticsInputError('a rate of return needs cash flows');
  const currency = flows[0]?.amount.currency;
  for (const flow of flows) {
    if (flow.amount.currency !== currency) {
      throw new AnalyticsInputError(
        `cash flows mix ${currency} and ${flow.amount.currency}; convert before solving`,
      );
    }
  }
  return [...flows].sort((a, b) => DateOnly.compare(a.date, b.date));
}

function signOf(value: string): -1 | 0 | 1 {
  return Quantity.compare(Quantity.of(value), Quantity.zero);
}

function straddlesZero(a: string, b: string): boolean {
  const left = signOf(a);
  const right = signOf(b);
  return left === 0 || right === 0 || left !== right;
}

function insideOrOnBracket(rate: string, lo: string, hi: string): boolean {
  return (
    Quantity.compare(Quantity.of(rate), Quantity.of(lo)) >= 0 &&
    Quantity.compare(Quantity.of(rate), Quantity.of(hi)) <= 0
  );
}

function insideBracket(rate: string, lo: string, hi: string): boolean {
  return (
    Quantity.compare(Quantity.of(rate), Quantity.of(lo)) > 0 &&
    Quantity.compare(Quantity.of(rate), Quantity.of(hi)) < 0
  );
}

function midpoint(lo: string, hi: string): string {
  return Quantity.divide(Quantity.add(Quantity.of(lo), Quantity.of(hi)), '2');
}

function withinTolerance(a: string, b: string): boolean {
  const gap = absolute(Quantity.subtract(Quantity.of(a), Quantity.of(b)));
  return Quantity.compare(Quantity.of(gap), Quantity.of(XIRR_TOLERANCE)) < 0;
}

function absolute(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}
