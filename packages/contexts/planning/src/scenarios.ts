// SPDX-License-Identifier: MIT
/**
 * Saved scenarios: the holder's baseline plan and named forks of it (WP 4.6,
 * `plan_scenarios`, migration 0022; 07 §5.10; D20).
 *
 * ## The baseline is what the holder *states*; the rest is read at run time
 *
 * A baseline row holds the plan facts no ledger can supply — a birth date, a
 * retirement and plan-end age, a glidepath, a withdrawal policy, a Social
 * Security statement, pensions — as a validated `profile`. Everything that
 * *can* be observed is not stored here: starting balances by tax bucket come
 * from a sealed `net_worth_daily` day, contributions and spending from WP
 * 4.3's revealed behaviour (09 GOAL-4), each at projection time. So a baseline
 * never goes stale by holding yesterday's balance, and a run records which
 * sealed day it started from.
 *
 * ## A fork is a delta, never a copy
 *
 * 07 §5.10's eight levers — `retire_age`, `savings_rate`, `annual_spending`,
 * `expected_return_shift`, `ss_claim_age`, `part_time_income`,
 * `one_time_windfall`, `glidepath` — and nothing else. `diffLevers` drops a
 * lever equal to the baseline's own value before anything is written (WP 4.2's
 * `diffOverrides`, one table over), and a fork left with no lever is refused:
 * a fork that restated the baseline's spending would keep the old number after
 * the holder corrected the baseline, and the compare screen would show a
 * difference nobody chose. The migration's `plan_scenarios_shape` and
 * `plan_scenarios_levers_are_deltas` make a copy inexpressible in the column.
 *
 * ## One seed, on the baseline
 *
 * A fork has no seed of its own (`plan_scenarios_seed_is_the_baselines`). Every
 * run of every fork uses its baseline's seed, so a compare is under common
 * random numbers (07 §5.4 detail 1) by construction, not by a caller
 * remembering to pass the same number twice.
 *
 * ## No JSON number in either document
 *
 * Ages and years are strings, rates decimal strings, amounts
 * `{"minor": "…", "currency": "…"}` — `plan_document_has_no_json_number`
 * refuses anything else (D3 does not stop at the serialisation edge).
 */
