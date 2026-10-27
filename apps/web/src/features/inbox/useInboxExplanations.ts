// SPDX-License-Identifier: MIT
/**
 * WP 11.1: the one-line "why" for the uncategorised rows on screen — **one** batched
 * `GET /transactions/explanations` for every row's id, keyed by transaction id.
 *
 * The line is the server's, composed from the decision working stored when the decision was made
 * (`@ctx/categorization`'s `explain-line.ts`). This hook hands it over as received; nothing on this side composes,
 * rewrites or recomputes an explanation (the tiers arrive too, and are not read here).
 *
 * WP 11.2 moved the hook to `features/category-suggestions/suggestion-api.ts` (the transaction list reads the same
 * batch for the model's suggestion chip); the Inbox keeps its name.
 */
export {
  MAX_EXPLANATION_IDS,
  useCategoryExplanations as useInboxExplanations,
} from '../category-suggestions/suggestion-api.ts';
