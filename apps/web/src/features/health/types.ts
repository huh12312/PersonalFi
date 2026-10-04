// SPDX-License-Identifier: MIT
import type { MoneyJson } from '@core/kernel';

/**
 * Mirrors the real wire shape `apps/api/src/routes/brief.ts`'s
 * `GET /insights/health-score` serves — **not** generated from the
 * contract. WP 5.8 and its route landed in this same tree while this work
 * package was in flight (`healthScoreSchema`/`findLatestHealthScore`,
 * `apps/api/src/routes/brief.ts:235–265`, confirmed by reading the route's
 * own source), but `apps/web/src/api/generated/types.gen.ts` had not been
 * regenerated as of this package's work (`GetHealthScoreResponses` still
 * has no 200 branch — the success type is `unknown`): `pnpm run gen`
 * regenerating the client is an orchestrator, wave-boundary action
 * (05-phase-5-dispatch.md §4 item 8), not this package's to run mid-wave.
 * This file types the view against the route's real response —
 * `{ healthScore: { isoWeek, overall, components, excluded, computedAt } }`
 * — read from `brief.ts`'s own schema rather than guessed; the orchestrator
 * deletes this file in favour of the generated type the moment `pnpm run
 * gen` is re-run.
 */
export const HEALTH_COMPONENT_IDS = [
  'emergency_fund_months',
  'savings_rate',
  'debt_to_income',
  'subscription_load',
  'diversification',
  'fee_drag',
] as const;
export type HealthComponentId = (typeof HEALTH_COMPONENT_IDS)[number];

export const HEALTH_BANDS = ['poor', 'fair', 'good', 'excellent'] as const;
export type HealthBand = (typeof HEALTH_BANDS)[number];

export const HEALTH_SCORE_DIRECTIONS = [
  'improved',
  'worsened',
  'unchanged',
  'no_previous_data',
] as const;
export type HealthScoreDirection = (typeof HEALTH_SCORE_DIRECTIONS)[number];

export interface HealthComponentResult {
  readonly component: HealthComponentId;
  /** A decimal string (months, a ratio) or `MoneyJson` (`fee_drag`) — never a JSON number. */
  readonly value: string | MoneyJson;
  readonly band: HealthBand;
  /** A decimal string, renormalised over the computable components. */
  readonly weight: string;
  /** 0-100. */
  readonly score: number;
  readonly direction: HealthScoreDirection;
}

export interface HealthExcludedComponent {
  readonly component: HealthComponentId;
  readonly reason: string;
}

export interface HealthScoreResult {
  readonly isoWeek: string;
  /** 0-100, the weighted average over computable components. `null` when every component is excluded. */
  readonly overall: number | null;
  readonly components: readonly HealthComponentResult[];
  readonly excluded: readonly HealthExcludedComponent[];
  readonly computedAt: string;
}

/** `GET /insights/health-score`'s real 200 body (`apps/api/src/routes/brief.ts`'s `z.object({ healthScore: healthScoreSchema })`). */
export interface HealthScoreWireResponse {
  readonly healthScore: HealthScoreResult;
}

/** Type guard narrowing a `MoneyJson | string` value to `MoneyJson` — `fee_drag` only. */
export function isMoneyValue(value: string | MoneyJson): value is MoneyJson {
  return typeof value === 'object';
}
