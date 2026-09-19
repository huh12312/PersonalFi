// SPDX-License-Identifier: MIT
/**
 * `rollovers` and `budget_alerts_state` — migration `0009_budgeting.sql`.
 *
 * `rollovers` is one audit row per carryover, and the property WP 2.1 has to
 * prove — `Σ rolloverOut(n) = Σ rolloverIn(n+1)` — is a `CHECK` on it rather
 * than a test alone. What the policy *discarded* is not lost either: it lands in
 * `absorbedByRtaMinor`, and `available = rolloverOut + absorbedByRta` is the
 * second `CHECK`. Every cent of a closing envelope is therefore accounted for in
 * exactly one of two places, by the database.
 *
 * "Absorbed by RTA" is 07 §1.3's `RTA(p+1) -= |cash_overspend(p)|` **recorded,
 * not applied**: Ready to Assign comes from the balance-sheet identity, so a
 * cent that does not carry forward is already absent from the next period's
 * envelopes and therefore already reflected in its RTA. Subtracting it a second
 * time would double-count it. This is the audit trail for a number nobody has to
 * add up.
 *
 * `budget_alerts_state` is edge-triggering. A row means "already fired"; it is
 * *deleted*, not updated, when a recompute puts the line back below the
 * threshold, which is what makes a re-crossing after a refund fire again.
 * Without it, recomputing a period after every sync page would emit "80% of
 * Groceries spent" on every page for the rest of the month and WP 2.4's
 * coalescing window would be papering over a bug in this context.
 */
import {
  amountMinorColumn,
  createdAtColumn,
  currencyColumn,
  idColumn,
  instantColumn,
  userIdColumn,
} from '@core/db';
import { index, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { RolloverPolicy } from './lines.ts';

/**
 * `RTA_NEGATIVE` is 07 §1.9 step 4 — "this is the one hard alert". The three
 * percentage rungs and the two overspend kinds are per line.
 */
export const ALERT_THRESHOLDS = [
  'PCT_50',
  'PCT_80',
  'PCT_100',
  'OVERSPENT_CASH',
  'OVERSPENT_CREDIT',
  'RTA_NEGATIVE',
] as const;
export type AlertThreshold = (typeof ALERT_THRESHOLDS)[number];

export const rollovers = pgTable(
  'rollovers',
  {
    id: idColumn(),
    userId: userIdColumn(),
    budgetId: uuid('budget_id').notNull(),
    fromPeriodId: uuid('from_period_id').notNull(),
    toPeriodId: uuid('to_period_id').notNull(),
    fromLineId: uuid('from_line_id').notNull(),
    toLineId: uuid('to_line_id').notNull(),
    policy: text('policy').$type<RolloverPolicy>().notNull(),
    /** `available(c, p)` at the moment `fromPeriodId` closed. */
    availableMinor: amountMinorColumn('available_minor').notNull(),
    rolloverOutMinor: amountMinorColumn('rollover_out_minor').notNull(),
    /** `= rolloverOutMinor`, by `CHECK`. Conservation is data, not convention. */
    rolloverInMinor: amountMinorColumn('rollover_in_minor').notNull(),
    /** The part the policy discarded. Recorded, not applied — see the header. */
    absorbedByRtaMinor: amountMinorColumn('absorbed_by_rta_minor').notNull(),
    currency: currencyColumn().notNull(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('rollovers_from_line_idx').on(table.fromLineId),
    uniqueIndex('rollovers_to_line_idx').on(table.toLineId),
    index('rollovers_period_idx').on(table.fromPeriodId, table.toPeriodId),
    index('rollovers_user_idx').on(table.userId),
  ],
);

export const budgetAlertsState = pgTable(
  'budget_alerts_state',
  {
    id: idColumn(),
    userId: userIdColumn(),
    budgetId: uuid('budget_id').notNull(),
    budgetPeriodId: uuid('budget_period_id').notNull(),
    /** NULL for the budget-wide `RTA_NEGATIVE`, set for a line threshold. */
    budgetLineId: uuid('budget_line_id'),
    threshold: text('threshold').$type<AlertThreshold>().notNull(),
    /** `spent / assigned` at the crossing. A ratio, not money — never a float. */
    ratio: numeric('ratio', { precision: 7, scale: 4, mode: 'string' }),
    /** The `domain_events.id` this crossing emitted, so an alert traces back. */
    eventId: uuid('event_id'),
    crossedAt: instantColumn('crossed_at').notNull().defaultNow(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    // As on `budget_lines`, the two partial unique indexes live in the
    // migration: one over `(period, line, threshold)` where the line is set, one
    // over `(period, threshold)` where it is NULL. A single index over all three
    // would let `RTA_NEGATIVE` — whose `budget_line_id` is NULL — be inserted
    // twice, because NULLs never conflict in a b-tree.
    index('budget_alerts_state_user_idx').on(table.userId),
  ],
);

export type RolloverRow = typeof rollovers.$inferSelect;
export type NewRolloverRow = typeof rollovers.$inferInsert;
export type BudgetAlertStateRow = typeof budgetAlertsState.$inferSelect;
export type NewBudgetAlertStateRow = typeof budgetAlertsState.$inferInsert;
