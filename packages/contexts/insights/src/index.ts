// SPDX-License-Identifier: MIT
/**
 * `@ctx/insights` — Insights / Advisory.
 *
 * The `Advisor` contract and the insight feed. The only context that reads
 * broadly, and it does so through a single assembler (`SnapshotBuilder`) so
 * data minimisation has exactly one implementation point.
 *
 * This file is the context's *only* public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 *
 * ## What WP 2.6 ships: a platform, with no advisors in it
 *
 * There is no rule catalogue here. `createAdvisorRegistry([])` is a complete,
 * working registry that proposes nothing, and that is what the app runs until
 * WP 2.7's twenty built-ins arrive. What WP 2.6 provides is everything those
 * rules — and, in Phase 5, a local model, and in Phase 6 a third-party
 * sidecar — will be judged by:
 *
 *   * **The contract.** `AdvisorSnapshot`, `AdvisorRequest`, `AdvisorResponse`
 *     and `AdvisorManifest` as zod definitions, with the normative JSON Schema
 *     emitted from them into `@core/contracts`' `advisor/v1/` and byte-compared
 *     by `test/contract-parity.test.ts`. `ADVISOR_CONTRACT_VERSION` is `1.0.0`;
 *     the wire carries the integer `1`.
 *   * **`SnapshotBuilder` and the scope catalogue.** One assembler, iterating
 *     grants rather than sources, with the 08 §4.2 minimisation rules read off
 *     a declarative table.
 *   * **The seven-step validation pipeline.** Transport, schema, envelope,
 *     capability, evidence, derivations, numerals. Its output type is the only
 *     thing `store.ts` will write, so "nothing reaches the feed unvalidated" is
 *     a type error rather than a convention.
 *   * **`pending_review` persistence, the 30/90/permanent dismissal ladder, the
 *     alert budget, and kill switches 1–3.**
 *
 * ## The three claims this package exists to make true
 *
 * 1. **An advisor cannot act.** There is no `status` field on the wire, no
 *    acting member in `proposed_actions[].kind`, no write port, no database
 *    handle, and no return channel. `test/pending-review.test.ts` sabotages
 *    each.
 * 2. **An advisor cannot invent a number.** Every `source_ref` must resolve
 *    into the snapshot *we* sent, every numeral in every rendered field must be
 *    traceable to a snapshot value or to arithmetic we re-computed ourselves,
 *    and every evidence label must agree with what it cites.
 *    `test/no-fabricated-numbers.test.ts` and `test/evidence-resolution.test.ts`
 *    sabotage each.
 * 3. **An advisor sees only what it was granted.** An ungranted scope has no
 *    code path; `transactions.raw` is unreachable for an `external` advisor by
 *    a row in a table, not by an `if`. `test/snapshot-scopes.test.ts` asserts
 *    both.
 *
 * ## What WP 2.7 implements against
 *
 * `Advisor` (a manifest and one function), `AdvisorRegistry`, and the
 * `AdvisorSnapshot` shape. A built-in rule is a function from a snapshot to
 * `Insight[]`; it declares its scopes and its triggers in a manifest, and it is
 * judged by the same pipeline a Phase 6 sidecar will be. Nothing in this
 * package knows that built-ins exist.
 */

/** Stable identifier used by feature flags (`module.insights`) and event metadata. */
export const CONTEXT_ID = 'insights' as const;

// --- The contract ----------------------------------------------------------

export {
  ADVISOR_CONTRACT_MAJOR,
  ADVISOR_SCHEMA_BASE,
  SUPPORTED_CONTRACT_MAJORS,
} from './contract/version.ts';

export {
  ADVISOR_KINDS,
  ADVISOR_SCOPES,
  SCOPE_CATALOGUE,
  SCOPE_KEYS,
  isAdvisorScope,
  scopeDefinition,
  scopesPermittedForKind,
  type AdvisorKind,
  type AdvisorScope,
  type ScopeDefinition,
  type ScopeMinimisation,
} from './contract/scopes.ts';

