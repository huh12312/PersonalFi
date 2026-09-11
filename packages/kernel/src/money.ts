// SPDX-License-Identifier: MIT
import { currency, minorUnitScale, type CurrencyCode } from './currency.ts';
import { CurrencyMismatchError, InvalidValueError } from './errors.ts';

/**
 * An exact monetary amount: integer minor units plus its currency.
 *
 * House sign convention (stated once, enforced at every adapter boundary):
 * **negative = outflow, positive = inflow.**
 *
 * Never a float. Never a JSON number. Serialize with `toJSON` (minor units as a
 * decimal string) or `formatAmount` (a human decimal string).
 */
export interface Money {
  readonly minor: bigint;
  readonly currency: CurrencyCode;
}

export type RoundingMode = 'half-even' | 'half-up' | 'half-down' | 'floor' | 'ceil' | 'trunc';

export function money(minor: bigint, code: CurrencyCode | string): Money {
  return Object.freeze({ minor, currency: typeof code === 'string' ? currency(code) : code });
}

export function zero(code: CurrencyCode | string): Money {
  return money(0n, code);
}

/** Scale (decimal places) of this amount's currency. */
export function scaleOf(m: Money): number {
  return minorUnitScale(m.currency);
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor + b.minor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.minor - b.minor, a.currency);
}

export function negate(m: Money): Money {
  return money(-m.minor, m.currency);
}

export function absolute(m: Money): Money {
  return m.minor < 0n ? negate(m) : m;
}

/** Sum of a (possibly empty) sequence. An empty sequence needs an explicit currency. */
export function sum(amounts: Iterable<Money>, code?: CurrencyCode | string): Money {
  let total: Money | undefined;
  for (const amount of amounts) {
    total = total === undefined ? amount : add(total, amount);
  }
  if (total !== undefined) {
    if (code !== undefined) assertSameCurrency(total, zero(code));
    return total;
  }
  if (code === undefined) {
    throw new InvalidValueError('sum', 'empty sequence requires an explicit currency');
  }
  return zero(code);
}

/** -1 if a < b, 0 if equal, 1 if a > b. Throws on a currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.minor < b.minor) return -1;
  if (a.minor > b.minor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.minor === b.minor;
}

export function isZero(m: Money): boolean {
  return m.minor === 0n;
}

export function isNegative(m: Money): boolean {
  return m.minor < 0n;
}

export function isPositive(m: Money): boolean {
  return m.minor > 0n;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

/** Multiply by a whole number of times. Exact, never rounds. */
export function multiplyByInteger(m: Money, factor: bigint): Money {
  return money(m.minor * factor, m.currency);
}

const DECIMAL_PATTERN = /^([+-]?)(\d+)(?:\.(\d+))?$/;

interface ParsedDecimal {
  readonly sign: bigint;
  readonly unscaled: bigint;
  readonly scale: number;
}

function parseDecimal(what: string, text: string): ParsedDecimal {
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (match === null) {
    throw new InvalidValueError(
      what,
      `expected a plain decimal string, got ${JSON.stringify(text)}`,
    );
  }
  const [, signText = '', intPart = '0', fracPart = ''] = match;
  return {
    sign: signText === '-' ? -1n : 1n,
    unscaled: BigInt(`${intPart}${fracPart}`),
    scale: fracPart.length,
  };
}

function pow10(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

/** Divide `numerator` by `denominator` (both exact) applying `mode`. denominator > 0. */
function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) throw new InvalidValueError('division', 'denominator must be positive');
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;
  if (remainder === 0n) return quotient;

  const negative = numerator < 0n;
  const twiceRemainder = (remainder < 0n ? -remainder : remainder) * 2n;
  const awayFromZero = negative ? quotient - 1n : quotient + 1n;

  switch (mode) {
    case 'trunc':
      return quotient;
    case 'floor':
      return negative ? quotient - 1n : quotient;
    case 'ceil':
      return negative ? quotient : quotient + 1n;
    case 'half-up':
      return twiceRemainder >= denominator ? awayFromZero : quotient;
    case 'half-down':
      return twiceRemainder > denominator ? awayFromZero : quotient;
    case 'half-even': {
      if (twiceRemainder > denominator) return awayFromZero;
      if (twiceRemainder < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
    }
  }
}

/**
 * Multiply by an exact decimal supplied as a string (`'0.075'`, `'-1.5'`).
 *
 * A `number` is deliberately not accepted: `0.1 * 3` is the bug this type exists
 * to prevent. Rounds with banker's rounding by default.
 */
