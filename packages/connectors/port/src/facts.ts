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

/** A position. Phase 3 wires these to `@ctx/investments`; the port carries them now. */
export interface ProviderHoldingFact {
  readonly providerAccountId: string;
  readonly securityId: string;
  readonly symbol: string | null;
  /** `@core/kernel`'s `Quantity` wire form: a decimal string, never a float. */
  readonly quantity: string;
  readonly costBasis: Money | null;
  readonly value: Money;
  readonly asOf: Date;
  readonly raw: unknown;
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
