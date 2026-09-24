// SPDX-License-Identifier: MIT
/**
 * Plaid shapes → the port's canonical facts.
 *
 * Pure functions over parsed JSON. No network, no clock of their own, no SDK
 * client — which is what lets `map.test.ts` drive every one of them from a
 * recorded fixture and assert the field map row by row.
 *
 * The three decisions worth arguing about are recorded where they are made:
 * the sign inversion (`amount.ts`), what goes into the fingerprint
 * (`transactionFactOf`), and how Plaid's six account types collapse into the
 * ledger's six (`ACCOUNT_TYPE_OF`).
 */
import {
  ConnectorError,
  fingerprintOf,
  investmentTransactionFingerprintOf,
  securityFingerprintOf,
  securityIdentifierOf,
  strongestIdentifier,
  type Capability,
  type ProviderAccountFact,
  type ProviderAccountType,
  type ProviderBalanceFact,
  type ProviderCounterparty,
  type ProviderHoldingFact,
  type ProviderInvestmentTransactionFact,
  type ProviderLiabilityFact,
  type ProviderSecurityFact,
  type ProviderTransactionFact,
  type SecurityIdentifier,
} from '@connector/port';
import {
  QUANTITY_SCALE,
  parseDateOnly,
  quantity,
  type CurrencyCode,
  type DateOnly,
} from '@core/kernel';
import { currencyOf, moneyOf, moneyOrNullOf, signedAmountOf, signedBalanceOf } from './amount.ts';
import type {
  AccountBase,
  CreditCardLiability,
  Holding,
  InvestmentTransaction,
  LiabilitiesObject,
  MortgageLiability,
  Security,
  StudentLoan,
  Transaction,
} from 'plaid';

/**
 * Plaid's `account.type` → the ledger's `AccountType`.
 *
 * `brokerage` is the legacy spelling of `investment` and Plaid still returns it
 * for some institutions. `other` covers cash-management and prepaid products,
 * which behave like a depository account for every purpose the ledger has; the
 * alternative would be `manual`, which would claim the user typed it in.
 */
const ACCOUNT_TYPE_OF: Readonly<Record<string, ProviderAccountType>> = Object.freeze({
  depository: 'depository',
  credit: 'credit',
  loan: 'loan',
  investment: 'investment',
  brokerage: 'investment',
  other: 'depository',
});

/**
 * The one subtype that changes the answer.
 *
 * Plaid files a Coinbase-style account as `type: investment, subtype: crypto
 * exchange`. The ledger has a `crypto` type and a crypto balance is a
 * *quantity of a security with a price*, not money — so getting this wrong puts
 * a BTC position into a column that thinks it is dollars.
 */
const CRYPTO_SUBTYPES: ReadonlySet<string> = new Set(['crypto exchange']);

function malformed(message: string, detail: Record<string, unknown>): ConnectorError {
  return ConnectorError.fromCondition('MALFORMED_RESPONSE', message, { redactedContext: detail });
}

export function accountTypeOf(account: Pick<AccountBase, 'type' | 'subtype'>): ProviderAccountType {
  const subtype = account.subtype === null ? null : String(account.subtype);
  if (subtype !== null && CRYPTO_SUBTYPES.has(subtype)) return 'crypto';
  const mapped = ACCOUNT_TYPE_OF[String(account.type)];
  if (mapped === undefined) {
    throw malformed(`plaid sent an unknown account type`, { accountType: String(account.type) });
  }
  return mapped;
}

/**
 * What *this account* can do, as distinct from what the connector can do.
 *
 * 08 §2.5 asks for this precisely because "a connector may support `holdings`
 * while a particular checking account within it does not". A savings account
 * declaring `holdings` would make an empty holdings list look like a brokerage
 * that holds nothing.
 */
export function accountCapabilitiesOf(type: ProviderAccountType): readonly Capability[] {
  const base: Capability[] = ['accounts', 'balances'];
  if (type === 'depository' || type === 'credit' || type === 'loan') base.push('transactions');
  if (type === 'investment' || type === 'crypto') base.push('holdings', 'investment_txns');
  if (type === 'credit' || type === 'loan') base.push('liabilities');
  return base;
}

