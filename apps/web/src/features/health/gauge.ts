// SPDX-License-Identifier: MIT
/**
 * The health gauge's arithmetic (WP 10.12; Monarch's equivalent: an arc with segments,
 * `SWEEP_RADIANS`, round caps). A 270° arc open at the bottom: angles are degrees **clockwise from 12 o'clock**,
 * the arc runs from −135° (score 0, lower left) through 0° (score 50, the top) to +135° (score 100, lower right).
 * Pure, so the angles, the segments and the paths are unit-tested without a browser.
 */
import { TIERS, type Tier } from './tiers.ts';

export const GAUGE_SWEEP_DEG = 270;
export const GAUGE_START_DEG = -135;
export const GAUGE_END_DEG = GAUGE_START_DEG + GAUGE_SWEEP_DEG;

export function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.min(100, Math.max(0, score));
}

/** The needle/fill angle for a score: 0 → −135°, 50 → 0°, 100 → +135°. */
export function angleFor(score: number): number {
  return GAUGE_START_DEG + (GAUGE_SWEEP_DEG * clampScore(score)) / 100;
}

export interface TierSegment {
  readonly tier: Tier;
  readonly startDeg: number;
  readonly endDeg: number;
}

/** One arc per tier, end to end, covering exactly the 270° sweep. */
export function tierSegments(): TierSegment[] {
  return TIERS.map((tier) => ({ tier, startDeg: angleFor(tier.min), endDeg: angleFor(tier.max) }));
}

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A point on the circle at `deg` clockwise from 12 o'clock. */
export function polar(cx: number, cy: number, r: number, deg: number): Point {
  const rad = (deg * Math.PI) / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function round(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** An SVG path for the clockwise arc from `startDeg` to `endDeg`. */
export function arcPath(
  cx: number,
  cy: number,
  r: number,
  startDeg: number,
  endDeg: number,
): string {
  const start = polar(cx, cy, r, startDeg);
  const end = polar(cx, cy, r, endDeg);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${round(start.x)} ${round(start.y)} A ${round(r)} ${round(r)} 0 ${String(large)} 1 ${round(end.x)} ${round(end.y)}`;
}

/** The length of an arc of `deg` degrees at radius `r`. */
export function arcLength(r: number, deg: number): number {
  return (r * Math.abs(deg) * Math.PI) / 180;
}

/** The angle a straight gap of `px` subtends at radius `r` (the 2 px surface gap between segments). */
export function gapDegrees(px: number, r: number): number {
  return ((px / r) * 180) / Math.PI;
}

export interface GaugeGeometry {
  readonly width: number;
  readonly height: number;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly stroke: number;
}

/** The SVG box for a gauge `size` px wide: tall enough for the arc's lower ends and their caps, no more. */
export function gaugeGeometry(size: number, stroke: number): GaugeGeometry {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - stroke / 2 - 3;
  const lowest = cy - r * Math.cos((GAUGE_END_DEG * Math.PI) / 180);
  return { width: size, height: Math.ceil(lowest + stroke / 2 + 3), cx, cy, r, stroke };
}
