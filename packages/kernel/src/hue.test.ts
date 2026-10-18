// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import { newId } from './ids.ts';
import { CHART_HUES, hueForId, isChartHue } from './hue.ts';

describe('hueForId', () => {
  it('is deterministic and case-insensitive', () => {
    const id = '0192f3a1-7b2c-7d4e-8f00-123456789abc';
    expect(hueForId(id)).toBe(hueForId(id));
    expect(hueForId(id.toUpperCase())).toBe(hueForId(id));
  });

  it('pins known values (a change here re-colours every unpersisted category)', () => {
    expect(hueForId('')).toBe(CHART_HUES[0x811c9dc5 % 13]);
    expect(hueForId('')).toBe('orange');
    expect(hueForId('00000000-0000-7000-8000-000000000001')).toBe('yellow');
    expect(hueForId('0192f3a1-7b2c-7d4e-8f00-123456789abc')).toBe('green');
  });

  it('spreads v7 ids evenly over the thirteen hues', () => {
    const counts = new Map<string, number>();
    const n = 13_000;
    for (let i = 0; i < n; i += 1) {
      const hue = hueForId(newId());
      counts.set(hue, (counts.get(hue) ?? 0) + 1);
    }
    expect(counts.size).toBe(13);
    for (const count of counts.values()) {
      // Expected 1000 per hue; ±15% is > 4 sigma for a fair hash at this n.
      expect(count).toBeGreaterThan(850);
      expect(count).toBeLessThan(1150);
    }
  });

  it('only ever names a hue in the vocabulary', () => {
    expect(isChartHue(hueForId('x'))).toBe(true);
    expect(isChartHue('blue')).toBe(false);
    expect(isChartHue('sand')).toBe(false);
  });
});
