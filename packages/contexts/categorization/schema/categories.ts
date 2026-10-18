// SPDX-License-Identifier: MIT
import {
  createdAtColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import type { ChartHue } from '@core/kernel';
import { index, integer, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/** What a category does to an aggregate. Mirrors `src/taxonomy.ts`'s `CategoryKind`. */
export const CATEGORY_KINDS = ['income', 'expense', 'transfer', 'investment', 'other'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/**
 * How a category's spending behaves (WP 10.11, migration 0047; Monarch's equivalent). Only the holder
 * sets it; NULL is "unclassified". The migration's CHECK lists the same three values, asserted equal by
 * `apps/api/test/db/category-variability-routes.test.ts`.
 */
export const CATEGORY_VARIABILITIES = ['fixed', 'flexible', 'non_monthly'] as const;
export type CategoryVariability = (typeof CATEGORY_VARIABILITIES)[number];

/**
 * The chart of categories, per user.
 *
 * **Per user, even for the system taxonomy**, and that is a deliberate cost. A
 * single shared system table would be smaller and would make the seed a one-time
 * job, but it would also mean a user cannot rename "Dining & Drinks" to "Eating
 * Out" without either mutating a global row or introducing a second override
 * table that every read then has to consult. Decision D6 already puts `user_id`
 * on every user-scoped table; this just takes it seriously. The cost is ~150 rows
 * per user, once.
 *
 * `key` is the stable identity — `dining.coffee` — and the mapping tables, the
 * rules and the classifier all speak keys. `id` is what a foreign key points at,
 * including `@ctx/ledger`'s deliberately opaque `transactions.user_category_id`.
 * Two identifiers for one thing is usually a smell; here it is the only way to
 * have both "a rule written in 2026 still means the same category in 2029" and
 * "renaming a category is an UPDATE".
 *
 * `archived_at` rather than `DELETE`: a category with three years of history
 * behind it cannot be deleted without either orphaning those rows or rewriting
 * them, and rewriting history to tidy a picklist is how a ledger stops being
 * trustworthy.
 */
export const categories = pgTable(
  'categories',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** NULL for a top level. Exactly two levels; a CHECK in the migration enforces it. */
    parentId: uuid('parent_id'),
    key: text('key').notNull(),
    label: text('label').notNull(),
    description: text('description').notNull().default(''),
    kind: text('kind').$type<CategoryKind>().notNull(),
    /** A Lucide icon name (decision D20). A key, never markup. */
    icon: text('icon').notNull().default('circle'),
    sort: integer('sort').notNull().default(0),
    /**
     * The chart hue (WP 10.8, migration 0045): one of `CHART_HUES`, CHECKed by `categories_hue_check`.
     * NULL until the first read assigns `hueForId(id)`; never re-derived after that.
     */
    hue: text('hue').$type<ChartHue>(),
    /**
     * Fixed / flexible / non-monthly (WP 10.11, migration 0047), CHECKed by `categories_variability_check`.
     * NULL = unclassified. Never derived: a recurring stream only *suggests* `fixed`.
     */
    variability: text('variability').$type<CategoryVariability>(),
    /** Seeded by us. A user may rename it; they may not delete it. */
    isSystem: flagColumn('is_system').notNull().default(false),
    archivedAt: instantColumn('archived_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('categories_user_key_idx').on(table.userId, table.key),
    index('categories_user_parent_idx').on(table.userId, table.parentId, table.sort),
  ],
);

/**
 * Plaid PFC v2 → our keys, as a table rather than only as code.
 *
 * It is *also* `src/pfc-map.ts`, and the duplication is the point: the code
 * constant is what the engine reads on the hot path (a `Map` lookup, no round
 * trip, testable without a database), and the table is what makes the mapping
 * **user-editable** — a user who thinks their bank's "GENERAL_SERVICES_EDUCATION"
 * belongs under Family rather than Education should be able to say so once
 * instead of writing a rule. `source` records which it is, and the seeding path
 * never overwrites a row marked `user`.
 *
 * Risk R13 is the reason this layer exists at all: when Plaid revises PFC, the
 * revision lands here and nowhere else, and budget history does not move.
 */
export const providerCategoryMap = pgTable(
  'provider_category_map',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** `plaid`. Named so a second enrichment provider does not need a second table. */
    provider: text('provider').notNull().default('plaid'),
    /** `v2`. Pinned in code too (`personal_finance_category_version`), per 01 §5.4. */
    taxonomyVersion: text('taxonomy_version').notNull().default('v2'),
    primaryCode: text('primary_code').notNull(),
    /** NULL for a primary-only row, which is the fallback when `detailed` is unknown. */
    detailedCode: text('detailed_code'),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    source: text('source').$type<'system' | 'user'>().notNull().default('system'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('provider_category_map_code_idx').on(
      table.userId,
      table.provider,
      table.taxonomyVersion,
      table.primaryCode,
      table.detailedCode,
    ),
  ],
);

/**
 * Merchant Category Codes, and what each one means to us.
 *
 * Reference data, not user data — but it still carries `user_id`, because
 * decision D6 says every user-scoped table does and because the `category_id` it
 * points at *is* user-scoped. The alternative, a global table storing a category
 * *key* and resolving it per user on read, trades one join for one column and
 * buys an exception to a rule that is worth more intact.
 *
 * Provenance: `greggles/mcc-codes`, the Unlicense (02 §4.4, "ship verbatim").
 */
export const mccCodes = pgTable(
  'mcc_codes',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** Four digits, zero-padded. A CHECK in the migration enforces the shape. */
    mcc: text('mcc').notNull(),
    description: text('description').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('mcc_codes_user_code_idx').on(table.userId, table.mcc)],
);

export type CategoryRow = typeof categories.$inferSelect;
export type NewCategoryRow = typeof categories.$inferInsert;
export type ProviderCategoryMapRow = typeof providerCategoryMap.$inferSelect;
export type McccCodeRow = typeof mccCodes.$inferSelect;