export function multiplyByDecimal(
  m: Money,
  factor: string,
  mode: RoundingMode = 'half-even',
): Money {
  const { sign, unscaled, scale } = parseDecimal('decimal factor', factor);
  const numerator = m.minor * unscaled * sign;
  return money(divideRounded(numerator, pow10(scale), mode), m.currency);
}

/**
 * Split an amount across integer weights, distributing the remainder by the
 * largest-remainder method so the parts always sum back to the original.
 * `$10.00` over `[1,1,1]` yields `3.34 / 3.33 / 3.33`; no cent is ever lost.
 */
export function allocate(m: Money, weights: readonly bigint[]): Money[] {
  if (weights.length === 0) throw new InvalidValueError('allocation', 'weights must not be empty');
  let totalWeight = 0n;
  for (const weight of weights) {
    if (weight < 0n) throw new InvalidValueError('allocation', 'weights must not be negative');
    totalWeight += weight;
  }
  if (totalWeight === 0n) {
    throw new InvalidValueError('allocation', 'weights must not sum to zero');
  }

  const negative = m.minor < 0n;
  const total = negative ? -m.minor : m.minor;

  const base: bigint[] = [];
  const remainders: bigint[] = [];
  let distributed = 0n;
  for (const weight of weights) {
    const product = total * weight;
    const share = product / totalWeight;
    base.push(share);
    remainders.push(product - share * totalWeight);
    distributed += share;
  }

  let leftover = total - distributed;
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : b.remainder > a.remainder ? 1 : -1,
    );

  for (const { index } of order) {
    if (leftover <= 0n) break;
    base[index] = (base[index] ?? 0n) + 1n;
    leftover -= 1n;
  }

  return base.map((share) => money(negative ? -share : share, m.currency));
}

/** Split evenly into `parts` shares, remainder distributed to the earliest shares. */
export function allocateEvenly(m: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new InvalidValueError('allocation', `parts must be a positive integer, got ${parts}`);
  }
  return allocate(
    m,
    Array.from({ length: parts }, () => 1n),
  );
}

/** Plain decimal string with the currency's scale, e.g. `'-12.34'`. No symbols, no grouping. */
export function formatAmount(m: Money): string {
  const scale = scaleOf(m);
  const negative = m.minor < 0n;
  const digits = (negative ? -m.minor : m.minor).toString().padStart(scale + 1, '0');
  const sign = negative ? '-' : '';
  if (scale === 0) return `${sign}${digits}`;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** `'-12.34 USD'`. Presentation-layer localisation is the frontend's job, not the kernel's. */
export function format(m: Money): string {
  return `${formatAmount(m)} ${m.currency}`;
}

/**
 * Parse a human decimal amount. More decimal places than the currency's scale is
 * an error, not a silent rounding: rounding money is always a deliberate act.
 */
export function parseAmount(text: string, code: CurrencyCode | string): Money {
  const target = typeof code === 'string' ? currency(code) : code;
  const { sign, unscaled, scale } = parseDecimal('money amount', text);
  const currencyScale = minorUnitScale(target);
  if (scale > currencyScale) {
    throw new InvalidValueError(
      'money amount',
      `${target} has ${currencyScale} decimal places, got ${scale}`,
    );
  }
  return money(sign * unscaled * pow10(currencyScale - scale), target);
}

export interface MoneyJson {
  readonly minor: string;
  readonly currency: string;
}

/** Wire form. Minor units as a *string*: JSON numbers cannot hold a bigint safely. */
export function toJSON(m: Money): MoneyJson {
  return { minor: m.minor.toString(), currency: m.currency };
}

export function fromJSON(value: MoneyJson): Money {
  if (!/^[+-]?\d+$/.test(value.minor)) {
    throw new InvalidValueError('money minor units', JSON.stringify(value.minor));
  }
  return money(BigInt(value.minor), currency(value.currency));
}

/** Namespace form, for call sites that prefer `Money.add(a, b)`. */
export const Money = {
  of: money,
  zero,
  add,
  subtract,
  negate,
  absolute,
  sum,
  compare,
  equals,
  isZero,
  isNegative,
  isPositive,
  min,
  max,
  multiplyByInteger,
  multiplyByDecimal,
  allocate,
  allocateEvenly,
  formatAmount,
  format,
  parseAmount,
  scaleOf,
  toJSON,
  fromJSON,
} as const;
