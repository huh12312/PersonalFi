// SPDX-License-Identifier: MIT
/**
 * The type rule, the never-zero-gain rule, and the decimal arithmetic both
 * rest on.
 *
 * The first test in this file is checked by **`tsc`, not by vitest**: vitest
 * transpiles without type-checking, so a `@ts-expect-error` that stopped being
 * an error would still pass here and fail `pnpm exec tsc -b --noEmit`, which
 * is what `just verify` and CI run. That is the intended enforcement point —
 * the rule is about what a *caller can write*, and only the compiler sees
 * that.
 */
import { DateOnly, Money, Quantity, currency } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { timeWeightedReturn } from './twr.ts';
import {
  AnalyticsInputError,
  RATIO_SCALE,
  decimalPow,
  points,
  portfolioDollarGain,
  ratio,
  ratioOfMoney,
  ratioToNumberApproximate,
  ratioToPoints,
  roundDecimalString,
  scaleMoney,
  type DollarGain,
  type MoneyWeightedReturn,
  type TimeWeightedReturn,
} from './types.ts';

const USD = currency('USD');
const usd = (dollars: string) => Money.parseAmount(dollars, USD);
const on = (date: string) => DateOnly.parse(date);

const TWR: TimeWeightedReturn = timeWeightedReturn({
  valuations: [
    { date: on('2025-01-01'), value: usd('100000.00') },
    { date: on('2026-01-01'), value: usd('108000.00') },
  ],
  flows: [],
});

describe('return shapes', () => {
  it('a TWR and a dollar gain cannot be placed in the same return shape', () => {
    const gain = portfolioDollarGain(
      [{ id: 'h-1', marketValue: usd('108000.00'), costBasis: usd('100000.00') }],
      USD,
    );
    if (gain.status !== 'available') throw new Error('expected a gain');

    // 07 §4.2: "Never put a TWR next to a dollar gain." Each of these is a
    // compile error; if any of them stopped being one, `tsc` fails on the
    // unused directive and this file is what points at the rule that broke.

    // @ts-expect-error — a time-weighted return may not carry a dollar gain.
    const _twrWithGain: TimeWeightedReturn = { ...TWR, gain: gain.gain };
    // The realistic failure is not a literal but a *variable*: a route handler
    // merges two engines' output and then returns it. Excess-property checking
    // does not apply to a value that is no longer fresh, so this line is the
    // one that only `gain?: never` can refuse — and the one that turns `tsc`
    // red when the rule is removed.
    const merged = { ...TWR, gain: gain.gain };
    // @ts-expect-error — and it is still refused once it stops being a literal.
    const _twrWithGainIndirect: TimeWeightedReturn = merged;
    void _twrWithGainIndirect;
    // @ts-expect-error — nor a market value, which is the same mistake in a hat.
    const _twrWithValue: TimeWeightedReturn = { ...TWR, marketValue: gain.marketValue };
    // @ts-expect-error — and a dollar gain may not carry a return ratio.
    const _gainWithReturn: DollarGain = { ...gain, periodReturn: TWR.periodReturn };
    const _benchmarked: MoneyWeightedReturn = {
      kind: 'money_weighted',
      status: 'unavailable',
      reason: 'single_flow',
      detail: 'n/a',
      spanDays: 0,
      benchmarkComparable: false,
      // @ts-expect-error — "never benchmark an MWR": there is no field for one.
      benchmark: ratio('0.10'),
    };
    void _twrWithGain;
    void _twrWithValue;
    void _gainWithReturn;
    void _benchmarked;

    // The runtime half: the two shapes share no field a UI could pair.
    expect(Object.keys(TWR)).not.toContain('gain');
    expect(Object.keys(TWR)).not.toContain('marketValue');
    expect(Object.keys(gain)).not.toContain('periodReturn');
    expect(Object.keys(gain)).not.toContain('annualized');
    // Only one of the three shapes claims to be comparable to an index.
    expect(TWR.benchmarkComparable).toBe(true);
    expect(gain).not.toHaveProperty('benchmarkComparable');
  });

  it('an unavailable basis makes the gain unavailable, not zero', () => {
    const gain = portfolioDollarGain(
      [
        { id: 'h-1', marketValue: usd('40000.00'), costBasis: usd('31000.00') },
        // A Coinbase position transferred in: real value, no basis anywhere.
        { id: 'h-2', marketValue: usd('19870.60'), costBasis: null },
      ],
      USD,
    );

    expect(gain.status).toBe('unavailable');
    if (gain.status !== 'unavailable') throw new Error('unreachable');
    expect(gain.reason).toBe('basis_unknown');
    expect(gain.positionIds).toEqual(['h-2']);
    // Not a $19,870.60 gain from a zero basis, and not a $9,000 gain from the
    // positions that happen to have one either — both are fabrications.
    expect(gain).not.toHaveProperty('gain');
    expect(gain.warning).toMatch(/unavailable rather than computed from zero/);
    // The market value is knowable, and is still reported.
    expect(gain.marketValue).toEqual(usd('59870.60'));

    // A missing *price* is a different unavailability, and loses the value too.
    const unpriced = portfolioDollarGain(
      [{ id: 'h-3', marketValue: null, costBasis: usd('100.00') }],
      USD,
    );
    if (unpriced.status !== 'unavailable') throw new Error('unreachable');
    expect(unpriced.reason).toBe('price_unknown');
    expect(unpriced.marketValue).toBeNull();

    // And when everything is known, it is money — not a ratio.
    const known = portfolioDollarGain(
      [{ id: 'h-1', marketValue: usd('40000.00'), costBasis: usd('31000.00') }],
      USD,
    );
    if (known.status !== 'available') throw new Error('unreachable');
    expect(known.gain).toEqual(usd('9000.00'));
  });
});