export function accountFactOf(account: AccountBase): ProviderAccountFact {
  const type = accountTypeOf(account);
  return {
    providerAccountId: account.account_id,
    name: account.name,
    officialName: account.official_name,
    type,
    subtype: account.subtype === null ? null : String(account.subtype),
    currency: currencyOf(
      account.balances.iso_currency_code,
      account.balances.unofficial_currency_code,
      'USD',
    ),
    // Plaid's mask is already the last 2–4 digits; the port forbids more and
    // Plaid never offers more on a Transactions Item (we do not request Auth).
    mask: account.mask,
    // Plaid does not report closure on `/accounts/get`: an account that closes
    // stops being returned. `linkAccounts` in @ctx/connections is what notices a
    // disappearance; claiming `closed: true` here would be a guess.
    closed: false,
    capabilities: accountCapabilitiesOf(type),
  };
}

export function balanceFactOf(account: AccountBase, fallbackAsOf: Date): ProviderBalanceFact {
  const code = currencyOf(
    account.balances.iso_currency_code,
    account.balances.unofficial_currency_code,
    'USD',
  );
  const type = accountTypeOf(account);
  const current =
    account.balances.current === null
      ? null
      : signedBalanceOf(account.balances.current, code, type, 'balances.current');
  if (current === null) {
    throw malformed('a balance with no current value', { accountType: type });
  }
  const lastUpdated = account.balances.last_updated_datetime;

  return {
    providerAccountId: account.account_id,
    current,
    // Magnitudes, not net-worth contributions. See `amount.ts`.
    available: moneyOrNullOf(account.balances.available, code, 'balances.available'),
    limit: moneyOrNullOf(account.balances.limit, code, 'balances.limit'),
    asOf:
      typeof lastUpdated === 'string' && lastUpdated.length > 0
        ? instantOf(lastUpdated, 'balances.last_updated_datetime')
        : fallbackAsOf,
  };
}

/**
 * One transaction, sign-inverted, fingerprinted, with its raw payload attached.
 *
 * ### What goes into the fingerprint, and why it is not `name`
 *
 * `fingerprintOf` is the *cross-provider* dedupe key: "the dedupe key when a CSV
 * import overlaps a Plaid backfill" (08 §2.5). The thing a CSV or OFX export of
 * the same account actually contains is the institution's raw descriptor —
 * `AMZN Mktp US*2H4LK` — not Plaid's cleaned and enriched `name`. So
 * `original_description` is the input when Plaid gives one (we opt in via
 * `options.include_original_description`), and `name` is the fallback.
 *
 * The known cost is recorded in the evidence doc: `original_description` is not
 * filled for every institution, so a transaction whose fill flips between syncs
 * gets a new fingerprint. That degrades cross-provider matching for that row; it
 * cannot duplicate or lose it, because same-provider identity is
 * `providerTransactionId` and the ledger's natural key, not the fingerprint.
 */
