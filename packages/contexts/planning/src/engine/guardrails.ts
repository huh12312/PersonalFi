// SPDX-License-Identifier: MIT
/**
 * Guyton-Klinger guardrails with a spending floor and a cumulative-cut cap —
 * 07 §5.6, with Kitces' critique encoded rather than footnoted.
 *
 * ```
 * initial_wr = 0.045                       # user-settable
 * UPPER = initial_wr × 1.20                # capital preservation guardrail
 * LOWER = initial_wr × 0.80                # prosperity guardrail
 * each year (after year 1, and not in the final 15 years of the plan for the preservation rule):
 *     current_wr = withdrawal / portfolio_value
 *     if current_wr > UPPER:  withdrawal ×= 0.90        # cut 10%
 *     if current_wr < LOWER:  withdrawal ×= 1.10        # raise 10%
 *     # inflation rule: skip the COLA if last year's portfolio return was negative
 *     #   AND current_wr > initial_wr
 *     else:                   withdrawal ×= (1 + inflation)
 *     withdrawal = max(withdrawal, floor_spending)
 * ```
 *
 * > "unmodified guardrails produced cumulative spending cuts of ~28% in 2008,
 * > ~36% in the dot-com bust, and ~54% through 1965–1975 stagflation. Therefore
 * > add a **spending floor** … and cap cumulative real cuts at 20%." — 07 §5.6
 *
 * ## In today's dollars
 *
 * The engine is real-dollar (07 §5.2), so "withdrawal ×= (1 + inflation)" is
 * *no change* to real spending, and a skipped COLA is a real cut of
 * `1/(1 + i)`. Both kinds of cut — a skipped COLA and a 10% preservation cut —
 * count toward the cap, because both cost the retiree purchasing power, which
 * is what Kitces' 28/36/54% figures measure.
 *
 * ## The two bounds, and why they are one line
 *
 * After the rules run, real spending is raised to
 * `max(floor, (1 − cap) × initialSpending)`. That makes the invariant a
 * one-liner a property test can state for *every* return sequence: planned
 * real spending never falls below either bound. What the portfolio can *fund*
 * is a different question — a depleted portfolio funds less than it plans —
 * and the engine reports that separately as a shortfall, never by quietly
 * lowering the plan.
 *
 * ## The rate is on the portfolio withdrawal
 *
 * G-K's withdrawal rate is the portfolio's, so income (Social Security, a
 * pension) is subtracted before dividing: `rate = (spending − income) / portfolio`.
 * A retirement whose income already covers its spending has no portfolio
 * withdrawal and no rate; the rails do not fire (and cannot ratchet spending up
 * 10% a year on a zero rate).
 *
 * Interior module: `number`, no money. State is mutated in place and the step
 * returns a bit set, so WP 4.5 can run it in the Monte Carlo inner loop without
 * allocating.
 */

/** The method's parameters. Defaults are `GUYTON_KLINGER`; a plan may override each. */
export interface GuardrailRules {
  readonly upperMultiple: number;
  readonly lowerMultiple: number;
  readonly cutFraction: number;
  readonly raiseFraction: number;
  /** The preservation (cut) rule is off in the final N years of the plan. */
  readonly preservationEndsYearsBeforeEnd: number;
  /** G-K's inflation rule caps a COLA at 6%; `null` disables the cap. */
  readonly maxInflationRaise: number | null;
  /** Maximum cumulative real cut from initial spending. `null` = unmodified G-K. */
  readonly cumulativeCutCap: number | null;
  /** Real spending floor (essential spend). 0 = none. */
  readonly floor: number;
}

/**
 * The published method, cited field by field. Not in WP 4.2's assumptions file
 * because these define the *method* 07 §5.6 specifies, not a market or tax
 * parameter; each is overridable per plan.
 */
export const GUYTON_KLINGER = Object.freeze({
  upperMultiple: 1.2,
  lowerMultiple: 0.8,
  cutFraction: 0.1,
  raiseFraction: 0.1,
  preservationEndsYearsBeforeEnd: 15,
  maxInflationRaise: 0.06,
  cumulativeCutCap: 0.2,
  sources: Object.freeze({
    rails:
      'Guyton & Klinger, "Decision Rules and Maximum Initial Withdrawal Rates", Journal of Financial ' +
      'Planning, March 2006 — capital preservation rule (>20% above initial rate: cut 10%, off in the ' +
      'final 15 years) and prosperity rule (>20% below: raise 10%); 07 §5.6',
    inflation:
      'Guyton & Klinger 2006, inflation rule — no increase after a negative-return year when the ' +
      'current rate exceeds the initial rate; the annual increase is capped at 6%; 07 §5.6',
    cap:
      '07 §5.6 — "cap cumulative real cuts at 20%", after Kitces (kitces.com, "Why Guyton-Klinger ' +
      'Guardrails Are Too Risky For Most Retirees", 2024: cuts of ~28% in 2008, ~36% in the dot-com ' +
      'bust, ~54% through 1965–1975)',
    floor: '07 §5.6 — floor_spending = essential_spend (NEED-class categories)',
  }),
});