export {
  ACCOUNT_TAX_TREATMENTS,
  AMOUNT_BUCKETS,
  AdvisorSnapshotSchema,
  BudgetsStatusSchema,
  CashSummarySchema,
  CashflowMonthlySchema,
  HoldingsAggregateSchema,
  HoldingsDetailSchema,
  LIABILITY_KINDS,
  LiabilitiesTermsSchema,
  MARKET_RATE_KINDS,
  MarketRatesSchema,
  MoneyJsonSchema,
  NetWorthSummarySchema,
  RecurringListSchema,
  TransactionsRawSchema,
  TransactionsSummarySchema,
  type AccountTaxTreatment,
  type AdvisorSnapshot,
  type AmountBucket,
  type LiabilityKind,
  type MarketRateKind,
  type MoneyJson,
} from './contract/snapshot.ts';

export {
  AdvisorKindSchema,
  AdvisorRequestSchema,
  AdvisorScopeSchema,
  DigestSchema,
  type AdvisorRequest,
} from './contract/request.ts';

export {
  AdvisorResponseSchema,
  CONFIDENCE_BASES,
  DerivationSchema,
  EvidenceSchema,
  HORIZONS,
  ImpactSchema,
  InsightSchema,
  PROPOSED_ACTION_KINDS,
  ProposedActionSchema,
  SEVERITIES,
  SourceRefSchema,
  severityRank,
  type AdvisorResponse,
  type ConfidenceBasis,
  type Derivation,
  type Evidence,
  type Impact,
  type Insight,
  type ProposedAction,
  type ProposedActionKind,
  type Severity,
} from './contract/response.ts';

export {
  AdvisorManifestSchema,
  PLATFORM_LIMITS,
  TriggerSchema,
  resolveLimits,
  type AdvisorManifest,
  type AdvisorTrigger,
  type ResolvedLimits,
} from './contract/manifest.ts';

export {
  ADVISOR_ARTEFACT_VERSION,
  advisorSchemaDocuments,
  serialiseSchema,
  type SchemaDocument,
} from './contract/json-schema.ts';

// --- The validator ---------------------------------------------------------

export {
  VALIDATION_STEPS,
  validateResponse,
  type InsightRejection,
  type ResolvedEvidenceRow,
  type ResponseRejection,
  type ValidatedInsight,
  type ValidationInput,
  type ValidationOutcome,
  type ValidationStep,
} from './validate/pipeline.ts';

export {
  displayValue,
  evidenceValueAgrees,
  isSnapshotRef,
  parsePath,
  resolveSourceRef,
  type RefFailure,
  type RefResolution,
} from './validate/evidence.ts';

export {
  DERIVATION_LITERALS,
  evaluateDerivation,
  numericValueOf,
  type DerivationFailure,
  type DerivationOutcome,
} from './validate/derivations.ts';

export {
  collectNumericCandidates,
  extractNumerals,
  isTraceable,
  maskLiterals,
  renderingsOf,
  stringLiteralsOf,
  stripUrls,
  traceContext,
  untraceableNumerals,
  type Numeral,
  type TraceContext,
} from './validate/numerals.ts';

export {
  MAX_SUMMARY_LENGTH,
  hasForbiddenCharacter,
  markdownViolations,
  renderableStrings,
  renderedText,
  type MarkdownViolation,
  type RenderableFields,
} from './validate/markdown.ts';

export {
  checkLink,
  externalUrlOf,
  hostMatches,
  type LinkRefusal,
  type LinkVerdict,
} from './validate/links.ts';

// --- The snapshot ----------------------------------------------------------

export {
  MARKET_RATE_FRESH_DAYS,
  SNAPSHOT_WINDOWS,
  SnapshotBuilder,
  bucketOf,
  monthOf,
  percentStringToRatio,
  roundToMultiple,
  type BuildSnapshotInput,
  type BuiltSnapshot,
} from './snapshot/builder.ts';

export {
  createTokeniser,
  deriveTokenKey,
  inputDigest,
  type TokenDomain,
  type Tokeniser,
} from './snapshot/tokens.ts';

/**
 * The read ports. `apps/api/src/domain.ts` implements them over `@ctx/ledger`,
 * `@ctx/budgeting`, `@ctx/recurring`, `@ctx/investments` and
 * `@ctx/integrations`; nothing in this package imports those contexts (the
 * boundary lint enforces it). None of the five has a write method, which is
 * what makes "an advisor proposes and never acts" structural at the data layer
 * as well as at the contract.
 */
