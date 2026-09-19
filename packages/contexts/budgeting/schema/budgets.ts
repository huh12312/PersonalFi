// SPDX-License-Identifier: MIT
/**
 * `budgets` and `budget_periods` — migration `0009_budgeting.sql`.
 *
 * See that file's header for the design. The two things worth repeating at the
 * query surface, because they are what a reader of this file is about to get
 * wrong:
 *
 *   * `endDate` is **exclusive**. A transaction belongs to the period with
 *     `startDate <= budgetDate < endDate`, exactly one of them, enforced by an
 *     `EXCLUDE USING gist` constraint rather than by application care. Writing
 *     `lte(budgetPeriods.endDate, date)` anywhere is a bug.
 *   * both date columns are `DATE`, read back as `YYYY-MM-DD` strings, which is
 *     the kernel's `DateOnly`. They are calendar dates in `budgets.timezone`,
 *     never instants — that is the whole reason a period roll across a DST
 *     boundary is uninteresting here rather than delicate.
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
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * 07 §1.9's settings switch. Presentation and auto-assign aggressiveness only:
 * the ledger underneath is identical in all four, which is why this is a column
 * on `budgets` and not a branch through the envelope math.
 */
export const BUDGET_MODES = ['ENVELOPE', 'ENVELOPE_LITE', 'TARGETS_ONLY', 'OFF'] as const;
export type BudgetMode = (typeof BUDGET_MODES)[number];

/** 07 §1.7. `CUSTOM` is a fixed number of days from an anchor. */
export const PERIOD_KINDS = [
  'CALENDAR_MONTH',
  'SEMIMONTHLY',
  'BIWEEKLY',
  'WEEKLY',
  'CUSTOM',
] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const PERIOD_STATUSES = ['open', 'closed'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export const budgets = pgTable(
  'budgets',
  {
    id: idColumn(),
    userId: userIdColumn(),
    name: text('name').notNull(),
    currency: currencyColumn().notNull(),
    /** IANA zone. Every period boundary is a calendar date in *this* zone. */
    timezone: text('timezone').notNull(),
    mode: text('mode').$type<BudgetMode>().notNull().default('ENVELOPE_LITE'),
    periodKind: text('period_kind').$type<PeriodKind>().notNull().default('CALENDAR_MONTH'),
    periodAnchorDate: dateColumn('period_anchor_date'),
    periodLengthDays: integer('period_length_days'),
    semimonthlySecondDay: integer('semimonthly_second_day').notNull().default(16),
    autoAssign: flagColumn('auto_assign').notNull().default(true),
    /**
     * Ledger account ids the user took *out* of the budget.
     *
     * An exclusion list, not an inclusion list: a newly linked checking account
     * must appear in the budget without a second action, and an inclusion list
     * that silently omits one breaks the Ready-to-Assign identity in the
     * direction nobody notices — more money than the budget knows about.
     */
    offBudgetAccountIds: jsonb('off_budget_account_ids')
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [uniqueIndex('budgets_user_name_idx').on(table.userId, table.name)],
);

export const budgetPeriods = pgTable(
  'budget_periods',
  {
    id: idColumn(),
    userId: userIdColumn(),
    budgetId: uuid('budget_id').notNull(),
    /**
     * Denormalised from `budgets.period_kind` at open time. The grid a closed
     * period was generated under is history: changing the setting must not
     * retroactively re-describe periods that already happened.
     */
    kind: text('kind').$type<PeriodKind>().notNull(),
    startDate: dateColumn('start_date').notNull(),
    /** **Exclusive.** See this file's header. */
    endDate: dateColumn('end_date').notNull(),
    sequence: integer('sequence').notNull(),
    status: text('status').$type<PeriodStatus>().notNull().default('open'),
    /** Cached. From identity I of the migration header, never by summing income. */
    readyToAssignMinor: amountMinorColumn('ready_to_assign_minor').notNull().default(0n),
    /** `PCT_OF_INCOME` and 50/30/20 only. Not an input to Ready to Assign. */
    incomeMinor: amountMinorColumn('income_minor').notNull().default(0n),
    currency: currencyColumn().notNull(),
    /** 07 §1.4 rule 6: `available` is a cache with a dirty cascade, never truth. */
    dirty: flagColumn('dirty').notNull().default(true),
    openedAt: instantColumn('opened_at').notNull().defaultNow(),
    closedAt: instantColumn('closed_at'),
    recomputedAt: instantColumn('recomputed_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // The `EXCLUDE USING gist` that makes "exactly one period contains this
    // date" true is deliberately not declared here: this file is the query
    // surface, not the DDL (the convention `@ctx/connections`'s
    // `schema/staging.ts` set), and Drizzle needs no constraint metadata to
    // filter on a date range. The migration is where it lives and is enforced.
    uniqueIndex('budget_periods_sequence_idx').on(table.budgetId, table.sequence),
    uniqueIndex('budget_periods_start_idx').on(table.budgetId, table.startDate),
    index('budget_periods_range_idx').on(table.budgetId, table.startDate, table.endDate),
    index('budget_periods_user_idx').on(table.userId),
  ],
);

export type BudgetRow = typeof budgets.$inferSelect;
export type NewBudgetRow = typeof budgets.$inferInsert;
export type BudgetPeriodRow = typeof budgetPeriods.$inferSelect;
export type NewBudgetPeriodRow = typeof budgetPeriods.$inferInsert;
