// SPDX-License-Identifier: MIT
/**
 * The mapping, pinned against the recorded shapes.
 *
 * The assertions that matter most here are the ones about **numbers**: the
 * Phase 3 risk table's first row is "a float reaches a quantity or a price", and
 * every value below crosses the boundary this package owns. So the arithmetic is
 * written out — `0.35 × 63,105.23 = 22,086.8305 → $22,086.83` — rather than
 * snapshotted, because a snapshot of a wrong number is still green.
 */
import { describe, expect, it } from 'vitest';
import { Money, Quantity } from '@core/kernel';
import {
  accountCapabilitiesOf,
  accountFactOf,
  accountIdByAssetOf,
  balanceFactOf,
  baseEffectOf,
  baseQuantityOf,
  dateOnlyOfInstant,
  grossQuoteOf,
  holdingFactOf,
  investmentTransactionFactOf,
  productOf,
  quoteEffectOf,
  securityFactOf,
  securityIdentifierOfAsset,
  sideOf,
  totalBalanceOf,
} from '../src/map.ts';
import { usdValueOf } from '../src/amount.ts';
import { ACCOUNTS_FIXTURE, FILLS_FIXTURE } from './fake.ts';
import { BTC_WALLET, DOGE_WALLET, ETH_WALLET, NOW, USD_WALLET, harness } from './harness.ts';

const [usd, btc, eth, doge] = ACCOUNTS_FIXTURE.accounts as [
  (typeof ACCOUNTS_FIXTURE.accounts)[number],
  (typeof ACCOUNTS_FIXTURE.accounts)[number],
  (typeof ACCOUNTS_FIXTURE.accounts)[number],
  (typeof ACCOUNTS_FIXTURE.accounts)[number],
];
const [btcFill, ethFill] = FILLS_FIXTURE.fills as [
  (typeof FILLS_FIXTURE.fills)[number],
  (typeof FILLS_FIXTURE.fills)[number],
];

describe('accounts', () => {
  it('files a fiat wallet as depository and a crypto wallet as crypto', () => {
    expect(accountFactOf(usd)).toMatchObject({
      providerAccountId: USD_WALLET,
      type: 'depository',
      subtype: 'fiat_wallet',
      currency: 'USD',
      mask: null,
      closed: false,
    });
    expect(accountFactOf(btc)).toMatchObject({
      providerAccountId: BTC_WALLET,
      type: 'crypto',
      subtype: 'crypto_wallet',
      // USD, not BTC: `money(…, 'BTC')` has two decimal places and would turn
      // 0.00000001 BTC into 0n. The native amount is the holding's quantity.
      currency: 'USD',
    });
  });

  it('declares per-account capabilities that do not lie about either kind', () => {
    // A USD wallet asked for its holdings would answer "none", which is
    // indistinguishable from "this account holds nothing" (08 §2.2).
    expect(accountCapabilitiesOf(true)).toEqual(['accounts', 'balances', 'transactions']);
    expect(accountCapabilitiesOf(false)).toEqual([
      'accounts',
      'balances',
      'holdings',
      'investment_txns',
    ]);
  });

  it('closes a wallet that Coinbase has deleted or deactivated', () => {
    expect(accountFactOf({ ...btc, deleted_at: '2026-01-01T00:00:00Z' }).closed).toBe(true);
    expect(accountFactOf({ ...btc, active: false }).closed).toBe(true);
  });

  it('adds hold to available, because a held balance is still held', () => {
    expect(String(totalBalanceOf(usd))).toBe('980');
    expect(
      String(
        totalBalanceOf({
          ...btc,
          available_balance: { value: '0.30000000', currency: 'BTC' },
          hold: { value: '0.05000000', currency: 'BTC' },
        }),
      ),
    ).toBe('0.35');
  });

  it('maps asset code to wallet uuid for routing a fill, ignoring fiat', () => {
    const byAsset = accountIdByAssetOf(ACCOUNTS_FIXTURE.accounts);
    expect(byAsset.get('BTC')).toBe(BTC_WALLET);
    expect(byAsset.get('ETH')).toBe(ETH_WALLET);
    expect(byAsset.has('USD')).toBe(false);
  });
});

