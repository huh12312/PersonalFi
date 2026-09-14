// SPDX-License-Identifier: MIT
import {
  createdAtColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { categories } from './categories.ts';

/**
 * Everything about a payee that is not the payee's identity.
 *
 * `@ctx/ledger` owns `merchants` — the identity, the normalised key, the display
 * name — and its header says so: "Everything richer … belongs to
 * `@ctx/categorization` (WP 1.4), which extends this table by migration rather
 * than owning a second one. Two merchant tables would guarantee two answers to
 * 'who did I pay?'".
 *
 * This is that extension, and the shape it takes is a **side table keyed on the
 * ledger's merchant id**, not extra columns on `merchants`. Same effect, one
 * important difference: `pnpm lint:schema-ownership` fails if this package adds a
 * column to a table `@ctx/ledger` owns, and it should — a migration in our
 * package silently widening another context's table is precisely the reach-around
 * that check exists to stop. The FK points one way, this context reads the ledger
 * merchant through the ledger's own read model, and the boundary holds.
 *
 * There is exactly one profile per ledger merchant, enforced by a unique index.
 */
export const merchantProfiles = pgTable(
  'merchant_profiles',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /**
     * `@ctx/ledger`'s `merchants.id`. Deliberately **not** a foreign key: a FK
     * from here into another context's table is the coupling the ownership check
     * forbids, and the referential integrity it would buy is worth less than the
     * boundary. Orphans are swept by the same job that rebuilds profiles.
     */
    ledgerMerchantId: uuid('ledger_merchant_id').notNull(),
    /** What we would call this merchant. The ledger's display name is what the list shows. */
    canonicalName: text('canonical_name').notNull(),
    /** `fingerprint()` of the canonical name. The grouping key. */
    fingerprint: text('fingerprint').notNull(),
    /**
     * Cleaned descriptors seen for this merchant, most common first. The evidence
     * behind a merge, and the input a future re-clustering run reads instead of
     * re-scanning every transaction.
     */
    descriptorPatterns: jsonb('descriptor_patterns').$type<string[]>().notNull().default([]),
    defaultCategoryId: uuid('default_category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    /** How many confirmed transactions the learned default rests on (04 §5.2: "≥ 3"). */
    defaultSupportCount: integer('default_support_count').notNull().default(0),
    /**
     * The user pinned this category. A locked default outranks anything learned
     * and is never overwritten by the learning path — 07 §2.1's "`source=USER`,
     * which always wins", applied to the category rather than to the name.
     */
    userLocked: flagColumn('user_locked').notNull().default(false),
    /** Plaid `counterparties[].entity_id`s seen. Stabler than any text key. */
    providerEntityIds: jsonb('provider_entity_ids').$type<string[]>().notNull().default([]),
    lastSeenAt: instantColumn('last_seen_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('merchant_profiles_ledger_merchant_idx').on(table.userId, table.ledgerMerchantId),
    index('merchant_profiles_fingerprint_idx').on(table.userId, table.fingerprint),
  ],
);

export type MerchantProfileRow = typeof merchantProfiles.$inferSelect;
export type NewMerchantProfileRow = typeof merchantProfiles.$inferInsert;
