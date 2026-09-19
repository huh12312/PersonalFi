// SPDX-License-Identifier: MIT
/**
 * `@ctx/recurring` — Recurring.
 *
 * Subscription and bill detection as a *candidate* pipeline with human
 * confirmation. A false "you have a subscription" is a trust-destroying bug, so
 * nothing is acted on silently: the engine scores, types and explains, and a
 * human confirms.
 *
 * This file is the context's *only* public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 *
 * ## What WP 2.2 ships
 *
 * A pure engine. No database, no I/O, no wall-clock read outside the injected
 * `Clock`. `detectRecurring(inputs, options)` takes `RecurringInput[]` — which
 * carries a `merchantId` and **never a descriptor** (D25) — and returns
 * `DetectionResult`, whose `streams`, `priceChanges` and `duplicateServices` are
 * exactly the shapes WP 2.3 persists into `recurring_series`,
 * `recurring_occurrences`, `price_change_events` and the candidate queue.
 *
 * The engine mints no identifiers: `streamKey` is content-derived and stable, so
 * a re-run over the same history proposes the same streams and WP 2.3's upsert
 * has something to key on. Identity (uuidv7) is assigned when a series is
 * persisted, not when it is detected.
 *
 * ## What it deliberately does not do
 *
 * It does not normalise merchants, create them, or see their names; it does not
 * read the clock; it does not decide what the user is told. Free-trial
 * conversion (07 §2.7) needs a seeded standard-price table that does not exist
 * yet and is left to the catalogue work in WP 2.7.
 */

/**
 * ## What WP 2.3 adds
 *
 * Persistence, a lifecycle and a forecast, on top of the same pure engine:
 *
 *   * `runDetection` — one pass, one transaction, scoped to the payees a sync
 *     touched. Rejections are applied to its *input*, so a refused merchant's
 *     rows are never even read.
 *   * `confirmCandidate` / `rejectCandidate` / `mergeSeries` — the human half.
 *     A confirmation pins a series against every future pass; a rejection is
 *     permanent and writes a `merchantKey → NOT_RECURRING` override.
 *   * `upcomingCalendar` / `forwardCashFlow` / `safeToSpend` — the read models,
 *     every number of which carries a band rather than a false precision.
 *   * `createRecurringConsumer` — the reaction to `ledger.TransactionsUpserted`,
 *     `ledger.TransactionSupersededByPosted` and
 *     `categorization.AssignmentsChanged`, idempotent by construction.
 *
 * Detection still never creates a merchant, and now has a database to prove it
 * in: `test/db/no-merchant-creation.test.ts` runs a full pass and asserts the
 * `merchants` row count **and its ids** are untouched.
 */

/** Stable identifier used by feature flags (`module.recurring`) and event metadata. */
export const CONTEXT_ID = 'recurring' as const;

export { detectRecurring, type DetectionOptions } from './detect.ts';

export {
  CADENCES,
  TIE_BAND,
  WEEKEND_FORWARD_TOLERANCE_DAYS,
  inferCadence,
  periodDaysOf,
  periodsPerYear,
  specOf,
  uncertaintyDays,
  type CadenceFit,
  type CadenceInference,
  type CadenceSpec,
} from './cadence.ts';

export {
  AUTO_CONFIRM_CONFIDENCE,
  CANDIDATE_CONFIDENCE,
  EARLY_DETECTION_CAP,
  EARLY_DETECTION_MAX_OCCURRENCES,
  merchantPrior,
  scoreConfidence,
  type ConfidenceInputs,
  type ConfidenceOutcome,
} from './confidence.ts';

export { profileAmounts, type AmountProfile } from './amount.ts';
export { groupCoarse, signOf, type CoarseGroup } from './grouping.ts';
export { detectPriceChanges, type PriceChangeOptions } from './price-change.ts';
export { predictNextDue, type NextDueInputs } from './next-due.ts';
export {
  assessDormancy,
  graceDays,
  type DormancyInputs,
  type DormancyOutcome,
} from './dormancy.ts';
export { detectDuplicateServices } from './duplicate-service.ts';
export {
  DEFAULT_SUBSCRIPTION_MONTHLY_CEILING_MAJOR,
  FREQUENT_MERCHANT_MIN_OCCURRENCES,
  RECURRING_FLOOR,
  RECURRING_TYPES,
  SUBSCRIPTION_FLOOR,
  monthlyEquivalentMinor,
  typeStream,
  type TypingInputs,
  type TypingOutcome,
} from './typing.ts';

// --- WP 2.3: events, persistence, lifecycle, forecast ----------------------

export {
  CandidateProposed,
  DuplicateServiceDetected,
  PriceChangeDetected,
  RECURRING_EVENTS,
  SeriesConfirmed,
  SeriesLapsed,
} from './events.ts';

export {
  CONSUMED_EVENT_TYPES,
  CONSUMER_NAME,
  createRecurringConsumer,
  transactionIdsOf,
  type RecurringConsumerOptions,
} from './consumer.ts';

export {
  DEFAULT_HISTORY_DAYS,
  DETECTION_VERSION,
  confirmCandidate,
  confirmSeries,
  mergeSeries,
  rejectCandidate,
  rejectSeries,
  runDetection,
  setSeriesMetadata,
  type CandidateDecisionInput,
  type DetectionRunInput,
  type DetectionRunResult,
  type RecurringDependencies,
  type RejectionInput,
  type RejectionResult,
} from './service.ts';

export {
  DEFAULT_HORIZON_DAYS,
  forwardCashFlow,
  listCandidates,
  listOverrides,
  listSeries,
  projectCharges,
  projectSeries,
  safeToSpend,
  seriesCountsByState,
  upcomingCalendar,
  type CalendarDay,
  type CandidateQueueEntry,
  type CashFlowForecast,
  type ProjectedCharge,
  type ProjectionInput,
  type SafeToSpend,
  type SeriesListInput,
  type UpcomingCalendar,
} from './read.ts';

/**
 * The read port. `apps/api/src/domain.ts` implements it over `@ctx/ledger`;
 * nothing in this package imports that context (the boundary lint enforces it).
 * It has **no write method**, which is the mechanism behind D25 rather than an
 * omission — see `ledger-port.ts`'s header.
 */
export {
  collectForRecurring,
  inMemoryLedgerPort,
  type LedgerPort,
  type ListForRecurringInput,
  type RecurringTransaction,
  type RecurringTransactionPage,
} from './ledger-port.ts';

export {
  RECURRING_ADVISORY_LOCK_CLASS,
  type MetadataPatch,
  type RecurringContext,
  type RecurringDatabase,
  type RecurringExecutor,
  type SourceEntry,
} from './store.ts';

export type {
  AmountModel,
  Cadence,
  CadenceOrUnknown,
  DetectionDiagnostics,
  DetectionResult,
  DuplicateServiceFinding,
  MerchantClass,
  MerchantFacts,
  MergeProposal,
  NextDue,
  Occurrence,
  PriceChange,
  RecurringInput,
  RecurringStream,
  Sign,
  StreamStatus,
  StreamSuppression,
  StreamType,
} from './types.ts';
