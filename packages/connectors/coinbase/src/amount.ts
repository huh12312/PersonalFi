// SPDX-License-Identifier: MIT
/**
 * Decimal strings in, `Money` and `Quantity` out. No float ever appears.
 *
 * ## Why this file is different from Plaid's `amount.ts`
 *
 * Plaid sends JSON **numbers** and the whole problem there is that a float has
 * already happened by the time we see it. Coinbase sends **decimal strings** —
 * `"0.00123456"`, `"63105.23"` — which is the good case, and the only way to
 * ruin it is to call `Number()` on the way past. Nothing here does. Every value
 * travels as a string until it becomes a `bigint`.
 *
 * ## The one conversion that needs care: quantity × price → `Money`
 *
 * A crypto wallet's contribution to net worth is `quantity × price`, and both
 * sides are decimal strings with more places than a cent. `Money.parseAmount`
 * refuses a USD string with three decimals (correctly — "rounding money is
 * always a deliberate act"), and `Money.multiplyByDecimal` would need the price
 * to already *be* a `Money`, which would round it to cents **before** the
 * multiply. That double rounding loses real value on a small position: at
 * $63,105.239 a coin, rounding the price first and then multiplying by 3.5
 * misplaces a cent, and misplaced cents in a holdings table are the thing a user
 * notices first.
 *
 * So `usdValueOf` rounds **once**, at the end, over exact integers:
 *
 * ```
 *   quantity = qUnscaled / 10^qScale
 *   price    = pUnscaled / 10^pScale
 *   minor    = round( qUnscaled · pUnscaled / 10^(qScale + pScale − 2) )
 * ```
 *
 * with banker's rounding, matching `@core/kernel`'s own default. The division is
 * `bigint`, so the only approximation in the whole path is the deliberate one on
 * the last line.
 *
 * ## Why a crypto wallet's balance is denominated in USD and not in BTC
 *
 * `money(…, 'BTC')` type-checks — `currency()` accepts any three letters — and
 * is a trap: `minorUnitScale` answers 2 for anything it does not know, so a
 * `Money` in BTC has **two** decimal places and `0.00000001 BTC` becomes `0n`.
 * That is D3, exactly, in the one place it would be least visible. The native
 * amount therefore travels as `ProviderHoldingFact.quantity` — a decimal string
 * with eighteen places — and the `Money` on an account, a balance or a holding
 * is always the USD valuation. `map.ts` has the matching comment.
 */
import { ConnectorError } from '@connector/port';
import {
  Money,
  currency,
  minorUnitScale,
  quantity,
  type CurrencyCode,
  type Quantity,
} from '@core/kernel';

/** Plain decimal, optionally signed. No exponent: Coinbase never sends one. */
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/;

export function malformed(what: string, detail: Record<string, unknown>): ConnectorError {
  return ConnectorError.fromCondition('MALFORMED_RESPONSE', `coinbase sent ${what}`, {
    redactedContext: detail,
  });
}

interface ExactDecimal {
  readonly negative: boolean;
  /** Absolute value, times `10^scale`. */
  readonly unscaled: bigint;
  readonly scale: number;
}

/**
 * Parse a Coinbase decimal string exactly.
 *
 * The `field` name is in every error and **no value ever is**: a balance is a
 * fact about the user's money, and an error message is the one place that
 * reliably escapes into a log file and a UI at the same time.
 */
