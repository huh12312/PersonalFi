// SPDX-License-Identifier: MIT
/**
 * THE NUMERIC BOUNDARY of the projection engine (dispatch §3 WP 4.4, §5 risk 1).
 *
 * > "inputs arrive as `Money` / `DateOnly` / decimal-string rates, are
 * > converted once at a single named function, the engine's interior is
 * > `number`, and results re-enter as `Money` rounded once at the boundary"
 * > — 04 §5.6; CONVENTIONS "Floats are correct for Monte Carlo… They may never
 * > flow back into a `*_minor` column without an explicit, rounded conversion."
 *
 * The named pair is **`toEngineAmount`** (Money → engine dollars) and
 * **`fromEngineAmount`** (engine dollars → Money, rounded half-even exactly
 * once). Rates and other dimensionless decimals cross through
 * `toEngineRate` / `fromEngineRatio`; calendar dates through `ageOn` and
 * `wholeYearsFrom`. Every other file under `src/engine/` is interior: it
 * never sees a `Money`, never calls `Number()`/`parseFloat` on one, never
 * reads `.minor` — and `boundary.test.ts` greps them to prove it.
 *
 * ## Why the round trip is exact to 1e15 minor units
 *
 * `toEngineAmount` is `Number(minor) / 10^scale`. `Number(minor)` is exact for
 * |minor| ≤ 2^53 − 1 (≈ 9.007e15), so the only rounding is the division, which
 * IEEE-754 does correctly (½ ulp). Going back, `x × 10^scale` adds at most
 * another ½ ulp. At 1e15 minor (USD $10 trillion) the two together are
 * ≤ 100 × ½ulp(1e13) + ½ulp(1e15) ≈ 0.098 + 0.0625 ≈ 0.16 of a minor unit, well
 * inside the ½ that half-even rounding tolerates, so `from(to(m)) === m`. Past
 * 2^53 − 1 the input is refused rather than silently rounded, and so is a
 * result whose minor-unit count would exceed it (or is NaN or ±∞).
 *
 * ## `EngineDollars` is `number`, named
 *
 * `EngineDollars` is an alias for `number` meaning "a float count of today's
 * major currency units, interior only". `scripts/check-numeric-boundaries.ts`
 * is syntactic and does not resolve aliases, so it cannot see this crossing —
 * the dispatch (§5, WP 4.14) is explicit that the ALLOW_LIST should gain one
 * entry per crossing function; that is WP 4.14's edit, recorded in the WP 4.4
 * evidence. Until then `boundary.test.ts` holds a stricter line of its own: no
 * identifier anywhere under `src/engine/` outside this file may even be
 * *spelled* like a magnitude (amount / balance / price / value / cost /
 * quantity), whatever its type.
 */
import {
  CurrencyMismatchError,
  DateOnly,
  Money,
  currency as currencyCode,
  minorUnitScale,
  type CurrencyCode,
} from '@core/kernel';
import {
  DECIMAL_PATTERN,
  canonicalDecimal,
  taxYear,
  type AssumptionsFile,
  type AssumptionsVersion,
} from '../assumptions.ts';
import type { EngineGlidepath } from './glidepath.ts';
import type { EngineCorrelation, EngineCrypto } from './montecarlo.ts';
import { GUYTON_KLINGER, decisionNames, guytonKlingerRules } from './guardrails.ts';
import type { EnginePensionCola } from './pension.ts';
import type { EngineSocialSecurity, SocialSecurityRules } from './social-security.ts';
import {
  ENGINE_VERSION,
  HSA,
  ROTH,
  TAXABLE,
  TAX_DEFERRED,
  type EngineOneOff,
  type EnginePlan,
  type PathResult,
  type PreparedPlan,
} from './deterministic.ts';

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type ProjectionRefusalCode =
  | 'planning.projection_currency_mismatch'
  | 'planning.projection_amount_out_of_range'
  | 'planning.projection_rate_invalid'
  | 'planning.projection_ages_invalid'
  | 'planning.projection_negative_input'
  | 'planning.projection_bucket_repeated'
  | 'planning.projection_order_invalid'
  | 'planning.projection_floor_above_spending'
  | 'planning.projection_claim_age_invalid'
  | 'planning.projection_target_outside_plan';

/** A projection input the engine will not compute on. `domain` / 422 — never clamped. */
export class ProjectionInputRefused extends Error {
  override readonly name = 'ProjectionInputRefused';
  readonly code: ProjectionRefusalCode;
  readonly field: string;

  constructor(code: ProjectionRefusalCode, field: string, detail: string) {
    super(`${field}: ${detail}`);
    this.code = code;
    this.field = field;
  }
}

export function isProjectionInputRefused(error: unknown): error is ProjectionInputRefused {
  return (
    error instanceof Error &&
    typeof (error as Error & { code?: unknown }).code === 'string' &&
    (error as Error & { code: string }).code.startsWith('planning.projection_')
  );
}

// ---------------------------------------------------------------------------
// The named pair
// ---------------------------------------------------------------------------

/** A float count of today's major currency units. Interior only; see the header. */
export type EngineDollars = number;

