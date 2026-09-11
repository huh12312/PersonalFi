// SPDX-License-Identifier: MIT
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { InvalidValueError } from './errors.ts';
import {
  QUANTITY_SCALE,
  addQuantity,
  compareQuantity,
  divideQuantity,
  fromDatabaseString,
  multiplyQuantity,
  quantity,
  subtractQuantity,
  toDatabaseString,
} from './quantity.ts';

/** Plausible holdings: from one satoshi to a few billion units. */
const arbQuantity = fc
  .tuple(fc.bigInt({ min: -(10n ** 18n), max: 10n ** 18n }), fc.integer({ min: 0, max: 18 }))
  .map(([unscaled, scale]) => {
    const negative = unscaled < 0n;
    const digits = (negative ? -unscaled : unscaled).toString().padStart(scale + 1, '0');
    const text = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
    return quantity(`${negative ? '-' : ''}${text}`);
  });

describe('Quantity', () => {
  it('adds commutatively and associatively', () => {
    fc.assert(
      fc.property(arbQuantity, arbQuantity, arbQuantity, (a, b, c) => {
        expect(addQuantity(a, b)).toBe(addQuantity(b, a));
        expect(addQuantity(addQuantity(a, b), c)).toBe(addQuantity(a, addQuantity(b, c)));
      }),
    );
  });

  it('round-trips through the NUMERIC(38,18) wire form', () => {
    fc.assert(
      fc.property(arbQuantity, (a) => {
        expect(fromDatabaseString(toDatabaseString(a))).toBe(a);
      }),
    );
  });

  it('keeps one satoshi through a round trip', () => {
    // The canonical precision test: this is 1e-8 BTC, and a float loses it.
    const satoshi = quantity('0.00000001');
    expect(toDatabaseString(satoshi)).toBe('0.000000010000000000');
    expect(fromDatabaseString('0.000000010000000000')).toBe(satoshi);

    // 18 decimals is the ERC-20 wei case, the reason the scale is 18 at all.
    const wei = quantity('0.000000000000000001');
    expect(addQuantity(wei, wei)).toBe('0.000000000000000002');
  });

  it('subtracts to exactly zero', () => {
    fc.assert(
      fc.property(arbQuantity, (a) => {
        expect(subtractQuantity(a, a)).toBe('0');
      }),
    );
  });

  it('does not accumulate float error across many additions', () => {
    let total = quantity('0');
    for (let index = 0; index < 10; index += 1) total = addQuantity(total, quantity('0.1'));
    expect(total).toBe('1');
    // The same loop with numbers gives 0.9999999999999999.
    expect(compareQuantity(total, quantity('1'))).toBe(0);
  });

  it('orders consistently with its numeric value', () => {
    fc.assert(
      fc.property(arbQuantity, arbQuantity, (a, b) => {
        const forward = compareQuantity(a, b);
        expect(compareQuantity(b, a)).toBe(-forward === 0 ? 0 : -forward);
      }),
    );
  });

  it('multiplies and divides as inverses when exact', () => {
    const q = quantity('12.5');
    expect(multiplyQuantity(q, '4')).toBe('50');
    expect(divideQuantity(quantity('50'), '4')).toBe('12.5');
    expect(() => divideQuantity(q, '0')).toThrow(InvalidValueError);
  });

  it('rejects input a NUMERIC(38,18) column could not hold', () => {
    expect(() => quantity('0.0000000000000000001')).toThrow(InvalidValueError); // 19 decimals
    expect(() => quantity('1'.repeat(21))).toThrow(InvalidValueError); // 21 integer digits
    expect(QUANTITY_SCALE).toBe(18);
  });

  it('rejects anything that is not a plain decimal string', () => {
    for (const bad of ['1e-8', 'NaN', 'Infinity', '', ' ', '0x1', '1,5', '.5.']) {
      expect(() => quantity(bad)).toThrow(InvalidValueError);
    }
  });
});
