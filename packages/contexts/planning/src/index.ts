// SPDX-License-Identifier: MIT
/**
 * `@ctx/planning` — Planning.
 *
 * Goals, assumptions, scenarios, deterministic projection, and Monte Carlo are
 * Phase 4. What exists today is WP 3.8: **the sole writer of the
 * `net_worth_daily` read model**, which is why that table lives here even
 * though every one of its inputs comes from Ledger or Investments.
 *
 * This file is the context's *only* public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 *
 * ## What WP 3.8 ships
 *
 *   * `computeNetWorth(ports, …)` — one day, every account, **four independent
 *     totals** over 07 §4.1's four booleans, with a per-account breakdown
 *     carrying D4's native amount, base amount, `fxRate` and `fxRateDate`.
 *   * `runSnapshot(executor, ports, context)` — seal what has closed, recompute
 *     the one day that may still move, emit `planning.NetWorthSnapshotTaken`.
 *   * The four ports it reads its world through (`src/ports.ts`), declared here
 *     and adapted in `apps/api/src/domain.ts`. This context holds no handle on
 *     `accounts`, `holdings`, `prices` or `fx_rates`.
 *   * The 04:00 job `planning.net_worth_snapshot` and the consumer that marks
 *     today dirty when a balance, a holding or a price lands.
 *
 * ## Three rules travel with the surface, because every caller inherits them
 *
 *   * **A sealed day is never updated.** 08 §3.5. A correction is a new
 *     revision carrying `supersedes_id` and `correction_reason`; `correctDay`
 *     is the only path, and there is no unguarded update anywhere in `src/`.
 *   * **A missing FX rate is `FxRateUnavailable`, never 1.0.** D4 and 08 §6.6.
 *     It propagates out of `computeNetWorth` and the day is not written for
 *     that account — a plausible par conversion would be wrong by the whole
 *     spread and invisible.
 *   * **An investment account is never backfilled by transaction subtraction.**
 *     04 §5.4. `INTERPOLATION_POLICY` is the statement of the rule and
 *     `InterpolationRefused` is what enforces it.
 */

/** Stable identifier used by feature flags (`module.planning`) and event metadata. */
export const CONTEXT_ID = 'planning' as const;

// --- events ----------------------------------------------------------------
export { NetWorthSnapshotTaken, PLANNING_EVENTS } from './events.ts';

// --- assumptions: one file, versioned, cited (WP 4.2) ----------------------
export {
  AssumptionOverrideRefused,
  AssumptionsOverridden,
  AssumptionsYearUnavailable,
  CITED_KINDS,
  FILING_STATUSES,
  OVERRIDABLE_PATHS,
  UnknownAssumptionsVersion,
  applyOverrides,
  assumptionsOverriddenPayloadSchema,
  assumptionsVersion,
  canonicalDecimal,
  compareDecimal,
  currentRegistry,
  diffOverrides,
  guardrailReferenceRate,
  isAssumptionsRefusal,
  loadAssumptions,
  loadOverrides,
  parseAssumptions,
  resolveForUser,
  resolveOverrides,
  saveOverrides,
  taxYear,
  type AppliedOverride,
  type AssumptionDeltas,
  type Assumptions,
  type AssumptionsFile,
  type AssumptionsOverriddenPayload,
  type AssumptionsRegistry,
  type AssumptionsVersion,
  type CitedRate,
  type FilingStatus,
  type OverridablePath,
  type ResolvedAssumptions,
  type StoredOverrides,
  type UsTaxYear,
} from './assumptions.ts';

// --- parameter citations: a key per cited node (WP 11.5a) ------------------
export {
  PARAMETER_KEY_PATTERN,
  UnknownParameterKey,
  isParameterRefusal,
  parameterByKey,
  parameterCatalogue,
  type ParameterCitation,
  type ParameterValue,
} from './parameters.ts';

// --- the ports the composition root implements -----------------------------
export {
  ACCOUNT_KINDS,
  defaultFlagsFor,
  type AccountFlags,
  type AccountKind,
  type AccountSide,
  type BalanceObservation,
  type BalancesReader,
  type FxQuote,
  type FxReader,
  type HoldingObservation,
  type HoldingsReader,
  type PlanningAccount,
  type PriceQuote,
  type PriceReader,
  type SnapshotPorts,
} from './ports.ts';