const MAX_EXACT_MINOR = Number.MAX_SAFE_INTEGER;

/** Banker's rounding on a float, exact: `x − floor(x)` has no rounding error below 2^52. */
function roundHalfEven(scaled: number): number {
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Money → engine dollars. **The one way in.** Refuses another currency and a
 * minor-unit count past 2^53 − 1 (where `Number()` would stop being exact).
 */
export function toEngineAmount(
  money: Money,
  expected: CurrencyCode,
  field = 'amount',
): EngineDollars {
  if (money.currency !== expected) {
    throw new ProjectionInputRefused(
      'planning.projection_currency_mismatch',
      field,
      new CurrencyMismatchError(expected, money.currency).message,
    );
  }
  const minor = money.minor;
  if (minor > BigInt(MAX_EXACT_MINOR) || minor < -BigInt(MAX_EXACT_MINOR)) {
    throw new ProjectionInputRefused(
      'planning.projection_amount_out_of_range',
      field,
      `${minor.toString()} minor units is beyond 2^53 − 1 and cannot enter the engine exactly`,
    );
  }
  return Number(minor) / 10 ** minorUnitScale(money.currency);
}

/**
 * Engine dollars → Money. **The one way out**, rounded half-even exactly once.
 * NaN, ±∞ and anything past 2^53 − 1 minor units are refused, never clamped.
 */
export function fromEngineAmount(
  dollars: EngineDollars,
  code: CurrencyCode,
  field = 'result',
): Money {
  if (!Number.isFinite(dollars)) {
    throw new ProjectionInputRefused(
      'planning.projection_amount_out_of_range',
      field,
      `the engine produced ${String(dollars)}, which is not a finite amount`,
    );
  }
  const scaled = dollars * 10 ** minorUnitScale(code);
  if (Math.abs(scaled) > MAX_EXACT_MINOR) {
    throw new ProjectionInputRefused(
      'planning.projection_amount_out_of_range',
      field,
      `the engine produced ${String(dollars)}, beyond 2^53 − 1 minor units`,
    );
  }
  return Money.of(BigInt(roundHalfEven(scaled)), code);
}

/** A decimal string (a rate, a share, an index) → `number`. Dimensionless: no rounding question. */
export function toEngineRate(decimal: string, field = 'rate'): number {
  if (typeof decimal !== 'string' || !DECIMAL_PATTERN.test(decimal)) {
    throw new ProjectionInputRefused(
      'planning.projection_rate_invalid',
      field,
      `expected a decimal string such as "0.065", got ${JSON.stringify(decimal)}`,
    );
  }
  return Number(decimal);
}

/** A dimensionless engine result (a cut, a factor, a return) → a canonical decimal string. */
export function fromEngineRatio(ratio: number, places = 6): string {
  if (!Number.isFinite(ratio)) {
    throw new ProjectionInputRefused(
      'planning.projection_amount_out_of_range',
      'ratio',
      `the engine produced ${String(ratio)}`,
    );
  }
  return canonicalDecimal(ratio.toFixed(places));
}

/** Whole years of age on `asOf`. A birthday not yet reached this year has not counted. */
export function ageOn(birthDate: DateOnly, asOf: DateOnly): number {
  let age = DateOnly.year(asOf) - DateOnly.year(birthDate);
  const monthDelta = DateOnly.month(asOf) - DateOnly.month(birthDate);
  if (monthDelta < 0 || (monthDelta === 0 && DateOnly.day(asOf) < DateOnly.day(birthDate))) {
    age -= 1;
  }
  return age;
}

/** Whole years from `from` to `to` (floor); negative when `to` is earlier. */
export function wholeYearsFrom(from: DateOnly, to: DateOnly): number {
  return ageOn(from, to);
}

// ---------------------------------------------------------------------------
// The Money-side plan
// ---------------------------------------------------------------------------

/** 07 §5.2's four tax buckets. Same values as WP 4.3's `TaxBucket` (unify when both land). */
export const PROJECTION_BUCKETS = ['TAXABLE', 'TAX_DEFERRED', 'ROTH', 'HSA'] as const;
export type ProjectionBucket = (typeof PROJECTION_BUCKETS)[number];

const SLOT: Readonly<Record<ProjectionBucket, number>> = Object.freeze({
  TAXABLE,
  TAX_DEFERRED,
  ROTH,
  HSA,
});

/** 07 §5.7 phase 2's default order; phase 1 uses it too. */
export const DEFAULT_WITHDRAWAL_ORDER: readonly ProjectionBucket[] = Object.freeze([
  'TAXABLE',
  'TAX_DEFERRED',
  'ROTH',
  'HSA',
]);

export type GlidepathChoice =
  | { readonly kind: 'age_based' }
  | { readonly kind: 'target_date' }
  | { readonly kind: 'rising_equity' }
  | { readonly kind: 'static'; readonly equityShare: string };

export interface BucketPlan {
  readonly bucket: ProjectionBucket;
  readonly startingBalance: Money;
  /** First-year contribution, today's dollars. */
  readonly annualContribution: Money;
  /** This bucket's own allocation (07 §5.2: "each bucket carries its own asset allocation"). */
  readonly glidepath?: GlidepathChoice;
}

export interface ClaimAge {
  readonly years: number;
  readonly months: number;
}

export type SocialSecurityPlan =
  | {
      readonly kind: 'statement';
      /** Monthly PIA at full retirement age, today's dollars, from the SSA statement. */
      readonly monthlyPia: Money;
      readonly claimAge: ClaimAge;
      /** 07 §5.8's "75% benefit after 2034" stress toggle. */
      readonly stressAfter2034: boolean;
    }
  | {
      readonly kind: 'earnings';
      /** Taxed (capped) earnings per calendar year, as the SSA statement reports them. */
      readonly history: readonly { readonly year: number; readonly earnings: Money }[];
      /** SSA OACT's national average wage index series, as published (decimal strings). */
      readonly averageWageIndex: readonly { readonly year: number; readonly index: string }[];
      /** Covered earnings per future working year, today's dollars; capped at the wage base. */
      readonly futureAnnualEarnings: Money | null;
      readonly claimAge: ClaimAge;
      readonly stressAfter2034: boolean;
    };

export type PensionColaChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'cpi' }
  | { readonly kind: 'fixed'; readonly rate: string };

