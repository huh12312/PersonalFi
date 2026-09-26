// SPDX-License-Identifier: MIT
/**
 * `@ctx/investments` — Investments & Market Data.
 *
 * Securities, holdings, lots, prices, and FX. `SecurityResolver` is the hard
 * part: Coinbase says ETH, Plaid says ETHEREUM, a wallet says a contract
 * address, a brokerage says a CUSIP — one resolver, one securities table,
 * everything else references `security_id`.
 *
 * This file is the context's *only* public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 *
 * ## What WP 3.1 ships
 *
 * The securities master and the resolver over it, and nothing that holds a
 * quantity or a price:
 *
 *   * `createSecurityResolver({ store, clock, events, figi })` —
 *     `resolve(identifier | fact, { userId, provider })` and `resolveAll(…)`,
 *     which is the one that batches OpenFIGI. Tiers strongest-first, first
 *     answer wins, **every abstain named and returned**, a deterministic merge
 *     when two rows turn out to be one asset, and `SecurityResolutionFailed`
 *     rather than an anonymous row when nothing can identify a position.
 *   * `classify(security)` — 07 §4.3's waterfall, with
 *     `classification_source` on every answer and `UNCLASSIFIED` as a positive
 *     statement rather than an absence.
 *   * `effectiveClassificationOf(derived, overlay)` — 04 §2.2's immutable-facts
 *     + mutable-overlay resolution, which is what makes a user's asset-class
 *     override survive a provider re-sync.
 *   * The `FigiMapper` port and a fake. The HTTP adapter is WP 3.4's, behind
 *     WP 2.4's egress allow-list, reused rather than reimplemented.
 *
 * ## What it deliberately does not do
 *
 * It holds no quantity, no price and no lot: `holdings`, `investment_transactions`
 * and `cost_basis_lots` are WP 3.2 (migration 0014), and `prices`/`fx_rates`
 * are WP 3.4 (0015). It reads no account — the resolver never learns which
 * account a position sits in, because the answer to "which security is this?"
 * cannot depend on that and a parameter nobody needs is a coupling waiting to
 * happen.
 */

/** Stable identifier used by feature flags (`module.investments`) and event metadata. */
export const CONTEXT_ID = 'investments' as const;

export {
  AllocationTargetsChanged,
  HoldingsUpdated,
  INVESTMENTS_EVENTS,
  LotsUpdated,
  PossibleWashSaleFlagged,
  RealizedGainRecorded,
  SecurityResolutionFailed,
} from './events.ts';

// ---------------------------------------------------------------------------
// WP 3.2 — holdings, lots, cost basis, corporate actions
// ---------------------------------------------------------------------------
//
// The engine is pure over `Quantity` (decimal strings) and `Money` (bigint
// minor units) and there is no `number` in any signature it exports. Three
// rules are worth naming at the surface because every consumer has to honour
// them:
//
//   * an unknown basis is `null`, and `unrealizedGainOf` answers
//     `{ status: 'unavailable' }` rather than a gain from zero (04 §5.5);
//   * a possible wash sale is labelled `POSSIBLE_WASH_SALE` and never
//     `WASH_SALE`, and the digital-asset exclusion is a dated config value
//     (`DEFAULT_WASH_SALE_CONFIG`) rather than a branch (07 §4.4);
//   * a self-transfer carries its lots and realises nothing (07 §6.2).

export {
  AVERAGE_COST_ELIGIBLE_TYPES,
  ACQUISITION_TYPES,
  BASIS_METHODS,
  BASIS_SOURCES,
  DEFAULT_BASIS_METHOD,
  LONG_TERM_HOLDING_DAYS,
  LOT_WARNING_CODES,
  LotError,
  UNKNOWN_BASIS_WARNING,
  carryLotsOnTransfer,
  isOpen,
  matchDisposal,
  openLot,
  orderLotsFor,
  quantityWeight,
  realizedGainOf,
  remainingBasisOf,
  remainingBasisPerUnit,
  termOf,
  type AcquisitionType,
  type BasisMethod,
  type BasisSource,
  type DisposalRequest,
  type DisposalResult,
  type Lot,
  type LotMatch,
  type LotWarning,
  type LotWarningCode,
  type OpenLotInput,
  type OpenLotResult,
  type OrderLotsOptions,
  type RealizedAmount,
  type RealizedGain,
  type Term,
} from './lots.ts';

export {
  PRICE_UNKNOWN_WARNING,
  UNAVAILABLE_REASONS,
  costBasisOf,
  lotsWithoutBasis,
  marketValueOf,
  unrealizedGainOf,
  type LotPrice,
  type UnavailableReason,
  type UnrealizedGain,
  type UnrealizedOptions,
  type Valuation,
} from './basis.ts';

