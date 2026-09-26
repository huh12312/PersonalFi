// SPDX-License-Identifier: MIT
/**
 * The canonical model (08 §2.5). Every adapter maps *into* these.
 *
 * ## Why these shapes and not 08's `CanonicalTransaction` verbatim
 *
 * 08 §2.5 was written before the Ledger existed. WP 1.1 then built
 * `applyProviderTransactions`, and its `ProviderTransactionInput` *is* the
 * canonical transaction — it carries provenance, it is already sign-normalised,
 * and it is the only shape the system of record accepts. Defining a second,
 * near-identical canonical transaction here and translating between them in the
 * orchestrator would create exactly one thing: a place for the two to drift.
 *
 * So `ProviderTransactionFact` is **structurally identical to `@ctx/ledger`'s
 * `ProviderTransactionInput`, plus `fingerprint`**. The orchestrator hands the
 * array straight to the ledger writer with no mapping step. That the two
 * declarations are separate files is not duplication-by-accident: the boundary
 * lint denies `packages/connectors/*` → `@ctx/*` outright (the whole point of
 * `@ctx/ledger` not knowing Plaid exists), and `@ctx/ledger`'s own seed loader
 * takes its dataset structurally for the same reason. A conformance assertion
 * and the composition root's type-check are what keep them aligned.
 *
 * ## The three conventions worth arguing about now (08 §2.5)
 *
 * 1. **Sign**: negative = outflow *from the account's perspective*, on every
 *    account type including credit cards. Plaid's convention is the inverse for
 *    some products; that inversion lives in the Plaid adapter and nowhere else.
 * 2. **`providerCategory` is a hint.** Stored, fed to the classifier as a
 *    feature, never written to a category id. Otherwise switching aggregators
 *    re-categorises the user's entire history.
 * 3. **`fingerprint` is mandatory for every adapter**, even ones with stable
 *    ids. It is the dedupe key when a CSV import overlaps a Plaid backfill and
 *    when a provider rotates its ids.
 */
import type { DateOnly, Money } from '@core/kernel';
import type { Capability } from './capabilities.ts';

/** A counterparty as a provider reports it. `entityId` is the useful part. */
export interface ProviderCounterparty {
  readonly name: string;
  readonly type: string | null;
  readonly entityId: string | null;
  readonly confidenceLevel: string | null;
}

/**
 * One provider's statement of one transaction, already sign-normalised.
 *
 * Assignable to `@ctx/ledger`'s `ProviderTransactionInput`. Keep it that way.
 */
export interface ProviderTransactionFact {
  /**
   * Which account this belongs to, in the provider's vocabulary.
   *
   * Not on `@ctx/ledger`'s input, because `applyProviderTransactions` takes the
   * account as a parameter — one call, one account. A provider page is not so
   * tidy: Plaid's `/transactions/sync` is per *item* and returns every account
   * at once. The orchestrator groups a page by this field and makes one ledger
   * call per account, which is also what keeps each of those calls a small,
   * short-lived transaction.
   */
  readonly providerAccountId: string;
  readonly providerTransactionId: string;
  /** The pending transaction this one replaces, when the provider says so. */
  readonly pendingTransactionId: string | null;
  /** Negative = outflow. Always carries a currency; never a float. */
  readonly amount: Money;
  /** The provider's own currency string, kept verbatim for reconciliation. */
  readonly isoCurrency: string | null;
  readonly postedDate: DateOnly;
  readonly authorizedDate: DateOnly | null;
  readonly postedAt: Date | null;
  readonly authorizedAt: Date | null;
  readonly name: string;
  readonly merchantName: string | null;
  readonly originalDescription: string | null;
  readonly paymentChannel: string | null;
  /** A hint. Never authoritative, never a category id. */
  readonly providerCategory: unknown;
  readonly pending: boolean;
  readonly location: unknown;
  readonly counterparties: readonly ProviderCounterparty[] | null;
  /** The verbatim payload. Kept so a Phase 3 question has a Phase 1 answer. */
  readonly raw: unknown;
  /**
   * `sha256(accountRef, postedDate, amount, normalisedDescription)` — see
   * `fingerprintOf`. Mandatory on every adapter, including ones with stable ids.
   */
  readonly fingerprint: string;
}