export interface PensionPlan {
  readonly name: string;
  readonly startAge: number;
  /** Annual payment when it starts, in that year's (nominal) dollars — as a plan statement quotes it. */
  readonly annualBenefit: Money;
  readonly cola: PensionColaChoice;
}

export interface IncomePlan {
  readonly name: string;
  readonly startAge: number;
  /** Exclusive. */
  readonly endAge: number;
  /** Today's dollars per year. */
  readonly annual: Money;
}

/**
 * A dated one-off flow (WP 5.5): a stored life event that leaves — a home
 * purchase, college, a sabbatical — or the solver's "a one-off this year".
 * Signed, **today's dollars** (the projection's basis, like every life event):
 * positive arrives, negative leaves. It lands in the year of the holder's age
 * on `occursOn`; `toEnginePlan` converts both halves here, at the one crossing.
 */
export interface OneOffPlan {
  readonly name: string;
  readonly occursOn: DateOnly;
  readonly amount: Money;
}

export type WithdrawalPolicyChoice =
  | { readonly kind: 'constant_real' }
  | {
      readonly kind: 'guardrails';
      /** 07 §5.6: essential spend. `null` = no floor. */
      readonly spendingFloor: Money | null;
      /** Default '0.2' (07 §5.6). `null` = unmodified Guyton-Klinger (for comparison only). */
      readonly cumulativeCutCap?: string | null;
    };

export interface ProjectionPlan {
  readonly currency: string;
  readonly asOf: DateOnly;
  readonly birthDate: DateOnly;
  readonly retirementAge: number;
  /** The age at the end of the last projected year (07 §5.2's `death`). */
  readonly planEndAge: number;
  readonly buckets: readonly BucketPlan[];
  /** `wage`: contributions grow at g_real (07 §5.2). `flat`: constant in today's dollars. */
  readonly contributionGrowth: 'wage' | 'flat';
  readonly glidepath: GlidepathChoice;
  /** Planned annual spending in retirement, today's dollars. */
  readonly annualSpending: Money;
  readonly withdrawalPolicy: WithdrawalPolicyChoice;
  /** 07 §5.7 phase 1: blended effective tax rate on tax-deferred withdrawals, e.g. '0.15'. */
  readonly taxDeferredRate: string;
  readonly withdrawalOrder?: readonly ProjectionBucket[];
  readonly socialSecurity: SocialSecurityPlan | null;
  readonly pensions: readonly PensionPlan[];
  readonly otherIncome: readonly IncomePlan[];
  /** 07 §5.10 `expected_return_shift`, added to both sleeves' nominal return. Default '0'. */
  readonly returnShift?: string;
  /** Where a solved additional contribution goes. Default TAXABLE. */
  readonly extraContributionBucket?: ProjectionBucket;
  /**
   * Dated one-off flows (WP 5.5). Absent and empty are the same plan; the
   * projection service fills it with the holder's stored outflows.
   */
  readonly oneOffs?: readonly OneOffPlan[];
}

/** What the engine needs of WP 4.2: a file and its version (an `Assumptions` or a `ResolvedAssumptions`). */
export interface AssumptionsLike {
  readonly version: AssumptionsVersion;
  readonly file: AssumptionsFile;
}

/** The oldest age a plan may run to. Past this the input is refused as a typo, not projected. */
export const MAX_PLAN_AGE = 120;

function assertWholeAge(age: number, field: string): void {
  if (!Number.isInteger(age) || age < 0 || age > MAX_PLAN_AGE) {
    throw new ProjectionInputRefused(
      'planning.projection_ages_invalid',
      field,
      `an age is a whole number of years within 0..${String(MAX_PLAN_AGE)}, got ${String(age)}`,
    );
  }
}

function nonNegative(dollars: number, field: string): number {
  if (dollars < 0) {
    throw new ProjectionInputRefused(
      'planning.projection_negative_input',
      field,
      'must not be negative',
    );
  }
  return dollars;
}

