// SPDX-License-Identifier: MIT
/**
 * `recurring_candidates` — migration `0010_recurring.sql`.
 *
 * The decision log, and the home of the permanent `merchant → NOT_RECURRING`
 * override a rejection writes. A candidate row is never deleted: the human's
 * answer is written onto it, and the detection pass reads the overrides
 * *before* it reads transactions, so a rejected merchant's rows never reach the
 * engine at all.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { jsonb, numeric, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';

export const CANDIDATE_STATES = ['PROPOSED', 'CONFIRMED', 'REJECTED', 'MERGED', 'EXPIRED'] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

/**
 * How far a rejection reaches.
 *
 * `MERCHANT` is what a rejection writes by default and is the dispatch plan's
 * `merchantKey → NOT_RECURRING`. `STREAM` exists because one merchant can host
 * two genuinely different streams — an annual plan ending and a monthly one
 * beginning is 07 §2.12's `ANNUAL_TO_MONTHLY` reality — and a user who rejects
 * one of them should not be silenced about the other forever.
 */
export const OVERRIDE_SCOPES = ['MERCHANT', 'STREAM'] as const;
export type OverrideScope = (typeof OVERRIDE_SCOPES)[number];

export const recurringCandidates = pgTable(
  'recurring_candidates',
  {
    id: idColumn(),
    userId: userIdColumn(),
    merchantId: uuid('merchant_id').notNull(),
    streamKey: text('stream_key').notNull(),
    seriesId: uuid('series_id'),
    state: text('state').$type<CandidateState>().notNull(),
    /** Set by a rejection and never cleared. */
    override: text('override').$type<'NOT_RECURRING'>(),
    overrideScope: text('override_scope').$type<OverrideScope>(),

    /** Frozen at proposal time: what the user was shown when they decided. */
    proposedCadence: text('proposed_cadence').notNull(),
    proposedType: text('proposed_type').notNull(),
    proposedConfidence: numeric('proposed_confidence', {
      precision: 7,
      scale: 6,
      mode: 'string',
    }).notNull(),
    proposedAmountMinor: amountMinorColumn('proposed_amount_minor').notNull(),
    proposedAmountCurrency: currencyColumn('proposed_amount_currency').notNull(),
    sources: jsonb('sources').notNull(),

    decidedAt: instantColumn('decided_at'),
    decidedReason: text('decided_reason'),
    mergedIntoSeriesId: uuid('merged_into_series_id'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [unique('recurring_candidates_user_key_uniq').on(table.userId, table.streamKey)],
);

export type RecurringCandidateRow = typeof recurringCandidates.$inferSelect;
export type NewRecurringCandidateRow = typeof recurringCandidates.$inferInsert;
