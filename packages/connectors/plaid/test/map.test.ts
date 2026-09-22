// SPDX-License-Identifier: MIT
/**
 * The field map, row by row, and the two scalar conversions underneath it.
 *
 * These are pure functions over parsed JSON, so every assertion here is against
 * a recorded fixture rather than against a request. The three decisions worth
 * arguing about get a `describe` each: the sign inversion (`amount.ts`), what
 * goes into the fingerprint, and how Plaid's account types collapse into the
 * ledger's.
 */
import { ConnectorError, fingerprintOf } from '@connector/port';
import { Money, QUANTITY_SCALE, currency, parseDateOnly } from '@core/kernel';
import type { AccountBase, Holding, Transaction } from 'plaid';
import { describe, expect, it } from 'vitest';
import {
  currencyOf,
  moneyOf,
  moneyOrNullOf,
  netWorthSignOf,
  signedAmountOf,
  signedBalanceOf,
} from '../src/amount.ts';
import {
  accountCapabilitiesOf,
  accountFactOf,
  accountTypeOf,
  balanceFactOf,
  currencyByAccountOf,
  decimalStringOf,
  holdingFactOf,
  investmentTransactionFactOf,
  liabilityFactsOf,
  securitiesByIdOf,
  transactionFactOf,
} from '../src/map.ts';
import { ACCOUNTS, INVESTMENTS, LIABILITIES, NOW, SYNC_PAGES } from './harness.ts';

// `CurrencyCode` is branded, so a test may not pass a bare string either.
const USD = currency('USD');
const JPY = currency('JPY');

const SECURITIES = securitiesByIdOf(INVESTMENTS.securities);
const CURRENCIES = currencyByAccountOf(ACCOUNTS);

function account(id: string): AccountBase {
  const found = ACCOUNTS.find((a) => a.account_id === id);
  if (found === undefined) throw new Error(`no fixture account ${id}`);
  return found;
}

function decimalPlaces(plain: string): number {
  const point = plain.indexOf('.');
  return point === -1 ? 0 : plain.length - point - 1;
}

