// SPDX-License-Identifier: MIT
import type { Brand } from './brand.ts';
import { InvalidValueError } from './errors.ts';

/** An ISO-4217 alphabetic currency code, uppercase, exactly three letters. */
export type CurrencyCode = Brand<string, 'CurrencyCode'>;

/**
 * ISO-4217 minor-unit exponents that differ from the default of 2.
 * Only currencies we might plausibly encounter are listed; the default covers
 * the rest. Adding a currency here is a schema-affecting change: see
 * docs/CONVENTIONS.md "Money rules".
 */
const MINOR_UNIT_EXPONENTS: Readonly<Record<string, number>> = {
  BHD: 3,
  BIF: 0,
  CLF: 4,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  IQD: 3,
  ISK: 0,
  JOD: 3,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  PYG: 0,
  RWF: 0,
  TND: 3,
  UGX: 0,
  UYW: 4,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
};

const CODE_PATTERN = /^[A-Z]{3}$/;

/** Validate and brand a currency code. Throws on anything that is not AAA..ZZZ. */
export function currency(code: string): CurrencyCode {
  const upper = code.toUpperCase();
  if (!CODE_PATTERN.test(upper)) {
    throw new InvalidValueError(
      'currency code',
      `expected three letters, got ${JSON.stringify(code)}`,
    );
  }
  return upper as CurrencyCode;
}

export function isCurrencyCode(code: string): code is CurrencyCode {
  return CODE_PATTERN.test(code);
}

/** Number of decimal places in the currency's minor unit (2 for USD, 0 for JPY). */
export function minorUnitScale(code: CurrencyCode): number {
  return MINOR_UNIT_EXPONENTS[code] ?? 2;
}

export const USD: CurrencyCode = 'USD' as CurrencyCode;