export function transactionFactOf(
  transaction: Transaction,
  fallbackCurrency: string,
): ProviderTransactionFact {
  const code = currencyOf(
    transaction.iso_currency_code,
    transaction.unofficial_currency_code,
    fallbackCurrency,
  );
  const amount = signedAmountOf(transaction.amount, code, 'transaction.amount');
  const postedDate = dateOnlyOf(transaction.date, 'transaction.date');
  const description = transaction.original_description ?? transaction.name;

  return {
    providerAccountId: transaction.account_id,
    providerTransactionId: transaction.transaction_id,
    // 01 §5.2, the highest-risk modelling detail in the integration: when a
    // pending transaction posts, Plaid puts the *old* id in `removed[]` and the
    // new row in `added[]` with this field pointing back. The ledger's
    // pending→posted migration keys off it, so it is passed through verbatim and
    // never inferred.
    pendingTransactionId: transaction.pending_transaction_id,
    amount,
    isoCurrency: transaction.iso_currency_code ?? transaction.unofficial_currency_code ?? null,
    postedDate,
    authorizedDate:
      transaction.authorized_date === null
        ? null
        : dateOnlyOf(transaction.authorized_date, 'transaction.authorized_date'),
    postedAt:
      transaction.datetime === null
        ? null
        : instantOf(transaction.datetime, 'transaction.datetime'),
    authorizedAt:
      transaction.authorized_datetime === null
        ? null
        : instantOf(transaction.authorized_datetime, 'transaction.authorized_datetime'),
    name: transaction.name,
    merchantName: transaction.merchant_name ?? null,
    originalDescription: transaction.original_description ?? null,
    paymentChannel: transaction.payment_channel === undefined ? null : transaction.payment_channel,
    // A hint, never a category id (08 §2.5 / 01 §5.4). Stored as the source
    // field and fed to the classifier as a feature; the user-facing category is
    // a separate, user-editable mapping, so a future PFC revision cannot shift
    // budget history under us.
    providerCategory:
      transaction.personal_finance_category === null ||
      transaction.personal_finance_category === undefined
        ? null
        : {
            primary: transaction.personal_finance_category.primary,
            detailed: transaction.personal_finance_category.detailed,
            confidenceLevel: transaction.personal_finance_category.confidence_level ?? null,
            version: transaction.personal_finance_category.version ?? null,
          },
    pending: transaction.pending,
    location: transaction.location,
    counterparties: counterpartiesOf(transaction),
    // Verbatim, so a Phase 3 question has a Phase 1 answer. Contains no
    // credential: a Plaid transaction object carries no token.
    raw: transaction,
    fingerprint: fingerprintOf({
      providerAccountId: transaction.account_id,
      postedDate,
      amount,
      description,
    }),
  };
}

function counterpartiesOf(transaction: Transaction): readonly ProviderCounterparty[] | null {
  if (transaction.counterparties === undefined || transaction.counterparties.length === 0) {
    return null;
  }
  return transaction.counterparties.map((counterparty) => ({
    name: counterparty.name,
    type: counterparty.type === undefined ? null : String(counterparty.type),
    // The useful part: stable across descriptor noise and across providers.
    entityId: counterparty.entity_id ?? null,
    confidenceLevel: counterparty.confidence_level ?? null,
  }));
}

/**
 * Every name Plaid gave for one security, strongest first is *not* assumed —
 * ordering is the port's job (`strongestIdentifier`), not this adapter's.
 *
 * Four of Plaid's `Security` fields are identifiers and one is a qualifier:
 * `figi` (added 2026-06-18 per 01 §5.5), `isin`, `cusip`, `ticker_symbol`, and
 * `market_identifier_code`, which qualifies the ticker and nothing else. A
 * ticker is emitted with its MIC when Plaid supplies one and without when it
 * does not; the resolver then refuses to treat an unqualified ticker as an
 * identity, which is the whole reason the field is carried rather than dropped.
 *
 * **`sedol` is deliberately absent.** 01 §5.5: Plaid removed it in 2026.
 *
 * `security_id` is *not* in this list. It is Plaid's own opaque id — stable
 * within one Item and meaningless outside it — and it travels as
 * `providerSecurityId` so that it can be recorded as corroborating evidence and
 * never as identity.
 */
export function securityIdentifiersOf(security: Security | null): readonly SecurityIdentifier[] {
  if (security === null) return [];
  const identifiers: SecurityIdentifier[] = [];
  const push = (kind: SecurityIdentifier['kind'], value: unknown, mic?: string | null): void => {
    if (typeof value !== 'string' || value.trim().length === 0) return;
    identifiers.push(securityIdentifierOf(kind, value.trim(), { mic: mic ?? null }));
  };

  // `figi` is typed as optional on some SDK versions; read it defensively rather
  // than pinning this file to one `plaid` minor.
  push('figi', (security as { figi?: unknown }).figi);
  push('isin', security.isin);
  push('cusip', security.cusip);
  push('ticker', security.ticker_symbol, security.market_identifier_code ?? null);
  return identifiers;
}

