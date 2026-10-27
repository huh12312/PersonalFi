// SPDX-License-Identifier: MIT
/**
 * `@ctx/categorization` — Categorization & Rules.
 *
 * Decides what a transaction *is*. The ledger stores facts; this context turns
 * them into a category, records which of six ordered tiers decided and how sure
 * it was, and keeps enough of the working to answer "why?" months later.
 *
 * This file is the context's **only** public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 *
 * ```text
 *  ledger.TransactionsUpserted ─▶ consumer ─▶ decide() ─┬─▶ category_assignments
 *                                    │                  └─▶ categorization.AssignmentsChanged
 *                                    └─ reads rows through LedgerPort (never an import)
 *
 *  user confirms  ─▶ confirmAssignment ─┬─▶ classifier_examples  (the model learns)
 *                                       └─▶ merchant_profiles    (the merchant learns)
 *  user writes a rule ─▶ applyRule({preview}) ─▶ "this would change 912 transactions"
 * ```
 *
 * ## The decision order
 *
 * ```
 *   1 user             the user's own edit, in @ctx/ledger's overlay — absolute
 *   2 rule             a user rule, by ascending priority
 *   3 merchant_default locked by the user, or learned from >= 3 confirmations
 *   4 provider         Plaid PFC v2, through a mapping table we control
 *   5 classifier       naive Bayes over this user's confirmations; abstains when unsure
 *   6 none             uncategorised, said out loud
 * ```
 *
 * Every tier records what it did whether it won or lost, which is what
 * `explainAssignment` returns.
 */

/** Stable identifier used by feature flags (`module.categorization`) and event metadata. */
export const CONTEXT_ID = 'categorization' as const;

// --- the taxonomy ----------------------------------------------------------
export {
  FLAT_TAXONOMY,
  TAXONOMY,
  UNCATEGORISED_KEY,
  isAssignableKey,
  isTaxonomyKey,
  kindOf,
  taxonomyEntry,
  type CategoryKind,
  type FlatCategory,
  type TaxonomyLeaf,
  type TaxonomyNode,
} from './taxonomy.ts';
export {
  PFC_DETAILED_COUNT,
  PFC_DETAILED_TO_KEY,
  PFC_PRIMARY_COUNT,
  PFC_PRIMARY_TO_KEY,
  matchProviderCategory,
  readProviderCategory,
  type ProviderCategoryHint,
  type ProviderMatch,
} from './pfc-map.ts';
export {
  MCC_CODES,
  MCC_CODE_COUNT,
  lookupMcc,
  mccCategoryKeys,
  mccTableIsWellFormed,
  type MccCode,
} from './mcc-codes.ts';

// --- merchant normalisation ------------------------------------------------
export {
  MAX_EDIT_DISTANCE,
  MIN_FUZZY_LENGTH,
  boundedLevenshtein,
  chooseCanonicalName,
  cleanDescriptor,
  clusterDescriptors,
  editBudget,
  fingerprint,
  fold,
  foldUpper,
  ngramFingerprint,
  normaliseDescriptor,
  similarity,
  titleCase,
  type CleanedDescriptor,
  type DescriptorObservation,
  type MerchantCluster,
  type NormalisedDescriptor,
} from './normalize/index.ts';

// --- the rule language -----------------------------------------------------
export {
  IMPLEMENTED_ACTIONS,
  actionSchema,
  actionsSchema,
  conditionSchema,
  conditionsSchema,
  ruleSchema,
  type Rule,
  type RuleAction,
  type RuleCondition,
  type RuleConditions,
} from './rules/schema.ts';
export {
  evaluateCondition,
  matchRule,
  orderRules,
  type ConditionOutcome,
  type MatchSubject,
  type RuleMatch,
} from './rules/match.ts';

// --- the classifier --------------------------------------------------------
export {
  COLD_MODEL,
  MIN_EXAMPLES_PER_CATEGORY,
  MIN_MARGIN,
  CONTEXT_ONLY_CEILING,
  PAYEE_MARGIN_SCALE,
  amountBucket,
  confidenceFromMargin,
  dayOfMonthBucket,
  featuresOf,
  predict,
  train,
  type AbstainCode,
  type ClassifierModel,
  type ClassifierOutcome,
  type TrainingExample,
} from './classifier.ts';

// --- the decision function -------------------------------------------------
export {
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_MERCHANT_SUPPORT,
  classifierFeaturesOf,
  decide,
  precedenceOf,
  shouldReplace,
  type AssignmentSource,
  type Decision,
  type DecisionContext,
  type DecisionInput,
  type MerchantDefault,
  type TierFacts,
  type TierOutcome,
} from './engine.ts';

// --- the gold-set replay (WP 11.1) ------------------------------------------
export {
  EVAL_SCHEMA,
  GRADED_TIERS,
  formatReplayReport,
  replayGoldSet,
  withoutExamples,
  type ConfusionPair,
  type GoldExample,
  type GradedTier,
  type Holdout,
  type IsolatedTierFigures,
  type OverallFigures,
  type ReplayOptions,
  type ReplayReport,
  type WaterfallTierFigures,
} from './eval/replay.ts';
export { loadGoldSet, type LoadedGoldSet } from './eval/load.ts';

// --- the Inbox's one-line "why", read from the stored working (WP 11.1) -----
export {
  MAX_EXPLAIN_BATCH,
  explainTransactions,
  type StoredSuggestion,
  type StoredTierView,
  type TransactionExplanation,
} from './explain.ts';
export { explanationLineOf, percentText } from './explain-line.ts';

