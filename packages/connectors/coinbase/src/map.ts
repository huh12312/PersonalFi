// SPDX-License-Identifier: MIT
/**
 * Coinbase v3 shapes → the port's canonical facts.
 *
 * ## The three modelling decisions worth arguing with
 *
 * 1. **A crypto wallet is an `investment`-flavoured account denominated in USD.**
 *    The port's `ProviderAccountType` has a `crypto` member and that is what a
 *    BTC wallet gets; its `currency` is nevertheless `USD`, because every
 *    `Money` on that account is a valuation and `money(…, 'BTC')` would have two
 *    decimal places (`amount.ts` explains why that is D3 in its least visible
 *    form). The native amount lives in `ProviderHoldingFact.quantity`, which is
 *    a decimal string with eighteen places. A **fiat** wallet keeps its own ISO
 *    currency and is `depository`: it is cash at an exchange, it is what a bank
 *    transfer lands in, and filing it as `crypto` would put the on-ramp's
 *    destination outside the cash accounts the transfer-pairing UI offers.
 *
 * 2. **A fill is an investment transaction and never a ledger transaction.**
 *    This is the v0.5 rung's other half. A $5,000 BTC buy expressed as a
 *    `ProviderTransactionFact` is $5,000 of spending in a "Crypto" category, and
 *    no amount of later re-categorisation recovers the quantity, the unit price
 *    and the fee that a cost-basis engine needs. `ledger.ts` owns the only
 *    `ProviderTransactionFact` this adapter ever emits, and it is a transfer.
 *
 * 3. **A crypto security is named by its ticker.** The §5 exit criterion is
 *    "ETH on Coinbase and in a wallet resolves to one security", and 3.1's own
 *    test says "ETH as a Coinbase ticker, a chain+contract and a brokerage
 *    CUSIP". So the identifier kind is `ticker` with a `null` MIC — an exchange
 *    is not an ISO-10383 venue and claiming one would be a fact we do not have.
 *    Coinbase's `product_id` travels as `providerSecurityId`: evidence, never
 *    identity (the D25 shape).
 */
import {
  investmentTransactionFingerprintOf,
  securityFingerprintOf,
  securityIdentifierOf,
  type Capability,
  type ProviderAccountFact,
  type ProviderBalanceFact,
  type ProviderHoldingFact,
  type ProviderInvestmentTransactionFact,
  type ProviderSecurityFact,
  type SecurityIdentifier,
} from '@connector/port';
import { DateOnly, Quantity } from '@core/kernel';
import {
  fiatCurrencyOf,
  fiatMoneyOf,
  malformed,
  negatedDecimal,
  quantityOf,
  sumDecimals,
  usdValueOf,
} from './amount.ts';
import type { CoinbaseAccount, CoinbaseFill } from './api.ts';
import { COINBASE_QUOTE_CURRENCY, coinbaseProductIdOf } from './provider.ts';

/** Coinbase's own account-type discriminant. Anything else is treated as crypto. */
export const COINBASE_FIAT_ACCOUNT_TYPE = 'ACCOUNT_TYPE_FIAT';

export function isFiatAccount(account: CoinbaseAccount): boolean {
  return account.type === COINBASE_FIAT_ACCOUNT_TYPE;
}

/** `available_balance + hold`. What the wallet actually contains. */
export function totalBalanceOf(account: CoinbaseAccount): string {
  return sumDecimals(
    [account.available_balance.value, account.hold?.value ?? '0'],
    `account.${isFiatAccount(account) ? 'fiat' : 'crypto'}_balance`,
  );
}

/**
 * An account fact.
 *
 * `mask` is `null` and always will be: Coinbase exposes no account number and
 * the port's own note is that the full number is "neither needed nor safe to
 * hold". `closed` folds `deleted_at` and `active`, because a wallet Coinbase has
 * deactivated still appears in `/accounts` and would otherwise keep a stale
 * balance alive in net worth.
 */
export function accountFactOf(account: CoinbaseAccount): ProviderAccountFact {
  const fiat = isFiatAccount(account);
  // Validated here even though the fact does not carry it verbatim: an asset
  // code we cannot name is a wallet we cannot price, and the account map is
  // where that failure is legible.
  assetCodeOf(account);
  return {
    providerAccountId: account.uuid,
    name: account.name,
    officialName: null,
    type: fiat ? 'depository' : 'crypto',
    subtype: fiat ? 'fiat_wallet' : 'crypto_wallet',
    // See the file comment: a crypto wallet's Money is always a USD valuation.
    currency: fiat ? fiatCurrencyOf(account.currency, 'account.currency') : COINBASE_QUOTE_CURRENCY,
    mask: null,
    closed: (account.deleted_at ?? null) !== null || account.active === false,
    capabilities: accountCapabilitiesOf(fiat),
  } satisfies ProviderAccountFact;
}

