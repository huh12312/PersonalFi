// SPDX-License-Identifier: MIT
import { Decimal } from 'decimal.js';
import type { Brand } from './brand.ts';
import { InvalidValueError } from './errors.ts';

/**
 * An arbitrary-precision decimal quantity of a security or crypto asset.
 *
 * Quantities are **not** money: they are genuinely fractional and need far more
 * precision than a minor unit. Stored as `NUMERIC(38,18)`, carried in TypeScript
 * as a canonical decimal string so `0.00000001 BTC` survives a round trip.
 * Never a `number`.
 */
export type Quantity = Brand<string, 'Quantity'>;

/** Decimal places available in `NUMERIC(38,18)`. */
export const QUANTITY_SCALE = 18;
/** Total significant digits available in `NUMERIC(38,18)`. */
export const QUANTITY_PRECISION = 38;
/** Digits available to the left of the decimal point. */
export const QUANTITY_MAX_INTEGER_DIGITS = QUANTITY_PRECISION - QUANTITY_SCALE;

// Wide enough that intermediate products never lose a storable digit, and
// configured to refuse exponential notation so `toString()` is always plain.
const Q = Decimal.clone({
  precision: 80,
  toExpNeg: -40,
  toExpPos: 60,
  rounding: Decimal.ROUND_HALF_EVEN,
});

const PLAIN_DECIMAL = /^[+-]?(\d+)(\.\d+)?$/;

function toDecimal(value: Quantity | string): InstanceType<typeof Q> {
  return new Q(value);
}

/** Canonicalise: trim trailing zeros beyond what is significant, normalise `-0`. */
function canonical(d: InstanceType<typeof Q>): Quantity {
  if (!d.isFinite()) throw new InvalidValueError('quantity', 'must be finite');
  const rounded = d.toDecimalPlaces(QUANTITY_SCALE, Decimal.ROUND_HALF_EVEN);
  const text = rounded.isZero() ? '0' : rounded.toFixed();
  const integerDigits = text.replace('-', '').split('.')[0]?.length ?? 0;
  if (integerDigits > QUANTITY_MAX_INTEGER_DIGITS) {
    throw new InvalidValueError(
      'quantity',
      `exceeds NUMERIC(${QUANTITY_PRECISION},${QUANTITY_SCALE}): ${integerDigits} integer digits`,
    );
  }
  return text as Quantity;
}

/**
 * Build a quantity from a plain decimal string. A `number` is rejected because
 * `0.1 + 0.2` is exactly the failure mode this type exists to prevent.
 */
export function quantity(value: string): Quantity {
  const text = value.trim();
  if (!PLAIN_DECIMAL.test(text)) {
    throw new InvalidValueError(
      'quantity',
      `expected a plain decimal string, got ${JSON.stringify(value)}`,
    );
  }
  const fraction = text.split('.')[1] ?? '';
  if (fraction.length > QUANTITY_SCALE) {
    throw new InvalidValueError(
      'quantity',
      `at most ${QUANTITY_SCALE} decimal places, got ${fraction.length}`,
    );
  }
  return canonical(toDecimal(text));
}

export const ZERO_QUANTITY: Quantity = '0' as Quantity;

export function addQuantity(a: Quantity, b: Quantity): Quantity {
  return canonical(toDecimal(a).plus(toDecimal(b)));
}

export function subtractQuantity(a: Quantity, b: Quantity): Quantity {
  return canonical(toDecimal(a).minus(toDecimal(b)));
}

export function negateQuantity(a: Quantity): Quantity {
  return canonical(toDecimal(a).negated());
}

export function multiplyQuantity(a: Quantity, factor: Quantity | string): Quantity {
  return canonical(toDecimal(a).times(toDecimal(factor)));
}

export function divideQuantity(a: Quantity, divisor: Quantity | string): Quantity {
  const d = toDecimal(divisor);
  if (d.isZero()) throw new InvalidValueError('quantity', 'division by zero');
  return canonical(toDecimal(a).dividedBy(d));
}

export function compareQuantity(a: Quantity, b: Quantity): -1 | 0 | 1 {
  return toDecimal(a).comparedTo(toDecimal(b)) as -1 | 0 | 1;
}

export function quantityEquals(a: Quantity, b: Quantity): boolean {
  return compareQuantity(a, b) === 0;
}

export function isZeroQuantity(a: Quantity): boolean {
  return toDecimal(a).isZero();
}

export function isNegativeQuantity(a: Quantity): boolean {
  return toDecimal(a).isNegative() && !toDecimal(a).isZero();
}

/** Exactly what goes into a `NUMERIC(38,18)` column: fixed scale, no exponent. */
export function toDatabaseString(a: Quantity): string {
  return toDecimal(a).toFixed(QUANTITY_SCALE);
}

/** Read back from a `NUMERIC(38,18)` column (node-postgres yields a string). */
export function fromDatabaseString(value: string): Quantity {
  return quantity(value.trim());
}

/**
 * Lossy on purpose, and named so. Only for charting and other estimates; the
 * result must never flow back into a quantity or a money column.
 */
export function toNumberApproximate(a: Quantity): number {
  return toDecimal(a).toNumber();
}

export const Quantity = {
  of: quantity,
  zero: ZERO_QUANTITY,
  add: addQuantity,
  subtract: subtractQuantity,
  negate: negateQuantity,
  multiply: multiplyQuantity,
  divide: divideQuantity,
  compare: compareQuantity,
  equals: quantityEquals,
  isZero: isZeroQuantity,
  isNegative: isNegativeQuantity,
  toDatabaseString,
  fromDatabaseString,
  toNumberApproximate,
} as const;
