// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/ledger`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database — these
 * definitions are the query surface and the ownership claim, not the DDL.
 *
 * `categories` is deliberately absent: `@ctx/categorization` owns it, and the
 * ledger stores only an opaque `user_category_id`. `connections` and `items` are
 * absent for the same reason — Ledger has no idea Plaid exists.
 */
export {
  accounts,
  accountBalances,
  ACCOUNT_TYPES,
  ACCOUNT_CLASSIFICATIONS,
  BALANCE_SOURCES,
  type AccountType,
  type AccountClassification,
  type BalanceSource,
  type AccountRow,
  type NewAccountRow,
  type AccountBalanceRow,
  type NewAccountBalanceRow,
} from './accounts.ts';
export { merchants, type MerchantRow, type NewMerchantRow } from './merchants.ts';
export {
  transactionsProvider,
  transactions,
  transactionSplits,
  type TransactionProviderRow,
  type NewTransactionProviderRow,
  type TransactionRow,
  type NewTransactionRow,
  type TransactionSplitRow,
  type NewTransactionSplitRow,
} from './transactions.ts';
export {
  transferLinks,
  rejectedTransferPairs,
  ledgerDedupKeys,
  TRANSFER_MATCH_KINDS,
  type TransferMatchKind,
  type TransferLinkRow,
  type NewTransferLinkRow,
  type RejectedTransferPairRow,
  type LedgerDedupKeyRow,
  type NewLedgerDedupKeyRow,
} from './transfers.ts';
export {
  accountOverrides,
  ACCOUNT_ROLES,
  MANAGEMENT_STYLES,
  TAX_TREATMENTS,
  VALUATION_BASES,
  type AccountRole,
  type ManagementStyle,
  type TaxTreatment,
  type ValuationBasis,
  type AccountOverrideRow,
  type NewAccountOverrideRow,
} from './account-overrides.ts';
