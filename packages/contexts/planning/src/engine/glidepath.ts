// SPDX-License-Identifier: MIT
/**
 * Glidepaths — 07 §5.9, as pluggable functions evaluated **per period**.
 *
 * > "The glidepath is a function passed into the MC engine, evaluated
 * > per-month. Keep it pluggable; the bond-tent variant is a differentiating
 * > feature and costs ~20 lines." — 07 §5.9
 *
 * Interior module: every quantity here is a plain `number` (an age in years, an
 * equity share in [0, 1]). Nothing in this file touches money, and nothing in it
 * reads a clock — the deterministic engine calls it once per year with that
 * year's age, and WP 4.5's Monte Carlo may call the same function per month
 * with a fractional age. Same function, same answer: the two engines cannot
 * disagree about the allocation.
 *
 * The four shapes and where each number comes from:
 *
 *   * `age_based` — 07 §5.9 DEFAULT: `clamp(110 − age, 30, 90) / 100`.
 *   * `target_date` — 07 §5.9 ALT "Vanguard/Schwab-like": Vanguard's published
 *     Target Retirement glide path — 90% equity until 25 years before the target
 *     date, declining to 50% at the target date, and to 30% seven years after
 *     it, flat thereafter (Vanguard, "Vanguard's approach to target-date funds",
 *     glide-path exhibit). Linear between the published knots.
 *   * `rising_equity` — 07 §5.9 ALT, Kitces & Pfau's bond tent (Pfau & Kitces,
 *     "Reducing Retirement Risk with a Rising Equity Glide Path", *Journal of
 *     Financial Planning*, January 2014): dip to 40% equity at retirement, rise
 *     back to 70% over 15 years. Before the dip it follows the age-based default
 *     and descends linearly over the final 10 working years.
 *   * `static` — 07 §5.9 ALT, a user-set share.
 *
 * These are method definitions from the memo, not market or tax parameters, so
 * they live beside the method rather than in WP 4.2's assumptions file (which
 * holds the numbers Appendix A says are never inlined). Every knot is exported
 * with its citation so the UI can show it.
 */

/** Which glidepath; `static` carries its share. Interior form (the share is a number). */
export type EngineGlidepath =
  | { readonly kind: 'age_based' }
  | { readonly kind: 'target_date' }
  | { readonly kind: 'rising_equity' }
  | { readonly kind: 'static'; readonly equityShare: number };

/** An equity share for an age, given the planned retirement age. Pure; [0, 1]. */
export type GlidepathFunction = (age: number, retireAge: number) => number;

/** 07 §5.9 DEFAULT, "110 minus age", clamped to [30, 90] percent. */
export const AGE_BASED_RULE = Object.freeze({
  offsetYears: 110,
  minimumEquity: 0.3,
  maximumEquity: 0.9,
  source: '07 §5.9 DEFAULT — equity_pct(age) = clamp(110 − age, 30, 90) / 100',
});

/**
 * Vanguard's published target-date glide path as knots of
 * (years relative to retirement, equity share). Negative = before retirement.
 */
export const TARGET_DATE_KNOTS: readonly (readonly [number, number])[] = Object.freeze([
  Object.freeze([-25, 0.9] as const),
  Object.freeze([0, 0.5] as const),
  Object.freeze([7, 0.3] as const),
]);
export const TARGET_DATE_SOURCE =
  '07 §5.9 ALT TARGET_DATE_TABLE — Vanguard Target Retirement glide path: 90% equity to 25 years ' +
  'before the target date, 50% at it, 30% seven years after (Vanguard, "Vanguard\'s approach to ' +
  'target-date funds")';

/** 07 §5.9 ALT RISING_EQUITY_GLIDEPATH — the bond tent. */
export const RISING_EQUITY_RULE = Object.freeze({
  equityAtRetirement: 0.4,
  equityAfterRise: 0.7,
  riseOverYears: 15,
  descentOverYears: 10,
  source:
    '07 §5.9 ALT — dip to ~40% equity at retirement, rise back to ~70% over 15 years (Pfau & Kitces, ' +
    'JFP January 2014); the 10-year descent into the dip follows the same paper',
});

function clamp(share: number, low: number, high: number): number {
  return share < low ? low : share > high ? high : share;
}

/** Linear interpolation over ascending knots, flat beyond both ends. */
function interpolate(knots: readonly (readonly [number, number])[], x: number): number {
  const first = knots[0];
  const last = knots[knots.length - 1];
  if (first === undefined || last === undefined) throw new Error('a glidepath needs knots');
  if (x <= first[0]) return first[1];
  if (x >= last[0]) return last[1];
  for (let index = 1; index < knots.length; index += 1) {
    const right = knots[index];
    const left = knots[index - 1];
    if (right === undefined || left === undefined) break;
    if (x <= right[0]) {
      const span = right[0] - left[0];
      return left[1] + ((x - left[0]) / span) * (right[1] - left[1]);
    }
  }
  return last[1];
}

export function ageBasedEquity(age: number): number {
  return clamp(
    (AGE_BASED_RULE.offsetYears - age) / 100,
    AGE_BASED_RULE.minimumEquity,
    AGE_BASED_RULE.maximumEquity,
  );
}

export function targetDateEquity(age: number, retireAge: number): number {
  return interpolate(TARGET_DATE_KNOTS, age - retireAge);
}

export function risingEquity(age: number, retireAge: number): number {
  const rule = RISING_EQUITY_RULE;
  const descentStart = retireAge - rule.descentOverYears;
  if (age <= descentStart) return ageBasedEquity(age);
  if (age < retireAge) {
    const from = ageBasedEquity(descentStart);
    return from + ((age - descentStart) / rule.descentOverYears) * (rule.equityAtRetirement - from);
  }
  const risen = Math.min(1, (age - retireAge) / rule.riseOverYears);
  return rule.equityAtRetirement + risen * (rule.equityAfterRise - rule.equityAtRetirement);
}

/**
 * Resolve a glidepath description to its function. Called once per plan, never
 * inside the per-year loop.
 */
export function glidepathFunction(glidepath: EngineGlidepath): GlidepathFunction {
  switch (glidepath.kind) {
    case 'age_based':
      return (age) => ageBasedEquity(age);
    case 'target_date':
      return targetDateEquity;
    case 'rising_equity':
      return risingEquity;
    case 'static': {
      const share = glidepath.equityShare;
      if (!(share >= 0 && share <= 1)) {
        throw new RangeError(`a static equity share must be within [0, 1], got ${String(share)}`);
      }
      return () => share;
    }
  }
}
