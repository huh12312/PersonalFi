// SPDX-License-Identifier: MIT
/**
 * The deterministic projection — 07 §5.2, run per tax bucket, in today's dollars.
 *
 * ```
 * r_real = (1 + r_nominal) / (1 + i) − 1
 * g_real = (1 + wage_growth) / (1 + i) − 1
 * accumulation:  B_{t+1} = B_t × (1 + r_real) + C_t × (1 + r_real)^0.5,  C_t = C_0 × (1 + g_real)^t
 * decumulation:  W_t = spend_t − SS_t − pension_t − other_t
 *                B_{t+1} = (B_t − W_t − tax_t) × (1 + r_real)
 * ```
 *
 * ## One step function, two engines
 *
 * `stepYear` is the whole per-period recursion: glidepath → per-bucket real
 * return → contributions (mid-year) or spending policy → withdrawal ordering →
 * blended tax → growth. `runPath` is a loop around it. WP 4.5's Monte Carlo is
 * meant to call **this same `stepYear`** with drawn `MarketYear`s instead of
 * `expectedMarket(plan)` — so "zero volatility makes the Monte Carlo median
 * equal the deterministic path" (07 §8.4 invariant 1) holds by construction
 * rather than by two implementations agreeing. The step allocates nothing when
 * `record` is `null`: its scratch buffers live on the `PathState`.
 *
 * ## What is and is not in the recursion
 *
 *   * **Real only.** Every flow here is today's dollars. The nominal series is
 *     derived *after* the fact from the running inflation index and never
 *     feeds back (`'real and nominal never mix'` is the test).
 *   * **Tax: 07 §5.7 phase 1.** One blended effective rate on `TAX_DEFERRED`
 *     withdrawals, grossed up so the net covers the need. `TAXABLE` gains,
 *     bracket-filling, RMDs and IRMAA are not modelled (dispatch §1 cut line 1).
 *   * **Order: TAXABLE → TAX_DEFERRED → ROTH → HSA** by default (07 §5.7), the
 *     HSA last because it is the only bucket that is tax-free in and out.
 *   * **Income before retirement** (a Social Security claim at 62 with
 *     retirement at 65) is saved into `TAXABLE` under the same mid-year
 *     convention; after retirement it offsets spending. A surplus in
 *     retirement (income above spending) is deposited into `TAXABLE` at the
 *     start of the year.
 *   * **Failure does not stop the path** (07 §5.4 detail 2): a depleted
 *     portfolio keeps running on income alone and the unfunded spending is
 *     accumulated as `shortfallTotal`, so the result reports magnitude, not a
 *     boolean.
 *   * **Dated one-off flows** (WP 5.5, on WP 4.5's design — wp4.5 §10 item
 *     10): a signed `oneOffByYear`, built once by `preparePlan` from the
 *     plan's `oneOffs` (which `boundary.ts#toEnginePlan` converts from Money,
 *     the one crossing), read once per year. **Before retirement** an inflow
 *     joins `TAXABLE`'s contribution under the mid-year convention (exactly as
 *     income does); an outflow is drawn at mid-year through the withdrawal
 *     order, `TAXABLE` first, a `TAX_DEFERRED` draw grossed up by the blended
 *     rate. **In retirement** the flow is added to the year's need *outside*
 *     the spending policy — the guardrails never see a house purchase as
 *     spending, and never cut or raise around it. An outflow the buckets
 *     cannot fund is a **shortfall** like any other unfunded dollar, and dates
 *     depletion: WP 4.5 left that undecided, and a plan that cannot pay for
 *     the house it has planned does not sustain. A plan with no one-offs reads
 *     zeros and computes byte-identically to one without the field — the
 *     reference cases, golden drift and the golden vector are the proof.
 *
 * Interior module: `number` only, no money type. Money enters and leaves in
 * `boundary.ts`, and nowhere else.
 */
import { glidepathFunction, type EngineGlidepath, type GlidepathFunction } from './glidepath.ts';
import {
  newGuardrailState,
  startGuardrails,
  stepGuardrails,
  type GuardrailRules,
  type GuardrailState,
} from './guardrails.ts';
import {
  incomeForYear,
  pensionForYear,
  type EngineIncomeStream,
  type EnginePension,
} from './pension.ts';
import {
  deriveSocialSecurity,
  socialSecurityForYear,
  type EngineSocialSecurity,
  type SocialSecurityDerivation,
  type SocialSecurityRules,
} from './social-security.ts';