/**
 * Per-account capabilities (08 §2.5).
 *
 * A fiat wallet has no positions and no fills of its own, so it declares neither
 * `holdings` nor `investment_txns`; a crypto wallet has both and is not where a
 * cash transfer lands. Declaring the union on every account would tell the
 * orchestrator to ask a USD wallet for its holdings and then treat the empty
 * answer as "this account holds nothing", which is the one thing 08 §2.2 says an
 * honest capability declaration exists to prevent.
 */
export function accountCapabilitiesOf(fiat: boolean): readonly Capability[] {
  return fiat
    ? (['accounts', 'balances', 'transactions'] satisfies readonly Capability[])
    : (['accounts', 'balances', 'holdings', 'investment_txns'] satisfies readonly Capability[]);
}

/** `BTC`, `USD`, `USDC`. Uppercased once, here. */
export function assetCodeOf(account: CoinbaseAccount): string {
  const code = account.currency;
  if (typeof code !== 'string' || !/^[A-Za-z0-9]{2,16}$/.test(code)) {
    throw malformed('an account asset code it cannot name', { field: 'account.currency' });
  }
  return code.toUpperCase();
}

/**
 * A balance observation, always as a contribution to net worth.
 *
 * `price` is `null` for a fiat wallet and required for a crypto wallet with a
 * non-zero balance. A zero crypto balance is priced at zero without a ticker
 * call: zero times anything is zero, and spending a request on a dust wallet to
 * learn that would be a rate limit spent on nothing.
 */
export function balanceFactOf(
  account: CoinbaseAccount,
  price: string | null,
  asOf: Date,
): ProviderBalanceFact {
  const total = totalBalanceOf(account);
  const available = quantityOf(account.available_balance.value, 'account.available_balance');

  if (isFiatAccount(account)) {
    const code = fiatCurrencyOf(account.currency, 'account.currency');
    return {
      providerAccountId: account.uuid,
      current: fiatMoneyOf(total, code, 'account.total_balance'),
      available: fiatMoneyOf(available, code, 'account.available_balance'),
      limit: null,
      asOf,
    };
  }

  const at = price ?? '0';
  return {
    providerAccountId: account.uuid,
    current: usdValueOf(total, at, 'account.total_balance'),
    available: usdValueOf(available, at, 'account.available_balance'),
    // A wallet has no credit line. `null` says so; `0` would claim one of zero.
    limit: null,
    asOf,
  };
}

/** The identifier a crypto position is filed under. See decision 3 above. */
export function securityIdentifierOfAsset(asset: string): SecurityIdentifier {
  return securityIdentifierOf('ticker', asset.toUpperCase(), { mic: null });
}

/** One asset, as the port's canonical security fact. */
export function securityFactOf(asset: string, price: string | null): ProviderSecurityFact {
  const identifiers = [securityIdentifierOfAsset(asset)];
  return {
    providerSecurityId: coinbaseProductIdOf(asset),
    identifiers,
    name: asset.toUpperCase(),
    type: 'cryptocurrency',
    subtype: null,
    currency: COINBASE_QUOTE_CURRENCY,
    // 07 §6.3 wants stablecoins classified `CASH_LIKE` for allocation and
    // `SEPARATE` for risk. That is a *classification* decision and WP 3.1's
    // waterfall owns it; an adapter asserting `isCashEquivalent` for USDC would
    // be a provider inventing an asset class. `null` is the honest answer.
    isCashEquivalent: null,
    closePrice: price,
    closePriceAsOf: null,
    raw: { asset: asset.toUpperCase(), productId: coinbaseProductIdOf(asset), price },
    fingerprint: securityFingerprintOf(identifiers),
  };
}

/**
 * A position in one crypto wallet.
 *
 * `costBasis` is **`null`, never zero**. v3 reports no basis at all — the R6
 * finding in one field — and 04 §5.5 is explicit that an unknown basis must
 * report `unavailable` rather than gain-from-zero. WP 3.2 derives what it can
 * from the fills this adapter *does* return, and labels the rest `ESTIMATED`.
 */
