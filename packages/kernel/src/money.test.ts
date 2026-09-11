// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CurrencyMismatchError, InvalidValueError } from './errors.ts';
import {
  add,
  allocate,
  allocateEvenly,
  compare,
  format,
  formatAmount,
  fromJSON,
  money,
  multiplyByDecimal,
  negate,
  parseAmount,
  subtract,
  sum,
  toJSON,
  zero,
} from './money.ts';

/** Amounts up to ±$90 trillion in minor units: comfortably past any real balance. */
const arbMinor = fc.bigInt({ min: -9_000_000_000_000_000n, max: 9_000_000_000_000_000n });
const arbUsd = arbMinor.map((minor) => money(minor, 'USD'));

describe('Money arithmetic', () => {
  it('adds commutatively', () => {
    fc.assert(
      fc.property(arbUsd, arbUsd, (a, b) => {
        expect(add(a, b)).toEqual(add(b, a));
      }),
    );
  });

  it('adds associatively', () => {
    fc.assert(
      fc.property(arbUsd, arbUsd, arbUsd, (a, b, c) => {
        expect(add(add(a, b), c)).toEqual(add(a, add(b, c)));
      }),
    );
  });

  it('treats zero as the additive identity and negation as its inverse', () => {
    fc.assert(
      fc.property(arbUsd, (a) => {
        expect(add(a, zero('USD'))).toEqual(a);
        expect(add(a, negate(a))).toEqual(zero('USD'));
        expect(subtract(a, a)).toEqual(zero('USD'));
      }),
    );
  });

  it('never loses precision the way a float would', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. It is exact here, which is the whole point.
    const total = add(parseAmount('0.10', 'USD'), parseAmount('0.20', 'USD'));
    expect(formatAmount(total)).toBe('0.30');

    // A float would round this to 8 significant digits and lose the cents.
    const large = add(parseAmount('99999999999.99', 'USD'), parseAmount('0.01', 'USD'));
    expect(formatAmount(large)).toBe('100000000000.00');
  });

  it('refuses to combine currencies rather than coercing them', () => {
    const usd = money(100n, 'USD');
    const eur = money(100n, 'EUR');
    expect(() => add(usd, eur)).toThrow(CurrencyMismatchError);
    expect(() => subtract(usd, eur)).toThrow(CurrencyMismatchError);
    expect(() => compare(usd, eur)).toThrow(CurrencyMismatchError);
    // The message names both sides; a silent 0 here would be a ledger corruption.
    expect(() => add(usd, eur)).toThrow(/USD.*EUR/);
  });

  it('sums a sequence to the same value as folding it', () => {
    fc.assert(
      fc.property(fc.array(arbUsd, { maxLength: 50 }), (amounts) => {
        const folded = amounts.reduce((acc, cur) => add(acc, cur), zero('USD'));
        expect(sum(amounts, 'USD')).toEqual(folded);
      }),
    );
  });
});

describe('Money.allocate', () => {
  it('always sums back to the original amount', () => {
    fc.assert(
      fc.property(
        arbUsd,
        fc.array(fc.bigInt({ min: 0n, max: 1_000n }), { minLength: 1, maxLength: 12 }),
        (total, weights) => {
          fc.pre(weights.reduce((a, b) => a + b, 0n) > 0n);
          const parts = allocate(total, weights);
          expect(parts).toHaveLength(weights.length);
          expect(sum(parts, 'USD')).toEqual(total);
        },
      ),
    );
  });

  it('distributes the remainder rather than dropping it', () => {
    // The canonical case: $10 three ways is 3.34 / 3.33 / 3.33, never 3.33 x3.
    const parts = allocateEvenly(parseAmount('10.00', 'USD'), 3);
    expect(parts.map(formatAmount)).toEqual(['3.34', '3.33', '3.33']);
  });

  it('keeps parts within one minor unit of each other when weights are equal', () => {
    fc.assert(
      fc.property(arbUsd, fc.integer({ min: 1, max: 20 }), (total, parts) => {
        const shares = allocateEvenly(total, parts).map((s) => s.minor);
        const highest = shares.reduce((a, b) => (a > b ? a : b));
        const lowest = shares.reduce((a, b) => (a < b ? a : b));
        expect(highest - lowest).toBeLessThanOrEqual(1n);
      }),
    );
  });

  it('handles negative totals without losing a unit', () => {
    const parts = allocateEvenly(parseAmount('-10.00', 'USD'), 3);
    expect(parts.map(formatAmount)).toEqual(['-3.34', '-3.33', '-3.33']);
    expect(sum(parts, 'USD')).toEqual(parseAmount('-10.00', 'USD'));
  });

  it('respects weights proportionally', () => {
    const parts = allocate(parseAmount('100.00', 'USD'), [1n, 3n]);
    expect(parts.map(formatAmount)).toEqual(['25.00', '75.00']);
  });

  it('rejects weights that cannot define a split', () => {
    const ten = parseAmount('10.00', 'USD');
    expect(() => allocate(ten, [])).toThrow(InvalidValueError);
    expect(() => allocate(ten, [0n, 0n])).toThrow(InvalidValueError);
    expect(() => allocate(ten, [-1n, 2n])).toThrow(InvalidValueError);
  });
});

