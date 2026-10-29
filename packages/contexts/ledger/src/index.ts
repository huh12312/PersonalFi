// SPDX-License-Identifier: MIT
/**
 * `@ctx/ledger` — Ledger.
 *
 * The system of record and the gravitational centre of the app. Deliberately
 * dumb: it stores facts and their provenance, and does not categorise, budget, or
 * interpret. Provider-sourced rows are immutable; user intent lives in an overlay
 * resolved by one pure function.
 *
 * This file is the context's **only** public surface. Everything else under
 * `src/` is internal, and no other context may import from it — a consumer that
 * needs ledger data re-reads it through the read models below, or reacts to one
 * of the events in `LEDGER_EVENTS`.
 *
 * ```text
 *  sync adapter ─▶ applyProviderTransactions ─┬─▶ transactions_provider (facts)
 *                                             ├─▶ transactions          (identity + overlay + projection)
 *                                             └─▶ outbox                (TransactionsUpserted, …)
 *  user edit    ─▶ setTransactionOverlay ─────┘
 *  heuristics   ─▶ pairTransfers / detectRefundHints
 *  reads        ─▶ listTransactions / getTransaction / listAccounts / netWorthNow
 * ```
 */

/** Stable identifier used by feature flags (`module.ledger`) and event metadata. */
export const CONTEXT_ID = 'ledger' as const;

// --- the resolver, and the shapes it speaks --------------------------------
export { resolveCategory, resolveCategoryId, resolveEffective, withinDays } from './effective.ts';
export {
  normaliseMerchantName,
  dedupKeyOf,
  // Decision D25: merchant identity, and the gate that refuses it.
  resolveMerchantIdentity,
  merchantAbstainReasonOf,
  type NormalisedMerchant,
  type MerchantIdentity,
  type MerchantIdentityInput,
  type MerchantIdentitySource,
  type MerchantAbstainReason,
  type MerchantCounterparty,
} from './normalise.ts';
export { pruneNoiseMerchants } from './merchant-store.ts';
// WP 11.6: noise merchants, and the merchant.name suggestions recorded for them.
export {
  MERCHANT_NOISE_SHAPES,
  detectMerchantNoise,
  mayBeNoise,
  noiseShapesOf,
  type MerchantNoiseShape,
  type MerchantNoiseShapeDefinition,
  type MerchantNoiseVerdict,
} from './merchant-noise.ts';
export { processorPrefixOf } from './normalise.ts';
export {
  MERCHANT_NAME_LIST_MAX,
  MERCHANT_NAME_RUN_CAP,
  acceptMerchantNameSuggestion,
  countMerchantNameSuggestions,
  dismissMerchantNameSuggestion,
  listMerchantNameCandidates,
  listMerchantNameSuggestions,
  recordMerchantNameAnswer,
  type MerchantNameAnswer,
  type MerchantNameCandidate,
  type MerchantNameCandidates,
  type MerchantNameSuggestionView,
} from './merchant-name-suggestions.ts';
export {
  EMPTY_OVERLAY,
  NO_AUTO,
  NO_RULE,
  type AutoCategoryView,
  type AutoResolution,
  type CategorySource,
  type EffectiveTransaction,
  type LedgerTransaction,
  type ProviderCounterparty,
  type ProviderTransactionInput,
  type RuleResolution,
  type TransactionFact,
  type TransactionOverlay,
  type TransactionSplit,
} from './types.ts';

// --- errors ----------------------------------------------------------------
export { LedgerError, isLedgerError, type LedgerErrorCode } from './errors.ts';

// --- the executor shapes a caller needs ------------------------------------
export type { LedgerDatabase, LedgerExecutor, LedgerContext } from './db.ts';
export { autoOf, autoViewOf, factOf, overlayOf, ruleOf, effectiveOf, transactionOf } from './db.ts';

// --- events ----------------------------------------------------------------
export {
  LEDGER_EVENTS,
  AccountUpserted,
  BalanceRecorded,
  TransactionsUpserted,
  TransferPaired,
  TransactionSupersededByPosted,
  TransactionCategoryChosen,
} from './events.ts';