describe('the ratio type', () => {
  it('is a decimal string at a stated scale, never a float', () => {
    expect(ratio('0.05')).toBe('0.0500000000');
    expect(ratio('0.05')).toHaveLength(12);
    expect(RATIO_SCALE).toBe(10);
    // The canonical form makes equality a string comparison rather than an
    // epsilon argument.
    expect(ratio('0.0500000000')).toBe(ratio('0.05'));
    expect(ratioToPoints(ratio('0.0512'))).toBe('5.1200');
    expect(points('5.1')).toBe('5.1000');
  });

  it('rounds half-even, once, wherever a scale is imposed', () => {
    // Half-even: a tie goes to the even digit, so 0.125 rounds *down* and
    // 0.135 rounds up. Half-up would give 0.13 for the first, and a portfolio
    // full of half-up roundings drifts upward.
    expect(roundDecimalString('0.125', 2)).toBe('0.12');
    expect(roundDecimalString('0.135', 2)).toBe('0.14');
    expect(roundDecimalString('0.145', 2)).toBe('0.14');
    expect(roundDecimalString('-0.125', 2)).toBe('-0.12');
    expect(roundDecimalString('2.5', 0)).toBe('2');
    expect(roundDecimalString('3.5', 0)).toBe('4');
    // Money keeps its own rounding: a ratio applied to money rounds once, at
    // the boundary into minor units.
    expect(scaleMoney(usd('1000.00'), ratio('0.0003'))).toEqual(usd('0.30'));
    expect(scaleMoney(usd('19870.60'), ratio('0.005'))).toEqual(usd('99.35'));
  });

  it('refuses a zero denominator rather than answering zero', () => {
    expect(() => ratioOfMoney(usd('10.00'), usd('0.00'))).toThrow(AnalyticsInputError);
  });

  it('crosses to a number only through the function named for it', () => {
    expect(ratioToNumberApproximate(ratio('0.0812'))).toBeCloseTo(0.0812, 12);
  });
});

describe('decimal powers', () => {
  it('are exact on the cases an integer power would get right', () => {
    expect(Number(decimalPow('1.21', '0.5'))).toBeCloseTo(1.1, 12);
    expect(Number(decimalPow('1.08', '1'))).toBeCloseTo(1.08, 12);
    expect(Number(decimalPow('2', '10'))).toBeCloseTo(1024, 9);
    expect(Number(decimalPow('1.05', '-1'))).toBeCloseTo(1 / 1.05, 12);
  });

  it('holds accuracy where the return engines use them', () => {
    // (1 + 21%)^(365/731) — the two-year annualisation.
    const annualised = decimalPow('1.21', Quantity.divide(Quantity.of('365'), '731'));
    expect(Number(annualised)).toBeCloseTo(Math.pow(1.21, 365 / 731), 12);
    // A deep discount factor, which is where a naive power overflows.
    const deep = decimalPow('1.0001', '-3650');
    expect(Number(deep)).toBeCloseTo(Math.pow(1.0001, -3650), 12);
  });

  it('saturates instead of overflowing at the bracket endpoint', () => {
    // exp(+9.2 × 10) would be 1e40 and outside NUMERIC(38,18); the clamp keeps
    // the sign, which is all the bracket check needs.
    const saturated = decimalPow('0.0001', '-10');
    expect(Number(saturated)).toBeGreaterThan(0);
    expect(Number.isFinite(Number(saturated))).toBe(true);
  });
});