describe('balances', () => {
  it('reports a fiat wallet in its own currency', () => {
    expect(balanceFactOf(usd, null, NOW)).toMatchObject({
      providerAccountId: USD_WALLET,
      current: Money.of(98_000n, 'USD'),
      available: Money.of(98_000n, 'USD'),
      limit: null,
    });
  });

  it('values a crypto wallet at quantity × price, rounded once', () => {
    // 0.35 × 63,105.23 = 22,086.8305 → 2,208,683 cents (half-even on the .5).
    expect(balanceFactOf(btc, '63105.23', NOW).current).toEqual(Money.of(2_208_683n, 'USD'));
    // 2.05 × 2,489.77 = 5,104.0285 → 510,403 cents.
    expect(balanceFactOf(eth, '2489.77', NOW).current).toEqual(Money.of(510_403n, 'USD'));
  });

  it('gives an empty wallet a zero valuation without asking for a price', () => {
    expect(balanceFactOf(doge, null, NOW).current).toEqual(Money.of(0n, 'USD'));
  });

  it('never claims a credit limit a wallet does not have', () => {
    // `null` says "no limit"; `0` would claim a limit of zero.
    expect(balanceFactOf(btc, '63105.23', NOW).limit).toBeNull();
  });
});

describe('holdings and securities', () => {
  it('names a crypto position by its ticker, with the product id as evidence only', () => {
    const holding = holdingFactOf(btc, '63105.23', NOW);
    expect(holding).toMatchObject({
      providerAccountId: BTC_WALLET,
      quantity: '0.35',
      // v3 reports no basis at all. `null`, never zero: 04 §5.5 wants
      // `unavailable`, not gain-from-zero.
      costBasis: null,
    });
    // WP 3.7a: the whole `ProviderSecurityFact`, which for Coinbase is the same
    // one `securityFactOf` gives the balances path — one identifier, because v3
    // names an asset by its code and nothing else, but carrying the type and
    // the display name a `SecurityIdentifier` had no room for.
    expect(holding.security.identifiers).toEqual([
      { kind: 'ticker', value: 'BTC', chain: null, mic: null },
    ]);
    expect(holding.security.providerSecurityId).toBe('BTC-USD');
    expect(holding.security.type).toBe('cryptocurrency');
    expect(holding.security).toEqual(securityFactOf('BTC', '63105.23'));
    expect(holding.value).toEqual(Money.of(2_208_683n, 'USD'));
  });

  it('keeps the quantity a decimal string that survives eighteen places', () => {
    const dust = holdingFactOf(
      { ...btc, available_balance: { value: '0.000000010000000000', currency: 'BTC' } },
      '63105.23',
      NOW,
    );
    expect(dust.quantity).toBe('0.00000001');
    expect(typeof dust.quantity).toBe('string');
    // 0.00000001 × 63,105.23 = 0.0006310523 → 0 cents. Worth nothing, and still
    // one satoshi: the quantity is what survives, which is the entire reason
    // holdings carry both.
    expect(dust.value).toEqual(Money.of(0n, 'USD'));
    expect(Quantity.of(dust.quantity)).toBe('0.00000001');
  });

  it('fingerprints a security over its strongest identifier', () => {
    const fact = securityFactOf('ETH', '2489.77');
    expect(fact).toMatchObject({
      providerSecurityId: 'ETH-USD',
      identifiers: [{ kind: 'ticker', value: 'ETH' }],
      type: 'cryptocurrency',
      // 07 §6.3's CASH_LIKE decision belongs to WP 3.1's classification
      // waterfall, not to a provider adapter asserting an asset class.
      isCashEquivalent: null,
      closePrice: '2489.77',
    });
    expect(fact.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(securityIdentifierOfAsset('eth')).toEqual(securityIdentifierOfAsset('ETH'));
  });

  it('skips empty wallets and values the rest, end to end', async () => {
    const { connector, handle, options } = harness();
    const holdings = await connector.syncHoldings(handle, options);
    expect(holdings.map((holding) => holding.providerAccountId)).toEqual([BTC_WALLET, ETH_WALLET]);
    expect(holdings.every((holding) => holding.providerAccountId !== DOGE_WALLET)).toBe(true);
  });

  /**
   * The failure that must be loud. A position priced at $0.00 disappears from
   * net worth silently, and 08 §2.2's whole argument is that an empty answer is
   * indistinguishable from "there is genuinely nothing here".
   */
  it('refuses to value an unpriceable position rather than calling it zero', async () => {
    // Coinbase does not list the product at all: a 404, classified
    // `DATA_UNAVAILABLE`. Loud, and not a $0.00 position.
    const unlisted = harness({ tickers: {} });
    await expect(
      unlisted.connector.syncHoldings(unlisted.handle, unlisted.options),
    ).rejects.toMatchObject({ condition: 'DATA_UNAVAILABLE', kind: 'permanent' });

    // Coinbase lists it and quotes nothing — a 200 with an empty book, which is
    // the case an adapter would be most tempted to read as zero.
    const quiet = harness({ tickers: { 'BTC-USD': { trades: [] }, 'ETH-USD': { trades: [] } } });
    const thrown = await quiet.connector
      .syncHoldings(quiet.handle, quiet.options)
      .catch((error: unknown) => error);
    expect(thrown).toMatchObject({ condition: 'DATA_UNAVAILABLE', kind: 'permanent' });
    expect((thrown as Error).message).toMatch(/BTC/);
    expect((thrown as Error).message).toMatch(/unavailable rather than as zero/);
  });

  it('takes the best ask when there is no recent trade, before giving up', async () => {
    // 07 §6.1's price priority puts an exchange quote above a provider feed, and
    // an empty trade list with a live book is still a quote.
    const { connector, handle, options } = harness({
      tickers: {
        'BTC-USD': { trades: [], best_bid: '63000.00', best_ask: '63200.00' },
        'ETH-USD': { trades: [], best_bid: '2480.00', best_ask: '2490.00' },
      },
    });
    const holdings = await connector.syncHoldings(handle, options);
    // 0.35 × 63,200.00 = 22,120.00
    expect(holdings[0]?.value).toEqual(Money.of(2_212_000n, 'USD'));
  });
});

describe('fills', () => {
  it('splits a product id and refuses anything that is not BASE-QUOTE', () => {
    expect(productOf('BTC-USD')).toEqual({ base: 'BTC', quote: 'USD' });
    expect(() => productOf('BTC')).toThrowError(/BASE-QUOTE/);
    expect(() => productOf('BTC-PERP-USD')).toThrowError(/BASE-QUOTE/);
  });

  it('normalises the side and refuses a third one', () => {
    expect(sideOf(btcFill)).toBe('BUY');
    expect(sideOf({ ...btcFill, side: 'sell' })).toBe('SELL');
    expect(() => sideOf({ ...btcFill, side: 'CANCEL' })).toThrowError(/BUY nor SELL/);
  });

  it('signs the effect on each wallet consistently', () => {
    // A buy: base in, quote out, fee out.
    expect(String(baseEffectOf(btcFill))).toBe('0.1');
    expect(String(quoteEffectOf(btcFill))).toBe('-4020');
    // A sell: base out, quote in, fee still out.
    const sell = { ...btcFill, side: 'SELL' };
    expect(String(baseEffectOf(sell))).toBe('-0.1');
    expect(String(quoteEffectOf(sell))).toBe('3980');
  });

  /**
   * `size_in_quote` is the field an adapter forgets and then books a hundred
   * *bitcoin* for a hundred dollars.
   */
  it('reads size_in_quote as dollars, not as coins', () => {
    const retail = { ...btcFill, size: '100.00', size_in_quote: true, price: '40000.00' };
    expect(String(baseQuantityOf(retail))).toBe('0.0025');
    expect(String(grossQuoteOf(retail))).toBe('100');
    expect(String(quoteEffectOf(retail))).toBe('-120');
    // …and the plain case still reads as coins.
    expect(String(baseQuantityOf(btcFill))).toBe('0.1');
    expect(String(grossQuoteOf(btcFill))).toBe('4000');
  });

  it('maps a fill to an investment transaction with a mandatory fingerprint', () => {
    const byAsset = accountIdByAssetOf(ACCOUNTS_FIXTURE.accounts);
    const fact = investmentTransactionFactOf(ethFill, byAsset);
    expect(fact).toMatchObject({
      providerAccountId: ETH_WALLET,
      providerTransactionId: '6b2e1f4d9c3a5b7e0d1f2a3b4c5d6e7f',
      providerSecurityId: 'ETH-USD',
      date: '2026-06-02',
      type: 'buy',
      subtype: 'crypto_trade',
      quantity: '2',
      price: '2500',
    });
    // 2 × 2,500 + 12.50 out of the USD wallet.
    expect(fact.amount).toEqual(Money.of(-501_250n, 'USD'));
    expect(fact.fees).toEqual(Money.of(1_250n, 'USD'));
    expect(fact.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prefers entry_id and falls back to trade_id', () => {
    const byAsset = accountIdByAssetOf(ACCOUNTS_FIXTURE.accounts);
    const { entry_id: _dropped, ...withoutEntry } = btcFill;
    expect(investmentTransactionFactOf(withoutEntry, byAsset).providerTransactionId).toBe(
      btcFill.trade_id,
    );
  });

  it('refuses a fill in an asset it has no wallet for, rather than inventing one', () => {
    expect(() => investmentTransactionFactOf(btcFill, new Map())).toThrowError(/reports no wallet/);
  });

  it('refuses a fill quoted in a currency it cannot value', () => {
    const byAsset = accountIdByAssetOf(ACCOUNTS_FIXTURE.accounts);
    expect(() =>
      investmentTransactionFactOf({ ...btcFill, product_id: 'BTC-EUR' }, byAsset),
    ).toThrowError(/quoted in EUR/);
  });

  it('reads a trade time as a UTC calendar date', () => {
    expect(dateOnlyOfInstant('2026-09-10T23:59:59.999Z', 'x')).toBe('2026-09-10');
    expect(() => dateOnlyOfInstant('not a time', 'x')).toThrowError(/not an instant/);
  });
});

describe('the number boundary', () => {
  it.each([
    // 0.0006310523 of a dollar: worth nothing in cents, and the satoshi is
    // still intact in the quantity.
    ['0.00000001', '63105.23', 0n],
    // Half-even, both ways: 0.5 cents goes to 0, 1.5 and 2.5 both go to 2.
    ['1', '0.005', 0n],
    ['1', '0.015', 2n],
    ['1', '0.025', 2n],
    // 220,868.3365 → 22,086,834 cents. Rounding the price to cents *first*
    // would give 220,868.35, which is a cent and a half adrift.
    ['3.5', '63105.239', 22_086_834n],
  ])('%s × %s rounds half-even to %s cents', (quantityText, price, minor) => {
    expect(usdValueOf(quantityText, price, 'test').minor).toBe(minor);
  });

  it('refuses a non-string amount rather than coercing it', () => {
    // A JSON number reaching here would mean a float has already happened.
    expect(() => usdValueOf(42 as unknown as string, '1', 'test')).toThrowError(/non-string/);
  });
});