/** The account types the ledger models. Mirrors `@ctx/ledger`'s `AccountType`. */
export const PROVIDER_ACCOUNT_TYPES = [
  'depository',
  'credit',
  'loan',
  'investment',
  'crypto',
  'manual',
] as const;

export type ProviderAccountType = (typeof PROVIDER_ACCOUNT_TYPES)[number];

/** One account as the provider describes it. Maps to `upsertAccount`'s input. */
export interface ProviderAccountFact {
  readonly providerAccountId: string;
  readonly name: string;
  readonly officialName: string | null;
  readonly type: ProviderAccountType;
  /** Provider vocabulary (`checking`, `401k`, `wallet`). Unconstrained by design. */
  readonly subtype: string | null;
  readonly currency: string;
  /** Last 2–4 digits. Never the full number; it is neither needed nor safe to hold. */
  readonly mask: string | null;
  readonly closed: boolean;
  /**
   * Per-account capabilities (08 §2.5). A connector may support `holdings` while
   * a particular checking account within it does not.
   */
  readonly capabilities: readonly Capability[];
}

/**
 * A balance observation. Maps to `recordBalance`'s input.
 *
 * `current` is the account's **contribution to net worth**, so a card you owe
 * $420 on reports `-42000n`. `limit` is a magnitude and stays positive.
 */
export interface ProviderBalanceFact {
  readonly providerAccountId: string;
  readonly current: Money;
  readonly available: Money | null;
  readonly limit: Money | null;
  readonly asOf: Date;
}

/**
 * How a provider names a security (08 §2.5), **plus `figi` and `mic`**.
 *
 * 08 §2.5 states the union as
 * `{ kind:'ticker'|'cusip'|'isin'|'chain_contract'|'proprietary', value, chain? }`
 * and the five kinds below are that list verbatim. `figi` is a sixth, and `mic`
 * a second qualifier, for the same reason `MUTATION_DURING_PAGINATION` is
 * "08's table plus one" in `errors.ts`: 08 was written before Plaid's `Security`
 * object carried either. 01 §5.5 records `figi` **added 2026-06-18** alongside
 * `market_identifier_code`, and both are load-bearing here —
 *
 *   * a FIGI is the only globally unique, permanent, exchange-level identifier
 *     a provider hands us, so it is the strongest evidence of identity there is;
 *   * a bare ticker is **not** an identity. `BHP` is a different security on
 *     XNYS, XASX and XLON. Without a MIC a ticker can only ever corroborate.
 *
 * 01 §5.5 also records that **`sedol` was removed in 2026**; it is deliberately
 * absent and must not be re-added.
 *
 * `chain` and `mic` are mandatory-but-nullable rather than optional. An adapter
 * that has no MIC has to say so, which is the difference between "this ticker is
 * unqualified" and "somebody forgot the field".
 */
export const SECURITY_IDENTIFIER_KINDS = [
  'figi',
  'isin',
  'cusip',
  'ticker',
  'chain_contract',
  'proprietary',
] as const;

export type SecurityIdentifierKind = (typeof SECURITY_IDENTIFIER_KINDS)[number];

export interface SecurityIdentifier {
  readonly kind: SecurityIdentifierKind;
  /**
   * The identifier itself: `BBG000BPH459`, `US9229087690`, `VTI`, a contract
   * address, or a provider's own opaque id when `kind` is `proprietary`.
   */
  readonly value: string;
  /** `chain_contract` only: `ethereum`, `bitcoin`, `solana`. `null` otherwise. */
  readonly chain: string | null;
  /** `ticker` only: the ISO-10383 MIC (`XNAS`, `XNYS`). `null` when unqualified. */
  readonly mic: string | null;
}

/** Build a `SecurityIdentifier` without writing two `null`s at every call site. */
export function securityIdentifierOf(
  kind: SecurityIdentifierKind,
  value: string,
  qualifiers: { readonly chain?: string | null; readonly mic?: string | null } = {},
): SecurityIdentifier {
  return {
    kind,
    value,
    chain: qualifiers.chain ?? null,
    mic: qualifiers.mic ?? null,
  };
}

