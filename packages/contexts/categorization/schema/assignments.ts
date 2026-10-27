// SPDX-License-Identifier: MIT
import { createdAtColumn, flagColumn, idColumn, instantColumn, userIdColumn } from '@core/db';
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
import { rules } from './rules.ts';

/**
 * A tier's confidence in itself: `0.0000` to `1.0000`.
 *
 * `NUMERIC(5,4)`, not `DOUBLE PRECISION`, for the reason `@ctx/ledger`'s
 * `confidenceColumn()` gives: docs/CONVENTIONS.md permits floats for confidence
 * scores and arithmetically one would be fine, but the migration gate
 * (`packages/db/test/migrate.test.ts`) bans `REAL`/`DOUBLE PRECISION`/`FLOAT`
 * across the whole schema rather than adjudicating column by column, and a ban
 * with a growing exception list stops catching the case it was written for.
 *
 * Declared here rather than imported from `@ctx/ledger`: that would be a context
 * importing another context, which `personalfi/layer-imports` denies. Twenty-six
 * lines of identical reasoning in two places is the honest price of the boundary;
 * promoting the helper into `@core/db` alongside `amountMinorColumn()` is the
 * right fix and is proposed in this WP's evidence document.
 *
 * `mode: 'number'` because a confidence really is a number in the application —
 * it is thresholded, sorted on by the review queue, and compared against
 * `confidenceFloor`.
 */
function confidenceColumn(name: string) {
  return numeric(name, { precision: 5, scale: 4, mode: 'number' });
}

/** Mirrors `AssignmentSource` in `src/engine.ts`. Kept in step by a test. */
export const ASSIGNMENT_SOURCES = [
  'rule',
  'provider',
  'classifier',
  'user',
  'merchant_default',
] as const;
export type AssignmentSourceValue = (typeof ASSIGNMENT_SOURCES)[number];

/**
 * What the engine decided, and why.
 *
 * **History is kept; exactly one row per transaction is current.** Both halves
 * matter and they pull in opposite directions, so the shape is a partial unique
 * index on `(transaction_id) WHERE is_current` — the database, not the
 * application, guarantees that a transaction cannot have two current categories.
 * Application-enforced uniqueness under a consumer that may run on two workers is
 * uniqueness that holds until the day it matters.
 *
 * Why keep history at all, when the current row is what every read wants:
 *
 *   * **Auditability.** "This was Shopping until March, when a rule changed it"
 *     is a question a user asks after a report surprises them, and it is
 *     unanswerable from a table that only holds now.
 *   * **Measurement.** The accuracy numbers in this WP's evidence document are
 *     computed by comparing what the engine decided against what the user
 *     confirmed. That comparison needs the engine's *original* decision, which an
 *     in-place update destroys.
 *   * **Undo.** Retracting a retroactive rule application means restoring what
 *     was there before, which has to still be there.
 *
 * `evidence` holds the full decision chain — every tier, including the ones that
 * abstained and why — which is what `explainAssignment` returns. It is stored
 * rather than recomputed because a chain recomputed next week reflects next
 * week's rules and next week's model, and would confidently explain a decision
 * that was made for entirely different reasons.
 *
 * `transaction_id` is deliberately **not** a foreign key into
 * `@ctx/ledger.transactions`, for the same reason `merchant_profiles` is not: a
 * FK across a context boundary is the coupling `lint:schema-ownership` exists to
 * prevent. The ledger's `TransactionsUpserted` / removal events are what keep
 * this table honest.
 */
export const categoryAssignments = pgTable(
  'category_assignments',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** `@ctx/ledger`'s `transactions.id`. Opaque here, as their overlay column is to them. */
    transactionId: uuid('transaction_id').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    source: text('source').$type<AssignmentSourceValue>().notNull(),
    confidence: confidenceColumn('confidence').notNull().default(0),
    ruleId: uuid('rule_id').references(() => rules.id, { onDelete: 'set null' }),
    /** The full decision chain from `decide()`. See the note above. */
    evidence: jsonb('evidence').notNull(),
    decidedAt: instantColumn('decided_at').notNull(),
    /** Monotonic per transaction. 1 is the first decision ever made about it. */
    version: integer('version').notNull().default(1),
    /** Exactly one per transaction, enforced by a partial unique index. */
    isCurrent: flagColumn('is_current').notNull().default(true),
    /** Set when the user confirms this assignment. Feeds the classifier. */
    confirmedAt: instantColumn('confirmed_at'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    index('category_assignments_transaction_idx').on(table.transactionId, table.version),
    index('category_assignments_user_category_idx').on(table.userId, table.categoryId),
    index('category_assignments_confirmed_idx').on(table.userId, table.confirmedAt),
  ],
);

