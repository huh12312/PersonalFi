// SPDX-License-Identifier: MIT
import { createdAtColumn, idColumn, instantColumn, updatedAtColumn, userIdColumn } from '@core/db';
import { pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * WP 11.6 (`0063_merchant_name_suggestions.sql`): a local model's display-name
 * suggestion for one **noise** merchant (`detectMerchantNoise`), one row per
 * `(user_id, normalized_key)` — asked once, never again, whatever became of it.
 *
 * Beside `merchants` because it is about them: the key is a `merchants`
 * `normalized_key`, the only path an accepted suggestion takes is the
 * `user_merchant_name` overlay on `transactions` (`setTransactionOverlay`, the
 * manual rename's own code), and neither `merchants.display_name` nor
 * `transactions.effective_name` is ever written from here. The ledger owns all
 * three tables; nobody else could hold this one without reading them.
 *
 * Every status's columns are whole-or-none, CHECK-enforced in the migration:
 * `suggested`/`accepted`/`dismissed` carry `display_name`, `refused` carries
 * `refusal_class` and no name, and `decided_at` is set exactly on the holder's
 * accept or dismiss. `llm_provider` is CHECK-pinned to `ollama`: the query type
 * is local-only, and the table cannot record otherwise.
 */
export const MERCHANT_NAME_STATUSES = ['suggested', 'accepted', 'dismissed', 'refused'] as const;
export type MerchantNameStatus = (typeof MERCHANT_NAME_STATUSES)[number];

export const merchantNameSuggestions = pgTable(
  'merchant_name_suggestions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** `merchants.normalized_key` of the noise merchant (`[a-z0-9]+`). */
    normalizedKey: text('normalized_key').notNull(),
    /** The normaliser's residue, as sent to the model: what the suggestion is validated against. */
    descriptor: text('descriptor').notNull(),
    /** The processor prefix the normaliser stripped (`PAYPAL *`), as sent; `null` when none. */
    strippedPrefix: text('stripped_prefix'),
    status: text('status', { enum: MERCHANT_NAME_STATUSES }).notNull(),
    /** The validated, substring-preserving name. `null` exactly when `refused`. */
    displayName: text('display_name'),
    /** The validator's class (`name.invented`, `abstained`, …). Set exactly when `refused`. */
    refusalClass: text('refusal_class'),
    llmProvider: text('llm_provider').notNull(),
    llmModel: text('llm_model').notNull(),
    /** `advisor_runs.id` of the call. */
    runId: uuid('run_id').notNull(),
    /** `advisor_runs.input_digest`: the canonical digest of what the model was sent. */
    inputDigest: text('input_digest').notNull(),
    suggestedAt: instantColumn('suggested_at').notNull(),
    /** The holder's accept or dismiss. */
    decidedAt: instantColumn('decided_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('merchant_name_suggestions_key_idx').on(table.userId, table.normalizedKey),
  ],
);

export type MerchantNameSuggestionRow = typeof merchantNameSuggestions.$inferSelect;
export type NewMerchantNameSuggestionRow = typeof merchantNameSuggestions.$inferInsert;
