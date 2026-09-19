// SPDX-License-Identifier: MIT
/**
 * `recurring_series` and `recurring_occurrences` — migration `0010_recurring.sql`.
 *
 * See that file's header for the design: why `merchant_id` carries no foreign
 * key (decision D25 — this context has no write path to `merchants`), why
 * `state` and `status` are two different questions, and why `user_confirmed`
 * pins a row that detection may never overrule.
 *
 * This file is the *query surface*, not the DDL. Indexes, `CHECK` constraints
 * and the two natural keys live in the migration, which is the one ordered,
 * forward-only history of the database; declaring them twice is how the two
 * drift apart. The `unique()` markers below are the exception and are present
 * only because Drizzle's `onConflictDoUpdate` needs a target expression.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  dateColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { integer, jsonb, numeric, pgTable, smallint, text, unique, uuid } from 'drizzle-orm/pg-core';

/** Our relationship with the row. Not the stream's own lifecycle — see `status`. */
export const SERIES_STATES = ['CANDIDATE', 'ACTIVE', 'ARCHIVED'] as const;
export type SeriesState = (typeof SERIES_STATES)[number];

/**
 * A unit-interval score.
 *
 * `NUMERIC(7,6)` rather than a float: confidence, cadence score and coverage
 * are real numbers and would be perfectly well served by a `double precision`,
 * but `packages/db/test/migrate.test.ts` bans every float type across the whole
 * schema (a ledger has no legitimate use for one) and a score loses nothing by
 * being exact. Read back as a string, parsed at the edge — the same treatment
 * `@ctx/categorization` gives its `NUMERIC(5,4)` confidence.
 */
function scoreColumn(name: string) {
  return numeric(name, { precision: 7, scale: 6, mode: 'string' });
}

export const recurringSeries = pgTable(
  'recurring_series',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** The engine's content-derived key. Stable across re-runs; never shown. */
    streamKey: text('stream_key').notNull(),
    /** `@ctx/ledger`'s `merchants.id`, opaque and unreferenced (D25). */
    merchantId: uuid('merchant_id').notNull(),
    sign: text('sign').$type<'OUTFLOW' | 'INFLOW'>().notNull(),
    currency: currencyColumn().notNull(),
    accountIds: uuid('account_ids').array().notNull(),

    state: text('state').$type<SeriesState>().notNull(),
    /** 04 §5.1's pin. Detection never writes this `false`. */
    userConfirmed: flagColumn('user_confirmed').notNull(),
    confirmedAt: instantColumn('confirmed_at'),
    archivedAt: instantColumn('archived_at'),
    mergedIntoId: uuid('merged_into_id'),

    cadence: text('cadence').notNull(),
    cadenceScore: scoreColumn('cadence_score').notNull(),
    anchorDate: dateColumn('anchor_date').notNull(),
    dayOfMonthPair: smallint('day_of_month_pair').array(),

    amountModel: text('amount_model').$type<'FIXED' | 'VARIABLE' | 'IRREGULAR'>().notNull(),
    typicalAmountMinor: amountMinorColumn('typical_amount_minor').notNull(),
    typicalAmountCurrency: currencyColumn('typical_amount_currency').notNull(),
    amountMadMinor: amountMinorColumn('amount_mad_minor').notNull(),
    amountCv: numeric('amount_cv', { precision: 10, scale: 6, mode: 'string' }).notNull(),
    observedMinMinor: amountMinorColumn('observed_min_minor').notNull(),
    observedMaxMinor: amountMinorColumn('observed_max_minor').notNull(),

    type: text('type').notNull(),
    status: text('status').notNull(),
    confidence: scoreColumn('confidence').notNull(),
    eligibleForImpact: flagColumn('eligible_for_impact').notNull(),

    firstSeen: dateColumn('first_seen').notNull(),
    lastSeen: dateColumn('last_seen').notNull(),
    missedPeriods: integer('missed_periods').notNull(),
    coverage: scoreColumn('coverage').notNull(),

    nextDueDate: dateColumn('next_due_date'),
    nextDueUncertaintyDays: integer('next_due_uncertainty_days'),
    nextDueAmountMinor: amountMinorColumn('next_due_amount_minor'),

    duplicateNode: text('duplicate_node'),
    duplicatePeerKeys: text('duplicate_peer_keys').array(),
    duplicateAnnualImpactMinor: amountMinorColumn('duplicate_annual_impact_minor'),

    suppressions: jsonb('suppressions').notNull(),
    mergeProposal: jsonb('merge_proposal'),
    /** `[{ source, version, at, confidence }]`. Audit, not a single column. */
    sources: jsonb('sources').notNull(),
    detectionVersion: text('detection_version').notNull(),
    lastDetectedAt: instantColumn('last_detected_at'),

    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [unique('recurring_series_user_key_uniq').on(table.userId, table.streamKey)],
);

export type RecurringSeriesRow = typeof recurringSeries.$inferSelect;
export type NewRecurringSeriesRow = typeof recurringSeries.$inferInsert;

export const recurringOccurrences = pgTable(
  'recurring_occurrences',
  {
    id: idColumn(),
    userId: userIdColumn(),
    seriesId: uuid('series_id').notNull(),
    /** `@ctx/ledger`'s `transactions.id`, opaque and unreferenced. */
    transactionId: uuid('transaction_id').notNull(),
    accountId: uuid('account_id').notNull(),
    occurredOn: dateColumn('occurred_on').notNull(),
    amountMinor: amountMinorColumn('amount_minor').notNull(),
    amountCurrency: currencyColumn('amount_currency').notNull(),
    residualDays: integer('residual_days'),
    duplicateOf: uuid('duplicate_of'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // The engine's partition property, in the schema: every usable transaction
    // ends in exactly one stream.
    unique('recurring_occurrences_transaction_uniq').on(table.userId, table.transactionId),
  ],
);

export type RecurringOccurrenceRow = typeof recurringOccurrences.$inferSelect;
export type NewRecurringOccurrenceRow = typeof recurringOccurrences.$inferInsert;
