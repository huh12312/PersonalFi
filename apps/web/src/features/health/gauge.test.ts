// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { angleFor, arcPath, GAUGE_SWEEP_DEG, gaugeGeometry, polar, tierSegments } from './gauge.ts';

describe('the gauge arithmetic (WP 10.12)', () => {
  it('the tier segments run end to end and their angles sum to exactly 270°', () => {
    const segments = tierSegments();
    expect(segments.map((s) => s.tier.id)).toEqual(['building', 'steady', 'strong']);
    const total = segments.reduce((sum, s) => sum + (s.endDeg - s.startDeg), 0);
    expect(total).toBe(GAUGE_SWEEP_DEG);
    expect(total).toBe(270);
    expect(segments[0]?.startDeg).toBe(-135);
    expect(segments.at(-1)?.endDeg).toBe(135);
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]?.startDeg).toBe(segments[i - 1]?.endDeg);
    }
    // 0–50, 50–80, 80–100 of the score: 135°, 81°, 54°.
    expect(segments.map((s) => s.endDeg - s.startDeg)).toEqual([135, 81, 54]);
  });

  it('the needle angle: 0 → −135°, 50 → 0° (the top), 100 → +135°; clamped outside 0–100', () => {
    expect(angleFor(0)).toBe(-135);
    expect(angleFor(50)).toBe(0);
    expect(angleFor(100)).toBe(135);
    expect(angleFor(-10)).toBe(-135);
    expect(angleFor(140)).toBe(135);
    expect(angleFor(Number.NaN)).toBe(-135);
  });

  it('polar: 0° is 12 o’clock, +90° is 3 o’clock', () => {
    const top = polar(100, 100, 50, 0);
    expect(top.x).toBeCloseTo(100);
    expect(top.y).toBeCloseTo(50);
    const right = polar(100, 100, 50, 90);
    expect(right.x).toBeCloseTo(150);
    expect(right.y).toBeCloseTo(100);
  });

  it('the full sweep is drawn as a large arc, a tier segment under 180° is not', () => {
    expect(arcPath(100, 100, 50, -135, 135)).toContain(' 0 1 1 ');
    expect(arcPath(100, 100, 50, 0, 81)).toContain(' 0 0 1 ');
  });

  it('the box is tall enough for the arc’s lower ends and its caps', () => {
    const g = gaugeGeometry(232, 16);
    const lowest = polar(g.cx, g.cy, g.r, 135).y + g.stroke / 2;
    expect(g.height).toBeGreaterThanOrEqual(lowest);
    expect(g.height).toBeLessThan(g.width);
  });
});