/**
 * The single identifier an *investment transaction* is filed under.
 *
 * When Plaid gave no identifier at all — it happens for private placements and
 * for some cash-sweep lines — the fallback is `proprietary` carrying Plaid's own
 * `security_id`. That is deliberately a *dead end*: `@ctx/investments` never
 * accepts a proprietary identifier as an identity, so the position surfaces as a
 * resolution failure the user can see instead of minting an anonymous
 * `securities` row that will never merge with anything.
 *
 * **Holdings no longer come through here.** Picking the strongest single name
 * out of the four `securityIdentifiersOf` had already extracted is the WP 3.7a
 * defect (`@connector/port`'s `ProviderHoldingFact.security`), and a holding now
 * carries the whole `ProviderSecurityFact` through `holdingSecurityFactOf`.
 * `ProviderInvestmentTransactionFact.security` is still one identifier, so this
 * is still its shape; it is carried in
 * `docs/evidence/phase-3/wp3.7a-holding-identifiers.md` §7.
 */
function holdingSecurityOf(providerSecurityId: string, security: Security | null) {
  return (
    strongestIdentifier(securityIdentifiersOf(security)) ??
    securityIdentifierOf('proprietary', providerSecurityId)
  );
}

/** One Plaid `Security`, as the port's canonical security fact. */
export function securityFactOf(security: Security): ProviderSecurityFact {
  const extracted = securityIdentifiersOf(security);
  const identifiers =
    extracted.length > 0 ? extracted : [securityIdentifierOf('proprietary', security.security_id)];
  const closePriceAsOf = security.close_price_as_of ?? null;

  return {
    providerSecurityId: security.security_id,
    identifiers,
    name: security.name ?? null,
    type: security.type === null || security.type === undefined ? null : String(security.type),
    subtype: null,
    currency: security.iso_currency_code ?? null,
    isCashEquivalent: security.is_cash_equivalent ?? null,
    closePrice:
      security.close_price === null || security.close_price === undefined
        ? null
        : decimalStringOf(security.close_price, 'security.close_price'),
    closePriceAsOf:
      closePriceAsOf === null || closePriceAsOf.length === 0
        ? null
        : dateOnlyOf(closePriceAsOf, 'security.close_price_as_of'),
    raw: security,
    fingerprint: securityFingerprintOf(identifiers),
  };
}

/**
 * The security a *position* is filed under — the whole fact, every name at once.
 *
 * `/investments/holdings/get` returns `holdings` and `securities` as two arrays
 * joined by `security_id`, so this is a map lookup that cannot always hit: Plaid
 * has been observed to reference a `security_id` it did not include. That case
 * gets the same `proprietary` dead end `securityFactOf` uses for a security with
 * no names — the resolver refuses it as an identity and the position surfaces as
 * a `SecurityResolutionFailed` the user can act on, rather than as an anonymous
 * `securities` row that will never merge with anything.
 */
function holdingSecurityFactOf(
  providerSecurityId: string,
  security: Security | null,
): ProviderSecurityFact {
  if (security !== null) return securityFactOf(security);
  const identifiers = [securityIdentifierOf('proprietary', providerSecurityId)];
  return {
    providerSecurityId,
    identifiers,
    name: null,
    type: null,
    subtype: null,
    currency: null,
    isCashEquivalent: null,
    closePrice: null,
    closePriceAsOf: null,
    raw: null,
    fingerprint: securityFingerprintOf(identifiers),
  };
}

