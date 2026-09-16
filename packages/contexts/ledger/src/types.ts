// SPDX-License-Identifier: MIT
import type { DateOnly, Money } from '@core/kernel';

/**
 * The shapes the ledger speaks.
 *
 * Everything an adapter hands in is already normalised: money is `Money` with the
 * house sign convention (negative = outflow), dates are `DateOnly` with no zone,
 * instants are `Date`. Nothing in this context knows what a Plaid response looks
 * like — that translation is the connector's job (WP 1.2/1.3), and keeping it out
 * of here is what makes "swap the aggregator" a one-context change.
 */

/** A counterparty as a provider reports it. `entityId` is the useful part. */
export interface ProviderCounterparty {
  readonly name: string;
  readonly type: string | null;
  readonly entityId: string | null;
  readonly confidenceLevel: string | null;
}

/** One provider's statement of one transaction, already sign-normalised. */
export interface ProviderTransactionInput {
  readonly providerTransactionId: string;
  /** The pending transaction this one replaces, when the provider says so. */
  readonly pendingTransactionId: string | null;
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
  readonly providerCategory: unknown;
  readonly pending: boolean;
  readonly location: unknown;
  readonly counterparties: readonly ProviderCounterparty[] | null;
  /** The verbatim payload. Kept so a Phase 3 question has a Phase 1 answer. */
  readonly raw: unknown;
}

/**
 * The slice of a provider fact that `resolveEffective` is allowed to see.
 *
 * Deliberately narrow. A pure function with a small domain can be tested
 * exhaustively; one that takes the whole row invites a future contributor to
 * reach for `raw` and put provider-specific logic in the one place that must stay
 * provider-agnostic.
 *
 * `provider` and `counterparties` were added for decision D25 and are the only
 * widening this slice has taken. They are here because they have to be: D25's
 * second tier says a provider asserting a merchant *entity* outranks our text
 * heuristics, and if the read path could not see that assertion it would resolve
 * a different merchant than the write path did — which is the exact divergence
 * `resolveEffective` exists to make impossible, and which showed up in testing as
 * a `merchants` row no transaction pointed at. They are *not* a licence to reach
 * further: `raw`, `location` and `providerCategory` remain out, because nothing
 * about what a transaction *is* may depend on a field only one provider sends.
 *
 * Optional rather than required so the hundreds of existing `TransactionFact`
 * literals in tests keep compiling; absent means "no provider evidence", which is
 * the honest reading for a hand-built fact.
 */
export interface TransactionFact {
  readonly amount: Money;
  readonly postedDate: DateOnly;
  readonly authorizedDate: DateOnly | null;
  readonly name: string;
  readonly merchantName: string | null;
  readonly pending: boolean;
  readonly provider?: string | null;
  readonly counterparties?: readonly ProviderCounterparty[] | null;
}

/**
 * User intent. Sparse: `null` means "the user has not spoken", which is different
 * from "the user cleared it" only in that clearing writes an empty string or an
 * explicit `false`.
 */
export interface TransactionOverlay {
  readonly userNote: string | null;
  readonly userExcluded: boolean;
  /** Opaque. `@ctx/categorization` owns categories; the ledger stores the id. */
  readonly userCategoryId: string | null;
  readonly userMerchantName: string | null;
}

/** No user intent at all. The state every row starts in. */
export const EMPTY_OVERLAY: TransactionOverlay = Object.freeze({
  userNote: null,
  userExcluded: false,
  userCategoryId: null,
  userMerchantName: null,
});

/**
 * The rule tier's answer for one transaction: 04 §2.2's middle tier.
 *
 * Opaque here in exactly the way `userCategoryId` is — the id is one of
 * `@ctx/categorization`'s `categories.id` values and the ledger never
 * interprets it. Supplied by the caller (the composition root reads
 * `category_assignments`), never queried from here: `resolveEffective` is pure
 * and a resolution function that can do I/O is one that will eventually do I/O
 * on the read path for 50,000 rows.
 */
export interface RuleResolution {
  readonly ruleCategoryId: string | null;
}

/** No rule matched. The state every row resolves in until one does. */
export const NO_RULE: RuleResolution = Object.freeze({ ruleCategoryId: null });

/**
 * What a read path sees: fact and overlay, resolved.
 *
 * `merchantKey` rather than a merchant id, because resolution is pure and a
 * merchant id requires a database round trip. The writer maps key → id and stores
 * it in `transactions.effective_merchant_id`; the reader uses the stored id.
 */
export interface EffectiveTransaction {
  readonly date: DateOnly;
  readonly amount: Money;
  readonly name: string;
  readonly merchantKey: string | null;
  readonly merchantDisplayName: string | null;
  readonly pending: boolean;
  readonly excluded: boolean;
  readonly categoryId: string | null;
  readonly note: string | null;
}

/** A user-facing transaction as the reader returns it. */
export interface LedgerTransaction {
  readonly id: string;
  readonly accountId: string;
  readonly factId: string;
  readonly effective: EffectiveTransaction;
  readonly merchantId: string | null;
  readonly isTransfer: boolean;
  readonly transferLinkId: string | null;
  readonly refundOfId: string | null;
  readonly refundConfidence: number | null;
  readonly supersededById: string | null;
  readonly supersededReason: 'duplicate' | 'merged' | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A split, as stored. The splits of one transaction must sum to its amount. */
export interface TransactionSplit {
  readonly id: string;
  readonly transactionId: string;
  readonly position: number;
  readonly amount: Money;
  readonly userCategoryId: string | null;
  readonly note: string | null;
}