function shareOf(decimal: string, field: string): number {
  const share = toEngineRate(decimal, field);
  if (share < 0 || share > 1) {
    throw new ProjectionInputRefused(
      'planning.projection_rate_invalid',
      field,
      `must be within [0, 1], got ${decimal}`,
    );
  }
  return share;
}

function glidepathOf(choice: GlidepathChoice, field: string): EngineGlidepath {
  return choice.kind === 'static'
    ? { kind: 'static', equityShare: shareOf(choice.equityShare, `${field}.equityShare`) }
    : { kind: choice.kind };
}

/** The Social Security parameters, read from the assumptions file (never inlined). */
export function socialSecurityRulesFrom(
  assumptions: AssumptionsLike,
  year: number,
): SocialSecurityRules {
  const ss = taxYear(assumptions, year).socialSecurity;
  const code = currencyCode('USD');
  const fraction = (node: { readonly numerator: string; readonly denominator: string }) =>
    toEngineRate(node.numerator) / toEngineRate(node.denominator);
  const stress = assumptions.file.socialSecurityStress;
  return Object.freeze({
    bendFirst: toEngineAmount(ss.bendPoints.first.value, code, 'bendPoints.first'),
    bendSecond: toEngineAmount(ss.bendPoints.second.value, code, 'bendPoints.second'),
    factorBelowFirst: toEngineRate(ss.piaFactors.belowFirst.value),
    factorBetween: toEngineRate(ss.piaFactors.betweenBendPoints.value),
    factorAboveSecond: toEngineRate(ss.piaFactors.aboveSecond.value),
    fullRetirementAge: ss.fullRetirementAge.value.map((row) => ({
      bornFrom: toEngineRate(row.bornFrom),
      bornThrough: row.bornThrough === null ? null : toEngineRate(row.bornThrough),
      months: toEngineRate(row.age) * 12,
    })),
    earlyFirst36PerMonth: fraction(ss.earlyReductionPerMonth.first36Months.value),
    earlyBeyondPerMonth: fraction(ss.earlyReductionPerMonth.beyond36Months.value),
    delayedCreditPerYear: toEngineRate(ss.delayedRetirementCreditPerYear.value),
    delayedCreditEndsAtMonths: toEngineRate(ss.delayedRetirementCreditEndsAtAge.value) * 12,
    cola: toEngineRate(ss.cola.value),
    wageBase: toEngineAmount(ss.taxableWageBase.value, code, 'taxableWageBase'),
    stressFromYear: toEngineRate(stress.fromCalendarYear.value),
    stressPayableRatio: toEngineRate(stress.payableRatio.value),
  });
}

function claimMonthsOf(claim: ClaimAge, field: string): number {
  if (
    !Number.isInteger(claim.years) ||
    !Number.isInteger(claim.months) ||
    claim.months < 0 ||
    claim.months > 11 ||
    claim.years < 62 ||
    claim.years > MAX_PLAN_AGE
  ) {
    throw new ProjectionInputRefused(
      'planning.projection_claim_age_invalid',
      field,
      'a claim age is whole years (62 or later) and 0–11 months',
    );
  }
  return claim.years * 12 + claim.months;
}

function socialSecurityOf(
  plan: ProjectionPlan,
  code: CurrencyCode,
  birthYear: number,
): EngineSocialSecurity | null {
  const ss = plan.socialSecurity;
  if (ss === null) return null;
  const claimMonths = claimMonthsOf(ss.claimAge, 'socialSecurity.claimAge');
  if (ss.kind === 'statement') {
    return {
      kind: 'statement',
      monthlyPia: nonNegative(
        toEngineAmount(ss.monthlyPia, code, 'socialSecurity.monthlyPia'),
        'socialSecurity.monthlyPia',
      ),
      claimMonths,
      birthYear,
      stress: ss.stressAfter2034,
    };
  }
  const averageWageIndex = new Map<number, number>();
  for (const row of ss.averageWageIndex) {
    averageWageIndex.set(row.year, toEngineRate(row.index, `averageWageIndex.${String(row.year)}`));
  }
  const history = ss.history.map((row) => ({
    year: row.year,
    earnings: nonNegative(
      toEngineAmount(row.earnings, code, `socialSecurity.history.${String(row.year)}`),
      'socialSecurity.history',
    ),
  }));
  const lastHistoryYear = history.reduce((latest, row) => Math.max(latest, row.year), 0);
  const future =
    ss.futureAnnualEarnings === null
      ? 0
      : nonNegative(
          toEngineAmount(ss.futureAnnualEarnings, code, 'socialSecurity.futureAnnualEarnings'),
          'socialSecurity.futureAnnualEarnings',
        );
  return {
    kind: 'earnings',
    history,
    averageWageIndex,
    futureAnnualEarnings: future,
    firstFutureYear: Math.max(lastHistoryYear + 1, DateOnly.year(plan.asOf)),
    lastFutureYear: future > 0 ? birthYear + plan.retirementAge - 1 : 0,
    claimMonths,
    birthYear,
    stress: ss.stressAfter2034,
  };
}

function colaOf(choice: PensionColaChoice, field: string): EnginePensionCola {
  return choice.kind === 'fixed'
    ? { kind: 'fixed', rate: toEngineRate(choice.rate, `${field}.rate`) }
    : { kind: choice.kind };
}