// --- "make this a rule?" — the facts behind the suggestion (WP 11.1) --------
export {
  MAX_CANDIDATE_TRANSACTIONS,
  MAX_RULE_CANDIDATES,
  MIN_REPORTED_CONFIRMATIONS,
  listRuleCandidates,
  type RuleCandidate,
} from './rule-candidates.ts';

// --- WP 11.2: the holder's pick teaches tiers 3 and 5 ------------------------
export {
  CATEGORY_CHOSEN_EVENT,
  backfillLearningFromPicks,
  learnFromPick,
  type BackfillLearningResult,
  type LearnOutcome,
} from './learn.ts';

// --- WP 11.2: model suggestions for the residue (this context's half) -------
export {
  DEFAULT_SUGGESTION_SETTINGS,
  SUGGESTION_BATCH_MAX,
  SUGGESTION_GATE,
  SUGGESTION_REASON_MAX,
  SUGGEST_JOB_KIND,
  SUGGEST_MEASURE_JOB_KIND,
  applyCachedSuggestions,
  emptyFigures,
  gateOf,
  latestSuggestionEval,
  listResidueForSuggestion,
  measurementResidue,
  merchantKeyOf,
  readSuggestionSettings,
  recordSuggestionEval,
  recordSuggestions,
  rejectSuggestion,
  residueFeaturesOf,
  scoreMeasurement,
  suggestionTaxonomy,
  writeSuggestionSettings,
  type CachedAnswer,
  type GateVerdict,
  type MeasuredAnswer,
  type MeasurementFigures,
  type MeasurementResidue,
  type MerchantAnswer,
  type RecordSuggestionsResult,
  type RejectOutcome,
  type ResidueFeatures,
  type ResidueForSuggestion,
  type ResidueMerchant,
  type SuggestionCategory,
  type SuggestionEval,
  type SuggestionSettings,
  type SuggestionTaxonomy,
} from './suggestions.ts';
export {
  SUGGESTION_MODEL_CHOICES,
  type SuggestionModelChoice,
  type SuggestionVerdict,
} from '../schema/index.ts';

// --- WP 11.2b: tiers 3-5 made effective, through the ledger's projection -----
export {
  AUTO_SOURCES,
  PROJECTING_SOURCES,
  autoChangeOf,
  isAutoTier,
  reprojectAutoCategories,
  type AssignmentRowForProjection,
  type AutoSource,
  type ReprojectResult,
} from './auto-projection.ts';

// --- the port this context reads the ledger through ------------------------
export {
  streamTransactions,
  type CategorizableTransaction,
  type AutoCategoryChangeInput,
  type CategorizableTransactionPage,
  type LedgerPort,
  type WriteAutoCategoriesInput,
  type ListForCategorizationInput,
  type WriteRuleCategoryInput,
} from './ledger-port.ts';

// --- errors ----------------------------------------------------------------
export {
  CategorizationError,
  isCategorizationError,
  type CategorizationErrorCode,
} from './errors.ts';

// --- the executor shapes a caller needs ------------------------------------
export {
  confidenceText,
  type CategorizationContext,
  type CategorizationDatabase,
  type CategorizationExecutor,
} from './db.ts';

// --- events ----------------------------------------------------------------
export {
  CATEGORIZATION_EVENTS,
  AssignmentsChanged,
  MerchantDefaultLearned,
  RuleApplied,
} from './events.ts';

// --- the consumer ----------------------------------------------------------
export {
  CONSUMED_EVENT_TYPES,
  CONSUMER_NAME,
  createCategorizationConsumer,
  type ResidueRecorded,
  transactionIdsOf,
} from './consumer.ts';

// --- the retrain schedule (WP 2.5) ------------------------------------------
export {
  PROJECT_AUTO_JOB_KIND,
  enqueueProjectAuto,
  projectAutoJobHandler,
  RETRAIN_CRON,
  RETRAIN_JOB_KIND,
  RETRAIN_SCHEDULE_NAME,
  registerRetrainSchedule,
  retrainJobHandler,
} from './schedule.ts';

// --- the chart of categories, as a user has it -----------------------------
// The read model behind `GET /categories` and the boot pass that makes sure
// there is something to read (gate conditions D-6 / N-3). `listCategories`
// reads the *table*, never `TAXONOMY`: the constant is what we ship, the table
// is what the user has, and after a rename or a custom category they differ.
export {
  archiveCategory,
  createCategory,
  ensureTaxonomy,
  isCategoryVariability,
  listCategories,
  renameCategory,
  type ArchiveCategoryResult,
  type CreateCategoryInput,
  type EnsureTaxonomyInput,
  type EnsureTaxonomyResult,
  type ListCategoriesOptions,
  type RenameCategoryInput,
  type UserCategory,
} from './categories.ts';
export { CATEGORY_VARIABILITIES, type CategoryVariability } from '../schema/index.ts';

// --- seeding and service ---------------------------------------------------
export {
  categoryIdsByKey,
  categoryKeysById,
  seedSystemTaxonomy,
  type SeedTaxonomyResult,
} from './seed-taxonomy.ts';
export {
  applyRule,
  categorizeTransactions,
  confirmAssignment,
  createRule,
  createRuleFromTransaction,
  decisionInputOf,
  deleteRule,
  explainAssignment,
  listRuleRecords,
  loadClassifier,
  loadMerchantDefaults,
  loadRules,
  retrainClassifier,
  updateRule,
  type ApplyRuleResult,
  type AssignmentExplanation,
  type CategorizationTrigger,
  type CategorizeOptions,
  type CategorizeResult,
  type ConfirmResult,
  type RuleRecord,
  type RuleWriteInput,
} from './service.ts';
