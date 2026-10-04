// SPDX-License-Identifier: MIT
import type { HealthBand, HealthComponentId, HealthScoreDirection } from './types.ts';

export const COMPONENT_LABEL: Record<HealthComponentId, string> = {
  emergency_fund_months: 'Emergency fund',
  savings_rate: 'Savings rate',
  debt_to_income: 'Debt-to-income',
  subscription_load: 'Subscription load',
  diversification: 'Diversification',
  fee_drag: 'Fee drag',
};

export const COMPONENT_UNIT: Record<HealthComponentId, 'months' | 'ratio' | 'money'> = {
  emergency_fund_months: 'months',
  savings_rate: 'ratio',
  debt_to_income: 'ratio',
  subscription_load: 'ratio',
  diversification: 'ratio',
  fee_drag: 'money',
};

export const BAND_LABEL: Record<HealthBand, string> = {
  poor: 'Poor',
  fair: 'Fair',
  good: 'Good',
  excellent: 'Excellent',
};

export const DIRECTION_LABEL: Record<HealthScoreDirection, string> = {
  improved: 'Improved',
  worsened: 'Worsened',
  unchanged: 'Unchanged',
  no_previous_data: 'No previous week to compare',
};

/** `'→'`/`'↑'`/`'↓'` is the glyph; `DIRECTION_LABEL` above is always rendered beside it in words — never colour or the glyph alone (WCAG 2.2 AA, 05-phase-5-dispatch.md §3 WP 5.11). */
export const DIRECTION_GLYPH: Record<HealthScoreDirection, string> = {
  improved: '↑',
  worsened: '↓',
  unchanged: '→',
  no_previous_data: '—',
};

/**
 * `weight`/a ratio-unit `value` is a decimal string for a *ratio*, not
 * money (docs/CONVENTIONS.md: "Floats are correct for Monte Carlo,
 * percentages, and confidence scores") — `×100` for display is formatting,
 * the same operation `features/insights/severity.ts#confidencePercentLabel`
 * already performs on a confidence ratio. Never applied to a `MoneyJson`
 * value, which always renders through `<Money>` instead.
 */
export function formatRatioPercent(decimalString: string): string {
  const parsed = Number(decimalString);
  if (!Number.isFinite(parsed)) return decimalString;
  return `${(parsed * 100).toFixed(1)}%`;
}

export function formatMonths(decimalString: string): string {
  return `${decimalString} ${decimalString === '1' ? 'month' : 'months'}`;
}
