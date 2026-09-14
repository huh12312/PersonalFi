// SPDX-License-Identifier: MIT
import {
  createdAtColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import type { RuleAction, RuleConditions } from '../src/rules/schema.ts';

/**
 * User rules.
 *
 * `conditions` and `actions` are `jsonb` rather than the `rule_conditions` /
 * `rule_actions` child tables this package's OWNERSHIP.md originally claimed.
 * The claim was a sketch; this is what the shape turned out to want, and the
 * reason is worth recording because "just normalise it" is the reflex:
 *
 *   * A rule is read as a **whole** or not at all. There is no query that wants
 *     "all rules whose third condition mentions an amount", so the child tables
 *     would buy a three-way join on the sync path and nothing else.
 *   * A rule is edited as a whole. With child tables, changing one condition is a
 *     delete-and-reinsert that has to be transactional anyway, and gets a window
 *     where the rule is half a rule.
 *   * The safety a relational shape would buy — you cannot store nonsense — is
 *     bought instead by `conditionsSchema` and `actionsSchema` in
 *     `src/rules/schema.ts`, validated on write *and* on read. That is stricter
 *     than a column type: it rejects an amount range whose minimum exceeds its
 *     maximum, which no `CHECK` spread across two child tables would catch.
 *
 * OWNERSHIP.md records the two names as retired so nobody reserves them again.
 */
export const rules = pgTable(
  'rules',
  {
    id: idColumn(),
    userId: userIdColumn(),
    name: text('name').notNull(),
    /** Ascending: lower wins (04 §5.2). Gaps of 10 leave room to insert. */
    priority: integer('priority').notNull().default(100),
    enabled: flagColumn('enabled').notNull().default(true),
    conditions: jsonb('conditions').$type<RuleConditions>().notNull(),
    actions: jsonb('actions').$type<RuleAction[]>().notNull(),
    /** Evaluate in the sync consumer, not only on an explicit apply. */
    runOnSync: flagColumn('run_on_sync').notNull().default(true),
    /** Short-circuit the rest of the list once this matches (04 §5.2). */
    stopProcessing: flagColumn('stop_processing').notNull().default(false),
    /**
     * The transaction the "always categorise X as Y" button was pressed on.
     * Opaque, like every other reference into `@ctx/ledger` from here: it exists
     * so the rule list can link back to where the rule came from, which is the
     * fastest way for a user to work out what a rule they wrote in March does.
     */
    createdFromTransactionId: uuid('created_from_transaction_id'),
    lastAppliedAt: instantColumn('last_applied_at'),
    /** Transactions the last apply actually changed. Shown in the rule list. */
    lastAppliedCount: integer('last_applied_count').notNull().default(0),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [index('rules_user_priority_idx').on(table.userId, table.enabled, table.priority, table.id)],
);

/**
 * One row per `applyRule` run.
 *
 * A rule that retroactively recategorised 900 transactions is an event a user
 * will want to understand — and possibly undo — weeks later, and "how many did
 * that change?" is unanswerable after the fact without recording it at the time.
 * `preview` runs are recorded too: the preview count and the eventual real count
 * differing is exactly the signal that something moved in between.
 */
export const ruleRuns = pgTable(
  'rule_runs',
  {
    id: idColumn(),
    userId: userIdColumn(),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<'preview' | 'apply'>().notNull(),
    retroactive: flagColumn('retroactive').notNull().default(false),
    matchedCount: integer('matched_count').notNull().default(0),
    changedCount: integer('changed_count').notNull().default(0),
    startedAt: instantColumn('started_at').notNull(),
    finishedAt: instantColumn('finished_at'),
    createdAt: createdAtColumn(),
  },
  (table) => [index('rule_runs_rule_idx').on(table.ruleId, table.startedAt)],
);

export type RuleRow = typeof rules.$inferSelect;
export type NewRuleRow = typeof rules.$inferInsert;
export type RuleRunRow = typeof ruleRuns.$inferSelect;
