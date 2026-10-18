// SPDX-License-Identifier: MIT
/**
 * The health score's three tiers (WP 10.12, V5) — presentation of the score, never part of it. Monarch's copy is
 * "getting going / solid spot / thriving"; PersonalFi's plain words are **Building** (under 50), **Steady** (50 to
 * under 80) and **Strong** (80 and over). The edges sit on the score's own ladder: every component scores 25, 50,
 * 75 or 100 (`BAND_SCORE`), so all-fair is exactly 50 (Steady) and Strong needs some pillars at excellent.
 *
 * Each tier wears a status quartet (always beside its word, never colour alone): Building → warning, Steady →
 * success, Strong → info — the same "best is info" reading as the zone charts' excellent band.
 */
import type { HealthPillar, HealthThreshold } from '../../api/generated/types.gen.ts';
import { COMPONENT_LABEL } from './format.ts';
import { HEALTH_COMPONENT_IDS, type HealthComponentId } from './types.ts';

export type TierId = 'building' | 'steady' | 'strong';
export type StatusRole = 'success' | 'warning' | 'danger' | 'info';

export interface Tier {
  readonly id: TierId;
  readonly word: string;
  /** Inclusive lower edge, 0-100. */
  readonly min: number;
  /** Exclusive upper edge (100 is inclusive for the last tier). */
  readonly max: number;
  readonly status: StatusRole;
  readonly sentence: string;
}

export const TIERS: readonly Tier[] = [
  {
    id: 'building',
    word: 'Building',
    min: 0,
    max: 50,
    status: 'warning',
    sentence: 'You’re building the basics.',
  },
  {
    id: 'steady',
    word: 'Steady',
    min: 50,
    max: 80,
    status: 'success',
    sentence: 'You’re on steady ground.',
  },
  {
    id: 'strong',
    word: 'Strong',
    min: 80,
    max: 100,
    status: 'info',
    sentence: 'You’re in strong shape.',
  },
];

export function tierOf(score: number): Tier {
  for (const tier of TIERS) if (score < tier.max) return tier;
  return TIERS[TIERS.length - 1]!;
}

type ScoredPillar = Extract<HealthPillar, { status: 'scored' }>;

/** The pillar to work on: the lowest score; ties by the higher weight, then catalogue order. */
export function lowestPillar(pillars: readonly HealthPillar[]): ScoredPillar | null {
  const order = (id: HealthComponentId) => HEALTH_COMPONENT_IDS.indexOf(id);
  const scored = pillars.filter((pillar): pillar is ScoredPillar => pillar.status === 'scored');
  const sorted = [...scored].sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.weight) - Number(a.weight) ||
      order(a.component) - order(b.component),
  );
  return sorted[0] ?? null;
}

/** A ratio edge as a percent with no trailing zeros: `'0.10'` → `'10%'`, `'0.055'` → `'5.5%'`. */
export function percentOf(edge: string): string {
  const percent = Math.round(Number(edge) * 1000) / 10;
  return `${String(percent)}%`;
}

/** `'50.00'` → `'$50'`, `'25.50'` → `'$25.50'`. */
export function dollarsOf(edge: string): string {
  const value = Number(edge);
  return Number.isInteger(value) ? `$${String(value)}` : `$${value.toFixed(2)}`;
}

/**
 * The band edge that separates this pillar's band from the next better one, from the scoring rules on the wire.
 * `null` at excellent: there is no better band.
 */
export function nextEdgeOf(pillar: ScoredPillar, threshold: HealthThreshold): string | null {
  if (pillar.band === 'excellent') return null;
  const [b1, b2, b3] = threshold.boundaries;
  if (threshold.higherIsBetter) {
    return { poor: b1, fair: b2, good: b3 }[pillar.band];
  }
  return { poor: b3, fair: b2, good: b1 }[pillar.band];
}

/** The next step for one pillar, in plain words, aimed at the next band edge. */
export function nextStepOf(pillar: ScoredPillar, threshold: HealthThreshold): string | null {
  const edge = nextEdgeOf(pillar, threshold);
  if (edge === null) return null;
  switch (pillar.component) {
    case 'emergency_fund_months': {
      const months = Number(edge);
      return `build your cash toward ${String(months)} month${months === 1 ? '' : 's'} of spending`;
    }
    case 'savings_rate':
      return `save ${percentOf(edge)} of your income`;
    case 'debt_to_income':
      return `bring minimum payments under ${percentOf(edge)} of income`;
    case 'subscription_load':
      return `trim subscriptions to under ${percentOf(edge)} of take-home`;
    case 'diversification':
      return `bring your largest holding under ${percentOf(edge)} of your investments`;
    case 'fee_drag':
      return `cut avoidable fees below ${dollarsOf(edge)} a year`;
  }
}

/**
 * The hero's one sentence: the tier's line, then the one thing to do next (from the lowest-scoring pillar).
 * Honest at the edges: no score names what would unlock one; nothing below excellent says so.
 */
export function tierLineOf(
  score: number | null,
  pillars: readonly HealthPillar[],
  thresholds: readonly HealthThreshold[],
): string {
  if (score === null) {
    const withheld = pillars.find((pillar) => pillar.status === 'withheld');
    return withheld !== undefined && withheld.status === 'withheld'
      ? `There isn’t enough data to score yet. ${withheld.unlock}`
      : 'There isn’t enough data to score yet.';
  }
  const tier = tierOf(score);
  const lowest = lowestPillar(pillars);
  const threshold =
    lowest === null ? undefined : thresholds.find((t) => t.component === lowest.component);
  const step = lowest === null || threshold === undefined ? null : nextStepOf(lowest, threshold);
  if (lowest === null || step === null) {
    return `${tier.sentence} Every pillar we can measure is excellent — keep it that way.`;
  }
  return `${tier.sentence} The one thing to do next: ${step} (${COMPONENT_LABEL[lowest.component]}).`;
}