export {
  CASH_ACCOUNT_TYPES,
  PERCENT_PER_ANNUM,
  emptyPorts,
  inMemoryBudgetPort,
  inMemoryFxPort,
  inMemoryInvestmentsPort,
  inMemoryLedgerPort,
  inMemoryMarketDataPort,
  inMemoryRecurringPort,
  type BudgetPort,
  type CashAccountType,
  type CategorySpendRow,
  type FakeLedgerData,
  type FxPort,
  type InsightsAccount,
  type InsightsAllocationTarget,
  type InsightsAssetClassSlice,
  type InsightsBudgetLine,
  type InsightsBudgetPeriod,
  type InsightsCryptoCustody,
  type InsightsHoldings,
  type InsightsHoldingsAggregate,
  type InsightsIdleCash,
  type InsightsLiabilities,
  type InsightsLiability,
  type InsightsLot,
  type InsightsMarketRateObservation,
  type InsightsMarketRates,
  type InsightsPosition,
  type InsightsPriceChange,
  type InsightsRecurringStream,
  type InsightsSecurityPosition,
  type InsightsTransaction,
  type InvestmentsPort,
  type LedgerPort,
  type MarketDataPort,
  type MerchantSpendRow,
  type MonthlyCashflowRow,
  type RecurringPort,
  type SnapshotPorts,
} from './snapshot/ports.ts';

// --- Policy ----------------------------------------------------------------

export {
  COOLDOWN_LADDER_DAYS,
  PERMANENT_AFTER_DISMISSALS,
  afterDismissal,
  afterSnooze,
  cooldownKey,
  isSuppressed,
  rungFor,
  type CooldownRung,
  type SuppressionState,
} from './policy/cooldown.ts';

export {
  ALERT_BUDGET,
  ONE_TIME_WEIGHT,
  applyAlertBudget,
  belowFloor,
  effectiveImpactMinor,
  rank,
  type BudgetedFeed,
  type RankableInsight,
} from './policy/alert-budget.ts';

export {
  BREAKER_THRESHOLDS,
  CONSECUTIVE_FAILURE_LIMIT,
  KIND_FLAG_KEYS,
  LADDER_LEVEL,
  MODULE_FLAG_KEY,
  REJECTION_QUARANTINE_FLOOR,
  REJECTION_QUARANTINE_RATE,
  createRunSwitches,
  decideContinue,
  decideRun,
  shouldQuarantine,
  staticRunSwitches,
  type BreakerInputs,
  type BreakerThresholds,
  type CancelReason,
  type FlagReader,
  type KillSwitchInputs,
  type QuarantineReason,
  type RunDecision,
  type RunRefusal,
  type RunSwitchSources,
  type RunSwitches,
} from './policy/kill-switches.ts';

// WP 5.1: the run watcher, the prompt port, and the payload preview gate.
export {
  RUN_WATCH_POLL_MS,
  RunCancelled,
  watchRun,
  type RunWatch,
  type RunWatchOptions,
} from './policy/run-watch.ts';

export type { PromptRenderer, RenderedPrompt } from './ports.ts';

export {
  PreviewError,
  approvePayload,
  buildAdvisorRequest,
  effectiveRunScopes,
  hasLiveApproval,
  inspectRunPayload,
  previewRequest,
  queryShape,
  requiresPayloadApproval,
  revokePayloadApprovals,
  shapeFor,
  type BuiltRequest,
  type PayloadPreview,
  type QueryShapeInput,
  type RetainedPayloadInspection,
} from './preview.ts';

// --- The registry ----------------------------------------------------------

export {
  AdvisorRegistry,
  checkManifest,
  createAdvisorRegistry,
  type Advisor,
  type RegisteredAdvisor,
  type RegistrationRefusal,
  type RegistrationVerdict,
} from './registry.ts';

// --- The built-in catalogue (WP 2.7) ---------------------------------------

/**
 * Fourteen deterministic rules over 07 §3.3, plus the reasons the other nine in
 * scope cannot be written from Phase 2 data. `createBuiltinRegistry()` is what
 * replaces `createAdvisorRegistry([])` at the composition root; `defaultEnabled`
 * on each entry is the wave decision (cash and subscriptions on, spending off)
 * and is read once, when the `advisors` row is first written.
 */