import {
  DateOnly,
  Money,
  newId,
  type Clock,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import { configHash } from '@core/platform';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { canonicalDecimal, compareDecimal, DECIMAL_PATTERN } from './assumptions.ts';
import {
  MAX_PLAN_AGE,
  PROJECTION_BUCKETS,
  type BucketPlan,
  type ClaimAge,
  type GlidepathChoice,
  type IncomePlan,
  type PensionColaChoice,
  type PensionPlan,
  type ProjectionBucket,
  type ProjectionPlan,
} from './engine/boundary.ts';
import { oneTimeInflow, type UnappliedReason } from './life-events.ts';
import { ProjectionRefused } from './projection-store.ts';
import type { PlanningExecutor } from './store.ts';

export const SCENARIO_NAME_MAX_LENGTH = 96;

// ---------------------------------------------------------------------------
// Shared encodings
// ---------------------------------------------------------------------------

const decimalString = z.string().regex(DECIMAL_PATTERN);
const ageString = z.string().regex(/^(0|[1-9][0-9]{0,2})$/);
const dateString = z.string().refine((text) => DateOnly.is(text), 'a date as YYYY-MM-DD');
const amountJson = z.strictObject({
  minor: z.string().regex(/^-?(0|[1-9][0-9]{0,18})$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
const glidepathString = z
  .string()
  .regex(/^(age_based|target_date|rising_equity|static:(0|1|0\.[0-9]+|1\.0+))$/);
const claimAgeString = z.string().regex(/^[0-9]{2,3}y([0-9]|1[01])m$/);

function amountOf(json: z.infer<typeof amountJson>): MoneyType {
  return Money.fromJSON(json);
}

function jsonOfAmount(money: MoneyType): { minor: string; currency: string } {
  return Money.toJSON(money) as { minor: string; currency: string };
}

export function encodeGlidepath(choice: GlidepathChoice): string {
  return choice.kind === 'static' ? `static:${canonicalDecimal(choice.equityShare)}` : choice.kind;
}

export function decodeGlidepath(text: string): GlidepathChoice {
  if (text.startsWith('static:')) return { kind: 'static', equityShare: text.slice(7) };
  if (text === 'age_based' || text === 'target_date' || text === 'rising_equity') {
    return { kind: text };
  }
  throw new ProjectionRefused('planning.scenario_invalid', `unknown glidepath ${text}`);
}

export function encodeClaimAge(claim: ClaimAge): string {
  return `${String(claim.years)}y${String(claim.months)}m`;
}

export function decodeClaimAge(text: string): ClaimAge {
  const match = /^([0-9]{2,3})y([0-9]{1,2})m$/.exec(text);
  if (match === null) throw new ProjectionRefused('planning.scenario_invalid', `claim age ${text}`);
  return {
    years: Number.parseInt(match[1] ?? '', 10),
    months: Number.parseInt(match[2] ?? '', 10),
  };
}

function encodeCola(cola: PensionColaChoice): string {
  return cola.kind === 'fixed' ? `fixed:${canonicalDecimal(cola.rate)}` : cola.kind;
}

function decodeCola(text: string): PensionColaChoice {
  if (text.startsWith('fixed:')) return { kind: 'fixed', rate: text.slice(6) };
  if (text === 'none' || text === 'cpi') return { kind: text };
  throw new ProjectionRefused('planning.scenario_invalid', `unknown pension COLA ${text}`);
}

// ---------------------------------------------------------------------------
// The baseline profile
// ---------------------------------------------------------------------------

/** The holder's stated plan — everything a ledger cannot observe. */
export interface BaselineProfile {
  readonly birthDate: DateOnlyType;
  readonly retirementAge: number;
  readonly planEndAge: number;
  readonly currency: string;
  readonly glidepath: GlidepathChoice;
  readonly contributionGrowth: 'wage' | 'flat';
  /** Retirement spending, today's dollars. `null`: 09 GOAL-4's observed non-savings spending. */
  readonly annualSpending: MoneyType | null;
  readonly withdrawalPolicy: 'constant_real' | 'guardrails';
  /** 07 §5.6's floor: the revealed essential spend, none, or a stated amount. */
  readonly spendingFloor: 'essential_spend' | 'none' | MoneyType;
  /** Guyton-Klinger's cumulative real-cut cap. Absent = the engine's default (0.2). */
  readonly cumulativeCutCap?: string | null;
  /** 07 §5.7 phase 1's blended effective rate on tax-deferred withdrawals. */
  readonly taxDeferredRate: string;
  readonly socialSecurity: {
    readonly monthlyPia: MoneyType;
    readonly claimAge: ClaimAge;
    readonly stressAfter2034: boolean;
  } | null;
  readonly pensions: readonly PensionPlan[];
  /**
   * Stated annual contributions per bucket. `null`, or a bucket absent: WP
   * 4.3's revealed contributions for that bucket (and the run says which).
   */
  readonly contributions: Readonly<Partial<Record<ProjectionBucket, MoneyType>>> | null;
}

const bucketAmounts = z
  .strictObject({
    TAXABLE: amountJson.optional(),
    TAX_DEFERRED: amountJson.optional(),
    ROTH: amountJson.optional(),
    HSA: amountJson.optional(),
  })
  .nullable();

const profileJsonSchema = z.strictObject({
  birthDate: dateString,
  retirementAge: ageString,
  planEndAge: ageString,
  currency: z.string().regex(/^[A-Z]{3}$/),
  glidepath: glidepathString,
  contributionGrowth: z.enum(['wage', 'flat']),
  annualSpending: amountJson.nullable(),
  withdrawalPolicy: z.enum(['constant_real', 'guardrails']),
  spendingFloor: z.union([z.enum(['essential_spend', 'none']), amountJson]),
  cumulativeCutCap: decimalString.nullable().optional(),
  taxDeferredRate: decimalString,
  socialSecurity: z
    .strictObject({
      monthlyPia: amountJson,
      claimAge: claimAgeString,
      stressAfter2034: z.boolean(),
    })
    .nullable(),
  pensions: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(96),
        startAge: ageString,
        annualBenefit: amountJson,
        cola: z.string().regex(/^(none|cpi|fixed:-?(0|[1-9][0-9]*)(\.[0-9]+)?)$/),
      }),
    )
    .max(8),
  contributions: bucketAmounts,
});

export type BaselineProfileJson = z.infer<typeof profileJsonSchema>;

function invalidScenario(message: string): ProjectionRefused {
  return new ProjectionRefused('planning.scenario_invalid', message);
}

function assertAge(age: number, field: string): number {
  if (!Number.isInteger(age) || age < 0 || age > MAX_PLAN_AGE) {
    throw invalidScenario(`${field} must be a whole age within 0..${String(MAX_PLAN_AGE)}`);
  }
  return age;
}

/** Profile → its stored document. Validates as it goes; the result has no JSON number. */
export function profileToJson(profile: BaselineProfile): BaselineProfileJson {
  const inCurrency = (money: MoneyType, field: string) => {
    if (money.currency !== profile.currency) {
      throw invalidScenario(`${field} is ${money.currency}; the plan is ${profile.currency}`);
    }
    return jsonOfAmount(money);
  };
  assertAge(profile.retirementAge, 'retirementAge');
  assertAge(profile.planEndAge, 'planEndAge');
  if (profile.retirementAge > profile.planEndAge) {
    throw invalidScenario('retirementAge must not be after planEndAge');
  }
  const contributions: Partial<Record<ProjectionBucket, { minor: string; currency: string }>> = {};
  for (const bucket of PROJECTION_BUCKETS) {
    const stated = profile.contributions?.[bucket];
    if (stated !== undefined) contributions[bucket] = inCurrency(stated, `contributions.${bucket}`);
  }
  const document: BaselineProfileJson = {
    birthDate: profile.birthDate,
    retirementAge: String(profile.retirementAge),
    planEndAge: String(profile.planEndAge),
    currency: profile.currency,
    glidepath: encodeGlidepath(profile.glidepath),
    contributionGrowth: profile.contributionGrowth,
    annualSpending:
      profile.annualSpending === null ? null : inCurrency(profile.annualSpending, 'annualSpending'),
    withdrawalPolicy: profile.withdrawalPolicy,
    spendingFloor:
      typeof profile.spendingFloor === 'string'
        ? profile.spendingFloor
        : inCurrency(profile.spendingFloor, 'spendingFloor'),
    ...(profile.cumulativeCutCap === undefined
      ? {}
      : {
          cumulativeCutCap:
            profile.cumulativeCutCap === null ? null : canonicalDecimal(profile.cumulativeCutCap),
        }),
    taxDeferredRate: canonicalDecimal(profile.taxDeferredRate),
    socialSecurity:
      profile.socialSecurity === null
        ? null
        : {
            monthlyPia: inCurrency(profile.socialSecurity.monthlyPia, 'socialSecurity.monthlyPia'),
            claimAge: encodeClaimAge(profile.socialSecurity.claimAge),
            stressAfter2034: profile.socialSecurity.stressAfter2034,
          },
    pensions: profile.pensions.map((pension, index) => ({
      name: pension.name,
      startAge: String(assertAge(pension.startAge, `pensions.${String(index)}.startAge`)),
      annualBenefit: inCurrency(pension.annualBenefit, `pensions.${String(index)}`),
      cola: encodeCola(pension.cola),
    })),
    contributions: profile.contributions === null ? null : contributions,
  };
  // Round-trip through the schema so what is written is exactly what is read.
  const parsed = profileJsonSchema.safeParse(document);
  if (!parsed.success) {
    throw invalidScenario(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}

/** A stored profile document → the profile. Refuses anything the schema does not describe. */
export function profileFromJson(raw: unknown): BaselineProfile {
  const parsed = profileJsonSchema.safeParse(raw);
  if (!parsed.success) {
    throw invalidScenario(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const json = parsed.data;
  const contributions: Partial<Record<ProjectionBucket, MoneyType>> = {};
  for (const bucket of PROJECTION_BUCKETS) {
    const stated = json.contributions?.[bucket];
    if (stated !== undefined) contributions[bucket] = amountOf(stated);
  }
  return Object.freeze({
    birthDate: DateOnly.parse(json.birthDate),
    retirementAge: Number.parseInt(json.retirementAge, 10),
    planEndAge: Number.parseInt(json.planEndAge, 10),
    currency: json.currency,
    glidepath: decodeGlidepath(json.glidepath),
    contributionGrowth: json.contributionGrowth,
    annualSpending: json.annualSpending === null ? null : amountOf(json.annualSpending),
    withdrawalPolicy: json.withdrawalPolicy,
    spendingFloor:
      typeof json.spendingFloor === 'string' ? json.spendingFloor : amountOf(json.spendingFloor),
    ...(json.cumulativeCutCap === undefined ? {} : { cumulativeCutCap: json.cumulativeCutCap }),
    taxDeferredRate: json.taxDeferredRate,
    socialSecurity:
      json.socialSecurity === null
        ? null
        : {
            monthlyPia: amountOf(json.socialSecurity.monthlyPia),
            claimAge: decodeClaimAge(json.socialSecurity.claimAge),
            stressAfter2034: json.socialSecurity.stressAfter2034,
          },
    pensions: json.pensions.map((pension) => ({
      name: pension.name,
      startAge: Number.parseInt(pension.startAge, 10),
      annualBenefit: amountOf(pension.annualBenefit),
      cola: decodeCola(pension.cola),
    })),
    contributions: json.contributions === null ? null : contributions,
  });
}

// ---------------------------------------------------------------------------
// Levers (07 §5.10)
// ---------------------------------------------------------------------------

/**
 * A fork's levers. Every field optional; what is present is a delta against
 * the baseline. Stored under 07 §5.10's own snake_case names (`LEVER_KEYS`).
 */
export interface ScenarioLevers {
  /** Replaces the baseline's retirement age. */
  readonly retireAge?: number;
  /**
   * Additional share of annual income saved, as a decimal (`'0.02'` = save 2%
   * of income more). Added to `TAXABLE` (the engine's extra-contribution
   * bucket); a negative share reduces contributions in withdrawal order.
   */
  readonly savingsRate?: string;
  /** Replaces the retirement spending, today's dollars. */
  readonly annualSpending?: MoneyType;
  /** Added to both sleeves' nominal return (e.g. `'-0.01'`). */
  readonly expectedReturnShift?: string;
  /** Replaces the Social Security claim age. */
  readonly ssClaimAge?: ClaimAge;
  /** Income from the retirement age for `years` years, today's dollars. */
  readonly partTimeIncome?: { readonly annual: MoneyType; readonly years: number };
  /** A positive lump sum on a date — applied exactly as a positive life event. */
  readonly oneTimeWindfall?: { readonly amount: MoneyType; readonly on: DateOnlyType };
  readonly glidepath?: GlidepathChoice;
}

/** 07 §5.10's names, the only keys `plan_scenario_levers_are_well_formed` accepts. */
export const LEVER_KEYS = Object.freeze({
  retireAge: 'retire_age',
  savingsRate: 'savings_rate',
  annualSpending: 'annual_spending',
  expectedReturnShift: 'expected_return_shift',
  ssClaimAge: 'ss_claim_age',
  partTimeIncome: 'part_time_income',
  oneTimeWindfall: 'one_time_windfall',
  glidepath: 'glidepath',
} as const);

const leversJsonSchema = z.strictObject({
  retire_age: ageString.optional(),
  savings_rate: decimalString.optional(),
  annual_spending: amountJson.optional(),
  expected_return_shift: decimalString.optional(),
  ss_claim_age: claimAgeString.optional(),
  part_time_income: z
    .strictObject({ annual: amountJson, years: z.string().regex(/^[0-9]{1,2}$/) })
    .optional(),
  one_time_windfall: z.strictObject({ amount: amountJson, on: dateString }).optional(),
  glidepath: glidepathString.optional(),
});

export type ScenarioLeversJson = z.infer<typeof leversJsonSchema>;

function leverInvalid(message: string): ProjectionRefused {
  return new ProjectionRefused('planning.scenario_lever_invalid', message);
}

/** Levers → their stored document (no JSON number). */
export function leversToJson(levers: ScenarioLevers): ScenarioLeversJson {
  const json: ScenarioLeversJson = {
    ...(levers.retireAge === undefined ? {} : { retire_age: String(levers.retireAge) }),
    ...(levers.savingsRate === undefined
      ? {}
      : { savings_rate: canonicalDecimal(levers.savingsRate) }),
    ...(levers.annualSpending === undefined
      ? {}
      : { annual_spending: jsonOfAmount(levers.annualSpending) }),
    ...(levers.expectedReturnShift === undefined
      ? {}
      : { expected_return_shift: canonicalDecimal(levers.expectedReturnShift) }),
    ...(levers.ssClaimAge === undefined ? {} : { ss_claim_age: encodeClaimAge(levers.ssClaimAge) }),
    ...(levers.partTimeIncome === undefined
      ? {}
      : {
          part_time_income: {
            annual: jsonOfAmount(levers.partTimeIncome.annual),
            years: String(levers.partTimeIncome.years),
          },
        }),
    ...(levers.oneTimeWindfall === undefined
      ? {}
      : {
          one_time_windfall: {
            amount: jsonOfAmount(levers.oneTimeWindfall.amount),
            on: levers.oneTimeWindfall.on,
          },
        }),
    ...(levers.glidepath === undefined ? {} : { glidepath: encodeGlidepath(levers.glidepath) }),
  };
  const parsed = leversJsonSchema.safeParse(json);
  if (!parsed.success) {
    throw leverInvalid(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  return parsed.data;
}

export function leversFromJson(raw: unknown): ScenarioLevers {
  const parsed = leversJsonSchema.safeParse(raw);
  if (!parsed.success) {
    throw leverInvalid(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const json = parsed.data;
  return Object.freeze({
    ...(json.retire_age === undefined ? {} : { retireAge: Number.parseInt(json.retire_age, 10) }),
    ...(json.savings_rate === undefined ? {} : { savingsRate: json.savings_rate }),
    ...(json.annual_spending === undefined
      ? {}
      : { annualSpending: amountOf(json.annual_spending) }),
    ...(json.expected_return_shift === undefined
      ? {}
      : { expectedReturnShift: json.expected_return_shift }),
    ...(json.ss_claim_age === undefined ? {} : { ssClaimAge: decodeClaimAge(json.ss_claim_age) }),
    ...(json.part_time_income === undefined
      ? {}
      : {
          partTimeIncome: {
            annual: amountOf(json.part_time_income.annual),
            years: Number.parseInt(json.part_time_income.years, 10),
          },
        }),
    ...(json.one_time_windfall === undefined
      ? {}
      : {
          oneTimeWindfall: {
            amount: amountOf(json.one_time_windfall.amount),
            on: DateOnly.parse(json.one_time_windfall.on),
          },
        }),
    ...(json.glidepath === undefined ? {} : { glidepath: decodeGlidepath(json.glidepath) }),
  });
}

function sameClaim(a: ClaimAge, b: ClaimAge): boolean {
  return a.years === b.years && a.months === b.months;
}

/**
 * The levers to store: validated, and **every lever equal to the baseline's
 * own value dropped**. What remains is the fork's whole identity; nothing
 * that restates the baseline survives to go stale when the baseline moves.
 *
 * @throws {ProjectionRefused} `planning.scenario_lever_invalid` for a lever out of range;
 *   `planning.scenario_levers_empty` when nothing differs from the baseline.
 */
export function diffLevers(profile: BaselineProfile, levers: ScenarioLevers): ScenarioLevers {
  const kept: {
    -readonly [K in keyof ScenarioLevers]: ScenarioLevers[K];
  } = {};
  const currencyOf = (money: MoneyType, lever: string) => {
    if (money.currency !== profile.currency) {
      throw leverInvalid(`${lever} is ${money.currency}; the plan is ${profile.currency}`);
    }
  };

  if (levers.retireAge !== undefined) {
    if (
      !Number.isInteger(levers.retireAge) ||
      levers.retireAge < 0 ||
      levers.retireAge > profile.planEndAge
    ) {
      throw leverInvalid(
        `retire_age must be a whole age no later than ${String(profile.planEndAge)}`,
      );
    }
    if (levers.retireAge !== profile.retirementAge) kept.retireAge = levers.retireAge;
  }
  if (levers.savingsRate !== undefined) {
    if (
      !DECIMAL_PATTERN.test(levers.savingsRate) ||
      compareDecimal(levers.savingsRate, '-1') < 0 ||
      compareDecimal(levers.savingsRate, '1') > 0
    ) {
      throw leverInvalid('savings_rate is a decimal share of income within -1..1, e.g. "0.02"');
    }
    if (compareDecimal(levers.savingsRate, '0') !== 0) {
      kept.savingsRate = canonicalDecimal(levers.savingsRate);
    }
  }
  if (levers.annualSpending !== undefined) {
    currencyOf(levers.annualSpending, 'annual_spending');
    if (Money.isNegative(levers.annualSpending)) {
      throw leverInvalid('annual_spending must not be negative');
    }
    if (
      profile.annualSpending === null ||
      !Money.equals(profile.annualSpending, levers.annualSpending)
    ) {
      kept.annualSpending = levers.annualSpending;
    }
  }
  if (levers.expectedReturnShift !== undefined) {
    if (
      !DECIMAL_PATTERN.test(levers.expectedReturnShift) ||
      compareDecimal(levers.expectedReturnShift, '-0.2') < 0 ||
      compareDecimal(levers.expectedReturnShift, '0.2') > 0
    ) {
      throw leverInvalid('expected_return_shift is a decimal within -0.2..0.2, e.g. "-0.01"');
    }
    if (compareDecimal(levers.expectedReturnShift, '0') !== 0) {
      kept.expectedReturnShift = canonicalDecimal(levers.expectedReturnShift);
    }
  }
  if (levers.ssClaimAge !== undefined) {
    if (profile.socialSecurity === null) {
      throw leverInvalid('ss_claim_age needs a baseline with Social Security');
    }
    const claim = levers.ssClaimAge;
    if (
      !Number.isInteger(claim.years) ||
      !Number.isInteger(claim.months) ||
      claim.years < 62 ||
      claim.years > 70 ||
      (claim.years === 70 && claim.months > 0) ||
      claim.months < 0 ||
      claim.months > 11
    ) {
      throw leverInvalid('ss_claim_age is between 62y0m and 70y0m');
    }
    if (!sameClaim(claim, profile.socialSecurity.claimAge)) kept.ssClaimAge = claim;
  }
  if (levers.partTimeIncome !== undefined) {
    const { annual, years } = levers.partTimeIncome;
    currencyOf(annual, 'part_time_income');
    if (Money.isNegative(annual) || !Number.isInteger(years) || years < 0 || years > 40) {
      throw leverInvalid('part_time_income is a non-negative amount for 0–40 years');
    }
    if (Money.isPositive(annual) && years > 0) kept.partTimeIncome = { annual, years };
  }
  if (levers.oneTimeWindfall !== undefined) {
    currencyOf(levers.oneTimeWindfall.amount, 'one_time_windfall');
    if (!Money.isPositive(levers.oneTimeWindfall.amount)) {
      throw leverInvalid('one_time_windfall is a positive amount; an outflow is a life event');
    }
    kept.oneTimeWindfall = levers.oneTimeWindfall;
  }
  if (levers.glidepath !== undefined) {
    if (encodeGlidepath(levers.glidepath) !== encodeGlidepath(profile.glidepath)) {
      kept.glidepath = levers.glidepath;
    }
  }

  if (Object.keys(kept).length === 0) {
    throw new ProjectionRefused(
      'planning.scenario_levers_empty',
      'every lever equals the baseline: a fork that changes nothing is a copy, and a copy is ' +
        'never stored',
    );
  }
  return Object.freeze(kept);
}

/** What `applyLevers` could and could not express, for the run's record. */
export interface LeverApplication {
  readonly plan: ProjectionPlan;
  readonly windfall:
    | { readonly status: 'applied'; readonly age: number }
    | { readonly status: 'unapplied'; readonly reason: UnappliedReason }
    | null;
}

type MutableBucket = { -readonly [K in keyof BucketPlan]: BucketPlan[K] };

function withContribution(
  buckets: readonly BucketPlan[],
  bucket: ProjectionBucket,
  change: (current: MoneyType) => MoneyType,
  currency: string,
): BucketPlan[] {
  const out: MutableBucket[] = buckets.map((entry) => ({ ...entry }));
  const existing = out.find((entry) => entry.bucket === bucket);
  if (existing === undefined) {
    out.push({
      bucket,
      startingBalance: Money.zero(currency),
      annualContribution: change(Money.zero(currency)),
    });
  } else {
    existing.annualContribution = change(existing.annualContribution);
  }
  return out;
}

/**
 * The baseline's assembled plan with a fork's levers applied. Pure, Money
 * only: every lever is a replacement or an exact `Money` operation, so a fork
 * differs from its baseline by exactly its levers and nothing rounds twice.
 *
 * @throws {ProjectionRefused} `planning.scenario_income_unknown` when `savings_rate`
 *   needs an income the revealed derivation could not supply;
 *   `planning.scenario_lever_invalid` when a negative `savings_rate` exceeds every contribution.
 */
export function applyLevers(
  base: ProjectionPlan,
  levers: ScenarioLevers,
  context: { readonly annualIncome: MoneyType | null },
): LeverApplication {
  let plan: ProjectionPlan = base;
  if (levers.retireAge !== undefined) plan = { ...plan, retirementAge: levers.retireAge };
  if (levers.annualSpending !== undefined)
    plan = { ...plan, annualSpending: levers.annualSpending };
  if (levers.expectedReturnShift !== undefined) {
    plan = { ...plan, returnShift: levers.expectedReturnShift };
  }
  if (levers.glidepath !== undefined) plan = { ...plan, glidepath: levers.glidepath };
  if (levers.ssClaimAge !== undefined) {
    if (plan.socialSecurity === null) {
      throw leverInvalid('ss_claim_age needs a baseline with Social Security');
    }
    plan = { ...plan, socialSecurity: { ...plan.socialSecurity, claimAge: levers.ssClaimAge } };
  }
  if (levers.partTimeIncome !== undefined) {
    const stream: IncomePlan = {
      name: 'lever:part_time_income',
      startAge: plan.retirementAge,
      endAge: Math.min(plan.retirementAge + levers.partTimeIncome.years, plan.planEndAge),
      annual: levers.partTimeIncome.annual,
    };
    plan = { ...plan, otherIncome: [...plan.otherIncome, stream] };
  }
  if (levers.savingsRate !== undefined) {
    if (context.annualIncome === null) {
      throw new ProjectionRefused(
        'planning.scenario_income_unknown',
        'savings_rate is a share of income, and no income could be derived for this plan ' +
          '(WP 4.3 reports insufficient history or nothing derivable)',
      );
    }
    const extra = Money.multiplyByDecimal(context.annualIncome, levers.savingsRate, 'half-even');
    const bucket = plan.extraContributionBucket ?? 'TAXABLE';
    if (!Money.isNegative(extra)) {
      plan = {
        ...plan,
        buckets: withContribution(plan.buckets, bucket, (c) => Money.add(c, extra), plan.currency),
      };
    } else {
      // Save less: take the reduction out of contributions in withdrawal order
      // (07 §5.7's TAXABLE → TAX_DEFERRED → ROTH → HSA), never below zero.
      let remaining = Money.negate(extra);
      const buckets: MutableBucket[] = plan.buckets.map((entry) => ({ ...entry }));
      for (const name of plan.withdrawalOrder ?? PROJECTION_BUCKETS) {
        const entry = buckets.find((candidate) => candidate.bucket === name);
        if (entry === undefined || Money.isZero(remaining)) continue;
        const cut = Money.min(entry.annualContribution, remaining);
        entry.annualContribution = Money.subtract(entry.annualContribution, cut);
        remaining = Money.subtract(remaining, cut);
      }
      if (Money.isPositive(remaining)) {
        throw leverInvalid(
          `savings_rate ${levers.savingsRate} reduces saving by more than the plan contributes`,
        );
      }
      plan = { ...plan, buckets };
    }
  }
  let windfall: LeverApplication['windfall'] = null;
  if (levers.oneTimeWindfall !== undefined) {
    const outcome = oneTimeInflow(
      {
        key: 'lever:one_time_windfall',
        occursOn: levers.oneTimeWindfall.on,
        amount: levers.oneTimeWindfall.amount,
      },
      plan,
    );
    if ('reason' in outcome) {
      windfall = { status: 'unapplied', reason: outcome.reason };
    } else {
      windfall = { status: 'applied', age: outcome.age };
      plan = { ...plan, otherIncome: [...plan.otherIncome, outcome.stream] };
    }
  }
  return Object.freeze({ plan, windfall });
}

// ---------------------------------------------------------------------------
// Storage: plan_scenarios
// ---------------------------------------------------------------------------

export interface BaselineScenario {
  readonly kind: 'baseline';
  readonly id: string;
  readonly name: string;
  readonly profile: BaselineProfile;
  /** Unsigned 64-bit. Every fork of this baseline runs on it. */
  readonly seed: bigint;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ForkScenario {
  readonly kind: 'fork';
  readonly id: string;
  readonly baselineId: string;
  readonly name: string;
  readonly levers: ScenarioLevers;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type Scenario = BaselineScenario | ForkScenario;

interface RawScenario extends Record<string, unknown> {
  id: string;
  kind: string;
  baseline_id: string | null;
  name: string;
  profile: unknown;
  levers: unknown;
  seed: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

const COLUMNS = sql`id, kind, baseline_id, name, profile, levers, seed::text AS seed, created_at, updated_at`;

function scenarioOf(raw: RawScenario): Scenario {
  const createdAt = new Date(raw.created_at);
  const updatedAt = new Date(raw.updated_at);
  if (raw.kind === 'baseline') {
    return Object.freeze({
      kind: 'baseline',
      id: raw.id,
      name: raw.name,
      profile: profileFromJson(raw.profile),
      seed: BigInt(raw.seed ?? '0'),
      createdAt,
      updatedAt,
    });
  }
  return Object.freeze({
    kind: 'fork',
    id: raw.id,
    baselineId: raw.baseline_id ?? '',
    name: raw.name,
    levers: leversFromJson(raw.levers),
    createdAt,
    updatedAt,
  });
}

function assertName(name: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed === '' || trimmed.length > SCENARIO_NAME_MAX_LENGTH) {
    throw invalidScenario(`name must be 1–${String(SCENARIO_NAME_MAX_LENGTH)} characters`);
  }
  return trimmed;
}

/**
 * The default seed for a new baseline: the first 64 bits of a SHA-256 over its
 * id. Deterministic (no RNG, nothing to lint-ban), distinct per baseline, and
 * stored — so it is the stored `bigint` 04 §5.6 asks for, not a recomputation.
 */
export function defaultSeedFor(scenarioId: string): bigint {
  return BigInt(`0x${configHash({ planScenarioSeed: scenarioId }).slice(0, 16)}`);
}

/** The holder's baseline, or `null` before they have stated one. */
export async function getBaseline(
  executor: PlanningExecutor,
  userId: string,
): Promise<BaselineScenario | null> {
  const result = await executor.execute<RawScenario>(sql`
    SELECT ${COLUMNS} FROM plan_scenarios
     WHERE user_id = ${userId}::uuid AND kind = 'baseline'
  `);
  const raw = result.rows[0];
  return raw === undefined ? null : (scenarioOf(raw) as BaselineScenario);
}

/** One scenario, or `planning.scenario_not_found` — the same 404 for "not yours". */
export async function getScenario(
  executor: PlanningExecutor,
  userId: string,
  scenarioId: string,
): Promise<Scenario> {
  const result = await executor.execute<RawScenario>(sql`
    SELECT ${COLUMNS} FROM plan_scenarios
     WHERE user_id = ${userId}::uuid AND id = ${scenarioId}::uuid
  `);
  const raw = result.rows[0];
  if (raw === undefined) {
    throw new ProjectionRefused('planning.scenario_not_found', `no scenario ${scenarioId}`);
  }
  return scenarioOf(raw);
}

/** The baseline first, then its forks oldest first. */
export async function listScenarios(
  executor: PlanningExecutor,
  userId: string,
): Promise<readonly Scenario[]> {
  const result = await executor.execute<RawScenario>(sql`
    SELECT ${COLUMNS} FROM plan_scenarios
     WHERE user_id = ${userId}::uuid
     ORDER BY (kind = 'baseline') DESC, created_at, id
  `);
  return result.rows.map(scenarioOf);
}

/**
 * State (or restate) the baseline. One per holder; a second call replaces the
 * profile and keeps the id and the seed, so every fork and every stored run
 * still points at it.
 */
export async function saveBaseline(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly name: string;
    readonly profile: BaselineProfile;
    /** Only honoured when the baseline is first created. */
    readonly seed?: bigint;
    readonly clock: Clock;
  },
): Promise<BaselineScenario> {
  const name = assertName(input.name);
  const profile = profileToJson(input.profile);
  const now = input.clock.now().toISOString();
  const existing = await getBaseline(executor, input.userId);
  if (existing !== null) {
    const result = await executor.execute<RawScenario>(sql`
      UPDATE plan_scenarios
         SET name = ${name}, profile = ${JSON.stringify(profile)}::jsonb,
             updated_at = ${now}::timestamptz
       WHERE user_id = ${input.userId}::uuid AND id = ${existing.id}::uuid
      RETURNING ${COLUMNS}
    `);
    const raw = result.rows[0];
    if (raw === undefined) throw new Error('plan_scenarios baseline update returned no row');
    return scenarioOf(raw) as BaselineScenario;
  }
  const id = newId();
  const seed = input.seed ?? defaultSeedFor(id);
  if (seed < 0n || seed >= 1n << 64n)
    throw invalidScenario('seed must be an unsigned 64-bit integer');
  const result = await executor.execute<RawScenario>(sql`
    INSERT INTO plan_scenarios (id, user_id, kind, baseline_id, name, profile, levers, seed,
                                created_at, updated_at)
    VALUES (${id}::uuid, ${input.userId}::uuid, 'baseline', NULL, ${name},
            ${JSON.stringify(profile)}::jsonb, NULL, ${seed.toString()}::numeric,
            ${now}::timestamptz, ${now}::timestamptz)
    RETURNING ${COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('plan_scenarios baseline insert returned no row');
  return scenarioOf(raw) as BaselineScenario;
}

async function requireBaseline(
  executor: PlanningExecutor,
  userId: string,
  baselineId?: string,
): Promise<BaselineScenario> {
  if (baselineId !== undefined) {
    const named = await getScenario(executor, userId, baselineId);
    if (named.kind !== 'baseline') {
      throw new ProjectionRefused(
        'planning.scenario_fork_of_fork',
        'a scenario forks the baseline; a fork of a fork would make a delta against a delta',
      );
    }
    return named;
  }
  const baseline = await getBaseline(executor, userId);
  if (baseline === null) {
    throw new ProjectionRefused(
      'planning.scenario_no_baseline',
      'state a baseline plan before forking it',
    );
  }
  return baseline;
}

/** Fork the baseline. Stores the levers that differ from it — and nothing else. */
export async function createScenario(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly name: string;
    readonly levers: ScenarioLevers;
    readonly baselineId?: string;
    readonly clock: Clock;
  },
): Promise<ForkScenario> {
  const name = assertName(input.name);
  const baseline = await requireBaseline(executor, input.userId, input.baselineId);
  const levers = leversToJson(diffLevers(baseline.profile, input.levers));
  const now = input.clock.now().toISOString();
  const result = await executor.execute<RawScenario>(sql`
    INSERT INTO plan_scenarios (id, user_id, kind, baseline_id, name, profile, levers, seed,
                                created_at, updated_at)
    VALUES (${newId()}::uuid, ${input.userId}::uuid, 'fork', ${baseline.id}::uuid, ${name},
            NULL, ${JSON.stringify(levers)}::jsonb, NULL,
            ${now}::timestamptz, ${now}::timestamptz)
    RETURNING ${COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('plan_scenarios fork insert returned no row');
  return scenarioOf(raw) as ForkScenario;
}

/** Replace a fork's levers (PUT semantics), diffed against its baseline as on create. */
export async function updateScenarioLevers(
  executor: PlanningExecutor,
  input: {
    readonly userId: string;
    readonly scenarioId: string;
    readonly levers: ScenarioLevers;
    readonly name?: string;
    readonly clock: Clock;
  },
): Promise<ForkScenario> {
  const scenario = await getScenario(executor, input.userId, input.scenarioId);
  if (scenario.kind !== 'fork') {
    throw invalidScenario('the baseline has no levers; restate it with saveBaseline');
  }
  const baseline = await requireBaseline(executor, input.userId, scenario.baselineId);
  const levers = leversToJson(diffLevers(baseline.profile, input.levers));
  const name = input.name === undefined ? scenario.name : assertName(input.name);
  const result = await executor.execute<RawScenario>(sql`
    UPDATE plan_scenarios
       SET levers = ${JSON.stringify(levers)}::jsonb, name = ${name},
           updated_at = ${input.clock.now().toISOString()}::timestamptz
     WHERE user_id = ${input.userId}::uuid AND id = ${scenario.id}::uuid
    RETURNING ${COLUMNS}
  `);
  const raw = result.rows[0];
  if (raw === undefined) throw new Error('plan_scenarios fork update returned no row');
  return scenarioOf(raw) as ForkScenario;
}

/** Delete a fork (its runs go with it). The baseline is restated, never deleted. */
export async function deleteScenario(
  executor: PlanningExecutor,
  input: { readonly userId: string; readonly scenarioId: string },
): Promise<void> {
  const scenario = await getScenario(executor, input.userId, input.scenarioId);
  if (scenario.kind === 'baseline') {
    throw new ProjectionRefused(
      'planning.scenario_baseline_not_deletable',
      'the baseline is the plan every fork and goal evaluation is measured against; restate it',
    );
  }
  await executor.execute(sql`
    DELETE FROM plan_scenarios
     WHERE user_id = ${input.userId}::uuid AND id = ${scenario.id}::uuid AND kind = 'fork'
  `);
}