function transaction(id: string): Transaction {
  const found = SYNC_PAGES.flatMap((p) => [...p.added, ...p.modified]).find(
    (t) => t.transaction_id === id,
  );
  if (found === undefined) throw new Error(`no fixture transaction ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

describe('currencyOf', () => {
  it('prefers the ISO code', () => {
    expect(currencyOf('EUR', null, 'USD')).toBe('EUR');
  });

  it('falls back to the unofficial code for a non-ISO instrument', () => {
    // `iso_currency_code` is null for e.g. a crypto balance, and
    // `unofficial_currency_code` carries something like BTC.
    expect(currencyOf(null, 'BTC', 'USD')).toBe('BTC');
  });

  it('falls back to the account currency when Plaid states neither', () => {
    expect(currencyOf(null, null, 'GBP')).toBe('GBP');
  });

  it('rejects a code the ledger cannot denominate rather than coercing it', () => {
    // A `Money` denominated in a code the kernel cannot scale is a wrong number,
    // not a missing one.
    const thrown = (() => {
      try {
        currencyOf('MATICWEI', null, 'USD');
      } catch (error) {
        return error;
      }
      return null;
    })();
    expect(thrown).toBeInstanceOf(ConnectorError);
    expect(thrown).toMatchObject({ condition: 'MALFORMED_RESPONSE', kind: 'permanent' });
  });
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

describe('a Plaid JSON number becomes Money', () => {
  it('rounds to the currency scale, deliberately, rather than refusing', () => {
    // `Money.parseAmount` refuses extra decimal places because "rounding money
    // is always a deliberate act". A provider float is exactly the case where
    // that act has to be performed: a fee of 1.005 USD is a real thing an
    // institution reports, and failing a nightly sync over a third decimal place
    // is a worse answer.
    expect(moneyOf(4.5, USD, 'amount').minor).toBe(450n);
    expect(moneyOf(0, USD, 'amount').minor).toBe(0n);
    expect(moneyOf(1.006, USD, 'fee').minor).toBe(101n);
    expect(moneyOf(-1.006, USD, 'fee').minor).toBe(-101n);
  });

  it('rounds the double, not the decimal literal, and does so deterministically', () => {
    // `1.005` written in source is not 1.005: the nearest double is
    // 1.00499999999999989, so `toFixed(2)` correctly answers '1.00'. That is not
    // a bug to route around — it is the only self-consistent reading of a value
    // that arrived as a JSON number in the first place, and `toFixed` is
    // specified precisely enough that it is the same answer on every engine.
    // Recorded here so the behaviour is a decision rather than a surprise.
    expect((1.005).toFixed(2)).toBe('1.00');
    expect(moneyOf(1.005, USD, 'fee').minor).toBe(100n);
    expect(moneyOf(-1.005, USD, 'fee').minor).toBe(-100n);
    // The pre-rounded value is preserved verbatim in every fact's `raw`, so the
    // original is never lost.
  });

  it('honours a zero-decimal currency', () => {
    expect(moneyOf(1234.6, JPY, 'amount').minor).toBe(1235n);
  });

  it('refuses a non-finite or implausible value', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1e15, -1e15]) {
      expect(() => moneyOf(value, USD, 'balances.current')).toThrow(ConnectorError);
    }
  });

  it('maps null and undefined to null, not to zero', () => {
    // Zero is a balance. Null is "the institution did not say", and conflating
    // them puts a fabricated number in the ledger.
    expect(moneyOrNullOf(null, USD, 'limit')).toBeNull();
    expect(moneyOrNullOf(undefined, USD, 'limit')).toBeNull();
    expect(moneyOrNullOf(0, USD, 'limit')?.minor).toBe(0n);
  });

  it('inverts the sign for a transaction amount', () => {
    expect(signedAmountOf(4.5, USD, 'amount').minor).toBe(-450n);
    expect(signedAmountOf(-2100, USD, 'amount').minor).toBe(210_000n);
  });

  it('signs a balance by whether the account is an asset or a debt', () => {
    expect(netWorthSignOf('credit')).toBe(-1);
    expect(netWorthSignOf('loan')).toBe(-1);
    expect(netWorthSignOf('depository')).toBe(1);
    expect(netWorthSignOf('investment')).toBe(1);
    expect(netWorthSignOf('crypto')).toBe(1);
    expect(signedBalanceOf(420, USD, 'credit', 'current').minor).toBe(-42_000n);
    expect(signedBalanceOf(420, USD, 'depository', 'current').minor).toBe(42_000n);
  });
});

describe('decimalStringOf', () => {
  it('never emits exponential notation, because a NUMERIC literal cannot be one', () => {
    // `String(1e-7)` is `'1e-7'`, which is not a NUMERIC(38,18) literal and not
    // a Quantity. A holding of 0.0000001 BTC is a real thing.
    expect(decimalStringOf(1e-7, 'quantity')).toBe('0.0000001');
    expect(decimalStringOf(1e-7, 'quantity')).not.toContain('e');
    expect(decimalStringOf(-1e-7, 'quantity')).toBe('-0.0000001');
  });

  it('never manufactures float noise by padding out to the column scale', () => {
    // `(268.4).toFixed(18)` is '268.399999999999977263' — the exact value of the
    // double, faithfully printed, and seventeen digits the institution never
    // said. Those digits would survive into the ledger and into every derived
    // cost-basis figure. The shortest round-trip form is the closest a JSON
    // number gets to "what the provider actually stated".
    expect(decimalStringOf(268.4, 'price')).toBe('268.4');
    expect(decimalStringOf(19.99, 'price')).toBe('19.99');
    expect(decimalStringOf(4.53, 'apr')).toBe('4.53');
    expect(decimalStringOf(0.1 + 0.2, 'quantity')).toBe('0.30000000000000004');
  });

  it('clamps a value with more decimal places than the column can hold', () => {
    // NUMERIC(38,18). The shortest round-trip form of this double is
    // '0.0000033333333333333337' — 22 decimal places — so it has to be rounded
    // *somewhere*, and doing it here means the column's limit is enforced at the
    // boundary rather than four layers down inside a driver.
    //
    // Computed rather than written as a literal: the literal would trip
    // `no-loss-of-precision`, which is the same observation this test is about.
    const tooPrecise = 1e-5 / 3;
    expect(decimalPlaces(String(tooPrecise))).toBeGreaterThan(QUANTITY_SCALE);

    const rounded = decimalStringOf(tooPrecise, 'quantity');
    expect(decimalPlaces(rounded)).toBeLessThanOrEqual(QUANTITY_SCALE);
    expect(rounded).toBe('0.000003333333333333');
  });

  it('rounds a value below the column scale to zero rather than to exponential notation', () => {
    // 1e-20 cannot be represented in NUMERIC(38,18) at all. '0' is the honest
    // answer; '1e-20' would be a literal Postgres rejects, and keeping the
    // magnitude would be a lie about the column.
    expect(decimalStringOf(1e-20, 'quantity')).toBe('0');
  });

  it('trims trailing zeros but keeps the integer part', () => {
    expect(decimalStringOf(62.5, 'quantity')).toBe('62.5');
    expect(decimalStringOf(5, 'quantity')).toBe('5');
    expect(decimalStringOf(0, 'quantity')).toBe('0');
    expect(decimalStringOf(-2, 'quantity')).toBe('-2');
    expect(decimalStringOf(100, 'quantity')).toBe('100');
  });

  it('honours a caller-supplied scale, which is what APRs use', () => {
    expect(decimalStringOf(19.99, 'apr', 6)).toBe('19.99');
    expect(QUANTITY_SCALE).toBeGreaterThan(6);
  });

  it('refuses a non-finite or implausible value', () => {
    expect(() => decimalStringOf(Number.NaN, 'quantity')).toThrow(ConnectorError);
    expect(() => decimalStringOf(1e15, 'quantity')).toThrow(ConnectorError);
  });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('account types', () => {
  it.each([
    ['depository', 'checking', 'depository'],
    ['credit', 'credit card', 'credit'],
    ['loan', 'mortgage', 'loan'],
    ['investment', 'brokerage', 'investment'],
    // The legacy spelling Plaid still returns for some institutions.
    ['brokerage', 'brokerage', 'investment'],
    // Cash-management and prepaid products behave like a depository account for
    // every purpose the ledger has; `manual` would claim the user typed it in.
    ['other', 'cash management', 'depository'],
    // The one subtype that changes the answer: a crypto balance is a quantity of
    // a security with a price, not money.
    ['investment', 'crypto exchange', 'crypto'],
  ])('maps type=%s subtype=%s to %s', (type, subtype, expected) => {
    expect(accountTypeOf({ type, subtype } as unknown as AccountBase)).toBe(expected);
  });

  it('refuses a type it has never seen rather than guessing', () => {
    expect(() =>
      accountTypeOf({ type: 'annuity', subtype: null } as unknown as AccountBase),
    ).toThrow(ConnectorError);
  });

  it('reports per-account capabilities, not the connector’s', () => {
    // 08 §2.5: "a connector may support holdings while a particular checking
    // account within it does not". A savings account declaring `holdings` makes
    // an empty list look like a brokerage that holds nothing.
    expect(accountCapabilitiesOf('depository')).toEqual(['accounts', 'balances', 'transactions']);
    expect(accountCapabilitiesOf('credit')).toEqual([
      'accounts',
      'balances',
      'transactions',
      'liabilities',
    ]);
    expect(accountCapabilitiesOf('investment')).toEqual([
      'accounts',
      'balances',
      'holdings',
      'investment_txns',
    ]);
  });
});

describe('accountFactOf', () => {
  it('maps the checking account field for field', () => {
    expect(accountFactOf(account('acct-checking-001'))).toEqual({
      providerAccountId: 'acct-checking-001',
      name: 'Everyday Checking',
      officialName: 'Northwind Mutual Everyday Checking',
      type: 'depository',
      subtype: 'checking',
      currency: 'USD',
      mask: '6789',
      closed: false,
      capabilities: ['accounts', 'balances', 'transactions'],
    });
  });

  it('never claims an account is closed, because /accounts/get cannot say so', () => {
    // An account that closes stops being *returned*. `linkAccounts` in
    // @ctx/connections notices the disappearance; claiming `closed: true` here
    // would be a guess.
    for (const fixture of ACCOUNTS) {
      expect(accountFactOf(fixture).closed).toBe(false);
    }
  });

  it('carries the mask as Plaid gave it, which is never more than four digits', () => {
    for (const fixture of ACCOUNTS) {
      expect(accountFactOf(fixture).mask?.length ?? 0).toBeLessThanOrEqual(4);
    }
  });
});

describe('balanceFactOf', () => {
  it('uses the institution timestamp when there is one and the run clock when there is not', () => {
    const withStamp = balanceFactOf(account('acct-brokerage-003'), NOW);
    expect(withStamp.asOf).toEqual(new Date('2026-06-01T09:15:00Z'));

    const without = balanceFactOf(account('acct-checking-001'), NOW);
    expect(without.asOf).toBe(NOW);
  });

  it('refuses a balance with no current value rather than inventing a zero', () => {
    const blank = {
      ...account('acct-checking-001'),
      balances: { ...account('acct-checking-001').balances, current: null },
    };
    expect(() => balanceFactOf(blank, NOW)).toThrow(ConnectorError);
  });
});

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

describe('transactionFactOf', () => {
  it('maps the enriched coffee row field for field', () => {
    const fact = transactionFactOf(transaction('txn-0001-pending-coffee'), 'USD');

    expect(fact.providerAccountId).toBe('acct-checking-001');
    expect(fact.providerTransactionId).toBe('txn-0001-pending-coffee');
    expect(fact.amount.minor).toBe(-450n);
    expect(fact.isoCurrency).toBe('USD');
    expect(fact.postedDate).toBe(parseDateOnly('2026-06-01'));
    expect(fact.authorizedDate).toBe(parseDateOnly('2026-06-01'));
    expect(fact.postedAt).toEqual(new Date('2026-06-01T15:42:11Z'));
    expect(fact.authorizedAt).toEqual(new Date('2026-06-01T15:42:11Z'));
    expect(fact.name).toBe('SQ *BLUE BOTTLE 4471');
    expect(fact.merchantName).toBe('Blue Bottle Coffee');
    expect(fact.originalDescription).toBe('SQ *BLUE BOTTLE 4471 OAKLAND CA');
    expect(fact.paymentChannel).toBe('in store');
    expect(fact.pending).toBe(true);
    expect(fact.pendingTransactionId).toBeNull();
  });

  it('carries the PFC as a hint with its version, never as a category id', () => {
    // 08 §2.5 / 01 §5.4: it is a feature for the classifier and a source field
    // in the ledger; the user-facing category is a separate, user-editable
    // mapping, so a future PFC revision cannot shift budget history under us.
    const fact = transactionFactOf(transaction('txn-0001-pending-coffee'), 'USD');
    expect(fact.providerCategory).toEqual({
      primary: 'FOOD_AND_DRINK',
      detailed: 'FOOD_AND_DRINK_COFFEE',
      confidenceLevel: 'VERY_HIGH',
      version: 'v2',
    });
  });

  it('keeps counterparties, including the entity id that survives descriptor noise', () => {
    const fact = transactionFactOf(transaction('txn-0001-pending-coffee'), 'USD');
    expect(fact.counterparties).toEqual([
      {
        name: 'Blue Bottle Coffee',
        type: 'merchant',
        entityId: 'eyg8o776k0QmNgVpAmaQj4WgzW9Qzo6O51gdd',
        confidenceLevel: 'VERY_HIGH',
      },
      {
        name: 'Square',
        type: 'payment_processor',
        entityId: 'sq-3Jd9k1mQWpZzLb7Vn0Ya',
        confidenceLevel: 'HIGH',
      },
    ]);
  });

  it('reports no counterparties as null rather than an empty array', () => {
    expect(transactionFactOf(transaction('txn-0004-water'), 'USD').counterparties).toBeNull();
  });

  it('keeps the whole Plaid object in raw, which carries no credential', () => {
    const source = transaction('txn-0002-payroll');
    const fact = transactionFactOf(source, 'USD');
    expect(fact.raw).toBe(source);
    expect(JSON.stringify(fact.raw)).not.toMatch(/access[-_]token/i);
  });

  it('uses the account currency when the row states none', () => {
    const noCurrency = {
      ...transaction('txn-0004-water'),
      iso_currency_code: null,
      unofficial_currency_code: null,
    };
    const fact = transactionFactOf(noCurrency, 'GBP');
    expect(fact.amount.currency).toBe('GBP');
    // `isoCurrency` stays null: "not stated" is not the same claim as "GBP".
    expect(fact.isoCurrency).toBeNull();
  });
});

describe('the fingerprint keys on the institution descriptor, not on Plaid’s cleaned name', () => {
  it('uses original_description when Plaid filled it', () => {
    // `fingerprintOf` is the cross-provider dedupe key — "the dedupe key when a
    // CSV import overlaps a Plaid backfill" (08 §2.5) — and what a CSV or OFX
    // export of the same account contains is the institution's raw descriptor,
    // not Plaid's enriched `name`.
    const source = transaction('txn-0001-pending-coffee');
    const fact = transactionFactOf(source, 'USD');
    expect(fact.fingerprint).toBe(
      fingerprintOf({
        providerAccountId: 'acct-checking-001',
        postedDate: parseDateOnly('2026-06-01'),
        amount: Money.parseAmount('-4.50', 'USD'),
        description: 'SQ *BLUE BOTTLE 4471 OAKLAND CA',
      }),
    );
    expect(fact.fingerprint).not.toBe(
      fingerprintOf({
        providerAccountId: 'acct-checking-001',
        postedDate: parseDateOnly('2026-06-01'),
        amount: Money.parseAmount('-4.50', 'USD'),
        description: source.name,
      }),
    );
  });

  it('falls back to name when the institution did not fill a descriptor', () => {
    // The known cost, recorded in the evidence doc: a row whose fill flips
    // between syncs gets a new fingerprint. That degrades cross-provider
    // matching for that row; it cannot duplicate or lose it, because
    // same-provider identity is `providerTransactionId`.
    const source = transaction('txn-0004-water');
    expect(source.original_description).toBeNull();
    expect(transactionFactOf(source, 'USD').fingerprint).toBe(
      fingerprintOf({
        providerAccountId: 'acct-card-002',
        postedDate: parseDateOnly('2026-06-02'),
        amount: Money.parseAmount('-64.20', 'USD'),
        description: 'PORTSIDE WATER CO',
      }),
    );
  });

  it('is a sha256 hex digest on every fixture row', () => {
    for (const page of SYNC_PAGES) {
      for (const row of [...page.added, ...page.modified]) {
        expect(transactionFactOf(row, 'USD').fingerprint).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Holdings and investment transactions
// ---------------------------------------------------------------------------

describe('holdingFactOf', () => {
  const holdings = INVESTMENTS.holdings;

  it('maps the equity holding, resolving the ticker through the securities map', () => {
    const fact = holdingFactOf(holdings[0] as Holding, SECURITIES, NOW);
    expect(fact).toMatchObject({
      providerAccountId: 'acct-brokerage-003',
      providerSecurityId: 'sec-vti-0001',
      // The strongest name Plaid gave, not the first one it listed: the fixture
      // carries a FIGI, an ISIN, a CUSIP and a MIC-qualified ticker, and
      // `IDENTIFIER_RANK` picks the FIGI — the only globally unique, permanent,
      // exchange-level name in the set (01 §5.5, `figi` added 2026-06-18).
      security: { kind: 'figi', value: 'BBG000BDTF76', chain: null, mic: null },
      quantity: '62.5',
    });
    expect(fact.value.minor).toBe(1_677_500n);
    expect(fact.costBasis?.minor).toBe(1_420_000n);
    expect(fact.asOf).toEqual(new Date('2026-06-01T20:00:00Z'));
  });

  it('falls back from the price datetime to the price date to the run clock', () => {
    // Fill rates vary wildly by institution (01 §5.5), so all three branches are
    // reachable in the wild and all three are fixtures here.
    expect(holdingFactOf(holdings[1] as Holding, SECURITIES, NOW).asOf).toEqual(
      new Date('2026-06-01T00:00:00.000Z'),
    );
    expect(holdingFactOf(holdings[2] as Holding, SECURITIES, NOW).asOf).toBe(NOW);
  });

  it('keeps a sub-satoshi quantity as a decimal string, never as 1e-7', () => {
    const fact = holdingFactOf(holdings[2] as Holding, SECURITIES, NOW);
    expect(fact.security.value).toBe('BTC');
    expect(fact.quantity).toBe('0.0000001');
    expect(fact.costBasis).toBeNull();
  });

  it('falls back to a proprietary dead end for a security Plaid would not name', () => {
    // WP 3.1. The cash-sweep fixture carries no ticker, CUSIP, ISIN or FIGI, so
    // the only name available is Plaid's own `security_id` — and that is
    // emitted as `proprietary`, which `@ctx/investments` refuses to treat as an
    // identity. The position therefore surfaces as a resolution failure rather
    // than minting an anonymous row nothing will ever merge with.
    const fact = holdingFactOf(holdings[1] as Holding, SECURITIES, NOW);
    expect(fact.security).toEqual({
      kind: 'proprietary',
      value: 'sec-cash-0002',
      chain: null,
      mic: null,
    });
    expect(fact.providerSecurityId).toBe('sec-cash-0002');
  });
});

describe('investmentTransactionFactOf', () => {
  const [buy, sell, dividend, contribution, fee] = INVESTMENTS.investment_transactions;

  it('inverts the amount like every other money value', () => {
    // A buy takes money out of the account: Plaid says +1342.00, we say -1342.00.
    expect(investmentTransactionFactOf(buy!, SECURITIES).amount.minor).toBe(-134_200n);
    // A sale puts money in.
    expect(investmentTransactionFactOf(sell!, SECURITIES).amount.minor).toBe(53_680n);
    expect(investmentTransactionFactOf(dividend!, SECURITIES).amount.minor).toBe(4_118n);
    expect(investmentTransactionFactOf(contribution!, SECURITIES).amount.minor).toBe(100_000n);
    expect(investmentTransactionFactOf(fee!, SECURITIES).amount.minor).toBe(-2_000n);
  });

  it('keeps quantity and price as decimal strings, in Plaid’s sign', () => {
    // Quantity is not money: a sale of two shares is -2, and inverting it would
    // say the position grew.
    const fact = investmentTransactionFactOf(sell!, SECURITIES);
    expect(fact.quantity).toBe('-2');
    expect(fact.price).toBe('268.4');
    expect(fact.type).toBe('sell');
    expect(fact.subtype).toBe('sell');
    expect(fact.fees?.minor).toBe(65n);
  });

  it('tolerates a cash movement with no security at all', () => {
    const fact = investmentTransactionFactOf(contribution!, SECURITIES);
    expect(fact.security).toBeNull();
    expect(fact.providerSecurityId).toBeNull();
    expect(fact.fees).toBeNull();
  });

  it('fingerprints every fact, because there is no cursor to dedupe with', () => {
    // 01 §5.5: no `/investments/transactions/sync`. A re-run of the same date
    // window is the normal case, not the exceptional one, so the fingerprint is
    // load-bearing rather than belt-and-braces — and it must be stable across
    // two mappings of the same row.
    for (const transaction of INVESTMENTS.investment_transactions) {
      const fact = investmentTransactionFactOf(transaction, SECURITIES);
      expect(fact.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(investmentTransactionFactOf(transaction, SECURITIES).fingerprint).toBe(
        fact.fingerprint,
      );
    }
    // Two different transactions must not share one.
    const fingerprints = INVESTMENTS.investment_transactions.map(
      (transaction) => investmentTransactionFactOf(transaction, SECURITIES).fingerprint,
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });
});

// ---------------------------------------------------------------------------
// Liabilities
// ---------------------------------------------------------------------------

describe('liabilityFactsOf', () => {
  const facts = liabilityFactsOf(LIABILITIES, CURRENCIES);

  it('picks the purchase APR rather than whichever Plaid listed first', () => {
    // The fixture lists balance_transfer_apr (0%) first on purpose: the purchase
    // rate is the one a payoff projection needs, and `aprs[0]` would be 0.
    const card = facts.find((f) => f.providerAccountId === 'acct-card-002');
    expect(card?.apr).toBe('19.99');
  });

  it('keeps statement balance and minimum payment as positive magnitudes', () => {
    // These are "what you owe" and "what you must pay".
    // `ProviderBalanceFact.current` is the field that carries the net-worth
    // sign; mixing the two conventions inside one fact is how a payoff
    // projection ends up adding a debt to net worth.
    const card = facts.find((f) => f.providerAccountId === 'acct-card-002');
    expect(card?.statementBalance?.minor).toBe(74_218n);
    expect(card?.minimumPayment?.minor).toBe(3_500n);
    expect(card?.nextPaymentDue).toBe(parseDateOnly('2026-06-22'));
  });

  it('maps a student loan through its interest rate', () => {
    const loan = facts.find((f) => f.providerAccountId === 'acct-student-005');
    expect(loan?.apr).toBe('4.53');
    expect(loan?.statementBalance?.minor).toBe(1_264_000n);
    expect(loan?.minimumPayment?.minor).toBe(21_000n);
  });

  it('reports a mortgage with no statement balance, because Plaid has none', () => {
    // The outstanding principal is the account's balance and arrives through
    // `syncBalances`.
    const mortgage = facts.find((f) => f.providerAccountId === 'acct-mortgage-004');
    expect(mortgage?.apr).toBe('3.125');
    expect(mortgage?.statementBalance).toBeNull();
    expect(mortgage?.minimumPayment?.minor).toBe(185_000n);
    expect(mortgage?.nextPaymentDue).toBe(parseDateOnly('2026-07-01'));
  });

  it('drops a liability that names no account, because nothing can hold it', () => {
    // The orchestrator keys every fact by the provider account. The drop is
    // visible: that account still syncs its balance.
    expect(LIABILITIES.credit?.some((c) => c.account_id === null)).toBe(true);
    expect(facts).toHaveLength(3);
    for (const fact of facts) {
      expect(fact.providerAccountId.length).toBeGreaterThan(0);
    }
  });
});