// --- the holder's overlay on an account (WP 9.2) ---------------------------
export {
  ACCOUNT_ROLES,
  AccountOverrideChanged,
  MANAGEMENT_STYLES,
  OVERRIDE_FIELDS,
  OverrideNotApplicable,
  TAX_TREATMENTS,
  VALUATION_BASES,
  clearAccountOverrides,
  getAccountOverride,
  isOverrideNotApplicable,
  listAccountOverrides,
  overrideFingerprint,
  overrideRefusal,
  resolveAccountOverlay,
  setAccountOverrides,
  type AccountOverride,
  type AccountRole,
  type ManagementStyle,
  type OverrideField,
  type OverrideWriteResult,
  type ProviderTaxDefault,
  type ResolvedAccountOverlay,
  type SetAccountOverridesInput,
  type TaxTreatment,
  type TaxTreatmentSource,
  type ValuationBasis,
} from './overrides/index.ts';

// --- write paths -----------------------------------------------------------
export {
  applyProviderTransactions,
  contentHashOf,
  projectEffective,
  type ApplyOptions,
  type ApplyProviderTransactionsInput,
  type ApplyResult,
  type SupersededPending,
} from './apply.ts';
export {
  classificationOf,
  listAccounts,
  netWorthNow,
  recordBalance,
  setAccountClosed,
  setIncludeInNetWorth,
  upsertAccount,
  type AccountBalanceSummary,
  type AccountSummary,
  type LedgerWriteContext,
  type NetWorthInput,
  type NetWorthNow,
  type NetWorthTotal,
  type RecordBalanceInput,
  type UpsertAccountInput,
  type UpsertAccountResult,
} from './accounts.ts';
export { setRuleCategory, setTransactionOverlay, type OverlayPatch } from './overlay.ts';

// --- WP 11.2b: the automatic tiers' projection (tiers 3-5 of the decision order) ---
export {
  setAutoCategories,
  type AutoCategoryChange,
  type AutoPlacement,
  type SetAutoCategoriesResult,
} from './auto-category.ts';

// --- heuristics ------------------------------------------------------------
export {
  confirmTransferPair,
  listTransferLinks,
  pairTransfers,
  proposeTransferPairs,
  rejectTransferPair,
  rejectionKey,
  type PairTransfersInput,
  type PairTransfersResult,
  type TransferLeg,
  type TransferLinkSummary,
  type TransferPairingOptions,
  type TransferProposal,
} from './transfers.ts';
export {
  DEFAULT_REFUND_WINDOW_DAYS,
  detectRefundHints,
  proposeRefundHints,
  refundHintOf,
  type DetectRefundsInput,
  type RefundHint,
  type RefundLeg,
  type RefundOptions,
} from './refunds.ts';

// --- read models -----------------------------------------------------------
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  countTransactions,
  decodeCursor,
  encodeCursor,
  getTransaction,
  listForCategorization,
  listMerchants,
  merchantDisplayNames,
  listRemovedTransactions,
  listTransactions,
  listAggregateRowsInWindow,
  listAggregateSumsInWindow,
  listRefundLinkedRowsInWindow,
  type LedgerAggregateRow,
  type LedgerAggregateSum,
  scanForProjectionCheck,
  sumTransactions,
  type CategorizationFeedFilters,
  type CategorizationFeedPage,
  type CategorizationFeedRow,
  type ListTransactionsInput,
  type TransactionDetail,
  type TransactionFilters,
  type TransactionPage,
  type TransactionProvenance,
  type TransferLinkView,
} from './read.ts';

// --- demo data -------------------------------------------------------------
export {
  SEED_PROVIDER,
  grade,
  loadSeedDataset,
  type Grading,
  type LoadSeedOptions,
  type LoadSeedResult,
  type SeedAccountLike,
  type SeedDatasetLike,
  type SeedMerchantLike,
  type SeedTransactionLike,
} from './seed-loader.ts';