// --- the aggregate ---------------------------------------------------------
export {
  computeNetWorth,
  summariseValuation,
  type BreakdownEntry,
  type ComputeInput,
  type NetWorthSnapshot,
  type UnvaluedAccount,
  type ValuationMethod,
} from './net-worth.ts';

// --- D4 on the aggregate ---------------------------------------------------
export {
  FxRateUnavailable,
  assertRateIsAnObservation,
  convertToBase,
  isFxRateUnavailable,
  type ConvertedAmount,
} from './fx.ts';

// --- 04 §5.4's interpolation policy ----------------------------------------
export {
  INTERPOLATION_METHODS,
  INTERPOLATION_POLICY,
  InterpolationRefused,
  backfillByTransactionSubtraction,
  interpolateQuantity,
  methodFor,
  type InterpolatedQuantity,
  type InterpolationMethod,
} from './interpolate.ts';

// --- 08 §3.5's seal --------------------------------------------------------
export {
  SEAL_HOUR_LOCAL,
  SealedRowImmutable,
  assertSealable,
  isSealable,
  localHourIn,
  openDateIn,
  sealableDates,
} from './seal.ts';

// --- persistence (this context's own table, and nobody else's) -------------
export {
  currentRow,
  markDirty,
  openDays,
  platformOf,
  readSeries,
  sealDay,
  upsertOpenDay,
  writeCorrection,
  type NetWorthRow,
  type PlanningDatabase,
  type PlanningExecutor,
} from './store.ts';

// --- the snapshotter -------------------------------------------------------
export { correctDay, runSnapshot, type SnapshotContext, type SnapshotResult } from './snapshot.ts';

// --- WP 10.13: net worth by account type, bucketed; milestones (0049) -------
export {
  dismissMilestones,
  listUndismissedMilestones,
  milestonesCrossed,
  recordMilestoneCrossings,
  type MilestoneCrossing,
  type MilestoneDirection,
  type RecordedMilestone,
} from './milestones.ts';
export { NetWorthMilestoneCrossed } from './events.ts';
export {
  NET_WORTH_BUCKETINGS,
  NET_WORTH_SEGMENT_KINDS,
  bucketSpine,
  bucketStartOf,
  readNetWorthBuckets,
  segmentKindOf,
  type NetWorthBucket,
  type NetWorthBucketing,
  type NetWorthSegment,
  type NetWorthSegmentKind,
  type SegmentAccountLookup,
} from './buckets.ts';

// --- wiring: the consumer, the job, the schedule ---------------------------
export {
  CONSUMED_EVENT_TYPES as NET_WORTH_CONSUMED_EVENT_TYPES,
  CONSUMER_NAME as NET_WORTH_CONSUMER_NAME,
  createNetWorthConsumer,
  type PlanningConsumerOptions,
} from './consumer.ts';
export {
  SNAPSHOT_CRON,
  SNAPSHOT_JOB_KIND,
  SNAPSHOT_SCHEDULE_NAME,
  netWorthSnapshotJobHandler,
  registerNetWorthSnapshotSchedule,
  type SnapshotJobDependencies,
} from './jobs.ts';