/**
 * One security as a provider describes it.
 *
 * The shape exists so an adapter can hand over **every** name it was given at
 * once, rather than one at a time. That is not a convenience: `@ctx/investments`
 * resolves a security by walking identifier tiers strongest-first and taking the
 * first one that hits a row it already has, and it can only do that if it sees
 * the whole set. A brokerage that reports a CUSIP *and* a ticker for the same
 * position is how that position joins the row a crypto wallet already created.
 *
 * `providerSecurityId` — a Plaid `security_id`, a Coinbase `product_id` — is
 * carried as **evidence and never as identity** (the D25 shape, applied to
 * securities). It is stable within one provider and meaningless across two, so
 * it belongs in `security_identifiers` with `kind = 'proprietary'` and nowhere
 * near an identity column. An adapter that puts it in `identifiers` as anything
 * other than `proprietary` is stating something it cannot know.
 */
export interface ProviderSecurityFact {
  /** The provider's own opaque id. Evidence, never identity. */
  readonly providerSecurityId: string;
  /** Every name the provider gave, strongest or weakest, in any order. */
  readonly identifiers: readonly SecurityIdentifier[];
  readonly name: string | null;
  /** Provider vocabulary (`equity`, `etf`, `cryptocurrency`). Unconstrained. */
  readonly type: string | null;
  readonly subtype: string | null;
  readonly currency: string | null;
  /** Plaid's `is_cash_equivalent`. `null` when the provider does not say. */
  readonly isCashEquivalent: boolean | null;
  /** A decimal string, never a float. `null` when unpriced. */
  readonly closePrice: string | null;
  readonly closePriceAsOf: DateOnly | null;
  readonly raw: unknown;
  /**
   * `securityFingerprintOf(identifiers)` — mandatory, like every other fact's.
   *
   * Hashed over the *strongest* identifier rather than over all of them, so two
   * providers that agree on an ISIN fingerprint alike even though one of them
   * also volunteered a ticker. Hashing the whole set would make the fingerprint
   * a function of how chatty the provider is, which is the opposite of a
   * cross-provider dedupe key.
   */
  readonly fingerprint: string;
}

/** A position. Phase 3 wires these to `@ctx/investments`; the port carries them now. */
export interface ProviderHoldingFact {
  readonly providerAccountId: string;
  /**
   * What this is a position *in* — **every** name the provider gave it.
   *
   * Was `securityId: string` + `symbol: string | null` through Phase 1 — the
   * provider's opaque id and an unqualified ticker, which between them cannot
   * express "ETH on Ethereum" and cannot distinguish `BHP` on XASX from `BHP` on
   * XNYS. Both failure modes end the same way: two `securities` rows for one
   * asset, allocation double-counting it and TWR wrong for both halves.
   *
   * WP 3.1 replaced that pair with a single `SecurityIdentifier`, and WP 3.7's
   * own wiring test found that this was still one name short of enough. The
   * resolver tiers **strongest-first over the whole set** and `ProviderSecurityFact`
   * exists so an adapter can hand it that set at once; a field holding one
   * identifier forces every adapter to pick, and picking is the defect. Plaid's
   * `holdingSecurityOf` picked the FIGI and dropped the ISIN, the CUSIP and the
   * MIC-qualified ticker it had already extracted, so a security first seen as
   * `ticker/VTI@XNYS` and later as `figi/BBG000BDTF76` became two `securities`
   * rows that could never merge — no provider ever stated both at once. The
   * single identifier also carried no `type` and no `name`, so `securities.type`
   * from this path degraded to `other` for everything.
   *
   * So this is the **whole fact**, not an identifier and not an identifier plus
   * an optional set: one shape, no dual path, nothing for an adapter to choose
   * between. `providerSecurityId` lives inside it (evidence, never identity),
   * which is also why this interface no longer carries its own copy.
   *
   * See `docs/evidence/phase-3/wp3.7a-holding-identifiers.md`.
   */
  readonly security: ProviderSecurityFact;
  /** `@core/kernel`'s `Quantity` wire form: a decimal string, never a float. */
  readonly quantity: string;
  readonly costBasis: Money | null;
  /**
   * `null` when the provider itself has no fiat quote for this position —
   * distinct from a zero balance, which is never reported as a holding at all
   * (see every adapter's own `syncHoldings`: a zero quantity is filtered out
   * before this shape is even built). WP 3.6's `WalletRpcConnector` is the
   * motivating case: a watch-only wallet reads a real on-chain quantity but
   * has no price source of its own (01 §3.5's Esplora/Etherscan hosts quote
   * neither), so 08 §2.2's "never report $0.00 for an unpriced asset" applies
   * here exactly as it does to `costBasis` above — `null` is the honest
   * answer, and a caller that needs a fiat figure gets one downstream, from
   * WP 3.4's price ladder joined on `security_id` after resolution (never
   * fabricated here, and never coerced to zero). `@ctx/investments`'
   * `Holding.institutionValue` carries this through unchanged; every
   * consumer that values a holding for allocation, net worth or the holdings
   * list already reads the ladder's own price and never this field — see
   * `docs/evidence/phase-4/wp4.12a-gate-conditions.md` C-2 for the trace.
   */
  readonly value: Money | null;
  readonly asOf: Date;
  readonly raw: unknown;
}

