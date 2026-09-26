// SPDX-License-Identifier: MIT
/**
 * Social Security — 07 §5.8's seven steps, interior (`number`) form.
 *
 * ```
 * 1. Index each year's earnings (capped at that year's taxable maximum) by the AWI ratio to the
 *    year the worker turns 60. Earnings at/after 60 are used nominally.
 * 2. AIME = sum(highest 35 indexed years) / 420, rounded down to a whole dollar.
 * 3. PIA (2026 bend points, locked in the year the worker turns 62) … 0.90 / 0.32 / 0.15
 * 4. FRA = 67 for anyone born 1960 or later.
 * 5. Claim adjustment: −5/9 of 1% per month for the first 36 early months, −5/12 beyond;
 *    +8%/year (2/3 of 1% per month) to age 70.
 * 6. Apply COLA annually (2.8% for 2026).
 * 7. Taxable wage base 2026: $184,500.
 * ```
 *
 * **Every parameter arrives in `SocialSecurityRules`**, built by
 * `boundary.ts` from WP 4.2's assumptions file (`taxYear(…).socialSecurity`
 * and `socialSecurityStress`) — the bend points, factors, FRA schedule,
 * reduction fractions, delayed credit, its end age, the COLA and the wage base
 * are never written here. What *is* written here is statute that has no annual
 * figure: 35 computation years (SSA §215(b)(2)(A)), indexing to age 60
 * (§215(b)(3)), and first eligibility at 62 (§202(a)) — reported to WP 4.2 as
 * candidates for the file.
 *
 * ## Rounding, exactly as SSA does it, on floats that cannot fool it
 *
 * SSA truncates the PIA to the dime after the formula and after every COLA,
 * and floors the monthly benefit to the dollar (SSA OACT, "Benefit Calculation
 * Examples for Workers Retiring in 2026", case A: $2,609.88 → $2,609.80 →
 * $1,826.00 at 62). A float can land a hair *below* an exact boundary
 * (`2609.8` stored as `2609.7999…`) and a naïve `Math.floor` would then lose a
 * whole dime or dollar. `ROUNDING_GUARD` adds 1e-6 before flooring, and that is
 * provably safe here because every true value this module floors is a rational
 * whose distance from the next boundary is either zero or far larger:
 *
 *   * PIA formula: integer AIME × factors in hundredths → exact cents; ×10 is a
 *     multiple of 0.1 — distance to a dime boundary ≥ 0.1.
 *   * COLA: dimes × (1000 + k)/1000 → ×10 has denominator 1000 — distance ≥ 1e-3.
 *   * Early reduction, first 36 months: factor (180 − m)/180; beyond 36:
 *     (192 − (m − 36))/240; delayed credit: (150 + m)/150. Dimes × those →
 *     denominators ≤ 2,400 — distance to a dollar ≥ 4.1e-4.
 *
 * Float error at these magnitudes (< $10⁵) is ~1e-11, so a 1e-6 guard can
 * never push a true value across a boundary it was not already on.
 */

/** The parameters, as numbers — built only by `boundary.ts` from the assumptions file. */
export interface SocialSecurityRules {
  /** Monthly AIME dollars (07 Appendix A: $1,286 and $7,749 for 2026). */
  readonly bendFirst: number;
  readonly bendSecond: number;
  readonly factorBelowFirst: number;
  readonly factorBetween: number;
  readonly factorAboveSecond: number;
  /** FRA in months of age, by birth-year cohort. `bornThrough` null = open-ended. */
  readonly fullRetirementAge: readonly {
    readonly bornFrom: number;
    readonly bornThrough: number | null;
    readonly months: number;
  }[];
  /** 5/900: 5/9 of 1% per early month, for the first 36. */
  readonly earlyFirst36PerMonth: number;
  /** 5/1200: 5/12 of 1% per early month beyond 36. */
  readonly earlyBeyondPerMonth: number;
  /** 0.08 per year of delay past FRA. */
  readonly delayedCreditPerYear: number;
  /** 70 × 12: no credit accrues after this age. */
  readonly delayedCreditEndsAtMonths: number;
  /** The file year's COLA (07 Appendix A: 2.8%). */
  readonly cola: number;
  /** Annual taxable maximum (07 Appendix A: $184,500). */
  readonly wageBase: number;
  /** "75% benefit after 2034" (07 §5.8) — the calendar year it starts and the payable ratio. */
  readonly stressFromYear: number;
  readonly stressPayableRatio: number;
}