// --- WP 4.1: goals, contribution plans, risk profile, cash earmarks --------
export { GoalCreated, RiskProfileAnswered } from './events.ts';
export {
  PLANNING_ERROR_STATUS,
  PlanningError,
  isPlanningError,
  type PlanningErrorCode,
  type PlanningErrorFamily,
  type PlanningErrorStatus,
} from './errors.ts';
export {
  GOAL_NAME_MAX_LENGTH,
  MAX_FUNDING_ACCOUNTS,
  addContribution,
  assertFundingAccountsExist,
  assertTargetDateNotPast,
  createGoal,
  deleteGoal,
  getGoal,
  listContributions,
  listGoals,
  removeContribution,
  updateGoal,
  validateNewGoal,
  type FundingAccountsReader,
  type Goal,
  type GoalPatch,
  type GoalsContext,
  type NewGoalInput,
  type ValidGoal,
} from './goals.ts';
export {
  CADENCE_PERIODS_PER_YEAR,
  MAX_ESCALATION_PCT,
  amountOn,
  annualAmount,
  escalatedAmount,
  escalationFactor,
  parseEscalationPct,
  validateContributionPlan,
  wholeYearsBetween,
  type ContributionPlan,
  type ContributionPlanInput,
  type EscalationPct,
  type ValidContributionPlan,
} from './contributions.ts';
export {
  BAND_GROUPS,
  NO_EVIDENCE_CEILING,
  RISK_DISPOSITIONS,
  RISK_FRAMINGS,
  RISK_INSTRUMENT,
  RISK_INSTRUMENT_VERSION,
  TOLERANCE_BANDS,
  answerRiskProfile,
  buildRiskProfileRecord,
  currentRiskProfile,
  deriveTolerance,
  marginalBracketIndex,
  riskProfileAnswers,
  taxBracketBand,
  toleranceFor,
  type BracketSchedule,
  type DispositionScore,
  type RiskAnswers,
  type RiskDisposition,
  type RiskFraming,
  type RiskInstrumentVersion,
  type RiskItem,
  type RiskItemId,
  type RiskOption,
  type RiskPoints,
  type RiskProfileInput,
  type RiskProfileRecord,
  type StoredRiskProfile,
  type TaxBracketBand,
  type ToleranceDerivation,
} from './risk-profile.ts';
export {
  EARMARK_NAME_MAX_LENGTH,
  createEarmark,
  listEarmarks,
  liveEarmarksByAccount,
  releaseEarmark,
  type CashEarmark,
  type NewEarmarkInput,
} from './earmarks.ts';
export {
  CONTRIBUTION_CADENCES,
  CONTRIBUTION_SOURCES,
  GOAL_KINDS,
  GOAL_STATUSES,
  LIQUIDITY_NEEDS,
  RISK_TOLERANCES,
  type ContributionCadence,
  type ContributionSource,
  type GoalKind,
  type GoalStatus,
  type LiquidityNeed,
  type RiskTolerance,
} from '../schema/goals.ts';

// --- WP 4.3: revealed behaviour, rolling twelve months ----------------------
// The two ports the composition root binds (`CashflowReader` over @ctx/ledger,
// `SpendingReader` over @ctx/budgeting — 08 §1.6 draws no plan → budg arrow),
// the pure derivation, and the window arithmetic under it.
export {
  TAX_BUCKETS,
  defaultTaxBucketFor,
  defaultTaxBucketWithBasis,
  type AccountOverlayFacts,
  type CashflowAccount,
  type CashflowInflow,
  type CashflowReader,
  type RevealedPorts,
  type SpendingBudget,
  type SpendingClass,
  type SpendingLine,
  type SpendingPeriod,
  type SpendingPeriodSummary,
  type SpendingReader,
  type TaxBucket,
} from './ports.ts';
export {
  INCOME_BASIS,
  REVEALED_DEFAULTS,
  RevealedParametersInvalid,
  computeRevealedBehavior,
  deriveRevealedBehavior,
  derivedContributionPlan,
  gatherRevealedFacts,
  type DerivedAmount,
  type DerivedAmountValue,
  type DerivedRate,
  type DerivedRateValue,
  type ExclusionReason,
  type InsufficientHistory,
  type NotDerivable,
  type OneOffTestOutcome,
  type RevealedBehavior,
  type RevealedExclusion,
  type RevealedFacts,
  type RevealedInput,
  type RevealedParameters,
  type RevealedWindow,
  type SpendingCategorySummary,
} from './revealed.ts';
export { trailingWindow, type OneOffThresholds, type TrailingWindow } from './windows.ts';

// --- WP 4.4: the deterministic projection engine (pure; the number boundary
// lives in engine/boundary.ts and nowhere else) --------------------------------
export * from './engine/index.ts';
// WP 5.5: the earliest-retirement solver. `solveRetirementImpact` is the Money-facing entry
// point WP 5.6's `RetirementImpactPort` binds (W-C); `earliestRetirementAge` is the engine-unit
// one the dispatch names.
export {
  LATEST_SEARCHED_RETIREMENT_AGE,
  MONTHS_OF_SPENDING_DERIVATION,
  earliestRetirementAge,
  solveRetirementImpact,
  type MonthsOfSpending,
  type RetirementAction,
  type RetirementAgeAnswer,
  type RetirementImpact,
  type RetirementImpactAction,
  type RetirementImpactRun,
} from './engine/retirement-date.ts';