/**
 * Recorded on every run (WP 4.6's `projection_runs.engine_version`). Bump on any change that moves
 * an output for an input the engine already accepted.
 *
 * WP 5.5 added an *input* (`oneOffs`) and did not bump it: for every plan expressible before, the
 * recursion computes byte-identically (the one-off reads 0) — WP 4.14's reference cases, the golden
 * drift and WP 4.11's golden vector are unchanged to the bit — and a plan that now carries a
 * one-off has a different input digest, so the cache can never serve it an older answer. A bump
 * would also break WP 4.11's golden-vector pair on a string while every float agrees: the
 * serialised Monte Carlo header embeds this version, and the client kernel
 * (`apps/web/src/workers/kernel/deterministic.ts`, which does not model one-offs) says `/1`.
 */
export const ENGINE_VERSION = 'personalfi.deterministic/1';

/** Interior bucket order. The Money-side names are `PROJECTION_BUCKETS` in `boundary.ts`. */
export const TAXABLE = 0;
export const TAX_DEFERRED = 1;
export const ROTH = 2;
export const HSA = 3;
export const BUCKET_SLOTS = 4;

/** A shortfall smaller than half a cent is floating-point dust, not an unfunded dollar. */
export const SHORTFALL_TOLERANCE = 0.005;

export type EnginePolicy =
  | { readonly kind: 'constant_real' }
  | { readonly kind: 'guardrails'; readonly rules: GuardrailRules };

/** The whole plan in engine units. Built by `boundary.ts#toEnginePlan`, and only there. */
export interface EnginePlan {
  readonly startAge: number;
  readonly retireAge: number;
  /** The path runs for ages `startAge … endAge − 1`; `endAge` is the age at its last year-end. */
  readonly endAge: number;
  readonly startYear: number;
  /** Per bucket slot, today's dollars. */
  readonly wealth0: readonly number[];
  /** Per bucket slot, the first year's contribution in today's dollars. */
  readonly contribution0: readonly number[];
  readonly glidepaths: readonly EngineGlidepath[];
  /** `g_real`, or 0 for flat real contributions. */
  readonly contributionGrowth: number;
  /** Planned real spending in retirement, per year. */
  readonly spending: number;
  readonly inflation: number;
  readonly equityNominal: number;
  readonly bondNominal: number;
  /** 07 §5.7 phase 1: the blended effective tax rate on tax-deferred withdrawals. */
  readonly taxDeferredRate: number;
  readonly withdrawalOrder: readonly number[];
  readonly policy: EnginePolicy;
  readonly socialSecurity: EngineSocialSecurity | null;
  readonly socialSecurityRules: SocialSecurityRules | null;
  readonly pensions: readonly EnginePension[];
  readonly otherIncome: readonly EngineIncomeStream[];
  /** Where a solved additional contribution goes. */
  readonly extraBucket: number;
  /**
   * Dated one-off flows, today's dollars, signed: positive arrives, negative
   * leaves. Optional so an `EnginePlan` written before WP 5.5 (WP 4.11's
   * golden-vector fixture, the client kernel's port) still describes the
   * same plan.
   */
  readonly oneOffs?: readonly EngineOneOff[];
}

/** One dated flow: the age in whose year it lands, and its signed real size. */
export interface EngineOneOff {
  readonly age: number;
  readonly real: number;
}

/** One year of market outcomes, after inflation. Deterministic: constant. Monte Carlo: drawn. */
export interface MarketYear {
  readonly equityReal: number;
  readonly bondReal: number;
  readonly inflation: number;
}

/** An additional contribution under test (the solver's lever). */
export interface ExtraContribution {
  readonly annual: number;
  /** Contributions stop at the start of the year this age is reached. */
  readonly untilAge: number;
}

export const NO_EXTRA: ExtraContribution = Object.freeze({ annual: 0, untilAge: 0 });

/** A plan with its per-year income and glidepath functions resolved once. */
export interface PreparedPlan {
  readonly plan: EnginePlan;
  readonly years: number;
  readonly glide: readonly GlidepathFunction[];
  readonly socialSecurityByYear: Float64Array;
  readonly pensionByYear: Float64Array;
  readonly otherByYear: Float64Array;
  /** Signed one-off flows per year (WP 5.5): the sum of every `oneOffs` entry in that year. */
  readonly oneOffByYear: Float64Array;
  readonly socialSecurity: SocialSecurityDerivation | null;
}

export function realRate(nominal: number, inflation: number): number {
  return (1 + nominal) / (1 + inflation) - 1;
}

