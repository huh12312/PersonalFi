// SPDX-License-Identifier: MIT
/**
 * Concentration over the committed fixture, where VTI is deliberately held in
 * two accounts.
 *
 * Measured per holding row it is a 23% position and a 7% position. Measured
 * per *security*, which is what an exposure is, it is one 30.4% position —
 * comfortably past 07 I4's 20% trigger. The whole point of the aggregation is
 * that the second number is the true one.
 */
import { Money, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { FIXTURE_HOLDINGS } from '../../test/fixtures/portfolio.ts';
import { CONCENTRATION_TRIGGER, concentration } from './concentration.ts';
import { ratio, type ValuationOptions } from './types.ts';

const USD = currency('USD');
const LAST_KNOWN: ValuationOptions = { currency: USD, scale: 2, basis: 'last_known' };

describe('concentration', () => {
  it('aggregates a security across accounts before measuring it', () => {
    const report = concentration(FIXTURE_HOLDINGS, LAST_KNOWN);

    expect(report.topHolding?.securityId).toBe('sec-vti');
    // 40,892.61 + 12,791.39 = 53,684.00 across a taxable account and an IRA.
    expect(Money.formatAmount(report.topHolding?.value ?? Money.zero(USD))).toBe('53684.00');
    expect(report.topHolding?.holdingCount).toBe(2);
    expect(report.topHoldingPct).toBe('0.3041593295');
    expect(report.aboveTrigger).toBe(true);
    expect(CONCENTRATION_TRIGGER).toBe(ratio('0.20'));

    // Eleven holdings, ten securities: the aggregation is visible in the count.
    expect(FIXTURE_HOLDINGS).toHaveLength(11);
    expect(report.positionCount).toBe(10);
  });

  it('computes a Herfindahl index the fixture pins', () => {
    const report = concentration(FIXTURE_HOLDINGS, LAST_KNOWN);
    expect(report.herfindahl).toBe('0.1763411515');
    // 1/HHI: this portfolio behaves like 5.7 equally sized positions, not ten.
    expect(report.effectivePositions).toBe('5.6708260749');
    // Bounded below by 1/n = 0.1 and above by 1.
    expect(Number(report.herfindahl)).toBeGreaterThanOrEqual(1 / report.positionCount);
    expect(Number(report.herfindahl)).toBeLessThanOrEqual(1);
  });

  it('measures against investable assets, not everything held', () => {
    // Mark the IRA's bond fund non-investable (a plan that cannot be traded):
    // it leaves the denominator, and every other position's share rises.
    const withLocked = FIXTURE_HOLDINGS.map((holding) =>
      holding.holdingId === 'h-03' ? { ...holding, isInvestable: false } : holding,
    );
    const report = concentration(withLocked, LAST_KNOWN);
    expect(Money.formatAmount(report.investableTotal)).toBe('141867.60');
    expect(Number(report.topHoldingPct)).toBeGreaterThan(0.378);
    expect(report.positionCount).toBe(9);
  });

  it('excludes a STALE price rather than counting it at a stale number', () => {
    const asOfNow = concentration(FIXTURE_HOLDINGS, {
      currency: USD,
      scale: 2,
      basis: 'as_of_now',
    });
    expect(asOfNow.excluded.map((entry) => entry.holdingId)).toEqual(['h-10']);
    expect(Money.formatAmount(asOfNow.investableTotal)).toBe('174449.60');
    expect(asOfNow.positions.map((position) => position.securityId)).not.toContain('sec-oldco');
  });

  it('answers an empty portfolio with a zero, not a division', () => {
    const report = concentration([], LAST_KNOWN);
    expect(report.topHolding).toBeNull();
    expect(report.herfindahl).toBe(ratio('0'));
    expect(report.effectivePositions).toBe(ratio('0'));
    expect(report.aboveTrigger).toBe(false);
  });
});