export function guytonKlingerRules(
  floor: number,
  overrides: Partial<Omit<GuardrailRules, 'floor'>> = {},
): GuardrailRules {
  return Object.freeze({
    upperMultiple: overrides.upperMultiple ?? GUYTON_KLINGER.upperMultiple,
    lowerMultiple: overrides.lowerMultiple ?? GUYTON_KLINGER.lowerMultiple,
    cutFraction: overrides.cutFraction ?? GUYTON_KLINGER.cutFraction,
    raiseFraction: overrides.raiseFraction ?? GUYTON_KLINGER.raiseFraction,
    preservationEndsYearsBeforeEnd:
      overrides.preservationEndsYearsBeforeEnd ?? GUYTON_KLINGER.preservationEndsYearsBeforeEnd,
    maxInflationRaise:
      overrides.maxInflationRaise === undefined
        ? GUYTON_KLINGER.maxInflationRaise
        : overrides.maxInflationRaise,
    cumulativeCutCap:
      overrides.cumulativeCutCap === undefined
        ? GUYTON_KLINGER.cumulativeCutCap
        : overrides.cumulativeCutCap,
    floor,
  });
}

/** Mutable per-path state. One per path; reset with `startGuardrails`. */
export interface GuardrailState {
  /** Real spending in the first retirement year — the cap's reference. */
  initialSpending: number;
  /** Portfolio withdrawal rate in the first retirement year; ≤ 0 disables the rails. */
  initialRate: number;
  /** This year's planned real spending. */
  spending: number;
  /** max over the path of (1 − spending / initialSpending). */
  worstCut: number;
}

export function newGuardrailState(): GuardrailState {
  return { initialSpending: 0, initialRate: 0, spending: 0, worstCut: 0 };
}

// Decision bits. A year can carry several (a skipped COLA and a cut, then the cap).
export const GR_FIRST_YEAR = 1;
export const GR_INFLATION_SKIPPED = 2;
export const GR_INFLATION_CAPPED = 4;
export const GR_PRESERVATION_CUT = 8;
export const GR_PROSPERITY_RAISE = 16;
export const GR_FLOOR_BOUND = 32;
export const GR_CAP_BOUND = 64;

export const GUARDRAIL_DECISIONS: readonly (readonly [number, string])[] = Object.freeze([
  [GR_FIRST_YEAR, 'first_year'],
  [GR_INFLATION_SKIPPED, 'inflation_skipped'],
  [GR_INFLATION_CAPPED, 'inflation_capped'],
  [GR_PRESERVATION_CUT, 'preservation_cut'],
  [GR_PROSPERITY_RAISE, 'prosperity_raise'],
  [GR_FLOOR_BOUND, 'floor_bound'],
  [GR_CAP_BOUND, 'cap_bound'],
] as const);

export function decisionNames(bits: number): string[] {
  return GUARDRAIL_DECISIONS.filter(([bit]) => (bits & bit) !== 0).map(([, name]) => name);
}

function lowerBound(state: GuardrailState, rules: GuardrailRules): number {
  const capped =
    rules.cumulativeCutCap === null ? 0 : (1 - rules.cumulativeCutCap) * state.initialSpending;
  return Math.max(rules.floor, capped);
}

/** First retirement year: spending is the plan's, the initial rate is set. */
export function startGuardrails(
  state: GuardrailState,
  rules: GuardrailRules,
  plannedSpending: number,
  portfolio: number,
  income: number,
): number {
  const spending = Math.max(plannedSpending, rules.floor);
  state.initialSpending = spending;
  state.initialRate = portfolio > 0 ? (spending - income) / portfolio : 0;
  state.spending = spending;
  state.worstCut = 0;
  return GR_FIRST_YEAR | (spending > plannedSpending ? GR_FLOOR_BOUND : 0);
}

/**
 * One later retirement year. `portfolio` is the real total at the start of the
 * year, before this year's withdrawal; `lastNominalReturn` is the portfolio's
 * nominal return over the year just ended; `inflation` is that year's CPI change.
 * Mutates `state.spending` and `state.worstCut`; returns the decision bits.
 */
export function stepGuardrails(
  state: GuardrailState,
  rules: GuardrailRules,
  portfolio: number,
  income: number,
  lastNominalReturn: number,
  inflation: number,
  yearsRemaining: number,
): number {
  let bits = 0;
  const railsActive = state.initialRate > 0 && portfolio > 0;
  const previous = state.spending;
  let candidate = previous;

  // Inflation rule. "Frozen" = last year's nominal withdrawal, in today's dollars.
  const frozen = previous / (1 + inflation);
  const frozenRate = railsActive ? (frozen - income) / portfolio : 0;
  if (railsActive && lastNominalReturn < 0 && frozenRate > state.initialRate) {
    candidate = frozen;
    bits |= GR_INFLATION_SKIPPED;
  } else if (rules.maxInflationRaise !== null && inflation > rules.maxInflationRaise) {
    candidate = (previous * (1 + rules.maxInflationRaise)) / (1 + inflation);
    bits |= GR_INFLATION_CAPPED;
  }

  // The two rails.
  if (railsActive) {
    const rate = (candidate - income) / portfolio;
    if (
      yearsRemaining > rules.preservationEndsYearsBeforeEnd &&
      rate > state.initialRate * rules.upperMultiple
    ) {
      candidate *= 1 - rules.cutFraction;
      bits |= GR_PRESERVATION_CUT;
    } else if (rate < state.initialRate * rules.lowerMultiple) {
      candidate *= 1 + rules.raiseFraction;
      bits |= GR_PROSPERITY_RAISE;
    }
  }

  // The floor and the cap: one bound, never breached.
  const bound = lowerBound(state, rules);
  if (candidate < bound) {
    const capBinds =
      rules.cumulativeCutCap !== null &&
      (1 - rules.cumulativeCutCap) * state.initialSpending >= rules.floor;
    bits |= capBinds ? GR_CAP_BOUND : GR_FLOOR_BOUND;
    candidate = bound;
  }

  state.spending = candidate;
  if (state.initialSpending > 0) {
    const cut = 1 - candidate / state.initialSpending;
    if (cut > state.worstCut) state.worstCut = cut;
  }
  return bits;
}