export {
  BUILTIN_CATALOGUE,
  CATALOGUE_GAPS,
  CATALOGUE_SCOPE,
  advisorFor,
  builtinAdvisors,
  builtinRules,
  createBuiltinRegistry,
  type BuiltinCatalogueEntry,
  type CatalogueGap,
  type RuleWave,
} from './advisors/catalogue.ts';

export { BUILTIN_RULE_VERSION, builtinManifest, type ManifestInput } from './advisors/manifest.ts';

export {
  IMPACT_CEILING_MAJOR,
  clampImpact,
  contextOf,
  type BuiltinRule,
  type ImpactVerdict,
  type RuleContext,
  type RuleOutput,
} from './advisors/support.ts';

export {
  ACTIONABILITY,
  DISMISS_PENALTY,
  URGENCY_MULTIPLIER,
  actionabilityOf,
  applyCatalogueBudget,
  rankBuiltin,
  rankableBuiltinOf,
  urgencyOf,
  type RankableBuiltin,
  type RankableFeedRow,
} from './advisors/ranking.ts';

export {
  BANNED_PHRASES,
  lintAdviceCopy,
  lintInsightCopy,
  type CopyField,
  type CopyRule,
  type CopyViolation,
} from './advisors/copy-lint.ts';

// --- Events, consumer, jobs ------------------------------------------------

export {
  AdvisorRunCancelled,
  AdvisorRunCompleted,
  AdvisorRunFailed,
  AdvisorRunStarted,
  INSIGHTS_EVENTS,
  InsightAccepted,
  InsightDismissed,
  InsightProposed,
  InsightReviewed,
} from './events.ts';

export {
  BASE_EVENT_TYPES,
  CONSUMER_NAME,
  advisorsForEvent,
  createInsightsConsumer,
  type InsightsConsumerOptions,
} from './consumer.ts';

export {
  DEFAULT_ADVISOR_CRON,
  RUN_ALL_JOB_KIND,
  RUN_JOB_KIND,
  RUN_LOCAL_JOB_KIND,
  SCHEDULE_NAME,
  createRunAllJob,
  createRunJob,
  createRunLocalJob,
  insightsJobs,
  jobKindFor,
  registerNightlySchedule,
  requestAdvisorRuns,
  type JobDependencies,
  type QueuedAdvisorRun,
  type RequestedAdvisorRun,
  type RunJobPayload,
} from './jobs.ts';

// --- Services and read models ----------------------------------------------

export {
  LaneViolation,
  laneOf,
  reviewInsight,
  runAdvisor,
  runAdvisors,
  type RunLane,
  type InsightsDependencies,
  type InsightsSettings,
  type RunAdvisorInput,
  type RunAdvisorResult,
  type ReviewResult,
} from './service.ts';

export {
  advisorHealth,
  insightFeed,
  listInsights,
  rankableOf,
  type ActionView,
  type AdvisorHealthView,
  type EvidenceView,
  type FeedInput,
  type InsightView,
} from './read.ts';

export {
  INSIGHTS_ADVISORY_LOCK_CLASS,
  RUN_PAYLOAD_RETENTION_DAYS,
  clearQuarantine,
  findAdvisor,
  findInsight,
  findRun,
  findRunPayload,
  grantScopes,
  latestRuns,
  listAdvisors,
  listGrants,
  loadSuppression,
  loadSuppressions,
  lockAdvisor,
  pruneRunPayloads,
  quarantineAdvisor,
  recordFeedback,
  recordRunModel,
  registerAdvisor,
  rejectionsSince,
  requestRunCancel,
  retainRunPayload,
  revokeScopes,
  setAdvisorEnabled,
  type CancelRequestOutcome,
  type FeedbackInput,
  type FeedbackResult,
  type RegisterAdvisorInput,
  type UpsertInsightInput,
  type UpsertInsightResult,
} from './store.ts';

export type { InsightsContext, InsightsDatabase, InsightsExecutor } from './db.ts';

// WP 5.9 — the dismiss-reason feedback loop, outcome verification, forward
// validation and rule health (05-phase-5-dispatch.md §3). Appended, not
// merged into the blocks above: this file is shared with WP 5.7, and each
// package's own labelled block is how two agents editing it at once never
// collide on the same lines.
export { rankFeed } from './read.ts';

export { afterAlreadyKnow, afterIntentional } from './policy/cooldown.ts';