// WP 3.14 close-out — the v0.5 rung's "holdings reconcile to balances" clause
// (docs/evidence/phase-3/wp3.14-quality.md §1, §8 item 5): compares the
// stored `institutionValue` against a computed `quantity × price`, reusing
// `basis.ts`'s `marketValueOf` arithmetic rather than adding a second one.
export {
  DEFAULT_RECONCILE_TOLERANCE_MINOR,
  HOLDING_RECONCILIATION_STATUSES,
  reconcileHolding,
  reconcileHoldings,
  type HoldingReconciliation,
  type HoldingReconciliationStatus,
} from './reconcile.ts';

export {
  DEFAULT_WASH_SALE_CONFIG,
  POSSIBLE_WASH_SALE,
  WASH_SALE_WINDOW_DAYS,
  WASH_SALE_WINDOW_SPAN_DAYS,
  applyWashSaleToLot,
  applyWashSales,
  isInsideWashSaleWindow,
  scanForPossibleWashSales,
  type AcquisitionForScan,
  type DisposalForScan,
  type PossibleWashSale,
  type ScanInput,
  type WashSaleConfig,
  type WashSaleLabel,
} from './wash-sale.ts';

export {
  applySplit,
  isReverseSplit,
  scaleQuantity,
  splitRatio,
  totalBasisOf,
  type SplitInput,
  type SplitRatio,
  type SplitResult,
} from './corporate-actions.ts';

export {
  LOT_EFFECTS,
  absoluteQuantity,
  acquisitionTypeOf,
  basisForAcquisition,
  basisSourceFor,
  holdingOf,
  investmentTransactionOf,
  lotEffectOf,
  normaliseTransactionType,
  warningForEstimatedBasis,
  type Holding,
  type InvestmentTransaction,
  type LotEffect,
  type MapTransactionOptions,
} from './holdings.ts';

export {
  LotConstraintError,
  assertLotIsWellFormed,
  drizzleLotStore,
  inMemoryLotStore,
  lotFromRow,
  type ElectionInput,
  type InMemoryLotStore,
  type LotStore,
  type UpsertHoldingOptions,
  type UpsertResult,
} from './lots-store.ts';

export {
  CONSUMED_EVENT_TYPES as LOTS_CONSUMED_EVENT_TYPES,
  CONSUMER_NAME as LOTS_CONSUMER_NAME,
  SELF_TRANSFER_WINDOW_DAYS,
  createLotConsumer,
  runLotSync,
  type InvestmentSyncPort,
  type LotConsumerOptions,
  type LotSyncDependencies,
  type LotSyncInput,
  type LotSyncResult,
  type ResolvedHoldingFact,
  type ResolvedTransactionFact,
} from './consumer.ts';

export {
  ABSTAIN_REASONS,
  IDENTIFIER_KINDS,
  IDENTITY_KINDS,
  NATIVE_ASSETS,
  RESOLUTION_TIERS,
  confidenceOf,
  cusipIsWellFormed,
  figiIsWellFormed,
  identifierKeyOf,
  identifierOf,
  identityRankOf,
  isIdentityBearing,
  isinIsWellFormed,
  micIsWellFormed,
  nativeAssetForContract,
  nativeAssetForSymbol,
  normaliseChain,
  normaliseIdentifiers,
  strongestIdentity,
  tierRankOf,
  type AbstainReason,
  type IdentifierKind,
  type IdentityKind,
  type NativeAsset,
  type NormaliseResult,
  type NormalisedIdentifier,
  type SecurityIdentifier,
  type TierAbstention,
} from './identifiers.ts';

export {
  MAX_LOOK_THROUGH_DEPTH,
  WEIGHT_RESIDUAL_FLAG_THRESHOLD_MICROS,
  classify,
  effectiveClassificationOf,
  loadSeedTable,
  seedTableOf,
  type ClassifiableSecurity,
  type Classification,
  type ClassificationOverride,
  type ClassifyOptions,
  type DerivedClassification,
  type EffectiveClassification,
  type ExternalLookups,
  type SeedFund,
  type SeedTable,
  type StoredOverlay,
} from './classify.ts';

export {
  FIGI_ID_TYPES,
  OPENFIGI_ANONYMOUS_MAX_JOBS_PER_REQUEST,
  OPENFIGI_MAX_JOBS_PER_MINUTE,
  OPENFIGI_MAX_JOBS_PER_REQUEST,
  createFakeFigiMapper,
  figiBatchesOf,
  figiJobOf,
  figiMappingOf,
  figiTableKeyOf,
  firstUnambiguousFigi,
  type FakeFigiMapper,
  type FakeFigiMapperOptions,
  type FigiIdType,
  type FigiMapJob,
  type FigiMapOutcome,
  type FigiMapper,
  type FigiMapping,
} from './figi.ts';