/** SSA §215(b)(2)(A): the benefit computation years for a retired worker. 35 years = 420 months. */
export const COMPUTATION_YEARS = 35;
/** SSA §215(b)(3): earnings are indexed to the year the worker turns 60. */
export const INDEXING_AGE = 60;
/** SSA §202(a): the earliest age a retired-worker benefit can be claimed. */
export const EARLIEST_CLAIM_AGE_YEARS = 62;
/** See the header: the largest float error this guard must absorb is ~1e-11. */
export const ROUNDING_GUARD = 1e-6;

/** SSA truncates to the next lower dime. */
export function truncateToDime(dollars: number): number {
  return Math.floor(dollars * 10 + ROUNDING_GUARD) / 10;
}

/** SSA pays whole dollars, rounded down. */
export function floorToDollar(dollars: number): number {
  return Math.floor(dollars + ROUNDING_GUARD);
}

/** One year of covered earnings, already in engine dollars. */
export interface EngineEarningsYear {
  readonly year: number;
  readonly earnings: number;
}

/**
 * Step 1. Each year's earnings × AWI(indexYear) / AWI(year) for years before
 * `indexYear`; at face value from `indexYear` on. A missing AWI for a year that
 * needs one is a refusal, never a guess.
 */
export function indexEarnings(
  history: readonly EngineEarningsYear[],
  averageWageIndex: ReadonlyMap<number, number>,
  indexYear: number,
): number[] {
  const base = averageWageIndex.get(indexYear);
  if (base === undefined) {
    throw new RangeError(`no average wage index for the indexing year ${String(indexYear)}`);
  }
  return history.map((row) => {
    if (row.year >= indexYear) return row.earnings;
    const index = averageWageIndex.get(row.year);
    if (index === undefined) {
      throw new RangeError(`no average wage index for ${String(row.year)}`);
    }
    return (row.earnings * base) / index;
  });
}

/** Step 2. The highest 35 indexed years over 420 months, floored to a whole dollar. */
export function averageIndexedMonthlyEarnings(indexed: readonly number[]): number {
  const highest = [...indexed].sort((a, b) => b - a).slice(0, COMPUTATION_YEARS);
  let total = 0;
  for (const year of highest) total += year;
  return floorToDollar(total / (COMPUTATION_YEARS * 12));
}

/** Step 3. The three-segment formula, truncated to the dime. */
export function piaFromAime(aime: number, rules: SocialSecurityRules): number {
  const low = Math.min(aime, rules.bendFirst);
  const middle = Math.max(0, Math.min(aime, rules.bendSecond) - rules.bendFirst);
  const high = Math.max(0, aime - rules.bendSecond);
  return truncateToDime(
    rules.factorBelowFirst * low + rules.factorBetween * middle + rules.factorAboveSecond * high,
  );
}

/** Step 6. Each COLA applied in turn, truncating to the dime after each (SSA case B). */
export function applyColas(pia: number, colas: readonly number[]): number {
  let adjusted = pia;
  for (const cola of colas) adjusted = truncateToDime(adjusted * (1 + cola));
  return adjusted;
}

/** Step 4. FRA in months of age for a birth year; a cohort the file does not hold is refused. */
export function fullRetirementAgeMonths(birthYear: number, rules: SocialSecurityRules): number {
  for (const row of rules.fullRetirementAge) {
    if (birthYear >= row.bornFrom && (row.bornThrough === null || birthYear <= row.bornThrough)) {
      return row.months;
    }
  }
  throw new RangeError(
    `the assumptions file has no full retirement age for birth year ${String(birthYear)}`,
  );
}

/**
 * Step 5. The factor a claim at `claimMonths` of age applies to the PIA. Early:
 * 5/9 of 1% for each of the first 36 months, 5/12 of 1% beyond. Late: 8%/yr,
 * accrued monthly, to 70 and no further.
 */
export function claimFactor(
  claimMonths: number,
  fraMonths: number,
  rules: SocialSecurityRules,
): number {
  if (claimMonths < EARLIEST_CLAIM_AGE_YEARS * 12) {
    throw new RangeError('a retired-worker benefit cannot be claimed before age 62');
  }
  if (claimMonths < fraMonths) {
    const early = fraMonths - claimMonths;
    const first = Math.min(early, 36);
    const beyond = Math.max(0, early - 36);
    return 1 - first * rules.earlyFirst36PerMonth - beyond * rules.earlyBeyondPerMonth;
  }
  const late = Math.min(claimMonths, rules.delayedCreditEndsAtMonths) - fraMonths;
  return 1 + (Math.max(0, late) * rules.delayedCreditPerYear) / 12;
}