describe('Money.multiplyByDecimal', () => {
  it('rounds half to even by default', () => {
    // 0.005 -> 0.00 (down to even) and 0.015 -> 0.02 (up to even).
    expect(formatAmount(multiplyByDecimal(money(5n, 'USD'), '0.1', 'half-even'))).toBe('0.00');
    expect(formatAmount(multiplyByDecimal(money(15n, 'USD'), '0.1', 'half-even'))).toBe('0.02');
    expect(formatAmount(multiplyByDecimal(money(5n, 'USD'), '0.1', 'half-up'))).toBe('0.01');
  });

  it('is symmetric under negation for half-even', () => {
    fc.assert(
      fc.property(arbUsd, (a) => {
        const scaled = multiplyByDecimal(a, '0.375');
        const negated = multiplyByDecimal(negate(a), '0.375');
        expect(negated).toEqual(negate(scaled));
      }),
    );
  });

  it('multiplies exactly when no rounding is needed', () => {
    expect(formatAmount(multiplyByDecimal(parseAmount('100.00', 'USD'), '1.5'))).toBe('150.00');
    expect(formatAmount(multiplyByDecimal(parseAmount('100.00', 'USD'), '-0.25'))).toBe('-25.00');
  });
});

describe('Money serialisation', () => {
  it('round-trips through JSON', () => {
    fc.assert(
      fc.property(arbUsd, (a) => {
        expect(fromJSON(toJSON(a))).toEqual(a);
      }),
    );
  });

  it('round-trips through its decimal string form', () => {
    fc.assert(
      fc.property(arbUsd, (a) => {
        expect(parseAmount(formatAmount(a), 'USD')).toEqual(a);
      }),
    );
  });

  it('serialises minor units as a string, never a JSON number', () => {
    const big = money(9_007_199_254_740_993n, 'USD'); // Number.MAX_SAFE_INTEGER + 2
    const wire = JSON.parse(JSON.stringify(toJSON(big))) as { minor: unknown };
    expect(typeof wire.minor).toBe('string');
    expect(fromJSON(toJSON(big))).toEqual(big);
  });

  it('honours currencies whose minor unit is not two decimals', () => {
    expect(formatAmount(money(1234n, 'JPY'))).toBe('1234'); // zero decimals
    expect(formatAmount(money(1234n, 'BHD'))).toBe('1.234'); // three decimals
    expect(format(money(-1234n, 'USD'))).toBe('-12.34 USD');
  });

  it('refuses an amount with more precision than the currency has', () => {
    expect(() => parseAmount('12.345', 'USD')).toThrow(InvalidValueError);
    expect(() => parseAmount('1.5', 'JPY')).toThrow(InvalidValueError);
    // Fewer places is fine; it is unambiguous.
    expect(parseAmount('12.3', 'USD')).toEqual(money(1230n, 'USD'));
    expect(parseAmount('12', 'USD')).toEqual(money(1200n, 'USD'));
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['1e3', '12.34.56', '', 'abc', '1,234.00', '0x10', 'Infinity']) {
      expect(() => parseAmount(bad, 'USD')).toThrow(InvalidValueError);
    }
  });
});