/**
 * The whole plan, converted once. Every `Money` goes through `toEngineAmount`,
 * every rate through `toEngineRate`, both dates through `ageOn`; the
 * capital-market and Social Security parameters come from `assumptions`.
 */
export function toEnginePlan(plan: ProjectionPlan, assumptions: AssumptionsLike): EnginePlan {
  const code = currencyCode(plan.currency);
  const startAge = ageOn(plan.birthDate, plan.asOf);
  if (startAge < 0) {
    throw new ProjectionInputRefused(
      'planning.projection_ages_invalid',
      'birthDate',
      'is after asOf',
    );
  }
  assertWholeAge(plan.retirementAge, 'retirementAge');
  assertWholeAge(plan.planEndAge, 'planEndAge');
  if (plan.planEndAge <= startAge || plan.retirementAge > plan.planEndAge) {
    throw new ProjectionInputRefused(
      'planning.projection_ages_invalid',
      'planEndAge',
      `the plan must end after today's age (${String(startAge)}) and no earlier than retirement`,
    );
  }

  const wealth0 = [0, 0, 0, 0];
  const contribution0 = [0, 0, 0, 0];
  const glidepaths: EngineGlidepath[] = [];
  const planGlide = glidepathOf(plan.glidepath, 'glidepath');
  for (let slot = 0; slot < 4; slot += 1) glidepaths.push(planGlide);
  const seen = new Set<ProjectionBucket>();
  for (const bucket of plan.buckets) {
    if (seen.has(bucket.bucket)) {
      throw new ProjectionInputRefused(
        'planning.projection_bucket_repeated',
        'buckets',
        `${bucket.bucket} appears twice; one entry per tax bucket`,
      );
    }
    seen.add(bucket.bucket);
    const slot = SLOT[bucket.bucket];
    const field = `buckets.${bucket.bucket}`;
    wealth0[slot] = nonNegative(
      toEngineAmount(bucket.startingBalance, code, `${field}.startingBalance`),
      `${field}.startingBalance`,
    );
    contribution0[slot] = nonNegative(
      toEngineAmount(bucket.annualContribution, code, `${field}.annualContribution`),
      `${field}.annualContribution`,
    );
    if (bucket.glidepath !== undefined) {
      glidepaths[slot] = glidepathOf(bucket.glidepath, `${field}.glidepath`);
    }
  }

  const order = plan.withdrawalOrder ?? DEFAULT_WITHDRAWAL_ORDER;
  if (order.length !== 4 || new Set(order).size !== 4 || order.some((b) => !(b in SLOT))) {
    throw new ProjectionInputRefused(
      'planning.projection_order_invalid',
      'withdrawalOrder',
      'must name each of the four buckets exactly once',
    );
  }

  const market = assumptions.file.capitalMarket;
  const inflation = toEngineRate(market.inflation.mean.value, 'inflation.mean');
  const shift = toEngineRate(plan.returnShift ?? '0', 'returnShift');
  const wageGrowth = inflation + toEngineRate(market.wageGrowth.spreadOverInflation.value);
  const spending = nonNegative(
    toEngineAmount(plan.annualSpending, code, 'annualSpending'),
    'annualSpending',
  );
  const taxDeferredRate = toEngineRate(plan.taxDeferredRate, 'taxDeferredRate');
  if (taxDeferredRate < 0 || taxDeferredRate >= 1) {
    throw new ProjectionInputRefused(
      'planning.projection_rate_invalid',
      'taxDeferredRate',
      'a blended effective rate is within [0, 1)',
    );
  }

  let policy: EnginePlan['policy'] = { kind: 'constant_real' };
  if (plan.withdrawalPolicy.kind === 'guardrails') {
    const floor =
      plan.withdrawalPolicy.spendingFloor === null
        ? 0
        : nonNegative(
            toEngineAmount(plan.withdrawalPolicy.spendingFloor, code, 'spendingFloor'),
            'spendingFloor',
          );
    if (floor > spending) {
      throw new ProjectionInputRefused(
        'planning.projection_floor_above_spending',
        'spendingFloor',
        'essential spending above planned spending is a plan that starts below its own floor',
      );
    }
    const capText = plan.withdrawalPolicy.cumulativeCutCap;
    const cap =
      capText === undefined
        ? GUYTON_KLINGER.cumulativeCutCap
        : capText === null
          ? null
          : shareOf(capText, 'cumulativeCutCap');
    policy = { kind: 'guardrails', rules: guytonKlingerRules(floor, { cumulativeCutCap: cap }) };
  }

  const birthYear = DateOnly.year(plan.birthDate);
  const socialSecurity = socialSecurityOf(plan, code, birthYear);
  const oneOffs = oneOffsOf(plan, code, startAge);

  return Object.freeze({
    startAge,
    retireAge: plan.retirementAge,
    endAge: plan.planEndAge,
    startYear: DateOnly.year(plan.asOf),
    wealth0,
    contribution0,
    glidepaths,
    contributionGrowth:
      plan.contributionGrowth === 'wage' ? (1 + wageGrowth) / (1 + inflation) - 1 : 0,
    spending,
    inflation,
    equityNominal: toEngineRate(market.usEquity.expectedReturn.value, 'usEquity') + shift,
    bondNominal:
      toEngineRate(market.usAggregateBonds.expectedReturn.value, 'usAggregateBonds') + shift,
    taxDeferredRate,
    withdrawalOrder: order.map((bucket) => SLOT[bucket]),
    policy,
    socialSecurity,
    socialSecurityRules:
      socialSecurity === null
        ? null
        : socialSecurityRulesFrom(assumptions, DateOnly.year(plan.asOf)),
    pensions: plan.pensions.map((pension, index) => {
      assertWholeAge(pension.startAge, `pensions.${String(index)}.startAge`);
      return {
        startAge: pension.startAge,
        annualAtStart: nonNegative(
          toEngineAmount(pension.annualBenefit, code, `pensions.${String(index)}`),
          `pensions.${String(index)}`,
        ),
        cola: colaOf(pension.cola, `pensions.${String(index)}.cola`),
      };
    }),
    otherIncome: plan.otherIncome.map((stream, index) => {
      assertWholeAge(stream.startAge, `otherIncome.${String(index)}.startAge`);
      assertWholeAge(stream.endAge, `otherIncome.${String(index)}.endAge`);
      return {
        startAge: stream.startAge,
        endAge: stream.endAge,
        annualReal: nonNegative(
          toEngineAmount(stream.annual, code, `otherIncome.${String(index)}`),
          `otherIncome.${String(index)}`,
        ),
      };
    }),
    extraBucket: SLOT[plan.extraContributionBucket ?? 'TAXABLE'],
    ...(oneOffs.length === 0 ? {} : { oneOffs }),
  });
}