function exactDecimalOf(text: unknown, field: string): ExactDecimal {
  if (typeof text !== 'string') {
    throw malformed(`a non-string ${field}`, { field, type: typeof text });
  }
  const match = DECIMAL.exec(text.trim());
  if (match === null) {
    throw malformed(`a ${field} that is not a plain decimal`, { field });
  }
  const [, sign = '', whole = '0', fraction = ''] = match;
  return {
    negative: sign === '-',
    unscaled: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

/** Banker's rounding of `numerator / 10^exponent`, exactly. `exponent >= 0`. */
function roundHalfEven(numerator: bigint, exponent: number): bigint {
  if (exponent <= 0) return numerator * 10n ** BigInt(-exponent);
  const denominator = 10n ** BigInt(exponent);
  const quotient = numerator / denominator;
  const remainder = numerator - quotient * denominator;
  if (remainder === 0n) return quotient;

  const negative = numerator < 0n;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const away = negative ? quotient - 1n : quotient + 1n;
  if (twice > denominator) return away;
  if (twice < denominator) return quotient;
  return quotient % 2n === 0n ? quotient : away;
}

/**
 * A Coinbase asset code: `BTC`, `ETH`, `USDC`, `MATIC`.
 *
 * Deliberately **not** a `CurrencyCode`. Half of them are longer than three
 * letters and none of them has an ISO minor unit, so branding one as a currency
 * would be a claim the kernel would then act on.
 */
export type AssetCode = string;

/** Validate the currency of a **fiat** wallet. A crypto code must never reach this. */
export function fiatCurrencyOf(code: unknown, field: string): CurrencyCode {
  if (typeof code !== 'string') {
    throw malformed(`a non-string ${field}`, { field, type: typeof code });
  }
  try {
    return currency(code);
  } catch {
    throw malformed(`a fiat ${field} the ledger cannot denominate`, { field, code });
  }
}

/**
 * A decimal string, as the kernel's `Quantity` wire form.
 *
 * `quantity()` refuses more than eighteen decimal places and more than twenty
 * integer digits — the `NUMERIC(38,18)` column's shape — so a malformed or
 * absurd balance fails here, at the boundary, rather than four layers down in a
 * database driver.
 */
export function quantityOf(value: unknown, field: string): Quantity {
  if (typeof value !== 'string') {
    throw malformed(`a non-string ${field}`, { field, type: typeof value });
  }
  try {
    return quantity(value.trim());
  } catch {
    throw malformed(`a ${field} the quantity column cannot hold`, { field });
  }
}

/** The base currency everything crypto is valued in (§6 Q3: USD base). */
export const USD_CODE: CurrencyCode = currency('USD');

/** A fiat decimal string as `Money`, in the currency the wallet is denominated in. */
export function fiatMoneyOf(value: unknown, code: CurrencyCode, field: string): Money {
  const parsed = exactDecimalOf(value, field);
  const minor = roundHalfEven(parsed.unscaled, parsed.scale - minorUnitScale(code));
  return Money.of(parsed.negative ? -minor : minor, code);
}

/**
 * `quantity × price`, as USD `Money`, rounded once at the end.
 *
 * Both arguments are decimal strings. See the file comment for the arithmetic
 * and for why doing this in two steps through `Money` would be wrong.
 */
export function usdValueOf(quantityText: string, priceText: string, field: string): Money {
  const q = exactDecimalOf(quantityText, `${field}.quantity`);
  const p = exactDecimalOf(priceText, `${field}.price`);
  const minor = roundHalfEven(
    q.unscaled * p.unscaled,
    q.scale + p.scale - minorUnitScale(USD_CODE),
  );
  return Money.of(q.negative === p.negative ? minor : -minor, USD_CODE);
}

/** `-1` if the decimal string is negative, `0` if zero, `1` otherwise. */
export function signOfDecimal(text: string, field: string): -1 | 0 | 1 {
  const parsed = exactDecimalOf(text, field);
  if (parsed.unscaled === 0n) return 0;
  return parsed.negative ? -1 : 1;
}

/** Negate a decimal string without going near a `number`. */
export function negatedDecimal(text: string, field: string): Quantity {
  const parsed = exactDecimalOf(text, field);
  if (parsed.unscaled === 0n) return quantityOf('0', field);
  const digits = parsed.unscaled.toString().padStart(parsed.scale + 1, '0');
  const body =
    parsed.scale === 0
      ? digits
      : `${digits.slice(0, -parsed.scale)}.${digits.slice(-parsed.scale)}`;
  return quantityOf(parsed.negative ? body : `-${body}`, field);
}

/** Sum a list of decimal strings exactly. Used by the ledger-gap reconciliation. */
export function sumDecimals(values: readonly string[], field: string): Quantity {
  let scale = 0;
  const parsed = values.map((value) => exactDecimalOf(value, field));
  for (const item of parsed) scale = Math.max(scale, item.scale);
  let total = 0n;
  for (const item of parsed) {
    const lifted = item.unscaled * 10n ** BigInt(scale - item.scale);
    total += item.negative ? -lifted : lifted;
  }
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const body = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return quantityOf(`${negative ? '-' : ''}${body}`, field);
}
