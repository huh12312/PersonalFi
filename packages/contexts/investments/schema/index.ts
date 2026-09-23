// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/investments`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database — here,
 * `0013_securities.sql`, whose header is where the design is argued.
 *
 * Eight tables so far, all user-scoped (decision D6), none of them carrying a
 * foreign key into another context's schema — `account_id` is an opaque UUID
 * throughout, which is what makes "the lot engine never creates an account"
 * structural rather than a habit. `0013_securities.sql` has the securities
 * master; `0014_lots.sql` has the five WP 3.2 tables. WP 3.4 adds the
 * market-data tables in 0015 and WP 3.6 `wallet_addresses` in 0016; both are
 * *claimed* in OWNERSHIP.md already, which is the point of claiming early.
 */
export {
  BASIS_SOURCES,
  holdings,
  holdingsSnapshots,
  type BasisSource,
  type HoldingRow,
  type HoldingSnapshotRow,
  type NewHoldingRow,
  type NewHoldingSnapshotRow,
} from './holdings.ts';

export {
  INVESTMENT_TRANSACTION_TYPES,
  TRANSACTION_SOURCES,
  investmentTransactions,
  type InvestmentTransactionRow,
  type InvestmentTransactionType,
  type NewInvestmentTransactionRow,
  type TransactionSource,
} from './investment-transactions.ts';

export {
  ACQUISITION_TYPES,
  BASIS_METHODS,
  basisMethodElections,
  costBasisLots,
  type AcquisitionType,
  type BasisMethod,
  type BasisMethodElectionRow,
  type CostBasisLotRow,
  type NewBasisMethodElectionRow,
  type NewCostBasisLotRow,
} from './lots.ts';

export {
  ASSET_CLASSES,
  CLASSIFICATION_SOURCES,
  IDENTIFIER_KINDS,
  IDENTITY_KINDS,
  OVERLAY_FIELDS,
  REGIONS,
  SECURITY_TYPES,
  securities,
  securityIdentifiers,
  securityOverlay,
  type AssetClass,
  type ClassificationSource,
  type IdentifierKind,
  type IdentityKind,
  type NewSecurityIdentifierRow,
  type NewSecurityOverlayRow,
  type NewSecurityRow,
  type OverlayField,
  type Region,
  type SecurityIdentifierRow,
  type SecurityOverlayRow,
  type SecurityRow,
  type SecurityType,
} from './securities.ts';

// WP 3.4, migration 0015_market_data.sql. `prices` and `fx_rates` live in this
// context rather than in `@ctx/integrations` because 08 §1.3 #7 gives
// Investments the `PriceReader`/`FxReader` ports over them; Integrations owns
// the *fetching* and `market_data_runs`, and hands rows here through an
// injected writer rather than reaching into these tables.
export {
  FX_ROW_SOURCES,
  PRICE_ROW_SOURCES,
  PRICE_SOURCES,
  fxRates,
  priceSourcePriority,
  prices,
  type FxRateRow,
  type FxRowSource,
  type NewFxRateRow,
  type NewPriceRow,
  type NewPriceSourcePriorityRow,
  type PriceRow,
  type PriceRowSource,
  type PriceSourceName,
  type PriceSourcePriorityRow,
} from './prices.ts';
