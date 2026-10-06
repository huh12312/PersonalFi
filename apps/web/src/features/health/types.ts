// SPDX-License-Identifier: MIT
import type { MoneyJson } from '@core/kernel';

/**
 * Vocabulary for the health-score view. The wire shape itself is the generated
 * `HealthScore` / `HealthScoreComponent` (CF-25 closed the hand-mirrored
 * `HealthScoreWireResponse` and the `as` cast that read it); only the label
 * tables' key types and the money guard live here.
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

/** Type guard narrowing a `MoneyJson | string` value to `MoneyJson` — `fee_drag` only. */
export function isMoneyValue(value: string | MoneyJson): value is MoneyJson {
  return typeof value === 'object';
}