export function holdingFactOf(
  holding: Holding,
  securities: ReadonlyMap<string, Security>,
  fallbackAsOf: Date,
): ProviderHoldingFact {
  const code = currencyOf(holding.iso_currency_code, holding.unofficial_currency_code, 'USD');
  const security = securities.get(holding.security_id) ?? null;
  const asOf = holding.institution_price_datetime ?? null;
  const asOfDate = holding.institution_price_as_of ?? null;

  return {
    providerAccountId: holding.account_id,
    security: holdingSecurityFactOf(holding.security_id, security),
    quantity: decimalStringOf(holding.quantity, 'holding.quantity'),
    // 01 §5.5: fill rates vary wildly and it is often *total* rather than
    // per-share. Carried as reported; Phase 3 prefers deriving from investment
    // transactions and treats this as the fallback.
    costBasis: moneyOrNullOf(holding.cost_basis, code, 'holding.cost_basis'),
    value: moneyOf(holding.institution_value, code, 'holding.institution_value'),
    asOf:
      asOf !== null && asOf.length > 0
        ? instantOf(asOf, 'holding.institution_price_datetime')
        : asOfDate !== null && asOfDate.length > 0
          ? instantOf(`${asOfDate}T00:00:00.000Z`, 'holding.institution_price_as_of')
          : fallbackAsOf,
    // The `Security` is no longer duplicated in here: it travels verbatim as
    // `security.raw`, and this fact is staged as jsonb in `connection_sync_facts`
    // where carrying it twice is a row that is twice the size for no answer.
    raw: { holding },
  };
}

/**
 * An investment transaction — now in the port's shape.
 *
 * This used to be `PlaidInvestmentTransactionFact`, declared here with a comment
 * naming the gap: "There is no `ProviderInvestmentTransactionFact` in
 * `@connector/port` and no port method that returns one." WP 3.1 closed it. The
 * local type is gone rather than aliased, because an alias is how two shapes
 * drift while continuing to type-check.
 *
 * What changed in the promotion, beyond the package it lives in:
 *
 *   * `securityId` + `symbol` (a Plaid id and a bare ticker) became
 *     `security: SecurityIdentifier | null` + `providerSecurityId`. The pair it
 *     replaced could not express "ETH on Ethereum" and could not tell `BHP` on
 *     XASX from `BHP` on XNYS.
 *   * `fingerprint` is now mandatory, as it is on every other fact (08 §2.5).
 *     01 §5.5's "no `/investments/transactions/sync`" means the only protection
 *     against a re-run of the same date window is idempotency, and the
 *     fingerprint is what makes that hold across a provider id rotation too.
 */
export function investmentTransactionFactOf(
  transaction: InvestmentTransaction,
  securities: ReadonlyMap<string, Security>,
): ProviderInvestmentTransactionFact {
  const code = currencyOf(
    transaction.iso_currency_code,
    transaction.unofficial_currency_code,
    'USD',
  );
  const security =
    transaction.security_id === null ? null : (securities.get(transaction.security_id) ?? null);
  // `null` when the transaction genuinely has no security (a cash sweep, a fee,
  // a deposit) and a `proprietary` dead end when Plaid named one it would not
  // identify — the two are different facts and collapsing them would make an
  // unresolvable security look like a cash movement.
  const identifier =
    transaction.security_id === null ? null : holdingSecurityOf(transaction.security_id, security);
  const date = dateOnlyOf(transaction.date, 'investment_transaction.date');
  const quantity = decimalStringOf(transaction.quantity, 'investment_transaction.quantity');
  const amount = signedAmountOf(transaction.amount, code, 'investment_transaction.amount');

  return {
    providerAccountId: transaction.account_id,
    providerTransactionId: transaction.investment_transaction_id,
    security: identifier,
    providerSecurityId: transaction.security_id,
    date,
    name: transaction.name,
    type: String(transaction.type),
    subtype: String(transaction.subtype),
    quantity,
    price: decimalStringOf(transaction.price, 'investment_transaction.price'),
    amount,
    fees: moneyOrNullOf(transaction.fees, code, 'investment_transaction.fees'),
    raw: transaction,
    fingerprint: investmentTransactionFingerprintOf({
      providerAccountId: transaction.account_id,
      date,
      amount,
      security: identifier,
      quantity,
    }),
  };
}

/**
 * `/liabilities/get`'s three (four, five) arrays, flattened per account.
 *
 * `statementBalance` and `minimumPayment` stay **positive magnitudes**: they are
 * "what you owe" and "what you must pay", and `ProviderBalanceFact.current` is
 * the field that carries the net-worth sign. Mixing the two conventions inside
 * one fact is how a payoff projection ends up adding a debt to net worth.
 */