/**
 * A buy, a sell, a dividend, a transfer in kind.
 *
 * Promoted out of `packages/connectors/plaid/src/map.ts`, where it lived as
 * `PlaidInvestmentTransactionFact` with a comment naming this promotion as the
 * gap. Two things forced it up here rather than leaving it Plaid-local:
 *
 *  1. **It is not Plaid-shaped.** Coinbase fills (WP 3.5) and a brokerage CSV
 *     produce the same four facts — a security, a signed quantity, a unit price
 *     and a fee — and a second adapter is the moment a "local type" becomes a
 *     de-facto contract nobody wrote down.
 *  2. **It cannot be smuggled through `ProviderTransactionFact`.** An investment
 *     transaction has a quantity, a price and a fee; flattening it into a bank
 *     transaction loses all three, and cost basis cannot be rebuilt from what is
 *     left. 04 §5.5 is explicit that an unknown basis must report `unavailable`
 *     rather than gain-from-zero, and a lossy fact is how it silently becomes
 *     the latter.
 *
 * **There is no cursor.** 01 §5.5: "There is no `/investments/transactions/sync`".
 * These arrive by date window and are idempotent on `providerTransactionId`,
 * which is why `syncInvestmentTransactions` returns an array rather than a
 * `TransactionPage` — a paging shape with no cursor behind it would be a lie the
 * conformance suite would then have to make exceptions for.
 */
export interface ProviderInvestmentTransactionFact {
  readonly providerAccountId: string;
  /** Plaid's `investment_transaction_id`. The idempotency key. */
  readonly providerTransactionId: string;
  /**
   * The security traded, or `null` — a cash sweep, a fee and a deposit are all
   * real investment transactions with no security behind them.
   *
   * The whole `ProviderSecurityFact`, not a single `SecurityIdentifier` — WP
   * 3.14a, the item `ProviderHoldingFact.security`'s own doc comment named as
   * carried: "the same argument applies to it... The fix is the same
   * one-field change." A provider that states a FIGI *and* a ticker for the
   * same trade is the identical shape holdings had, and `providerSecurityId`
   * lives inside the fact now, for the same reason `ProviderHoldingFact`
   * dropped its own copy — see `docs/evidence/phase-3/wp3.7a-holding-identifiers.md`
   * §2 and `docs/evidence/phase-3/wp3.14a-port-and-scope.md`.
   */
  readonly security: ProviderSecurityFact | null;
  readonly date: DateOnly;
  readonly name: string;
  /** Provider vocabulary: `buy`, `sell`, `cash`, `fee`, `transfer`. */
  readonly type: string;
  readonly subtype: string;
  /** Decimal string. Negative for a sale, as every provider reports it. */
  readonly quantity: string;
  /** Unit price, decimal string. Never a float: this gets multiplied and summed. */
  readonly price: string;
  /** House sign convention: negative = money left the account. */
  readonly amount: Money;
  readonly fees: Money | null;
  readonly raw: unknown;
  /** `investmentTransactionFingerprintOf(...)`. Mandatory, like every other fact's. */
  readonly fingerprint: string;
}

/** Loan and card terms. Phase 3 consumes these; the port carries them now. */
export interface ProviderLiabilityFact {
  readonly providerAccountId: string;
  /** A percentage, as a decimal string. Not money, not a float column. */
  readonly apr: string | null;
  readonly statementBalance: Money | null;
  readonly minimumPayment: Money | null;
  readonly nextPaymentDue: DateOnly | null;
  readonly raw: unknown;
}