export {
  NOT_TRUE_MIN_FIRINGS,
  NOT_TRUE_RATE_THRESHOLD,
  PRESET_REASON_CODES,
  decideFeedbackEffects,
  notTrueRate,
  reasonCodeForPreset,
  shouldQuarantineForNotTrue,
  type FeedbackFirings,
  type ReasonEffectInput,
  type ReasonEffectResult,
} from './policy/feedback.ts';

export {
  OUTCOME_HORIZON_DAYS_DEFAULT,
  evaluateDueOutcomes,
  horizonDueAt,
  isForwardProposal,
  recordOutcomeOnAccept,
  verdictFor,
  type OutcomeCounts,
} from './policy/outcomes.ts';

export { ruleHealth, type RuleHealthView, type WrongAmountFlag } from './policy/rule-health.ts';

// WP 5.7 — Anomaly and fee hunter (advisor contract 1.4.0, migration 0029).
// Appended rather than folded into the existing `contract/snapshot.ts` and
// `policy/alert-budget.ts` blocks above: this file is shared with WP 5.9 this
// wave, and each work package appends its own labelled block at the end
// rather than editing another's, so two agents in the same file never
// collide on the same lines.
export { TransactionsAnomaliesSchema, FeesSummarySchema } from './contract/snapshot.ts';
export { isP0Safety } from './policy/alert-budget.ts';

// WP 5.6 — the Weekly Advisory Brief (05-phase-5-dispatch.md §3, migration
// 0032_advisory_briefs.sql). Appended rather than folded into the blocks
// above: this file is shared with WP 5.3 this wave, and each package's own
// labelled block is how two agents editing it at once never collide on the
// same lines.
export {
  NO_DOLLAR_FIGURE_ANSWER,
  RETIREMENT_EFFECT_ASSUMPTION,
  type MonthsOfSpendingEffect,
  type RetirementActionInput,
  type RetirementAgeEffect,
  type RetirementEffect,
  type RetirementImpactAnswer,
  type RetirementImpactNotComputableReason,
  type RetirementImpactPort,
  type RetirementImpactRequest,
} from './brief/ports.ts';

export {
  BRIEF_JOB_KIND,
  DEFAULT_WEEKLY_BRIEF_CRON,
  WEEKLY_BRIEF_NARRATOR_ADVISOR_ID,
  WEEKLY_BRIEF_SCHEDULE_NAME,
  createBriefJob,
  registerWeeklyBriefSchedule,
  type BriefJobDependencies,
} from './brief/job.ts';

export { BriefPublished } from './events.ts';

// WP 5.3 — The narrator: grounded narration only (advisor contract 1.5.0,
// migration 0031). Appended as its own labelled block: this file is shared
// with WP 5.6 this wave, and each package appends rather than edits another's
// lines. `createNarratorAdvisor` is what the composition root registers (W-C,
// feature-detected on LOCAL_MODEL_ENDPOINT and LOCAL_MODEL_DIGEST), bound to
// WP 5.2's adapter; `narrationsFor` is the card's read for WP 5.10/5.11.
// `NARRATOR_ADVISOR_ID` is exported above by WP 5.6's block (`brief/job.ts`,
// the same `'local.narrator'`); `advisors/local/manifest.ts` holds this
// package's, and the two are one string until the orchestrator folds them.
export { NARRATOR_MANIFEST, NARRATOR_SCOPES, NARRATOR_VERSION } from './advisors/local/manifest.ts';
export {
  createNarratorAdvisor,
  type NarratorModelPort,
  type NarratorOptions,
} from './advisors/local/narrator.ts';
export { narrationsFor, type NarrationView } from './advisors/local/link.ts';
export { NARRATOR_REPLY_FORMAT } from './advisors/local/format.ts';
export {
  assembleFindings,
  launderFindings,
  redactDigitRuns,
  redactFreeText,
  type AssembledFindings,
  type LaunderingVerdict,
} from './advisors/local/findings.ts';
export {
  MAX_NARRATED_FINDINGS,
  NarratedFindingSchema,
  type NarratedFinding,
} from './contract/request.ts';
export {
  evalRequest,
  findingsFromSnapshot,
  judgeReply,
  planRequests,
  runNarratorEval,
  summarise,
  type EvalCase,
  type EvalReport,
  type EvalRequestSpec,
  type NarrationVerdict,
} from './advisors/local/eval.ts';