/**
 * The classifier's training corpus, as counts rather than as rows.
 *
 * One row per (feature, category) pair with a count, not one row per confirmed
 * transaction: training is a `GROUP BY` over this table, the table is bounded by
 * the vocabulary rather than by the history length, and re-training after a
 * thousand new transactions reads a few thousand small rows instead of joining
 * back to the ledger.
 *
 * The trade is that a single confirmation cannot be *un*-counted exactly without
 * knowing its features, so `confirmAssignment` writes the features it counted
 * into the assignment's evidence, and the rebuild path recomputes from confirmed
 * assignments rather than decrementing. Counts are a cache; confirmations are the
 * source of truth.
 */
export const classifierExamples = pgTable(
  'classifier_examples',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** `t:chewy`, `b:3`, `a:credit`, `d:out`, `m:family.pets`. See `src/classifier.ts`. */
    feature: text('feature').notNull(),
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    count: integer('count').notNull().default(0),
    updatedAt: instantColumn('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('classifier_examples_feature_idx').on(
      table.userId,
      table.feature,
      table.categoryId,
    ),
    index('classifier_examples_category_idx').on(table.userId, table.categoryId),
  ],
);

/**
 * A trained model, frozen.
 *
 * Stored whole rather than rebuilt on demand for one reason: **reproducibility of
 * an explanation**. A classifier decision recorded in January was made by
 * January's model, and "why did it think that?" is answerable only if January's
 * model still exists. `category_assignments.evidence` records the version, and
 * this table is where that version's parameters live.
 *
 * Exactly one row is active per user. The rest are history and are prunable.
 */
export const classifierVersions = pgTable(
  'classifier_versions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    version: integer('version').notNull(),
    /** The serialised `ClassifierModel`. */
    model: jsonb('model').notNull(),
    exampleCount: integer('example_count').notNull().default(0),
    categoryCount: integer('category_count').notNull().default(0),
    isActive: flagColumn('is_active').notNull().default(false),
    trainedAt: instantColumn('trained_at').notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [uniqueIndex('classifier_versions_user_version_idx').on(table.userId, table.version)],
);

/**
 * The stored working behind "uncategorised" (migration 0053, WP 11.1).
 *
 * When every tier abstains on a transaction with no assignment yet,
 * `category_assignments` records nothing, so the chain that explains the
 * abstention lives here instead: one row per transaction, rewritten only when
 * the chain changes, deleted when an assignment is written. Read by
 * `explainTransactions` for the Inbox's "why" line — never recomputed.
 */
export const categoryAbstentions = pgTable(
  'category_abstentions',
  {
    id: idColumn(),
    userId: userIdColumn(),
    /** `@ctx/ledger`'s `transactions.id`. Opaque here. */
    transactionId: uuid('transaction_id').notNull(),
    /** `{ chain: TierOutcome[] }`, the shape `category_assignments.evidence` has. */
    evidence: jsonb('evidence').notNull(),
    decidedAt: instantColumn('decided_at').notNull(),
    // WP 11.2 (0055): a language model's suggestion for this uncategorised row. Never an
    // assignment: the row stays uncategorised until the holder taps Confirm.
    suggestedCategoryId: uuid('suggested_category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    suggestionReason: text('suggestion_reason'),
    /** `advisor_runs.id` of the categorize.suggest run. @ctx/insights' table: no FK (D8). */
    suggestionRunId: uuid('suggestion_run_id'),
    suggestedAt: instantColumn('suggested_at'),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('category_abstentions_transaction_idx').on(table.userId, table.transactionId),
  ],
);

export type CategoryAbstentionRow = typeof categoryAbstentions.$inferSelect;
export type CategoryAssignmentRow = typeof categoryAssignments.$inferSelect;
export type NewCategoryAssignmentRow = typeof categoryAssignments.$inferInsert;
export type ClassifierExampleRow = typeof classifierExamples.$inferSelect;
export type ClassifierVersionRow = typeof classifierVersions.$inferSelect;