/** The monthly benefit a claim pays: PIA × factor, floored to the dollar. */
export function monthlyBenefit(pia: number, factor: number): number {
  return floorToDollar(pia * factor);
}

/** The interior description of a worker's benefit, built by `boundary.ts`. */
export type EngineSocialSecurity =
  | {
      readonly kind: 'statement';
      /** Monthly PIA at FRA in today's dollars, from the worker's SSA statement. */
      readonly monthlyPia: number;
      readonly claimMonths: number;
      readonly birthYear: number;
      readonly stress: boolean;
    }
  | {
      readonly kind: 'earnings';
      readonly history: readonly EngineEarningsYear[];
      readonly averageWageIndex: ReadonlyMap<number, number>;
      /** Future covered earnings per year in today's dollars, until retirement; 0 if none. */
      readonly futureAnnualEarnings: number;
      readonly firstFutureYear: number;
      readonly lastFutureYear: number;
      readonly claimMonths: number;
      readonly birthYear: number;
      readonly stress: boolean;
    };

/** Every intermediate of the seven steps, for the evidence and the UI's "why this number". */
export interface SocialSecurityDerivation {
  readonly indexYear: number | null;
  readonly aime: number | null;
  readonly pia: number;
  readonly fraMonths: number;
  readonly claimMonths: number;
  readonly factor: number;
  readonly monthly: number;
}

/**
 * The PIA and the claimed monthly benefit, in today's dollars.
 *
 * For `earnings`, indexing runs to the AWI of the year the worker turns 60, or
 * — when that year has not been published yet — to the latest published year,
 * with everything after it at face value. That is the "today's dollars"
 * convention SSA's own estimators use, and it pairs with bend points from the
 * plan's tax year (also today's wage level). For a worker first eligible in the
 * file's year it is exactly SSA's computation (the 2026 case A test).
 */
export function deriveSocialSecurity(
  input: EngineSocialSecurity,
  rules: SocialSecurityRules,
): SocialSecurityDerivation {
  const fraMonths = fullRetirementAgeMonths(input.birthYear, rules);
  let pia: number;
  let aime: number | null = null;
  let indexYear: number | null = null;
  if (input.kind === 'statement') {
    pia = truncateToDime(input.monthlyPia);
  } else {
    const published = [...input.averageWageIndex.keys()];
    const latest = published.length === 0 ? null : Math.max(...published);
    if (latest === null) throw new RangeError('the average wage index series is empty');
    indexYear = Math.min(input.birthYear + INDEXING_AGE, latest);
    const rows: EngineEarningsYear[] = [...input.history];
    for (let year = input.firstFutureYear; year <= input.lastFutureYear; year += 1) {
      rows.push({ year, earnings: Math.min(input.futureAnnualEarnings, rules.wageBase) });
    }
    aime = averageIndexedMonthlyEarnings(indexEarnings(rows, input.averageWageIndex, indexYear));
    pia = piaFromAime(aime, rules);
  }
  const factor = claimFactor(input.claimMonths, fraMonths, rules);
  return {
    indexYear,
    aime,
    pia,
    fraMonths,
    claimMonths: input.claimMonths,
    factor,
    monthly: monthlyBenefit(pia, factor),
  };
}

/**
 * The benefit paid during the year the worker is `ageYears` old (start of year
 * = birthday), in today's dollars. COLAs track inflation, so the real benefit
 * is flat once claimed — except under the stress toggle, which pays
 * `stressPayableRatio` of it from `stressFromYear` on.
 */
export function socialSecurityForYear(
  derivation: SocialSecurityDerivation,
  ageYears: number,
  calendarYear: number,
  stress: boolean,
  rules: SocialSecurityRules,
): number {
  const monthsPaid = Math.max(
    0,
    Math.min(12, ageYears * 12 + 12 - Math.max(derivation.claimMonths, ageYears * 12)),
  );
  const ratio = stress && calendarYear >= rules.stressFromYear ? rules.stressPayableRatio : 1;
  return derivation.monthly * monthsPaid * ratio;
}