/**
 * The plan's dated one-offs in engine units: each date through `ageOn`, each
 * amount through `toEngineAmount` — the one crossing, in both halves. A flow
 * dated before the plan's start (its effect is already in the balances) or in
 * or after its last year is refused, never clamped: the projection service has
 * already set those aside by name, so one arriving here is a caller's bug.
 */
function oneOffsOf(plan: ProjectionPlan, code: CurrencyCode, startAge: number): EngineOneOff[] {
  return (plan.oneOffs ?? []).map((flow, index) => {
    const field = `oneOffs.${String(index)}`;
    if (DateOnly.isBefore(flow.occursOn, plan.asOf)) {
      throw new ProjectionInputRefused(
        'planning.projection_ages_invalid',
        `${field}.occursOn`,
        `${flow.occursOn} is before the plan starts (${plan.asOf}); its effect is in the balances`,
      );
    }
    const age = ageOn(plan.birthDate, flow.occursOn);
    if (age < startAge || age >= plan.planEndAge) {
      throw new ProjectionInputRefused(
        'planning.projection_ages_invalid',
        `${field}.occursOn`,
        `lands at age ${String(age)}, outside the plan's ages ${String(startAge)}..${String(plan.planEndAge - 1)}`,
      );
    }
    return Object.freeze({ age, real: toEngineAmount(flow.amount, code, `${field}.amount`) });
  });
}

// ---------------------------------------------------------------------------
// The Money-side result
// ---------------------------------------------------------------------------

export interface ProjectionBucketYear {
  readonly bucket: ProjectionBucket;
  readonly start: Money;
  readonly contribution: Money;
  /** Gross withdrawal, including the tax on a tax-deferred one. */
  readonly withdrawal: Money;
  readonly end: Money;
  /** This bucket's real return for the year, from its glidepath. */
  readonly realReturn: string;
}

export interface ProjectionYear {
  readonly index: number;
  readonly age: number;
  readonly calendarYear: number;
  readonly phase: 'accumulation' | 'retirement';
  /** Today's dollars. The stored series. */
  readonly startWealth: Money;
  readonly endWealth: Money;
  /** The same year-end in that year's dollars — a presentation of `endWealth`, never an input to it. */
  readonly endWealthNominal: Money;
  readonly buckets: readonly ProjectionBucketYear[];
  readonly tax: Money;
  readonly socialSecurity: Money;
  readonly pension: Money;
  readonly otherIncome: Money;
  readonly spending: Money;
  readonly shortfall: Money;
  readonly guardrail: readonly string[];
}

export interface SocialSecuritySummary {
  readonly indexYear: number | null;
  readonly aime: Money | null;
  readonly pia: Money;
  readonly fullRetirementAge: ClaimAge;
  readonly claimAge: ClaimAge;
  readonly claimFactor: string;
  readonly monthlyBenefit: Money;
}

export type DisplayBasis = 'real' | 'nominal';

