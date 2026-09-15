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
  type Capability,
  type ProviderAccountFact,
  type ProviderAccountType,
  type ProviderBalanceFact,
  type ProviderCounterparty,
  type ProviderHoldingFact,
  type ProviderLiabilityFact,
  type ProviderTransactionFact,
} from '@connector/port';
import {
  QUANTITY_SCALE,
  parseDateOnly,
  quantity,
  type CurrencyCode,
  type DateOnly,
  type Money,
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
      transaction.datetime === null ? null : instantOf(transaction.datetime, 'transaction.datetime'),
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
    securityId: holding.security_id,
    symbol: security?.ticker_symbol ?? null,
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
    raw: { holding, security },
  };
}

/**
 * An investment transaction, in the shape the port does **not** have.
 *
 * There is no `ProviderInvestmentTransactionFact` in `@connector/port` and no
 * port method that returns one: 01 §5.5 notes there is no
 * `/investments/transactions/sync`, so these arrive by date window and are
 * idempotent on `investment_transaction_id`. Declared locally, and reported as a
 * port gap in the evidence doc, rather than smuggled through
 * `ProviderTransactionFact` — an investment transaction has a quantity, a price
 * and fees, and flattening it into a bank transaction would lose all three.
 */
export interface PlaidInvestmentTransactionFact {
  readonly providerAccountId: string;
  readonly providerTransactionId: string;
  readonly securityId: string | null;
  readonly symbol: string | null;
  readonly date: DateOnly;
  readonly name: string;
  readonly type: string;
  readonly subtype: string;
  /** Decimal string. Negative for a sale, as Plaid reports it. */
  readonly quantity: string;
  readonly price: string;
  /** Sign-inverted like every other amount: negative = money left the account. */
  readonly amount: Money;
  readonly fees: Money | null;
  readonly raw: unknown;
}

export function investmentTransactionFactOf(
  transaction: InvestmentTransaction,
  securities: ReadonlyMap<string, Security>,
): PlaidInvestmentTransactionFact {
  const code = currencyOf(
    transaction.iso_currency_code,
    transaction.unofficial_currency_code,
    'USD',
  );
  const security =
    transaction.security_id === null ? null : (securities.get(transaction.security_id) ?? null);

  return {
    providerAccountId: transaction.account_id,
    providerTransactionId: transaction.investment_transaction_id,
    securityId: transaction.security_id,
    symbol: security?.ticker_symbol ?? null,
    date: dateOnlyOf(transaction.date, 'investment_transaction.date'),
    name: transaction.name,
    type: String(transaction.type),
    subtype: String(transaction.subtype),
    quantity: decimalStringOf(transaction.quantity, 'investment_transaction.quantity'),
    price: decimalStringOf(transaction.price, 'investment_transaction.price'),
    amount: signedAmountOf(transaction.amount, code, 'investment_transaction.amount'),
    fees: moneyOrNullOf(transaction.fees, code, 'investment_transaction.fees'),
    raw: transaction,
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

/**
 * A JSON number as a plain decimal string, never exponential notation.
 *
 * `String(1e-7)` is `'1e-7'`, which is not a `NUMERIC(38,18)` literal and not a
 * `Quantity`. A holding of 0.0000001 BTC is a real thing, so this is a
 * correctness requirement rather than a formatting preference.
 */
export function decimalStringOf(value: number, field: string, scale = QUANTITY_SCALE): string {
  if (!Number.isFinite(value)) {
    throw malformed(`plaid sent a non-finite ${field}`, { field });
  }
  if (Math.abs(value) >= 1e15) {
    throw malformed(`plaid sent an implausible ${field}`, { field });
  }
  const fixed = value.toFixed(scale);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  // Validated through the kernel so a value the ledger's NUMERIC(38,18) column
  // would reject fails here, at the boundary, and not four layers down.
  return scale === QUANTITY_SCALE ? quantity(trimmed) : trimmed;
}