export function holdingFactOf(
  account: CoinbaseAccount,
  price: string,
  asOf: Date,
): ProviderHoldingFact {
  const asset = assetCodeOf(account);
  const total = totalBalanceOf(account);
  return {
    providerAccountId: account.uuid,
    // The whole fact, not the ticker alone (WP 3.7a). For Coinbase the set has
    // one member either way — v3 names an asset by its code and nothing else —
    // but `type: 'cryptocurrency'` and the display name ride along with it, and
    // those are what keep `securities.type` from degrading to `other` on the
    // holdings path. `securityFactOf` is the same function the balances path
    // uses, so the two can no longer disagree about what ETH is.
    security: securityFactOf(asset, price),
    quantity: total,
    costBasis: null,
    value: usdValueOf(total, price, 'holding.value'),
    asOf,
    raw: { account, price },
  };
}

// ---------------------------------------------------------------------------
// Fills
// ---------------------------------------------------------------------------

/** `BTC-USD` → `{ base: 'BTC', quote: 'USD' }`. */
export function productOf(productId: unknown): { readonly base: string; readonly quote: string } {
  if (typeof productId !== 'string') {
    throw malformed('a non-string fill.product_id', { field: 'fill.product_id' });
  }
  const parts = productId.split('-');
  const [base, quote] = parts;
  if (parts.length !== 2 || base === undefined || quote === undefined) {
    throw malformed('a fill.product_id that is not BASE-QUOTE', { field: 'fill.product_id' });
  }
  return { base: base.toUpperCase(), quote: quote.toUpperCase() };
}

/**
 * The base-asset quantity a fill moved.
 *
 * `size_in_quote` is the trap. A retail "buy $100 of BTC" reports `size` in the
 * **quote** currency, so taking `size` at face value books a hundred *bitcoin*.
 * When the flag is set the base quantity is `size / price`, computed through
 * `@core/kernel`'s decimal type rather than a division on doubles.
 */
export function baseQuantityOf(fill: CoinbaseFill): string {
  const size = quantityOf(fill.size, 'fill.size');
  if (fill.size_in_quote !== true) return size;
  const price = quantityOf(fill.price, 'fill.price');
  if (price === '0') {
    throw malformed('a size_in_quote fill priced at zero, which cannot be divided', {
      field: 'fill.price',
    });
  }
  return divideDecimals(size, price, 'fill.size_in_quote');
}

/** The gross quote-currency value of a fill, fees excluded. */
export function grossQuoteOf(fill: CoinbaseFill): string {
  if (fill.size_in_quote === true) return quantityOf(fill.size, 'fill.size');
  return multiplyDecimals(
    quantityOf(fill.size, 'fill.size'),
    quantityOf(fill.price, 'fill.price'),
    'fill.gross',
  );
}

/** `BUY` | `SELL`, normalised. Anything else is a shape we do not understand. */
export function sideOf(fill: CoinbaseFill): 'BUY' | 'SELL' {
  const side = typeof fill.side === 'string' ? fill.side.toUpperCase() : '';
  if (side === 'BUY' || side === 'SELL') return side;
  throw malformed('a fill with a side that is neither BUY nor SELL', { field: 'fill.side' });
}

/**
 * The signed effect a fill had on the **quote** wallet, fees included.
 *
 * A buy takes `gross + commission` out; a sell puts `gross − commission` in.
 * This is the number `ledger.ts` subtracts from the observed balance delta so
 * that a trade is never mistaken for a deposit, and `ledger-gap.ts` sums it to
 * quantify what v3 cannot explain. It is deliberately one function used by both,
 * because two copies of a sign convention is one copy too many.
 */
export function quoteEffectOf(fill: CoinbaseFill): string {
  const gross = grossQuoteOf(fill);
  const commission = quantityOf(fill.commission ?? '0', 'fill.commission');
  return sideOf(fill) === 'BUY'
    ? negatedDecimal(sumDecimals([gross, commission], 'fill.effect'), 'fill.effect')
    : sumDecimals([gross, negatedDecimal(commission, 'fill.commission')], 'fill.effect');
}

/** The signed effect a fill had on the **base** wallet. Fees are quote-side. */
export function baseEffectOf(fill: CoinbaseFill): string {
  const size = baseQuantityOf(fill);
  return sideOf(fill) === 'BUY' ? size : negatedDecimal(size, 'fill.size');
}

/**
 * One fill, as the port's investment-transaction fact.
 *
 * `amount` **includes** the commission, matching `@connector/plaid`'s convention
 * ("the complete value of the transaction") so that two adapters do not disagree
 * about what a cash effect means. `fees` carries the commission as a **positive
 * magnitude** — the same shape the port gives `ProviderBalanceFact.limit` — for
 * a fee-drag calculation. The two must not be added: the fee is already inside
 * `amount`, and adding them is how one $20 commission becomes $40 of drag.
 *
 * `providerTransactionId` prefers `entry_id` — Coinbase's own ledger-entry id,
 * unique per fill — and falls back to `trade_id`. Both are stable, and the port
 * has no cursor here (there is no `/investments/transactions/sync` analogue), so
 * this id is the entire defence against a re-run of the same window duplicating
 * a position.
 */