export function liabilityFactsOf(
  liabilities: LiabilitiesObject,
  currencyByAccount: ReadonlyMap<string, CurrencyCode>,
): readonly ProviderLiabilityFact[] {
  const facts: ProviderLiabilityFact[] = [];
  const codeFor = (accountId: string): CurrencyCode => currencyByAccount.get(accountId) ?? USD_CODE;

  // A liability whose `account_id` is null cannot be attached to anything: the
  // orchestrator keys every fact by the provider account. Dropping it is the
  // only option, and it is visible — the account still syncs its balance.
  for (const card of liabilities.credit ?? []) {
    if (card.account_id === null) continue;
    facts.push(creditFactOf(card, card.account_id, codeFor(card.account_id)));
  }
  for (const loan of liabilities.student ?? []) {
    if (loan.account_id === null) continue;
    facts.push(studentFactOf(loan, loan.account_id, codeFor(loan.account_id)));
  }
  for (const mortgage of liabilities.mortgage ?? []) {
    facts.push(mortgageFactOf(mortgage, mortgage.account_id, codeFor(mortgage.account_id)));
  }
  return facts;
}

/**
 * The purchase APR, or the first one Plaid listed.
 *
 * A card commonly reports several (`purchase_apr`, `balance_transfer_apr`,
 * `cash_apr`, `special`). The purchase rate is the one a payoff projection
 * needs; every rate survives verbatim in `raw`.
 */
function aprOf(card: CreditCardLiability): string | null {
  const purchase = card.aprs.find((apr) => String(apr.apr_type) === 'purchase_apr');
  const chosen = purchase ?? card.aprs[0];
  return chosen === undefined ? null : decimalStringOf(chosen.apr_percentage, 'apr_percentage', 6);
}

function creditFactOf(
  card: CreditCardLiability,
  providerAccountId: string,
  code: CurrencyCode,
): ProviderLiabilityFact {
  return {
    providerAccountId,
    apr: aprOf(card),
    statementBalance: moneyOrNullOf(card.last_statement_balance, code, 'last_statement_balance'),
    minimumPayment: moneyOrNullOf(card.minimum_payment_amount, code, 'minimum_payment_amount'),
    nextPaymentDue:
      card.next_payment_due_date === null
        ? null
        : dateOnlyOf(card.next_payment_due_date, 'next_payment_due_date'),
    raw: card,
  };
}

function studentFactOf(
  loan: StudentLoan,
  providerAccountId: string,
  code: CurrencyCode,
): ProviderLiabilityFact {
  return {
    providerAccountId,
    apr: decimalStringOf(loan.interest_rate_percentage, 'interest_rate_percentage', 6),
    statementBalance: moneyOrNullOf(loan.last_statement_balance, code, 'last_statement_balance'),
    minimumPayment: moneyOrNullOf(loan.minimum_payment_amount, code, 'minimum_payment_amount'),
    nextPaymentDue:
      loan.next_payment_due_date === null
        ? null
        : dateOnlyOf(loan.next_payment_due_date, 'next_payment_due_date'),
    raw: loan,
  };
}

function mortgageFactOf(
  mortgage: MortgageLiability,
  providerAccountId: string,
  code: CurrencyCode,
): ProviderLiabilityFact {
  const percentage = mortgage.interest_rate.percentage;
  return {
    providerAccountId,
    apr:
      percentage === null || percentage === undefined
        ? null
        : decimalStringOf(percentage, 'interest_rate.percentage', 6),
    // A mortgage has no statement balance in Plaid's model; the outstanding
    // principal is the account's balance, which arrives through `syncBalances`.
    statementBalance: null,
    minimumPayment: moneyOrNullOf(mortgage.next_monthly_payment, code, 'next_monthly_payment'),
    nextPaymentDue:
      mortgage.next_payment_due_date === null || mortgage.next_payment_due_date === undefined
        ? null
        : dateOnlyOf(mortgage.next_payment_due_date, 'next_payment_due_date'),
    raw: mortgage,
  };
}

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