// --- WP 4.6: projection service, scenarios, life events, store (0022) -------
// `planning.projection_refresh` (04:30), `planning.goal_pace@v1`, the
// `MonteCarloRunner` port the composition root binds to WP 4.5's worker host,
// and `SnapshotJobDependencies.portsFor(executor, userId)`.
export { GoalOffTrack, ProjectionCompleted } from './events.ts';
export {
  type MonteCarloOutcome,
  type MonteCarloPeriod,
  type MonteCarloRequest,
  type MonteCarloRunner,
} from './ports.ts';
export {
  PROJECTION_REFRESH_CRON,
  PROJECTION_REFRESH_JOB_KIND,
  PROJECTION_REFRESH_SCHEDULE_NAME,
  projectionRefreshJobHandler,
  registerProjectionRefreshSchedule,
  type ProjectionRefreshJobDependencies,
} from './jobs.ts';
export {
  PROJECTION_REFUSAL_STATUS,
  ProjectionRefused,
  isProjectionRefused,
  type ProjectionRefusalCodeWp46,
  type ProjectionRefusalStatus,
  type StoredPercentile,
  type StoredRun,
} from './projection-store.ts';
export {
  DEFAULT_MONTE_CARLO_PATHS,
  GOAL_PACE_CONSUMED_EVENT_TYPES,
  GOAL_PACE_CONSUMER_NAME,
  INPUT_DOCUMENT_SCHEMA,
  MAX_STORED_PATHS,
  assembleBaselinePlan,
  assembleInput,
  cacheKeyOf,
  compareScenarios,
  createGoalPaceConsumer,
  createProjectionInputsReader,
  evaluateGoalPace,
  goalEvaluationStoreOf,
  inputDigestOf,
  readProjection,
  refreshBaseline,
  runGoalEvaluation,
  runProjection,
  type CacheKeyParts,
  type DerivedInputs,
  type GoalEvaluationStore,
  type GoalFacts,
  type GoalPaceVerdict,
  type ProjectionInputsReader,
  type ProjectionOutcome,
  type ProjectionRequest,
  type ProjectionServiceDependencies,
  type RefreshOutcome,
  type ScenarioComparison,
  type Staleness,
} from './projection-service.ts';
// --- WP 9.2: a changed account overlay makes a stored run read stale ---------
export { overlayFactsOf, resolveOverlayFor, withOverlay } from './account-overlay.ts';
export {
  diffOverrideFingerprints,
  fingerprintOf,
  storedFingerprintOf,
  type OverrideChange,
  type OverrideFieldName,
  type OverrideFingerprint,
  type OverrideFingerprintEntry,
} from './override-staleness.ts';
export {
  LEVER_KEYS,
  SCENARIO_NAME_MAX_LENGTH,
  createScenario,
  defaultSeedFor,
  deleteScenario,
  diffLevers,
  getBaseline,
  getScenario,
  listScenarios,
  profileFromJson,
  profileToJson,
  saveBaseline,
  updateScenarioLevers,
  type BaselineProfile,
  type BaselineScenario,
  type ForkScenario,
  type Scenario,
  type ScenarioLevers,
} from './scenarios.ts';
export {
  LIFE_EVENT_NAME_MAX_LENGTH,
  LIFE_EVENT_SIGN,
  createLifeEvent,
  deleteLifeEvent,
  lifeEventsForPlan,
  listLifeEvents,
  updateLifeEvent,
  validateLifeEvent,
  type LifeEvent,
  type NewLifeEventInput,
  type UnappliedReason,
} from './life-events.ts';
export {
  LIFE_EVENT_KINDS,
  PROJECTION_METHODS,
  SCENARIO_KINDS,
  type LifeEventKind,
  type ProjectionMethod,
  type ScenarioKind,
} from '../schema/projections.ts';
