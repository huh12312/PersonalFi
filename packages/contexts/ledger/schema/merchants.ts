// SPDX-License-Identifier: MIT
import { createdAtColumn, idColumn, updatedAtColumn, userIdColumn } from '@core/db';
import { index, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The normalised payee.
 *
 * Ledger's only interest in a merchant is convergence: "SQ *BLUE BOTTLE 4471" and
 * "SQ *BLUE BOTTLE COFFE #12" must land on one row so the list can group by payee
 * and so the transfer and refund heuristics have a key to match on. It does not
 * categorise, does not know what a subscription is, and holds no taxonomy.
 *
 * Everything richer — logos, websites, subscription-likeness, the alias corpus,
 * the clustering pipeline — belongs to `@ctx/categorization` (WP 1.4), which
 * extends this table by migration rather than owning a second one. Two merchant
 * tables would guarantee two answers to "who did I pay?".
 */
export const merchants = pgTable(
  'merchants',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** Canonical slug from `normaliseMerchantName()`. Lower case, noise stripped. */
    normalizedKey: text('normalized_key').notNull(),
    displayName: text('display_name').notNull(),
    /**
     * Provider entity ids seen for this merchant (Plaid `counterparties[].entity_id`).
     * Stable across descriptor noise, so a far better grouping key than the text —
     * when the provider supplies one, which is most but not all of the time.
     */
    providerEntityIds: text('provider_entity_ids').array().notNull().default([]),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('merchants_user_key_idx').on(table.userId, table.normalizedKey),
    index('merchants_display_name_trgm_idx').on(table.displayName),
  ],
);

export type MerchantRow = typeof merchants.$inferSelect;
export type NewMerchantRow = typeof merchants.$inferInsert;
