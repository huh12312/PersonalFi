// SPDX-License-Identifier: MIT
/**
 * Fixed-scale decimal arithmetic in `bigint`, for the validator only.
 *
 * ## Why not a float, and why not `Money`
 *
 * The validator has to answer one question exactly: *does the arithmetic an
 * advisor declared actually produce the number it printed?* A float answers it
 * approximately — `18.99 * 12` is `227.88000000000002` in IEEE-754 — and an
 * approximate answer turns the anti-fabrication check into a tolerance
 * negotiation, which is how a control stops being one.
 *
 * `Money` is the right type for money and the wrong type here: a derivation's
 * operands are not all money. `$0 * 12` multiplies minor units by a count;
 * `$0 / $1` divides one figure by another and yields a ratio. `Money.multiply`
 * by a scalar exists, `Money / Money` deliberately does not, and forcing every
 * intermediate through a currency would make the common formulas unexpressible.
 *
 * So: a scale-6 decimal in `bigint`. Six because a ratio printed to four decimal
 * places (0.0125 = 1.25% APY) has to survive the round trip and six leaves two
 * digits of headroom; more scale would make the rounding of `1/3` a longer
 * number without making it a more correct one.
 *
 * Rounding is **half-even** at every step, matching docs/CONVENTIONS.md
 * ("Rounding is banker's (half-even) by default"), so a chain of multiplications
 * does not drift upward the way half-up does.
 *
 * Division by zero is `null`, not a throw. The validator must be *total* over
 * arbitrary JSON — `validation-totality.test.ts` is a fast-check property that
 * says so — and an advisor sending `$0 / 0` is a rejected derivation, not a
 * crashed worker.
 */

export const DECIMAL_SCALE = 6;
const SCALE_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

/** A decimal with an implicit scale of `DECIMAL_SCALE`. `1.5` is `1_500_000n`. */
export type Decimal = bigint;

/** The largest magnitude the validator will carry. Beyond it, arithmetic is `null`. */
const MAX_MAGNITUDE = 10n ** 24n * SCALE_FACTOR;

function guard(value: bigint | null): Decimal | null {
  if (value === null) return null;
  return value > MAX_MAGNITUDE || value < -MAX_MAGNITUDE ? null : value;
}

/**
 * Parse a decimal *string*. `null` for anything that is not one.
 *
 * Deliberately narrow: an optional sign, digits, an optional fraction. No
 * exponent (`1e400` is a denial-of-service in a parser that accepts it and a
 * number no advisor needs), no leading `+`, no whitespace, no separators. The
 * digit caps are what make the parse bounded rather than a function of the
 * attacker's input length.
 */
export function parseDecimal(text: string): Decimal | null {
  const match = /^(-?)(\d{1,25})(?:\.(\d{1,12}))?$/.exec(text);
  if (match === null) return null;
  const [, sign = '', whole = '0', fraction = ''] = match;
  const padded = (fraction + '0'.repeat(DECIMAL_SCALE)).slice(0, DECIMAL_SCALE);
  const magnitude = BigInt(whole) * SCALE_FACTOR + BigInt(padded === '' ? '0' : padded);
  return guard(sign === '-' ? -magnitude : magnitude);
}

/**
 * A JSON number as a decimal. `null` for `NaN`, infinities and anything whose
 * magnitude or precision the scale cannot hold honestly.
 *
 * Routed through `toFixed` rather than through arithmetic on the float, so the
 * conversion is the same one a reader doing it by hand would perform.
 */
export function fromNumber(value: number): Decimal | null {
  if (!Number.isFinite(value)) return null;
  if (Math.abs(value) >= 1e24) return null;
  return parseDecimal(value.toFixed(DECIMAL_SCALE).replace(/^\+/, ''));
}

export function add(left: Decimal, right: Decimal): Decimal | null {
  return guard(left + right);
}

export function subtract(left: Decimal, right: Decimal): Decimal | null {
  return guard(left - right);
}

/** Half-even division of two already-scaled integers. */
function divideRound(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator === 0n) return null;
  const negative = numerator < 0n !== denominator < 0n;
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const quotient = absoluteNumerator / absoluteDenominator;
  const remainder = absoluteNumerator % absoluteDenominator;
  const twice = remainder * 2n;
  let rounded = quotient;
  if (twice > absoluteDenominator) rounded += 1n;
  else if (twice === absoluteDenominator && quotient % 2n === 1n) rounded += 1n;
  return negative ? -rounded : rounded;
}

export function multiply(left: Decimal, right: Decimal): Decimal | null {
  return guard(divideRound(left * right, SCALE_FACTOR));
}

export function divide(left: Decimal, right: Decimal): Decimal | null {
  if (right === 0n) return null;
  return guard(divideRound(left * SCALE_FACTOR, right));
}

export function negate(value: Decimal): Decimal {
  return -value;
}

export function absolute(value: Decimal): Decimal {
  return value < 0n ? -value : value;
}

/**
 * Round to `decimals` places, half-even, and render.
 *
 * This is the function the numeral check compares through: an advisor printing
 * `$227.88` for a computed `227.880000` is rounding for display, which is
 * legitimate; an advisor printing `$230` for the same figure is not, and the
 * difference is exactly `decimals`.
 */
export function render(value: Decimal, decimals: number): string | null {
  if (decimals < 0 || decimals > DECIMAL_SCALE) return null;
  const factor = 10n ** BigInt(DECIMAL_SCALE - decimals);
  const scaled = divideRound(value, factor);
  if (scaled === null) return null;
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = decimals === 0 ? '' : `.${digits.slice(digits.length - decimals)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}
