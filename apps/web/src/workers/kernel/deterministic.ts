// SPDX-License-Identifier: MIT
/**
 * The deterministic per-year recursion `stepYear` — a **scoped port** of
 * `packages/contexts/planning/src/engine/deterministic.ts` (WP 4.4). See
 * `prng.ts`'s header for why this is a port rather than an import.
 *
 * ## Scope cut: what this worker's kernel does not model
 *
 * The slider preview never claims to be the saved plan (D20: "the server
 * remains authoritative for saved scenarios") — so this port carries only
 * what a live drag needs, and refuses, loudly, the rest of the server
 * engine's surface rather than silently approximating it:
 *
 *   * **No Social Security, pension or other income streams.** `EnginePlan`
 *     below has no such fields; a year's income is always 0.
 *   * **No guardrails withdrawal policy.** `EnginePolicy` is `'constant_real'`
 *     only — `stepYear` throws `UnsupportedPolicy` if asked for anything else.
 *   * **Real dollars, no tax nuance beyond the same one blended
 *     `taxDeferredRate` the server uses** — this part *is* carried, because
 *     it is cheap and the golden vector exercises it (the fixture's plan
 *     retires and withdraws).
 *
 * Everything that *is* in scope — the four-bucket accumulation/decumulation
 * recursion, the mid-year contribution convention, the withdrawal ordering —
 * is transcribed arithmetic-for-arithmetic from the server file, because
 * `docs/evidence/phase-4/wp4.11-client-worker.md`'s golden vector proves
 * byte-identical output against it for a scenario that exercises exactly
 * this path (accumulation into retirement, a shortfall, depletion).
 */
import { glidepathFunction, type EngineGlidepath, type GlidepathFunction } from './glidepath.ts';

/** Must equal the server's `ENGINE_VERSION` exactly — it is part of the golden-vector digest. */
export const ENGINE_VERSION = 'personalfi.deterministic/1';

export const TAXABLE = 0;
export const TAX_DEFERRED = 1;
export const ROTH = 2;
export const HSA = 3;
export const BUCKET_SLOTS = 4;

export const SHORTFALL_TOLERANCE = 0.005;

/** Thrown when a plan asks for a withdrawal policy this scoped kernel does not model. See file header. */
export class UnsupportedPolicy extends Error {
  constructor(kind: string) {
    super(
      `the client projection kernel only models the constant_real withdrawal policy; got '${kind}'. ` +
        'This is a deliberate WP 4.11 scope cut (see kernel/deterministic.ts header) — the server ' +
        'projection (docs/plan/04-phase-4-dispatch.md §3 "WP 4.4") remains authoritative.',
    );
    this.name = 'UnsupportedPolicy';
  }
}

export type EnginePolicy = { readonly kind: 'constant_real' };

/** The worker's plan shape — `EnginePlan`, trimmed to this file's scope (see header). */
export interface EnginePlan {
  readonly startAge: number;
  readonly retireAge: number;
  readonly endAge: number;
  readonly startYear: number;
  readonly wealth0: readonly number[];
  readonly contribution0: readonly number[];
  readonly glidepaths: readonly EngineGlidepath[];
  readonly contributionGrowth: number;
  readonly spending: number;
  readonly inflation: number;
  readonly equityNominal: number;
  readonly bondNominal: number;
  readonly taxDeferredRate: number;
  readonly withdrawalOrder: readonly number[];
  readonly policy: EnginePolicy;
  readonly extraBucket: number;
}

export interface MarketYear {
  readonly equityReal: number;
  readonly bondReal: number;
  readonly inflation: number;
}

export interface ExtraContribution {
  readonly annual: number;
  readonly untilAge: number;
}

export const NO_EXTRA: ExtraContribution = Object.freeze({ annual: 0, untilAge: 0 });

export interface PreparedPlan {
  readonly plan: EnginePlan;
  readonly years: number;
  readonly glide: readonly GlidepathFunction[];
}

export function realRate(nominal: number, inflation: number): number {
  return (1 + nominal) / (1 + inflation) - 1;
}

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
  if (plan.policy.kind !== 'constant_real') throw new UnsupportedPolicy(plan.policy.kind);
  return { plan, years, glide: plan.glidepaths.map((g) => glidepathFunction(g)) };
}

export interface PathState {
  readonly wealth: Float64Array;
  lastNominalReturn: number;
  lastInflation: number;
  inflationIndex: number;
  depletedAtAge: number;
  shortfallTotal: number;
  readonly scratchReturn: Float64Array;
  readonly scratchWithdrawal: Float64Array;
}

export function newPathState(plan: EnginePlan): PathState {
  const wealth = new Float64Array(BUCKET_SLOTS);
  for (let b = 0; b < BUCKET_SLOTS; b += 1) wealth[b] = plan.wealth0[b] ?? 0;
  return {
    wealth,
    lastNominalReturn: 0,
    lastInflation: plan.inflation,
    inflationIndex: 1,
    depletedAtAge: -1,
    shortfallTotal: 0,
    scratchReturn: new Float64Array(BUCKET_SLOTS),
    scratchWithdrawal: new Float64Array(BUCKET_SLOTS),
  };
}

/**
 * One year of the recursion, `record = false` always (the worker never
 * builds a `YearRecord` table — only checkpoints feed the bands). Mutates
 * `state` in place, same as the server's `stepYear`.
 */
export function stepYear(
  prepared: PreparedPlan,
  state: PathState,
  t: number,
  market: MarketYear,
  extra: ExtraContribution,
): void {
  const plan = prepared.plan;
  const age = plan.startAge + t;
  const retired = age >= plan.retireAge;
  const wealth = state.wealth;
  const returns = state.scratchReturn;
  const withdrawn = state.scratchWithdrawal;

  for (let b = 0; b < BUCKET_SLOTS; b += 1) {
    const equityShare = prepared.glide[b]?.(age, plan.retireAge) ?? 0;
    returns[b] = equityShare * market.equityReal + (1 - equityShare) * market.bondReal;
    withdrawn[b] = 0;
  }

  let grownFrom = 0;
  let grownTo = 0;

  if (!retired) {
    const growth = (1 + plan.contributionGrowth) ** t;
    for (let b = 0; b < BUCKET_SLOTS; b += 1) {
      const r = returns[b] ?? 0;
      let c = (plan.contribution0[b] ?? 0) * growth;
      if (b === plan.extraBucket && age < extra.untilAge) c += extra.annual;
      const start = wealth[b] ?? 0;
      wealth[b] = start * (1 + r) + c * Math.sqrt(1 + r);
      grownFrom += start + c;
      grownTo += wealth[b] ?? 0;
    }
  } else {
    // W_t = spend_t − income_t; income_t is always 0 in this scoped kernel (file header).
    const spending = plan.spending;
    let need = spending;
    for (const b of plan.withdrawalOrder) {
      if (need <= 0) break;
      const available = wealth[b] ?? 0;
      if (available <= 0) continue;
      if (b === TAX_DEFERRED) {
        const keep = 1 - plan.taxDeferredRate;
        const gross = Math.min(available, need / keep);
        withdrawn[b] = gross;
        need -= gross * keep;
      } else {
        const gross = Math.min(available, need);
        withdrawn[b] = gross;
        need -= gross;
      }
    }
    const shortfall = need > SHORTFALL_TOLERANCE ? need : 0;
    for (let b = 0; b < BUCKET_SLOTS; b += 1) {
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
}
