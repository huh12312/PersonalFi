// SPDX-License-Identifier: MIT
/**
 * XIRR: the divergence fixture, the two ways the answer is `n/a`, and the
 * nine-month return that must not be annualised.
 *
 * The sign-flipping fixture is not a curiosity — it is the shape of a real
 * account that was topped up after a loss:
 *
 * | Date | Flow | What it is |
 * |---|---|---|
 * | 2024-01-01 | −$1,000 | opened |
 * | 2025-01-01 | −$9,100 | added ten times as much a year later |
 * | 2026-01-01 | +$5,000 | what is left |
 *
 * At the standard 0.1 guess the NPV curve is almost flat — the derivative is
 * about +18 against an NPV of about −$5,139 — so Newton's first step is
 * `0.1 + 283.9`, which is not merely wrong but outside the bracket entirely.
 * Bisection has no tangent to follow and cannot do that.
 */
import { DateOnly, Money, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { moneyWeightedReturn } from './mwr.ts';
import { AnalyticsInputError, ratio } from './types.ts';
import { XIRR_BRACKET_HIGH, newtonOnly, npvOf, xirr, type DatedCashFlow } from './xirr.ts';

const USD = currency('USD');
const usd = (dollars: string) => Money.parseAmount(dollars, USD);
const on = (date: string) => DateOnly.parse(date);

/** The committed fixture that breaks Newton. */
const SIGN_FLIPPING: readonly DatedCashFlow[] = [
  { date: on('2024-01-01'), amount: usd('-1000.00') },
  { date: on('2025-01-01'), amount: usd('-9100.00') },
  { date: on('2026-01-01'), amount: usd('5000.00') },
];

describe('xirr', () => {
  it('Newton diverges and bisection converges on the sign-flipping fixture', () => {
    // 1. Plain Newton, with nothing to catch it, leaves the bracket.
    const newton = newtonOnly(SIGN_FLIPPING);
    expect(newton.converged).toBe(false);
    expect(newton.failure).toBe('left_bracket');
    expect(newton.iterations).toBe(1);
    const firstStep = newton.trace[1];
    if (firstStep === undefined) throw new Error('expected a first Newton iterate');
    expect(Number(firstStep)).toBeGreaterThan(Number(XIRR_BRACKET_HIGH));

    // 2. The production solver answers anyway, and says how.
    const outcome = xirr(SIGN_FLIPPING);
    if (outcome.status !== 'solved') throw new Error(`expected a rate, got ${outcome.reason}`);
    expect(outcome.diagnostics.newtonDiverged).toBe(true);
    expect(outcome.diagnostics.bisectionSteps).toBeGreaterThan(0);
    // Pinned exactly. An independent double-precision bisection of the same
    // NPV — run outside this codebase and recorded in the evidence note —
    // agrees to all ten places: -0.4801889654.
    expect(outcome.rate).toBe(ratio('-0.4801889654'));

    // 3. And the answer is a root, not merely a number the loop stopped at.
    expect(Math.abs(Number(npvOf(SIGN_FLIPPING, outcome.rate)))).toBeLessThan(0.01);
  });

  it('flows with no sign change return n/a rather than a number', () => {
    const contributionsOnly: readonly DatedCashFlow[] = [
      { date: on('2025-01-01'), amount: usd('-500.00') },
      { date: on('2025-02-01'), amount: usd('-500.00') },
      { date: on('2025-03-01'), amount: usd('-500.00') },
    ];

    const outcome = xirr(contributionsOnly);
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') throw new Error('unreachable');
    expect(outcome.reason).toBe('no_sign_change_in_flows');
    // The specific fabrication being refused: a 0% "break-even" return.
    expect(outcome).not.toHaveProperty('rate');

    // The same refusal through the portfolio-facing API: a wallet that only
    // ever received deposits and is now worth nothing has no rate of return.
    const mwr = moneyWeightedReturn({
      openingValue: { date: on('2025-01-01'), value: usd('500.00') },
      flows: [{ date: on('2025-02-01'), amount: usd('500.00') }],
      closingValue: { date: on('2025-03-01'), value: usd('0.00') },
    });
    expect(mwr.status).toBe('unavailable');
    if (mwr.status !== 'unavailable') throw new Error('unreachable');
    expect(mwr.reason).toBe('no_sign_change_in_flows');
    expect(mwr.periodReturn).toBeUndefined();

    // A single flow is not a return either.
    expect(xirr([{ date: on('2025-01-01'), amount: usd('-500.00') }])).toMatchObject({
      status: 'unavailable',
      reason: 'single_flow',
    });
  });

  it('a nine-month return is not annualized', () => {
    const nineMonths = moneyWeightedReturn({
      openingValue: { date: on('2025-01-01'), value: usd('10000.00') },
      flows: [],
      closingValue: { date: on('2025-10-02'), value: usd('10800.00') },
    });

    if (nineMonths.status !== 'available') throw new Error('expected a rate');
    expect(nineMonths.spanDays).toBe(274);
    // 8% over the period, which is what happened.
    expect(Number(nineMonths.periodReturn)).toBeCloseTo(0.08, 6);
    // Not 10.85%, which is what compounding 8% over 274 days to a year gives.
    expect(Number(nineMonths.periodReturn)).toBeLessThan(0.09);
    expect(nineMonths.annualized).toBeNull();
    expect(nineMonths.annualizationWithheld).toBe('period_under_one_year');

    // One day past a year, the same portfolio does annualise — the guard is a
    // threshold, not a refusal to ever compound.
    const overAYear = moneyWeightedReturn({
      openingValue: { date: on('2025-01-01'), value: usd('10000.00') },
      flows: [],
      closingValue: { date: on('2026-01-02'), value: usd('10800.00') },
    });
    if (overAYear.status !== 'available') throw new Error('expected a rate');
    expect(overAYear.annualized).not.toBeNull();
    expect(Number(overAYear.annualized)).toBeCloseTo(0.0799, 3);
  });

  it('solves a plain series with Newton alone and says so', () => {
    const simple: readonly DatedCashFlow[] = [
      { date: on('2025-01-01'), amount: usd('-10000.00') },
      { date: on('2026-01-01'), amount: usd('11000.00') },
    ];
    const outcome = xirr(simple);
    if (outcome.status !== 'solved') throw new Error('expected a rate');
    expect(Number(outcome.rate)).toBeCloseTo(0.1, 6);
    expect(outcome.diagnostics.newtonDiverged).toBe(false);
    expect(outcome.diagnostics.solver).toBe('newton');
    expect(outcome.diagnostics.bisectionSteps).toBe(0);

    // Plain Newton converges here too — the fixture above is what separates them.
    expect(newtonOnly(simple).converged).toBe(true);
  });

  it('returns n/a rather than an arbitrary root when the NPV never crosses zero', () => {
    // Two sign changes, two roots, and the same sign at both ends of the
    // bracket: reporting one of them as "the" return would be a coin toss.
    const twoRoots: readonly DatedCashFlow[] = [
      { date: on('2025-01-01'), amount: usd('-1000.00') },
      { date: on('2026-01-01'), amount: usd('2500.00') },
      { date: on('2027-01-01'), amount: usd('-1200.00') },
    ];
    const outcome = xirr(twoRoots);
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'no_bracket' });
  });

  it('refuses mixed currencies rather than adding them', () => {
    expect(() =>
      xirr([
        { date: on('2025-01-01'), amount: usd('-100.00') },
        { date: on('2026-01-01'), amount: Money.parseAmount('110.00', currency('EUR')) },
      ]),
    ).toThrow(AnalyticsInputError);
  });
});
