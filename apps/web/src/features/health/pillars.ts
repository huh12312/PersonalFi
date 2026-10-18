// SPDX-License-Identifier: MIT
/**
 * The pillars' words and URLs (WP 10.12): a slug per component for `/health/$pillar`, a one-line meaning, how a
 * value and an input are written, the weight as a share of the score, and the scoring ladder in words — built from
 * the thresholds on the wire, so the words and the zone chart can never disagree with the scoring rules.
 */
import { formatMoney, parseWireMoney } from '../../lib/money.ts';
import type { HealthPillarDatum, HealthThreshold, Money } from '../../api/generated/types.gen.ts';
import { BAND_LABEL, COMPONENT_UNIT, formatMonths, formatRatioPercent } from './format.ts';
import { dollarsOf, percentOf } from './tiers.ts';
import { HEALTH_COMPONENT_IDS, type HealthBand, type HealthComponentId } from './types.ts';
import { bandsAscending } from './zones.ts';

export const PILLAR_SLUG: Record<HealthComponentId, string> = {
  emergency_fund_months: 'emergency-fund',
  savings_rate: 'savings-rate',
  debt_to_income: 'debt-to-income',
  subscription_load: 'subscriptions',
  diversification: 'diversification',
  fee_drag: 'fees',
};

export function componentOfSlug(slug: string): HealthComponentId | null {
  return HEALTH_COMPONENT_IDS.find((id) => PILLAR_SLUG[id] === slug) ?? null;
}

export const PILLAR_MEANING: Record<HealthComponentId, string> = {
  emergency_fund_months: 'How many months your cash would cover your spending.',
  savings_rate: 'The share of your income you keep.',
  debt_to_income: 'Minimum debt payments as a share of your monthly income.',
  subscription_load: 'What subscriptions cost a year, as a share of take-home pay.',
  diversification: 'How much of your investments sits in your largest single holding.',
  fee_drag: 'Avoidable fees and fund costs over a year.',
};

export function isMoney(value: string | Money): value is Money {
  return typeof value === 'object';
}

export function moneyText(value: Money): string {
  return formatMoney(parseWireMoney(value), { signDisplay: 'auto' });
}

/** A pillar's metric value, in its unit. */
export function valueText(component: HealthComponentId, value: string | Money): string {
  if (isMoney(value)) return moneyText(value);
  return COMPONENT_UNIT[component] === 'months' ? formatMonths(value) : formatRatioPercent(value);
}

/** One input the pillar was built from, formatted by its kind. */
export function inputText(input: HealthPillarDatum): string {
  if (isMoney(input.value)) return moneyText(input.value);
  switch (input.kind) {
    case 'months':
      return formatMonths(input.value);
    case 'ratio':
      return formatRatioPercent(input.value);
    default:
      return input.value;
  }
}

/** The renormalised weight as a share of the score: `'0.200000'` → `'20%'`, `'0.235294'` → `'23.5%'`. */
export function weightText(weight: string): string {
  return percentOf(weight);
}

/** An edge in the metric's own unit. */
export function edgeText(threshold: HealthThreshold, edge: string): string {
  if (threshold.unit === 'usd_per_year') return `${dollarsOf(edge)} a year`;
  if (threshold.unit === 'months') {
    const months = Number(edge);
    return `${String(months)} month${months === 1 ? '' : 's'}`;
  }
  return percentOf(edge);
}

export interface LadderStep {
  readonly band: HealthBand;
  readonly words: string;
}

/** The ladder in words, worst band first: "Poor: under 1 month", "Fair: 1 month to under 3 months", … */
export function ladderOf(threshold: HealthThreshold): LadderStep[] {
  const [b1, b2, b3] = threshold.boundaries;
  const bands = bandsAscending(threshold);
  const ranges = [
    `under ${edgeText(threshold, b1)}`,
    `${edgeText(threshold, b1)} to under ${edgeText(threshold, b2)}`,
    `${edgeText(threshold, b2)} to under ${edgeText(threshold, b3)}`,
    `${edgeText(threshold, b3)} or more`,
  ];
  const steps = bands.map((band, index) => ({
    band,
    words: `${BAND_LABEL[band]}: ${ranges[index]!}`,
  }));
  return threshold.higherIsBetter ? steps : steps.reverse();
}

/** A metric number in its unit, for an axis, a readout and the table: "4.2 months", "12.5%", "$37.50". */
export function metricText(unit: HealthThreshold['unit'], value: number): string {
  if (unit === 'months') {
    const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
    return `${text} month${value === 1 ? '' : 's'}`;
  }
  if (unit === 'usd_per_year') {
    return Number.isInteger(value) ? `$${String(value)}` : `$${value.toFixed(2)}`;
  }
  const percent = Math.round(value * 1000) / 10;
  return `${String(percent)}%`;
}
