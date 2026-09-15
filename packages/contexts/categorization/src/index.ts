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
  amountBucket,
  featuresOf,
  predict,
  train,
  type ClassifierModel,
  type ClassifierOutcome,
  type TrainingExample,
} from './classifier.ts';

// --- the decision function -------------------------------------------------
export {
  DEFAULT_CONFIDENCE_FLOOR,
  DEFAULT_MERCHANT_SUPPORT,
  decide,
  precedenceOf,
  shouldReplace,
  type AssignmentSource,
  type Decision,
  type DecisionContext,
  type DecisionInput,
  type MerchantDefault,
  type TierOutcome,
} from './engine.ts';

// --- the port this context reads the ledger through ------------------------
export {
  streamTransactions,
  type CategorizableTransaction,
  type CategorizableTransactionPage,
  type LedgerPort,
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
  transactionIdsOf,
} from './consumer.ts';

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
  createRuleFromTransaction,
  decisionInputOf,
  explainAssignment,
  loadClassifier,
  loadMerchantDefaults,
  loadRules,
  retrainClassifier,
  type ApplyRuleResult,
  type AssignmentExplanation,
  type CategorizationTrigger,
  type CategorizeOptions,
  type CategorizeResult,
  type ConfirmResult,
} from './service.ts';