export {
  SecurityConstraintError,
  countSecurities,
  drizzleSecurityStore,
  inMemorySecurityStore,
  outboxOf,
  type IdentifierMatch,
  type IdentifierRow,
  type InMemorySecurityStore,
  type InvestmentsDatabase,
  type InvestmentsExecutor,
  type NewSecurity,
  type OverlayRecord,
  type SecurityPatch,
  type SecurityRecord,
  type SecurityStore,
} from './store.ts';

export {
  collectingEventSink,
  createSecurityResolver,
  securityTypeOf,
  type ResolvableInput,
  type ResolvableSecurity,
  type ResolveContext,
  type ResolvedSecurity,
  type Resolution,
  type ResolverEventSink,
  type SecurityResolver,
  type SecurityResolverOptions,
  type UnresolvedSecurity,
} from './resolver.ts';

// ---------------------------------------------------------------------------
// WP 3.4 — prices and FX (migration 0015)
// ---------------------------------------------------------------------------
//
// The two readers 08 §1.3 #7 names, and the rules that make their answers
// trustworthy. `@ctx/integrations` fetches the numbers; these tables and these
// readers are this context's, and rows cross that seam through an injected
// writer rather than through a table handle.
//
// The two rules worth knowing before calling either:
//
//   * `FxReader.rate` **throws** `FxRateUnavailable` rather than returning a
//     rate it does not have. D4 and 08 §6.6: a silent 1.0 is plausible,
//     invisible and wrong by the whole spread. The only 1.0 in the system is
//     the identity, answered structurally without reading a row.
//   * `PriceReader.price` computes 07 §6.1's staleness against the clock at
//     *read* time rather than trusting a stored boolean, and returns
//     `includeInAsOfNowDeltas: false` for a price older than 24 hours.

export {
  FxRateUnavailable,
  createFxReader,
  drizzleFxStore,
  inMemoryFxStore,
  invert,
  isFxRateUnavailable,
  type FxRate,
  type FxRateRecord,
  type FxReader,
  type FxReaderOptions,
  type FxStore,
} from './fx.ts';

export {
  DEFAULT_LADDERS,
  PRICE_STALE_AFTER_MS,
  createPriceReader,
  drizzlePriceStore,
  inMemoryPriceStore,
  ladderRows,
  priceStalenessOf,
  recordUserPriceOverride,
  type PricePoint,
  type PriceReader,
  type PriceReaderOptions,
  type PriceRecord,
  type PriceStaleness,
  type PriceStore,
  type UserPriceOverride,
} from './prices.ts';

// ---------------------------------------------------------------------------
// WP 4.7 — the Phase 3 gap-field sources: stored allocation targets, security
// tags, and idle-cash dwell (migration 0026). See each file's own header for
// the ownership argument: 08 §1.6's arrows point down, so this context stores
// what its own analytics and routes need and never reads @ctx/planning.
// ---------------------------------------------------------------------------

export {
  AllocationTargetsError,
  TARGET_SUM_TOLERANCE,
  assertTargetsSumToOne,
  drizzleAllocationTargetsStore,
  inMemoryAllocationTargetsStore,
  type StoredAllocationTarget,
  type AllocationTargetInput,
  type AllocationTargetsStore,
} from './targets.ts';

export {
  drizzleSecurityTagsStore,
  inMemorySecurityTagsStore,
  type SecurityTag,
  type SecurityTagsStore,
} from './tags.ts';

export {
  cashPositionFor,
  cashSnapshotHistory,
  idleDaysOf,
  type CashSnapshot,
  type DwellCashInput,
} from './dwell.ts';

// ---------------------------------------------------------------------------
// WP 3.3 — portfolio analytics (pure; no tables, no I/O, no clock)
// ---------------------------------------------------------------------------
//
// TWR by sub-period linking with Modified Dietz as the flagged `approximate`
// fallback; MWR by XIRR with Newton plus bisection and a typed `n/a`;
// allocation, drift, fee drag, concentration and idle cash. Four rules travel
// with the surface, because every consumer inherits them:
//
//   * a TWR, an MWR and a dollar gain are **three different shapes**, so no
//     response object can pair a return with a dollar amount or benchmark a
//     money-weighted return (07 §4.2, enforced by `tsc`);
//   * **nothing annualises a period under one year** — `annualized` is `null`
//     with `annualizationWithheld` saying why;
//   * **`unclassifiedPct` is returned beside every** allocation, drift, fee and
//     concentration number, present even when zero (07 §4.3, normative);
//   * **`unavailable` and `STALE` propagate**: a missing basis makes a gain
//     unavailable rather than zero, and a price older than 24 hours leaves an
//     "as of now" allocation named in `excluded` rather than counted stale.
//
// Ratios are decimal strings at a stated scale (`Ratio`, `Points`), never
// `number`; money stays `Money`. See `src/analytics/types.ts` for the decision
// and `docs/evidence/phase-3/wp3.3-analytics.md` for the worked numbers.

export * from './analytics/index.ts';