const USD_CODE = currencyOf('USD', null, 'USD');

export function currencyByAccountOf(
  accounts: readonly AccountBase[],
): ReadonlyMap<string, CurrencyCode> {
  return new Map(
    accounts.map((account) => [
      account.account_id,
      currencyOf(
        account.balances.iso_currency_code,
        account.balances.unofficial_currency_code,
        'USD',
      ),
    ]),
  );
}

export function securitiesByIdOf(securities: readonly Security[]): ReadonlyMap<string, Security> {
  return new Map(securities.map((security) => [security.security_id, security]));
}

/**
 * `YYYY-MM-DD` as a `DateOnly`, with no timezone anywhere near it.
 *
 * `docs/CONVENTIONS.md`: "Converting a bank's posted date through a timezone is
 * how a 2026-03-01 transaction becomes 2026-02-28 for a user in UTC-5." Plaid
 * sends the business date as a plain date string and it stays one.
 */
function dateOnlyOf(value: string, field: string): DateOnly {
  try {
    return parseDateOnly(value);
  } catch {
    throw malformed(`plaid sent an unparseable ${field}`, { field });
  }
}

/** An ISO-8601 instant. Rejected rather than silently `Invalid Date`. */
function instantOf(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw malformed(`plaid sent an unparseable ${field}`, { field });
  }
  return parsed;
}

/** Decimal places in a plain (non-exponential) decimal string. */
function decimalPlacesOf(plain: string): number {
  const point = plain.indexOf('.');
  return point === -1 ? 0 : plain.length - point - 1;
}

/**
 * A JSON number as a plain decimal string, never exponential notation.
 *
 * Two failure modes, pulling in opposite directions, which is why this is eight
 * lines rather than a `toFixed`:
 *
 *  1. **Exponential notation.** `String(1e-7)` is `'1e-7'`, which is not a
 *     `NUMERIC(38,18)` literal and not a `Quantity`. A holding of 0.0000001 BTC
 *     is a real thing, so this is a correctness requirement, not formatting.
 *  2. **Float noise.** `(268.4).toFixed(18)` is `'268.399999999999977263'` — the
 *     exact value of the double, faithfully printed to eighteen places. Padding
 *     every quantity out to the column's full scale therefore *manufactures*
 *     seventeen digits of garbage from a price the institution stated as 268.4,
 *     and those digits then survive into the ledger and into every derived
 *     cost-basis figure. `String(value)` gives the shortest decimal that
 *     round-trips to the same double — `'268.4'` — which is the closest thing to
 *     "what the provider actually said" that a JSON number can offer.
 *
 * So: prefer the shortest round-trip form, and fall back to `toFixed(scale)`
 * only in the two cases it is genuinely needed — exponential notation, and a
 * value whose shortest form has more decimal places than the column can hold.
 * `toFixed` is specified ("let n be an integer for which n / 10^f - x is as
 * close to zero as possible"), so that fallback is deterministic across engines,
 * which is the property that matters for a value that ends up in a fingerprint.
 */
export function decimalStringOf(value: number, field: string, scale = QUANTITY_SCALE): string {
  if (!Number.isFinite(value)) {
    throw malformed(`plaid sent a non-finite ${field}`, { field });
  }
  if (Math.abs(value) >= 1e15) {
    throw malformed(`plaid sent an implausible ${field}`, { field });
  }
  const shortest = String(value);
  const plain =
    shortest.includes('e') || shortest.includes('E') || decimalPlacesOf(shortest) > scale
      ? value.toFixed(scale)
      : shortest;
  const trimmed = plain.includes('.') ? plain.replace(/0+$/, '').replace(/\.$/, '') : plain;
  // Validated through the kernel so a value the ledger's NUMERIC(38,18) column
  // would reject fails here, at the boundary, and not four layers down.
  return scale === QUANTITY_SCALE ? quantity(trimmed) : trimmed;
}
