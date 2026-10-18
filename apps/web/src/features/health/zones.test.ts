// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { HealthThreshold } from '../../api/generated/types.gen.ts';
import { PILLARS, THRESHOLDS } from './test-fixtures.ts';
import { bandFor, metricNumber, yDomainOf, zonesOf } from './zones.ts';

const threshold = (component: string): HealthThreshold =>
  THRESHOLDS.find((t) => t.component === component)!;

/** `@ctx/insights`' `classifyDecimal`, restated by hand as the reference the zones must agree with. */
function classify(value: number, t: HealthThreshold): string {
  const [b1, b2, b3] = t.boundaries.map(Number) as [number, number, number];
  if (t.higherIsBetter) {
    if (value < b1) return 'poor';
    if (value < b2) return 'fair';
    if (value < b3) return 'good';
    return 'excellent';
  }
  if (value < b1) return 'excellent';
  if (value < b2) return 'good';
  if (value < b3) return 'fair';
  return 'poor';
}

describe('health zones (WP 10.12)', () => {
  it('higher is better (emergency fund, 1 / 3 / 6 months): at and either side of every edge', () => {
    const t = threshold('emergency_fund_months');
    const cases: Array<[number, string]> = [
      [0, 'poor'],
      [0.99, 'poor'],
      [1, 'fair'],
      [1.01, 'fair'],
      [2.99, 'fair'],
      [3, 'good'],
      [3.01, 'good'],
      [5.99, 'good'],
      [6, 'excellent'],
      [6.01, 'excellent'],
    ];
    for (const [value, band] of cases) expect(bandFor(value, t), String(value)).toBe(band);
  });

  it('lower is better (debt-to-income, 20 / 36 / 43 %): at and either side of every edge', () => {
    const t = threshold('debt_to_income');
    const cases: Array<[number, string]> = [
      [0, 'excellent'],
      [0.1999, 'excellent'],
      [0.2, 'good'],
      [0.2001, 'good'],
      [0.3599, 'good'],
      [0.36, 'fair'],
      [0.3601, 'fair'],
      [0.4299, 'fair'],
      [0.43, 'poor'],
      [0.4301, 'poor'],
    ];
    for (const [value, band] of cases) expect(bandFor(value, t), String(value)).toBe(band);
  });

  it('agrees with classifyDecimal on every edge of every ladder, and with the server’s band for each pillar', () => {
    for (const t of THRESHOLDS) {
      for (const edge of t.boundaries.map(Number)) {
        for (const value of [edge - 0.0001, edge, edge + 0.0001]) {
          expect(bandFor(value, t), `${t.component} ${String(value)}`).toBe(classify(value, t));
        }
      }
    }
    for (const pillar of PILLARS) {
      if (pillar.status !== 'scored') continue;
      expect(
        bandFor(metricNumber(pillar.value), threshold(pillar.component)),
        pillar.component,
      ).toBe(pillar.band);
    }
  });

  it('the zones are the scoring rules’ edges, clipped to the domain, in order', () => {
    const t = threshold('emergency_fund_months');
    const domain = yDomainOf(t, [4.2]);
    expect(domain).toEqual([0, 9]);
    expect(zonesOf(t, domain)).toEqual([
      { band: 'poor', status: 'danger', from: 0, to: 1 },
      { band: 'fair', status: 'warning', from: 1, to: 3 },
      { band: 'good', status: 'success', from: 3, to: 6 },
      { band: 'excellent', status: 'info', from: 6, to: 9 },
    ]);
    const lower = threshold('fee_drag');
    const feeDomain = yDomainOf(lower, [metricNumber({ minor: '3750', currency: 'USD' })]);
    expect(feeDomain).toEqual([0, 225]);
    expect(zonesOf(lower, feeDomain).map((z) => [z.band, z.from, z.to])).toEqual([
      ['excellent', 0, 25],
      ['good', 25, 50],
      ['fair', 50, 150],
      ['poor', 150, 225],
    ]);
  });

  it('the domain grows to a value beyond the ladder and below zero', () => {
    const t = threshold('savings_rate');
    expect(yDomainOf(t, [-0.2, 0.4])).toEqual([-0.2, 0.4 * 1.1]);
    expect(zonesOf(t, [-0.2, 0.44])[0]).toEqual({
      band: 'poor',
      status: 'danger',
      from: -0.2,
      to: 0.05,
    });
  });

  it('money is read in major units', () => {
    expect(metricNumber({ minor: '3750', currency: 'USD' })).toBe(37.5);
    expect(metricNumber('0.031000')).toBe(0.031);
  });
});
