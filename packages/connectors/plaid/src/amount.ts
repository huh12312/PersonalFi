// SPDX-License-Identifier: MIT
/**
 * Two conversions that happen exactly once each, here, at the boundary.
 *
 * ## 1. A JSON number becomes `Money`
 *
 * Plaid sends amounts as JSON numbers — `-12.34`, `1250`, `0.01`. The ledger
 * stores `bigint` minor units, and `docs/CONVENTIONS.md` is categorical: "Never
 * a float, anywhere, in the ledger."
 *
 * `Money.parseAmount` refuses a decimal string with more places than the
 * currency has, because "rounding money is always a deliberate act". A provider
 * float is exactly the case where that act has to be performed rather than
 * refused: a fee of `1.005` on a USD account is a real thing an institution
 * reports, and failing an entire nightly sync over a third decimal place would
 * be a worse answer than rounding it. So the rounding happens here, in one named
 * function, with the pre-rounded value preserved verbatim in the fact's `raw`.
 *
 * `toFixed` does the rounding. It is specified — "let n be an integer for which
 * n / 10^f - x is as close to zero as possible; if there are two such n, pick
 * the larger" — so it is deterministic across engines, which is the property
 * that matters for a value that ends up in a fingerprint.
 *
 * ## 2. The sign flips
 *
 * 01 §5.3 and `docs/CONVENTIONS.md`: **Plaid is positive for an outflow**, we
 * are negative for an outflow. 08 §2.5 says where the inversion belongs — "that
 * inversion lives in the Plaid adapter and nowhere else" — and `signedAmountOf`
 * is that one place. Nothing downstream of `map.ts` ever sees a Plaid sign.
 */
import { ConnectorError } from '@connector/port';
import { Money, currency, minorUnitScale, type CurrencyCode } from '@core/kernel';

/**
 * Beyond this, `toFixed` switches to exponential notation and `parseAmount`
 * would reject the string. No real balance is within nine orders of magnitude of
 * it, so hitting it means the response is wrong, not that someone is rich.
 */
const MAX_MAGNITUDE = 1e15;

function malformed(what: string, detail: Record<string, unknown>): ConnectorError {
  return ConnectorError.fromCondition('MALFORMED_RESPONSE', `plaid sent ${what}`, {
    redactedContext: detail,
  });
}

/**
 * Validate the currency Plaid attached to a value.
 *
 * `iso_currency_code` is null for a non-ISO instrument, in which case
 * `unofficial_currency_code` carries something like `BTC` or `MATIC`. Three
 * letters brand cleanly; anything longer is rejected as malformed rather than
 * silently coerced, because a `Money` denominated in a code the kernel cannot
 * scale is a wrong number, not a missing one.
 */
export function currencyOf(
  iso: string | null | undefined,
  unofficial: string | null | undefined,
  fallback: string,
): CurrencyCode {
  const code = iso ?? unofficial ?? fallback;
  try {
    return currency(code);
  } catch {
    throw malformed('a currency code the ledger cannot denominate', {
      isoCurrencyCode: iso ?? null,
      unofficialCurrencyCode: unofficial ?? null,
    });
  }
}

/**
 * A Plaid JSON number, in Plaid's own sign, as `Money`.
 *
 * Use for balances, limits, statement balances — anything where Plaid's sign is
 * already a magnitude or already means what we mean. For a *transaction* amount,
 * use `signedAmountOf`, which inverts.
 */
export function moneyOf(value: number, code: CurrencyCode, field: string): Money {
  if (!Number.isFinite(value)) {
    throw malformed(`a non-finite ${field}`, { field });
  }
  if (Math.abs(value) >= MAX_MAGNITUDE) {
    throw malformed(`an implausible ${field}`, { field, magnitude: Math.abs(value) });
  }
  // The deliberate rounding act. See the file comment.
  return Money.parseAmount(value.toFixed(minorUnitScale(code)), code);
}

/** Same, but `null`/`undefined` in gives `null` out. */
export function moneyOrNullOf(
  value: number | null | undefined,
  code: CurrencyCode,
  field: string,
): Money | null {
  return value === null || value === undefined ? null : moneyOf(value, code, field);
}

/**
 * **The sign inversion.** Plaid positive = outflow; we are negative = outflow.
 *
 * One function, one call site per fact type, asserted by `amount.test.ts` and by
 * the conformance suite's `money/signed-and-denominated` check.
 */
export function signedAmountOf(plaidAmount: number, code: CurrencyCode, field: string): Money {
  return Money.negate(moneyOf(plaidAmount, code, field));
}

/**
 * A liability or balance figure, signed as a contribution to net worth.
 *
 * `ProviderBalanceFact.current` is documented as "the account's contribution to
 * net worth, so a card you owe $420 on reports `-42000n`". Plaid reports that
 * same card as `current: 420` — a positive amount *owed*. Depository and
 * investment accounts already point the right way.
 *
 * `available` and `limit` are deliberately **not** put through this: the port
 * calls `limit` "a magnitude [that] stays positive", and a credit card's
 * `available` is available *credit*, which is a magnitude too. Inverting either
 * would produce a number that looks like money and means nothing.
 */
export function netWorthSignOf(accountType: string): 1 | -1 {
  return accountType === 'credit' || accountType === 'loan' ? -1 : 1;
}

export function signedBalanceOf(
  value: number,
  code: CurrencyCode,
  accountType: string,
  field: string,
): Money {
  const amount = moneyOf(value, code, field);
  return netWorthSignOf(accountType) === -1 ? Money.negate(amount) : amount;
}
