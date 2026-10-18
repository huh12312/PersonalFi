// SPDX-License-Identifier: MIT
/**
 * Health zones (WP 10.12; Monarch's equivalent): a pillar's metric against coloured bands
 * whose edges are **the scoring rules' own boundaries**, read from `GET /insights/health`'s `thresholds` (the
 * server's `HEALTH_BAND_THRESHOLDS`). Never invented, never re-typed here.
 *
 * Placement follows `classifyDecimal` exactly: with three ascending edges b1 < b2 < b3, a value lands in the band
 * indexed by how many edges it is at or above (an edge belongs to the band above it). Higher-is-better ladders
 * read poor → fair → good → excellent from the bottom; lower-is-better ladders read excellent → good → fair → poor.
 */
import { minorUnitScale, type CurrencyCode } from '@core/kernel';

import type { HealthThreshold, Money } from '../../api/generated/types.gen.ts';
import type { StatusRole } from './tiers.ts';
import type { HealthBand } from './types.ts';

export const BAND_STATUS: Record<HealthBand, StatusRole> = {
  poor: 'danger',
  fair: 'warning',
  good: 'success',
  excellent: 'info',
};

const HIGHER: readonly HealthBand[] = ['poor', 'fair', 'good', 'excellent'];
const LOWER: readonly HealthBand[] = ['excellent', 'good', 'fair', 'poor'];

/** The bands from the lowest value to the highest. */
export function bandsAscending(threshold: HealthThreshold): readonly HealthBand[] {
  return threshold.higherIsBetter ? HIGHER : LOWER;
}

/** The three edges as numbers (money edges are dollars, the unit the wire states them in). */
export function edgesOf(threshold: HealthThreshold): [number, number, number] {
  const [b1, b2, b3] = threshold.boundaries.map(Number) as [number, number, number];
  return [b1, b2, b3];
}

/** A metric value as a number on its axis: a decimal string as is; money in major units (presentation only). */
export function metricNumber(value: string | Money): number {
  if (typeof value === 'string') return Number(value);
  const scale = minorUnitScale(value.currency as CurrencyCode);
  return Number(value.minor) / 10 ** scale;
}

/** The band a value falls in — `classifyDecimal`'s semantics. */
export function bandFor(value: number, threshold: HealthThreshold): HealthBand {
  const atOrAbove = edgesOf(threshold).filter((edge) => value >= edge).length;
  return bandsAscending(threshold)[atOrAbove]!;
}

/** The y-domain: from min(0, lowest value) to max(1.5 × the top edge, 1.1 × the highest value). */
export function yDomainOf(threshold: HealthThreshold, values: readonly number[]): [number, number] {
  const [, , b3] = edgesOf(threshold);
  const lo = Math.min(0, ...values);
  const hi = Math.max(b3 * 1.5, ...values.map((value) => value * 1.1));
  return [lo, hi];
}

export interface Zone {
  readonly band: HealthBand;
  readonly status: StatusRole;
  /** Inclusive lower edge, clipped to the domain. */
  readonly from: number;
  /** Exclusive upper edge, clipped to the domain. */
  readonly to: number;
}

/** The four zones, bottom to top, clipped to `domain`; a zone wholly outside it is dropped. */
export function zonesOf(threshold: HealthThreshold, domain: readonly [number, number]): Zone[] {
  const [lo, hi] = domain;
  const edges = [-Infinity, ...edgesOf(threshold), Infinity];
  const bands = bandsAscending(threshold);
  const zones: Zone[] = [];
  bands.forEach((band, index) => {
    const from = Math.max(lo, edges[index]!);
    const to = Math.min(hi, edges[index + 1]!);
    if (to > from) zones.push({ band, status: BAND_STATUS[band], from, to });
  });
  return zones;
}