export interface ProjectionResult {
  readonly engineVersion: string;
  readonly assumptionsVersion: AssumptionsVersion;
  readonly currency: CurrencyCode;
  /** Always `real`: what WP 4.6 stores. */
  readonly basis: 'real';
  readonly startAge: number;
  readonly retirementAge: number;
  readonly planEndAge: number;
  readonly years: readonly ProjectionYear[];
  /** The display toggle's output: year-end wealth in the requested basis. Never stored. */
  readonly display: DisplayBasis;
  readonly displayedEndWealth: readonly Money[];
  /** No unfunded spending in any year. */
  readonly success: boolean;
  readonly depletionAge: number | null;
  readonly terminalWealth: Money;
  readonly totalShortfall: Money;
  /** 07 §5.6: the deepest real cut from initial spending on this path, as a decimal ratio. */
  readonly worstSpendingCut: string;
  readonly socialSecurity: SocialSecuritySummary | null;
}

function ageOfMonths(months: number): ClaimAge {
  return { years: Math.floor(months / 12), months: months % 12 };
}

/** Every engine float → Money, each rounded exactly once from its float. */
export function toProjectionResult(
  path: PathResult,
  prepared: PreparedPlan,
  plan: ProjectionPlan,
  assumptions: AssumptionsLike,
  display: DisplayBasis,
): ProjectionResult {
  const code = currencyCode(plan.currency);
  const out = (dollars: number, field: string) => fromEngineAmount(dollars, code, field);
  const present = PROJECTION_BUCKETS.filter((bucket) =>
    plan.buckets.some((entry) => entry.bucket === bucket),
  );
  const years = path.records.map((record) => {
    let startTotal = 0;
    let endTotal = 0;
    for (const slot of record.startWealth) startTotal += slot;
    for (const slot of record.endWealth) endTotal += slot;
    const buckets = present.map((bucket) => {
      const slot = SLOT[bucket];
      return Object.freeze({
        bucket,
        start: out(record.startWealth[slot] ?? 0, `${bucket}.start`),
        contribution: out(record.contribution[slot] ?? 0, `${bucket}.contribution`),
        withdrawal: out(record.withdrawal[slot] ?? 0, `${bucket}.withdrawal`),
        end: out(record.endWealth[slot] ?? 0, `${bucket}.end`),
        realReturn: fromEngineRatio(record.realReturn[slot] ?? 0, 8),
      });
    });
    return Object.freeze({
      index: record.t,
      age: record.age,
      calendarYear: record.calendarYear,
      phase: record.retired ? ('retirement' as const) : ('accumulation' as const),
      startWealth: out(startTotal, 'startWealth'),
      endWealth: out(endTotal, 'endWealth'),
      endWealthNominal: out(endTotal * record.inflationIndex, 'endWealthNominal'),
      buckets: Object.freeze(buckets),
      tax: out(record.tax, 'tax'),
      socialSecurity: out(record.socialSecurity, 'socialSecurity'),
      pension: out(record.pension, 'pension'),
      otherIncome: out(record.otherIncome, 'otherIncome'),
      spending: out(record.spending, 'spending'),
      shortfall: out(record.shortfall, 'shortfall'),
      guardrail: Object.freeze(decisionNames(record.decisions)),
    });
  });
  const last = years[years.length - 1];
  if (last === undefined) throw new Error('a projection produced no years');
  const ss = prepared.socialSecurity;
  return Object.freeze({
    engineVersion: ENGINE_VERSION,
    assumptionsVersion: assumptions.version,
    currency: code,
    basis: 'real',
    startAge: prepared.plan.startAge,
    retirementAge: prepared.plan.retireAge,
    planEndAge: prepared.plan.endAge,
    years: Object.freeze(years),
    display,
    displayedEndWealth: Object.freeze(
      years.map((year) => (display === 'real' ? year.endWealth : year.endWealthNominal)),
    ),
    success: path.state.depletedAtAge < 0,
    depletionAge: path.state.depletedAtAge < 0 ? null : path.state.depletedAtAge,
    terminalWealth: last.endWealth,
    totalShortfall: out(path.state.shortfallTotal, 'totalShortfall'),
    worstSpendingCut: fromEngineRatio(path.state.guard.worstCut, 6),
    socialSecurity:
      ss === null
        ? null
        : Object.freeze({
            indexYear: ss.indexYear,
            aime: ss.aime === null ? null : out(ss.aime, 'aime'),
            pia: out(ss.pia, 'pia'),
            fullRetirementAge: ageOfMonths(ss.fraMonths),
            claimAge: ageOfMonths(ss.claimMonths),
            claimFactor: fromEngineRatio(ss.factor, 8),
            monthlyBenefit: out(ss.monthly, 'monthlyBenefit'),
          }),
  });
}

// ---------------------------------------------------------------------------
// The solver's crossings
// ---------------------------------------------------------------------------

/** The plan's currency, validated. */
export function planCurrency(plan: ProjectionPlan): CurrencyCode {
  return currencyCode(plan.currency);
}

/** A monthly contribution the solver found (engine dollars per *year*) → Money per month. */
export function monthlyFromAnnual(annual: number, code: CurrencyCode): Money {
  return fromEngineAmount(annual / 12, code, 'requiredMonthly');
}

/** A monthly Money → engine dollars per year, for re-verifying a rounded answer. */
export function annualFromMonthly(monthly: Money, code: CurrencyCode): number {
  return toEngineAmount(monthly, code, 'requiredMonthly') * 12;
}

/** The next representable Money up: one minor unit. Exact, bigint. */
export function nextMinorUnit(money: Money): Money {
  return Money.add(money, Money.of(1n, money.currency));
}