export function investmentTransactionFactOf(
  fill: CoinbaseFill,
  accountIdByAsset: ReadonlyMap<string, string>,
): ProviderInvestmentTransactionFact {
  const { base, quote } = productOf(fill.product_id);
  if (quote !== COINBASE_QUOTE_CURRENCY) {
    throw malformed(`a fill quoted in ${quote}, which this adapter cannot value`, {
      field: 'fill.product_id',
      quote,
    });
  }
  const providerAccountId = accountIdByAsset.get(base);
  if (providerAccountId === undefined) {
    // The provider contradicted itself: it reported a trade in an asset it
    // reports no wallet for. Emitting the fact against an invented account id
    // would put a position in a place net worth cannot find.
    throw malformed(`a fill in ${base}, for which it reports no wallet`, {
      field: 'fill.product_id',
      asset: base,
    });
  }

  const side = sideOf(fill);
  const security = securityIdentifierOfAsset(base);
  const date = dateOnlyOfInstant(fill.trade_time, 'fill.trade_time');
  const quantity = baseEffectOf(fill);
  const price = quantityOf(fill.price, 'fill.price');
  const amount = usdValueOf(quoteEffectOf(fill), '1', 'fill.amount');
  const commission = quantityOf(fill.commission ?? '0', 'fill.commission');

  return {
    providerAccountId,
    providerTransactionId: fillIdOf(fill),
    security,
    providerSecurityId: coinbaseProductIdOf(base),
    date,
    name: `${side === 'BUY' ? 'Buy' : 'Sell'} ${base} on Coinbase Advanced Trade`,
    type: side === 'BUY' ? 'buy' : 'sell',
    subtype: 'crypto_trade',
    quantity,
    price,
    amount,
    fees: usdValueOf(commission, '1', 'fill.commission'),
    raw: fill,
    fingerprint: investmentTransactionFingerprintOf({
      providerAccountId,
      date,
      amount,
      security,
      quantity,
    }),
  };
}

export function fillIdOf(fill: CoinbaseFill): string {
  const id = fill.entry_id ?? fill.trade_id;
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw malformed('a fill with neither an entry_id nor a trade_id', { field: 'fill.entry_id' });
  }
  return id.trim();
}

/** Asset code → wallet uuid, for routing a fill to the account it belongs in. */
export function accountIdByAssetOf(
  accounts: readonly CoinbaseAccount[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const account of accounts) {
    if (isFiatAccount(account)) continue;
    const asset = assetCodeOf(account);
    // First wins. A user with two wallets in one asset (a vault plus a trading
    // wallet) gets the first Coinbase listed, which is the one `/accounts`
    // marks `default`; ordering is the provider's and we do not reorder it.
    if (!map.has(asset)) map.set(asset, account.uuid);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Small decimal helpers, kept here rather than in `amount.ts` because they are
// about *fills* rather than about the money/quantity boundary.
// ---------------------------------------------------------------------------

/**
 * `a × b`, exactly, as a decimal string.
 *
 * Through `@core/kernel`'s `Quantity`, which is a `Decimal` with 80 digits of
 * working precision and a hard `NUMERIC(38,18)` ceiling. Not through `number`:
 * a price times a size is precisely where 04's "the error compounds where nobody
 * looks" lands.
 */
export function multiplyDecimals(a: string, b: string, field: string): string {
  try {
    return Quantity.multiply(quantityOf(a, field), quantityOf(b, field));
  } catch {
    throw malformed(`a ${field} that overflows the quantity column`, { field });
  }
}

export function divideDecimals(a: string, b: string, field: string): string {
  try {
    return Quantity.divide(quantityOf(a, field), quantityOf(b, field));
  } catch {
    throw malformed(`a ${field} that overflows the quantity column`, { field });
  }
}

/** The UTC calendar date of an RFC-3339 instant. */
export function dateOnlyOfInstant(text: unknown, field: string): DateOnly {
  if (typeof text !== 'string') {
    throw malformed(`a non-string ${field}`, { field, type: typeof text });
  }
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) {
    throw malformed(`a ${field} that is not an instant`, { field });
  }
  return DateOnly.of(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

export function instantOf(text: unknown, field: string): Date {
  if (typeof text !== 'string') {
    throw malformed(`a non-string ${field}`, { field, type: typeof text });
  }
  const at = new Date(text);
  if (Number.isNaN(at.getTime())) {
    throw malformed(`a ${field} that is not an instant`, { field });
  }
  return at;
}
