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

export { INVESTMENTS_EVENTS, SecurityResolutionFailed } from './events.ts';

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
