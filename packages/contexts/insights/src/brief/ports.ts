// SPDX-License-Identifier: MIT
/**
 * `RetirementImpactPort` -- the Weekly Brief's read-only view of Planning's
 * earliest-retirement solver (WP 5.6, over WP 5.5's `solveRetirementImpact`).
 *
 * 08 §1.6's arrows point down: `@ctx/insights` may not import `@ctx/planning`
 * (`personalfi/layer-imports` denies `@ctx/*` → `@ctx/*` unconditionally), so
 * this port is declared here in Insights' own vocabulary -- `Money`, numbers,
 * strings -- and bound at the composition root
 * (`apps/api/src/domain.ts#createInsightsRetirementImpactPort`) exactly as
 * `PlanningPort` already is for `createInsightsPlanningPort`. The shapes below
 * mirror `@ctx/planning/src/engine/retirement-date.ts`'s `RetirementImpact`,
 * `RetirementAgeAnswer` and `MonthsOfSpending` field-for-field on purpose: the
 * adapter's job is to convert, not to redesign, and
 * `apps/api/test/db/brief-retirement-port.test.ts` proves the conversion is
 * exact by comparing the bound port's answer against a direct engine run.
 *
 * ## What an item's dollar figure becomes
 *
 * An item's annualised impact becomes an extra annual contribution to the
 * baseline plan, from now to retirement; a one-time impact becomes a one-off
 * this year. Both are stated under one assumption, printed beside the figure
 * on every computed answer (`RETIREMENT_EFFECT_ASSUMPTION`): *"if the saving
 * is invested in your plan."* Nothing here computes a number itself --
 * `effectOf` either returns the engine's own answer or explains, by name, why
 * it has none. The effect is secondary and never the rank key (07 §3.2:
 * "never compound speculative returns into the headline number") -- nothing
 * in `brief/ranking.ts` reads this port's answer.
 */
import type { Money } from '@core/kernel';

/**
 * Printed on every `computed` answer, verbatim -- so the assumption a reader
 * sees is the one the number actually rests on, not a paraphrase that could
 * drift from it.
 */
export const RETIREMENT_EFFECT_ASSUMPTION =
  'if the saving is invested in your plan, from now to retirement';

/** Mirrors `@ctx/planning`'s `RetirementAgeAnswer`, without importing it. */
export type RetirementAgeEffect =
  | { readonly kind: 'earliest'; readonly age: number; readonly engineRuns: number }
  | {
      readonly kind: 'unreachable';
      readonly reason: 'retirement_started' | 'latest_age';
      readonly detail: string;
    };

/** Mirrors `@ctx/planning`'s `MonthsOfSpending`. */
export type MonthsOfSpendingEffect =
  | {
      readonly months: number;
      readonly atAge: number;
      readonly wealthDifference: Money;
      readonly firstYearSpending: Money;
      readonly derivation: string;
    }
  | { readonly months: null; readonly reason: 'retirement_started' | 'no_retirement_spending' };

/** The engine's whole answer for one item's action, converted to Insights' vocabulary. */
export interface RetirementEffect {
  readonly engineVersion: string;
  readonly assumptionsVersion: string;
  readonly plannedRetirementAge: number;
  readonly baseline: RetirementAgeEffect;
  readonly withAction: RetirementAgeEffect;
  /** Whole years earlier with the action; `null` if either side is unreachable. */
  readonly yearsEarlier: number | null;
  readonly monthsOfSpending: MonthsOfSpendingEffect;
  readonly assumption: typeof RETIREMENT_EFFECT_ASSUMPTION;
}

/**
 * Why an item carries no figure. `no_dollar_figure`: the item claims no
 * annualised or one-time impact -- the assembly layer never calls the port for
 * these; it answers this reason itself. `no_baseline`: the holder has not
 * stated a baseline plan. Anything else is the planning engine's own refusal
 * code (`ProjectionRefused`/`ProjectionInputRefused`/`AssumptionOverrideRefused`),
 * carried through by name rather than swallowed.
 */
export type RetirementImpactNotComputableReason = 'no_dollar_figure' | 'no_baseline' | string;

export type RetirementImpactAnswer =
  | ({ readonly kind: 'computed' } & RetirementEffect)
  | { readonly kind: 'not_computable'; readonly reason: RetirementImpactNotComputableReason };

/** One Brief item's dollar figure, restated as the action the engine understands. */
export type RetirementActionInput =
  | { readonly kind: 'extra_annual'; readonly annual: Money }
  | { readonly kind: 'one_off'; readonly lump: Money };

export interface RetirementImpactRequest {
  readonly userId: string;
  readonly action: RetirementActionInput;
}

/**
 * Declared here, bound in `apps/api/src/domain.ts` over WP 5.5's
 * `solveRetirementImpact`. A holder with no baseline, or an item with no
 * dollar figure, is `not_computable` -- never a zero, never an estimate.
 */
export interface RetirementImpactPort {
  effectOf(request: RetirementImpactRequest): Promise<RetirementImpactAnswer>;
}

/** The answer for an item that claims no dollar figure -- the port is never called for it. */
export const NO_DOLLAR_FIGURE_ANSWER: RetirementImpactAnswer = Object.freeze({
  kind: 'not_computable',
  reason: 'no_dollar_figure',
});
