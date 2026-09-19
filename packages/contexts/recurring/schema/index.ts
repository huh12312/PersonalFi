// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/recurring`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database — here,
 * `0010_recurring.sql`, whose header is where the design is argued.
 *
 * Five tables, all user-scoped (decision D6), none of them carrying a foreign
 * key into another context's schema: `merchant_id` and `transaction_id` are
 * opaque UUIDs, which is what makes "recurring detection never creates a
 * merchant" (decision D25) a structural fact rather than a habit.
 */
export {
  SERIES_STATES,
  recurringOccurrences,
  recurringSeries,
  type NewRecurringOccurrenceRow,
  type NewRecurringSeriesRow,
  type RecurringOccurrenceRow,
  type RecurringSeriesRow,
  type SeriesState,
} from './series.ts';

export {
  CANDIDATE_STATES,
  OVERRIDE_SCOPES,
  recurringCandidates,
  type CandidateState,
  type NewRecurringCandidateRow,
  type OverrideScope,
  type RecurringCandidateRow,
} from './candidates.ts';

export {
  USAGE_DECLARATIONS,
  USAGE_SOURCES,
  priceChangeEvents,
  subscriptionMetadata,
  type NewPriceChangeEventRow,
  type NewSubscriptionMetadataRow,
  type PriceChangeEventRow,
  type SubscriptionMetadataRow,
  type UsageDeclaration,
  type UsageSource,
} from './metadata.ts';