/** `r_real` for each sleeve at the plan's expected rates. */
export function expectedMarket(plan: EnginePlan): MarketYear {
  return {
    equityReal: realRate(plan.equityNominal, plan.inflation),
    bondReal: realRate(plan.bondNominal, plan.inflation),
    inflation: plan.inflation,
  };
}

export function preparePlan(plan: EnginePlan): PreparedPlan {
  const years = plan.endAge - plan.startAge;
  if (!Number.isInteger(years) || years <= 0) {
    throw new RangeError('a projection needs at least one year');
  }
  const socialSecurityByYear = new Float64Array(years);
  const pensionByYear = new Float64Array(years);
  const otherByYear = new Float64Array(years);
  const oneOffByYear = new Float64Array(years);
  for (const flow of plan.oneOffs ?? []) {
    const t = flow.age - plan.startAge;
    if (!Number.isInteger(t) || t < 0 || t >= years || !Number.isFinite(flow.real)) {
      throw new RangeError(`a one-off at age ${String(flow.age)} is outside the plan's years`);
    }
    oneOffByYear[t] = (oneOffByYear[t] ?? 0) + flow.real;
  }
  let socialSecurity: SocialSecurityDerivation | null = null;
  if (plan.socialSecurity !== null && plan.socialSecurityRules !== null) {
    socialSecurity = deriveSocialSecurity(plan.socialSecurity, plan.socialSecurityRules);
  }
  for (let t = 0; t < years; t += 1) {
    const age = plan.startAge + t;
    if (
      socialSecurity !== null &&
      plan.socialSecurity !== null &&
      plan.socialSecurityRules !== null
    ) {
      socialSecurityByYear[t] = socialSecurityForYear(
        socialSecurity,
        age,
        plan.startYear + t,
        plan.socialSecurity.stress,
        plan.socialSecurityRules,
      );
    }
    let pension = 0;
    for (const stream of plan.pensions) pension += pensionForYear(stream, age, t, plan.inflation);
    pensionByYear[t] = pension;
    let other = 0;
    for (const stream of plan.otherIncome) other += incomeForYear(stream, age);
    otherByYear[t] = other;
  }
  return {
    plan,
    years,
    glide: plan.glidepaths.map((glidepath) => glidepathFunction(glidepath)),
    socialSecurityByYear,
    pensionByYear,
    otherByYear,
    oneOffByYear,
    socialSecurity,
  };
}

/** Mutable per-path state, reused across the years of one path. */
export interface PathState {
  readonly wealth: Float64Array;
  readonly guard: GuardrailState;
  /** The portfolio's nominal return over the year just ended (the G-K inflation rule reads it). */
  lastNominalReturn: number;
  /** CPI change over the year just ended: the COLA a retiree's next withdrawal is measured against. */
  lastInflation: number;
  /** Π(1 + i) to the end of the year just stepped: today's dollars → that year's dollars. */
  inflationIndex: number;
  /** First age with an unfunded shortfall, or −1. */
  depletedAtAge: number;
  shortfallTotal: number;
  retiredYears: number;
  /** Scratch, so a Monte Carlo step allocates nothing. */
  readonly scratchReturn: Float64Array;
  readonly scratchWithdrawal: Float64Array;
}

export function newPathState(plan: EnginePlan): PathState {
  const wealth = new Float64Array(BUCKET_SLOTS);
  for (let b = 0; b < BUCKET_SLOTS; b += 1) wealth[b] = plan.wealth0[b] ?? 0;
  return {
    wealth,
    guard: newGuardrailState(),
    lastNominalReturn: 0,
    lastInflation: plan.inflation,
    inflationIndex: 1,
    depletedAtAge: -1,
    shortfallTotal: 0,
    retiredYears: 0,
    scratchReturn: new Float64Array(BUCKET_SLOTS),
    scratchWithdrawal: new Float64Array(BUCKET_SLOTS),
  };
}

/** Everything that happened in one year, for the deterministic path's table. Not produced in the MC loop. */
export interface YearRecord {
  readonly t: number;
  readonly age: number;
  readonly calendarYear: number;
  readonly retired: boolean;
  readonly startWealth: readonly number[];
  readonly contribution: readonly number[];
  readonly withdrawal: readonly number[];
  readonly realReturn: readonly number[];
  readonly endWealth: readonly number[];
  readonly tax: number;
  readonly socialSecurity: number;
  readonly pension: number;
  readonly otherIncome: number;
  /** Planned real spending (retirement years; 0 before). */
  readonly spending: number;
  readonly shortfall: number;
  /** End-of-year inflation index: multiply a real figure by this for that year's nominal dollars. */
  readonly inflationIndex: number;
  /** Guardrail decision bits (`guardrails.ts`). */
  readonly decisions: number;
}