/** The engine's objective target, from a goal's Money target in either basis. */
export function toEngineTarget(
  target: Money,
  code: CurrencyCode,
  basis: 'real' | 'nominal',
  years: number,
  inflation: number,
): number {
  const dollars = nonNegative(toEngineAmount(target, code, 'target'), 'target');
  return basis === 'real' ? dollars : dollars / (1 + inflation) ** years;
}

export function toEngineCeiling(maxMonthly: Money, code: CurrencyCode): number {
  return nonNegative(toEngineAmount(maxMonthly, code, 'maxMonthly'), 'maxMonthly') * 12;
}

/** Engine dollars → Money for the solver's diagnostics (the gap at the ceiling). */
export function solverMoney(dollars: number, code: CurrencyCode, field: string): Money {
  return fromEngineAmount(dollars, code, field);
}

/** Money → whole minor units' worth of engine dollars, refused negative. The solver's action. */
export function toEngineAction(action: Money, code: CurrencyCode, field: string): number {
  return nonNegative(toEngineAmount(action, code, field), field);
}

/**
 * Whole months of `perYear` that `funded` pays for — ⌊12 × funded ÷ perYear⌋ —
 * computed in **exact bigint minor units from the two Money figures shown**, so
 * anyone can check it from the numbers on the screen (the gate computes one by
 * hand). `null` when there is no spending to divide by. Negative when `funded`
 * is: a flow that costs retirement months says so.
 */
export function wholeMonthsFunded(funded: Money, perYear: Money): number | null {
  if (funded.currency !== perYear.currency) {
    throw new ProjectionInputRefused(
      'planning.projection_currency_mismatch',
      'monthsOfSpending',
      new CurrencyMismatchError(perYear.currency, funded.currency).message,
    );
  }
  if (perYear.minor <= 0n) return null;
  const twelfths = funded.minor * 12n;
  // Floor toward −∞, so a small loss is −1 month rather than 0.
  let months = twelfths / perYear.minor;
  if (twelfths % perYear.minor !== 0n && twelfths < 0n) months -= 1n;
  return Number(months);
}

// ---------------------------------------------------------------------------
// The Monte Carlo's market parameters (WP 5.5; wp4.5 §10 item 6)
// ---------------------------------------------------------------------------

/** What the Monte Carlo reads from the assumptions file, in engine units. */
export interface MonteCarloMarket {
  readonly volatility: {
    readonly equity: number;
    readonly bond: number;
    readonly inflation: number;
  };
  readonly correlation: EngineCorrelation;
  /** Crypto's distribution parameters; the holding is the request's, not the file's. */
  readonly crypto: Omit<EngineCrypto, 'holding'>;
  /** 07 §6.4 treatment 1's disclaimer, verbatim — shown wherever a crypto assumption is. */
  readonly cryptoDisclaimer: string;
}

/**
 * The Monte Carlo's volatilities, correlation matrix and crypto parameters,
 * read once from the (resolved) assumptions file through `toEngineRate`.
 *
 * Here because this is the one file under `src/engine/` that may read a cited
 * node's `value` — WP 4.4's interior grep bans the spelling everywhere else,
 * and WP 4.5 had reached it from `worker-host.ts` through a `CITED = 'value'`
 * string accessor (a declared evasion, wp4.5 §10 item 6). That accessor is
 * gone; this is its proper home.
 */
export function monteCarloMarketFrom(assumptions: AssumptionsLike): MonteCarloMarket {
  const market = assumptions.file.capitalMarket;
  const correlation = assumptions.file.correlation.value;
  return {
    volatility: {
      equity: toEngineRate(market.usEquity.volatility.value, 'usEquity.volatility'),
      bond: toEngineRate(market.usAggregateBonds.volatility.value, 'usAggregateBonds.volatility'),
      inflation: toEngineRate(market.inflation.volatility.value, 'inflation.volatility'),
    },
    correlation: {
      assets: [...correlation.assets],
      matrix: correlation.matrix.map((row, i) =>
        row.map((cell, j) => toEngineRate(cell, `correlation[${String(i)}][${String(j)}]`)),
      ),
    },
    crypto: {
      expectedNominal: toEngineRate(market.crypto.expectedReturn.value, 'crypto.expectedReturn'),
      volatility: toEngineRate(market.crypto.volatility.value, 'crypto.volatility'),
      degreesOfFreedom: toEngineRate(
        market.crypto.degreesOfFreedom.value,
        'crypto.degreesOfFreedom',
      ),
    },
    cryptoDisclaimer: market.crypto.disclaimer.value,
  };
}

/**
 * Crypto held today → engine dollars: currency-checked, exact to 2^53, refused
 * negative. `null` or absent is no crypto. (WP 4.5 borrowed `toEngineTarget`
 * for this; the crossing now says what it is.)
 */
export function toEngineCryptoHolding(
  holding: Money | null | undefined,
  code: CurrencyCode,
): number {
  if (holding === undefined || holding === null) return 0;
  return nonNegative(toEngineAmount(holding, code, 'cryptoHolding'), 'cryptoHolding');
}
