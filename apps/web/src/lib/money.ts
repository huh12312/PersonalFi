// SPDX-License-Identifier: MIT
import { Money as MoneyKernel, currency, minorUnitScale, type CurrencyCode } from '@core/kernel';

/**
 * The wire shape (docs/CONVENTIONS.md "Money"): minor units as a *string*,
 * never a JSON number — `bigint` and IEEE-754 both make a JSON number a
 * liability. Every API response carries this shape; parse it with
 * {@link parseWireMoney} immediately at the query boundary and never touch
 * `.minor` as a string again.
 */
export interface WireMoney {
  readonly minor: string;
  readonly currency: string;
}

/** Parse the wire shape into the kernel's exact-arithmetic `Money`. Throws on malformed input. */
export function parseWireMoney(value: WireMoney): MoneyKernel {
  return MoneyKernel.fromJSON(value);
}

export function toWireMoney(value: MoneyKernel): WireMoney {
  return MoneyKernel.toJSON(value);
}

export type MoneySign = 'positive' | 'negative' | 'zero';

export function signOf(value: MoneyKernel): MoneySign {
  if (MoneyKernel.isZero(value)) return 'zero';
  return MoneyKernel.isNegative(value) ? 'negative' : 'positive';
}

/* ------------------------------------------------------------------------ */
/* Formatting — one memoized Intl.NumberFormat per (locale, currency, style) */
/* (05-frontend-architecture.md §2.7). Constructing one per row is the #1   */
/* perf trap in a 10k-row virtualized list.                                */
/* ------------------------------------------------------------------------ */

const DEFAULT_LOCALE = 'en-US';

/** U+2212 MINUS SIGN, not U+002D HYPHEN-MINUS — aligns with digit width under tabular-nums. */
const MINUS_SIGN = '−';

interface FormatMoneyOptions {
  readonly locale?: string;
  /** `'exceptZero'` (default, `+`/`−` always shown) or `'auto'` (negative only). */
  readonly signDisplay?: 'exceptZero' | 'auto' | 'never';
  /** Axis ticks / hero-adjacent labels only — never a table cell or transaction row (§2.7). */
  readonly compact?: boolean;
  readonly currencyDisplay?: 'symbol' | 'narrowSymbol' | 'code';
}

const currencyFormatCache = new Map<string, Intl.NumberFormat>();

function currencyFormatter(
  locale: string,
  code: string,
  signDisplay: 'exceptZero' | 'auto' | 'never',
  compact: boolean,
  currencyDisplay: 'symbol' | 'narrowSymbol' | 'code',
): Intl.NumberFormat {
  const key = `${locale}|${code}|${signDisplay}|${compact}|${currencyDisplay}`;
  let formatter = currencyFormatCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay,
      signDisplay,
      notation: compact ? 'compact' : 'standard',
    });
    currencyFormatCache.set(key, formatter);
  }
  return formatter;
}

function withProperMinusSign(formatted: string): string {
  return formatted.replace('-', MINUS_SIGN);
}

/**
 * Format a `Money` for display. Uses the kernel's exact decimal string
 * (`formatAmount`) as the input to `Intl.NumberFormat`, never a float
 * division of minor units — modern `Intl.NumberFormat` accepts an
 * arbitrary-precision numeric *string* and formats it exactly.
 */
export function formatMoney(value: MoneyKernel, options: FormatMoneyOptions = {}): string {
  const {
    locale = DEFAULT_LOCALE,
    signDisplay = 'exceptZero',
    compact = false,
    currencyDisplay = 'symbol',
  } = options;
  const formatter = currencyFormatter(locale, value.currency, signDisplay, compact, currencyDisplay);
  return withProperMinusSign(formatter.format(asNumericLiteral(MoneyKernel.formatAmount(value))));
}

/** The unabbreviated value for screen readers, e.g. "12,412 dollars 40 cents" — §2.7. */
export function formatMoneyForScreenReader(value: MoneyKernel, locale = DEFAULT_LOCALE): string {
  const scale = minorUnitScale(value.currency as CurrencyCode);
  const parts = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    currencyDisplay: 'name',
    minimumFractionDigits: scale,
  }).formatToParts(asNumericLiteral(MoneyKernel.formatAmount(value)));
  return parts.map((p) => p.value).join('');
}

/**
 * `Intl.NumberFormat` accepts an arbitrary-precision numeric string at
 * runtime (`StringNumericLiteral` in the TS lib), but only a template-literal
 * *type* proves that to the compiler. The kernel's `formatAmount` already
 * guarantees the runtime shape (`-?\d+(\.\d+)?`); this cast documents that
 * contract at the one call site that needs it, rather than widening the
 * public return type to `any`.
 */
function asNumericLiteral(decimal: string): `${number}` {
  return decimal as unknown as `${number}`;
}

/* ------------------------------------------------------------------------ */
/* Percentages — 1 decimal below 10%, 0 above, signDisplay exceptZero (§2.7) */
/* ------------------------------------------------------------------------ */

const percentFormatCache = new Map<string, Intl.NumberFormat>();

export function formatPercent(
  ratio: number,
  options: { locale?: string; signDisplay?: 'exceptZero' | 'auto' | 'never' } = {},
): string {
  const { locale = DEFAULT_LOCALE, signDisplay = 'auto' } = options;
  const magnitude = Math.abs(ratio) * 100;
  const maximumFractionDigits = magnitude < 10 ? 1 : 0;
  const key = `${locale}|${signDisplay}|${maximumFractionDigits}`;
  let formatter = percentFormatCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'percent',
      signDisplay,
      maximumFractionDigits,
    });
    percentFormatCache.set(key, formatter);
  }
  return withProperMinusSign(formatter.format(ratio));
}

export function currencyCode(code: string): CurrencyCode {
  return currency(code);
}

export { MoneyKernel as Money };