function sumOf(slots: Float64Array): number {
  let total = 0;
  for (let b = 0; b < slots.length; b += 1) total += slots[b] ?? 0;
  return total;
}

/**
 * A working year's contribution into bucket `b`: the plan's own (wage-grown),
 * the solver's extra, and — into `TAXABLE` — income and an arriving one-off,
 * under the mid-year convention. A plain function rather than a closure, so the
 * Monte Carlo's year loop still allocates nothing.
 */
function workingContribution(
  plan: EnginePlan,
  b: number,
  growth: number,
  age: number,
  extra: ExtraContribution,
  income: number,
  oneOff: number,
): number {
  let c = (plan.contribution0[b] ?? 0) * growth;
  if (b === plan.extraBucket && age < extra.untilAge) c += extra.annual;
  if (b === TAXABLE) c += oneOff > 0 ? income + oneOff : income;
  return c;
}

/**
 * One year of the recursion. Mutates `state`; returns the record when asked for
 * one. The Monte Carlo passes `record = false` and a drawn `market`.
 */
export function stepYear(
  prepared: PreparedPlan,
  state: PathState,
  t: number,
  market: MarketYear,
  extra: ExtraContribution,
  record: boolean,
): YearRecord | null {
  const plan = prepared.plan;
  const age = plan.startAge + t;
  const retired = age >= plan.retireAge;
  const wealth = state.wealth;
  const returns = state.scratchReturn;
  const withdrawn = state.scratchWithdrawal;
  const startWealth = record ? Array.from(wealth) : null;
  const contribution = record ? [0, 0, 0, 0] : null;

  for (let b = 0; b < BUCKET_SLOTS; b += 1) {
    const equityShare = prepared.glide[b]?.(age, plan.retireAge) ?? 0;
    returns[b] = equityShare * market.equityReal + (1 - equityShare) * market.bondReal;
    withdrawn[b] = 0;
  }

  const socialSecurity = prepared.socialSecurityByYear[t] ?? 0;
  const pension = prepared.pensionByYear[t] ?? 0;
  const other = prepared.otherByYear[t] ?? 0;
  const income = socialSecurity + pension + other;
  // WP 5.5: this year's signed one-off; 0 for every plan without one.
  const oneOff = prepared.oneOffByYear[t] ?? 0;

  let spending = 0;
  let shortfall = 0;
  let tax = 0;
  let decisions = 0;
  // Post-flow, pre-growth wealth per bucket: the weights for the portfolio's return.
  let grownFrom = 0;
  let grownTo = 0;

  if (!retired) {
    const growth = (1 + plan.contributionGrowth) ** t;
    // An outflow is drawn at mid-year, in the withdrawal order, from what each
    // bucket holds then: its start grown half a year plus its contribution —
    // so no draw can take a bucket below zero at the year-end.
    let owed = oneOff < 0 ? -oneOff : 0;
    if (owed > 0) {
      for (const b of plan.withdrawalOrder) {
        if (owed <= 0) break;
        const available =
          (wealth[b] ?? 0) * Math.sqrt(1 + (returns[b] ?? 0)) +
          workingContribution(plan, b, growth, age, extra, income, oneOff);
        if (available <= 0) continue;
        const keep = b === TAX_DEFERRED ? 1 - plan.taxDeferredRate : 1;
        const gross = Math.min(available, owed / keep);
        withdrawn[b] = gross;
        if (b === TAX_DEFERRED) tax += gross * plan.taxDeferredRate;
        owed -= gross * keep;
      }
      shortfall = owed > SHORTFALL_TOLERANCE ? owed : 0;
    }
    for (let b = 0; b < BUCKET_SLOTS; b += 1) {
      const r = returns[b] ?? 0;
      const c = workingContribution(plan, b, growth, age, extra, income, oneOff);
      if (contribution !== null) contribution[b] = c;
      // The net mid-year flow: the contribution less any one-off drawn from this bucket (0 unless
      // this year carries an outflow, so a plan without one computes exactly what it did before).
      const net = c - (withdrawn[b] ?? 0);
      const start = wealth[b] ?? 0;
      // 07 §5.2: B_{t+1} = B_t (1 + r) + C_t (1 + r)^0.5 — the mid-year contribution convention.
      wealth[b] = start * (1 + r) + net * Math.sqrt(1 + r);
      grownFrom += start + net;
      grownTo += wealth[b] ?? 0;
    }
    if (shortfall > 0) {
      state.shortfallTotal += shortfall;
      if (state.depletedAtAge < 0) state.depletedAtAge = age;
    }
  } else {
    const portfolio = sumOf(wealth);
    if (plan.policy.kind === 'constant_real') {
      spending = plan.spending;
    } else {
      decisions =
        state.retiredYears === 0
          ? startGuardrails(state.guard, plan.policy.rules, plan.spending, portfolio, income)
          : stepGuardrails(
              state.guard,
              plan.policy.rules,
              portfolio,
              income,
              state.lastNominalReturn,
              state.lastInflation,
              plan.endAge - age,
            );
      spending = state.guard.spending;
    }
    state.retiredYears += 1;

    // W_t = spend_t − SS_t − pension_t − other_t, and (WP 5.5) minus this
    // year's signed one-off — outside `spending`, so no guardrail reads it.
    let need = spending - income - oneOff;
    if (need < 0) {
      wealth[TAXABLE] = (wealth[TAXABLE] ?? 0) - need;
      if (contribution !== null) contribution[TAXABLE] = -need;
      need = 0;
    }
    for (const b of plan.withdrawalOrder) {
      if (need <= 0) break;
      const available = wealth[b] ?? 0;
      if (available <= 0) continue;
      if (b === TAX_DEFERRED) {
        const keep = 1 - plan.taxDeferredRate;
        const gross = Math.min(available, need / keep);
        withdrawn[b] = gross;
        tax += gross * plan.taxDeferredRate;
        need -= gross * keep;
      } else {
        const gross = Math.min(available, need);
        withdrawn[b] = gross;
        need -= gross;
      }
    }
    shortfall = need > SHORTFALL_TOLERANCE ? need : 0;
    for (let b = 0; b < BUCKET_SLOTS; b += 1) {
      // 07 §5.2: B_{t+1} = (B_t − W_t − tax_t)(1 + r) — withdrawal and its tax at the start of the year.
      const after = (wealth[b] ?? 0) - (withdrawn[b] ?? 0);
      wealth[b] = after * (1 + (returns[b] ?? 0));
      grownFrom += after;
      grownTo += wealth[b] ?? 0;
    }
    if (shortfall > 0) {
      state.shortfallTotal += shortfall;
      if (state.depletedAtAge < 0) state.depletedAtAge = age;
    }
  }

  const portfolioReal = grownFrom > 0 ? grownTo / grownFrom - 1 : 0;
  state.lastNominalReturn = (1 + portfolioReal) * (1 + market.inflation) - 1;
  state.lastInflation = market.inflation;
  state.inflationIndex *= 1 + market.inflation;

  if (!record || startWealth === null || contribution === null) return null;
  return {
    t,
    age,
    calendarYear: plan.startYear + t,
    retired,
    startWealth,
    contribution,
    withdrawal: Array.from(withdrawn),
    realReturn: Array.from(returns),
    endWealth: Array.from(wealth),
    tax,
    socialSecurity,
    pension,
    otherIncome: other,
    spending,
    shortfall,
    inflationIndex: state.inflationIndex,
    decisions,
  };
}

