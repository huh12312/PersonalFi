// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/categorization`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database — migration
 * `0006_categorization.sql` creates every table below, in this order.
 */
export {
  categories,
  mccCodes,
  providerCategoryMap,
  CATEGORY_KINDS,
  type CategoryKind,
  type CategoryRow,
  type NewCategoryRow,
  type McccCodeRow,
  type ProviderCategoryMapRow,
} from './categories.ts';
export {
  merchantProfiles,
  type MerchantProfileRow,
  type NewMerchantProfileRow,
} from './merchants.ts';
export {
  ruleRuns,
  rules,
  type NewRuleRow,
  type RuleRow,
  type RuleRunRow,
} from './rules.ts';
export {
  categoryAssignments,
  classifierExamples,
  classifierVersions,
  ASSIGNMENT_SOURCES,
  type AssignmentSourceValue,
  type CategoryAssignmentRow,
  type ClassifierExampleRow,
  type ClassifierVersionRow,
  type NewCategoryAssignmentRow,
} from './assignments.ts';
