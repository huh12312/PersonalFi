// SPDX-License-Identifier: MIT
/**
 * WP 11.2 (migration 0055): the model's category suggestions for the residue.
 *
 * Three tables, all this context's, and none of them an assignment:
 *
 *   * `category_suggestion_cache` — one model answer per (merchant, taxonomy
 *     version), so a merchant is asked about once; the holder's "Not this" is
 *     `rejected_at` on the same row (the negative example);
 *   * `category_suggestion_evals` — the precision gate's measurements;
 *   * `category_suggestion_settings` — which pinned model, and the separate
 *     hosted consent (D22: off, unticked; no row means exactly that).
 *
 * The suggestion shown in the Inbox lives on `category_abstentions`
 * (`assignments.ts`), beside the working that abstained.
 */
import { createdAtColumn, idColumn, instantColumn, updatedAtColumn, userIdColumn } from '@core/db';
import {
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { categories } from './categories.ts';

export const SUGGESTION_VERDICTS = ['suggested', 'abstained', 'refused'] as const;
export type SuggestionVerdict = (typeof SUGGESTION_VERDICTS)[number];

export const SUGGESTION_MODEL_CHOICES = ['narrator', 'classifier'] as const;
export type SuggestionModelChoice = (typeof SUGGESTION_MODEL_CHOICES)[number];

export const categorySuggestionCache = pgTable(
  'category_suggestion_cache',
  {
    id: idColumn(),
    userId: userIdColumn(),
    merchantKey: text('merchant_key').notNull(),
    taxonomyVersion: text('taxonomy_version').notNull(),
    model: text('model').notNull(),
    verdict: text('verdict').$type<SuggestionVerdict>().notNull(),
    categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
    reason: text('reason'),
    refusal: text('refusal'),
    runId: uuid('run_id'),
    rejectedAt: instantColumn('rejected_at'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('category_suggestion_cache_merchant_idx').on(
      table.userId,
      table.merchantKey,
      table.taxonomyVersion,
    ),
  ],
);

export const categorySuggestionEvals = pgTable(
  'category_suggestion_evals',
  {
    id: idColumn(),
    userId: userIdColumn(),
    modelChoice: text('model_choice').$type<SuggestionModelChoice>().notNull(),
    model: text('model').notNull(),
    modelDigest: text('model_digest'),
    status: text('status').$type<'completed' | 'failed'>().notNull(),
    failure: text('failure'),
    goldTotal: integer('gold_total').notNull(),
    residue: integer('residue').notNull(),
    asked: integer('asked').notNull(),
    scored: integer('scored').notNull(),
    correct: integer('correct').notNull(),
    abstained: integer('abstained').notNull(),
    refused: integer('refused').notNull(),
    precisionRatio: numeric('precision_ratio', { precision: 5, scale: 4 }),
    coverageRatio: numeric('coverage_ratio', { precision: 5, scale: 4 }),
    confusions: jsonb('confusions').notNull().default([]),
    batchDigests: jsonb('batch_digests').notNull().default([]),
    durationMs: integer('duration_ms'),
    measuredAt: instantColumn('measured_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('category_suggestion_evals_latest_idx').on(
      table.userId,
      table.modelChoice,
      table.measuredAt,
    ),
  ],
);

export const categorySuggestionSettings = pgTable('category_suggestion_settings', {
  userId: uuid('user_id').primaryKey(),
  modelChoice: text('model_choice').$type<SuggestionModelChoice>().notNull().default('narrator'),
  hostedConsentedAt: instantColumn('hosted_consented_at'),
  hostedConsentTextHash: text('hosted_consent_text_hash'),
  updatedAt: updatedAtColumn(),
});

export type CategorySuggestionCacheRow = typeof categorySuggestionCache.$inferSelect;
export type CategorySuggestionEvalRow = typeof categorySuggestionEvals.$inferSelect;
export type CategorySuggestionSettingsRow = typeof categorySuggestionSettings.$inferSelect;