/** A whole path. `marketFor(t)` supplies each year; the deterministic engine passes a constant. */
export interface PathResult {
  readonly records: readonly YearRecord[];
  readonly state: PathState;
}

export function runPath(
  prepared: PreparedPlan,
  marketFor: (t: number) => MarketYear,
  extra: ExtraContribution = NO_EXTRA,
  record = true,
): PathResult {
  const state = newPathState(prepared.plan);
  const records: YearRecord[] = [];
  for (let t = 0; t < prepared.years; t += 1) {
    const year = stepYear(prepared, state, t, marketFor(t), extra, record);
    if (year !== null) records.push(year);
  }
  return { records, state };
}

/** The deterministic engine: expected returns every year. */
export function runDeterministic(
  prepared: PreparedPlan,
  extra: ExtraContribution = NO_EXTRA,
  record = true,
): PathResult {
  const market = expectedMarket(prepared.plan);
  return runPath(prepared, () => market, extra, record);
}

/** Total real wealth at the end of year index `t` of a path. */
export function wealthAt(records: readonly YearRecord[], t: number): number {
  const year = records[t];
  if (year === undefined) throw new RangeError(`no year ${String(t)} in this path`);
  let total = 0;
  for (const bucket of year.endWealth) total += bucket;
  return total;
}
