// SPDX-License-Identifier: MIT
/**
 * `budget_lines` and `budget_line_actuals` — migration `0009_budgeting.sql`.
 *
 * One row per `(period, category)` — the money *and* the policy that governed
 * it, frozen per period — rather than 07 §1.10's split of `category` (mutable,
 * no history) plus `budget_entry` (the money). Editing a target changes the open
 * period and every period opened after it; closed periods keep what they were
 * actually budgeted under, so "what was my grocery target in March?" survives an
 * edit made in April.
 *
 * `categoryId` and `creditAccountId` are opaque UUIDs with no foreign key, for
 * the reason decision D8 gives for `transactions.user_category_id`:
 * `@ctx/categorization` owns `categories` and `@ctx/ledger` owns `accounts`, and
 * a foreign key here would be this context reaching into another's table.
 *
 * The two tables are split by *provenance*, not by size. Everything in
 * `budget_line_actuals` is a function of the ledger read through `LedgerPort`
 * and is recomputed wholesale; everything in `budget_lines` is what the user
 * decided. Keeping them apart means "recompute the actuals" can never clobber an
 * assignment.
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
import { index, integer, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * 07 §1.3: `CCP[card]` "is auto-created 1:1 with each on-budget credit account
 * and is not user-deletable."
 */
export const LINE_KINDS = ['category', 'credit_card_payment'] as const;
export type LineKind = (typeof LINE_KINDS)[number];

/** 07 §1.2's `rollover_fn`. */
export const ROLLOVER_POLICIES = ['ROLLOVER', 'RESET', 'ROLLOVER_ALLOW_NEGATIVE'] as const;
export type RolloverPolicy = (typeof ROLLOVER_POLICIES)[number];

/** 07 §1.8's six goal types. */
export const GOAL_TYPES = [
  'NONE',
  'MONTHLY_TARGET',
  'TARGET_BY_DATE',
  'MINIMUM_BALANCE',
  'PCT_OF_INCOME',
  'REFILL_UP_TO',
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

/** 07 §1.10's `budget_entry.source`. */
export const ASSIGNED_SOURCES = ['USER', 'AUTO', 'ROLLOVER_FIX'] as const;
export type AssignedSource = (typeof ASSIGNED_SOURCES)[number];

/** 07 §1.6's derived 50/30/20 layer. Nullable: a CCP line is none of the three. */
export const BUDGET_CLASSES = ['NEED', 'WANT', 'SAVINGS'] as const;
export type BudgetClass = (typeof BUDGET_CLASSES)[number];

export const budgetLines = pgTable(
  'budget_lines',
  {
    id: idColumn(),
    userId: userIdColumn(),
    budgetId: uuid('budget_id').notNull(),
    budgetPeriodId: uuid('budget_period_id').notNull(),
    kind: text('kind').$type<LineKind>().notNull(),
    /** Opaque: `@ctx/categorization` owns `categories`. Set iff `kind='category'`. */
    categoryId: uuid('category_id'),
    /** Opaque: `@ctx/ledger` owns `accounts`. Set iff `kind='credit_card_payment'`. */
    creditAccountId: uuid('credit_account_id'),
    name: text('name'),

    assignedMinor: amountMinorColumn('assigned_minor').notNull().default(0n),
    assignedSource: text('assigned_source').$type<AssignedSource>().notNull().default('USER'),
    /** `rollover_fn(available(c, p-1), policy)`. The audit row is in `rollovers`. */
    carryoverMinor: amountMinorColumn('carryover_minor').notNull().default(0n),
    /** `carryover + assigned + activity`. Cached (07 §1.4 rule 6). */
    availableMinor: amountMinorColumn('available_minor').notNull().default(0n),
    /** 07 §1.3's red half: cash that has already left a depository account. */
    cashOverspendMinor: amountMinorColumn('cash_overspend_minor').notNull().default(0n),
    /** 07 §1.3's yellow half: borrowed on a card, no cash gone yet. */
    creditOverspendMinor: amountMinorColumn('credit_overspend_minor').notNull().default(0n),
    /** CCP lines: envelope money moved onto this card this period. */
    fundedMinor: amountMinorColumn('funded_minor').notNull().default(0n),
    /** CCP lines: statement payments that left it this period. */
    paymentsMinor: amountMinorColumn('payments_minor').notNull().default(0n),
    /** CCP lines: identity II — what is owed that no envelope ever covered. */
    unfundedDebtMinor: amountMinorColumn('unfunded_debt_minor').notNull().default(0n),
    /**
     * The *opening* unfunded debt, as `carryoverMinor` is the opening
     * `availableMinor`. Written by a roll, never by a recompute.
     *
     * Without the split, a recompute would read its own previous closing value
     * as this period's opening and add the period's borrowing a second time —
     * and since the dirty cascade re-runs a period on every late transaction,
     * "recompute twice" is the normal path. The migration's comment on this
     * column carries the full derivation.
     */
    carryoverUnfundedDebtMinor: amountMinorColumn('carryover_unfunded_debt_minor')
      .notNull()
      .default(0n),
    currency: currencyColumn().notNull(),

    rolloverPolicy: text('rollover_policy').$type<RolloverPolicy>().notNull().default('ROLLOVER'),
    goalType: text('goal_type').$type<GoalType>().notNull().default('NONE'),
    goalAmountMinor: amountMinorColumn('goal_amount_minor'),
    goalTargetDate: dateColumn('goal_target_date'),
    /**
     * `PCT_OF_INCOME` only, `0..1`. `mode: 'string'` on purpose: this is the one
     * number in the goal machinery that is not an integer, and it reaches
     * `Money.multiplyByDecimal` — which takes a decimal *string* and refuses a
     * `number`, because `0.1 * 3` is the bug that type exists to prevent.
     */
    goalPercent: numeric('goal_percent', { precision: 7, scale: 4, mode: 'string' }),
    /** Auto-assign order. Lower first; ties break on id so a roll is deterministic. */
    priority: integer('priority').notNull().default(100),
    class: text('class').$type<BudgetClass>(),
    dirty: flagColumn('dirty').notNull().default(true),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    // The two partial unique indexes — one envelope per category per period, one
    // CCP line per card per period — are deliberately not declared here, the
    // convention `@ctx/connections`'s `schema/staging.ts` set: this file is the
    // query surface, not the DDL. They are partial rather than one composite
    // UNIQUE because `category_id` and `credit_account_id` are each NULL for the
    // other kind and NULLs never conflict in a b-tree, so a plain UNIQUE would
    // happily admit two CCP lines for the same card. The migration is where that
    // lives and is enforced.
    index('budget_lines_period_priority_idx').on(table.budgetPeriodId, table.priority, table.id),
    index('budget_lines_user_idx').on(table.userId),
  ],
);

export const budgetLineActuals = pgTable(
  'budget_line_actuals',
  {
    id: idColumn(),
    userId: userIdColumn(),
    budgetPeriodId: uuid('budget_period_id').notNull(),
    budgetLineId: uuid('budget_line_id').notNull(),
    /** Signed, house convention: negative = outflow. Refunds netted, transfers out. */
    activityMinor: amountMinorColumn('activity_minor').notNull().default(0n),
    cashActivityMinor: amountMinorColumn('cash_activity_minor').notNull().default(0n),
    creditActivityMinor: amountMinorColumn('credit_activity_minor').notNull().default(0n),
    outflowMinor: amountMinorColumn('outflow_minor').notNull().default(0n),
    inflowMinor: amountMinorColumn('inflow_minor').notNull().default(0n),
    refundMinor: amountMinorColumn('refund_minor').notNull().default(0n),
    currency: currencyColumn().notNull(),
    transactionCount: integer('transaction_count').notNull().default(0),
    /**
     * Exists so the exclusion is *observable* rather than merely claimed. A
     * report that says "0 transfers excluded" on a month with a card payment in
     * it is a bug with a visible symptom instead of a silent wrong total.
     */
    transferExcludedCount: integer('transfer_excluded_count').notNull().default(0),
    refundNettedCount: integer('refund_netted_count').notNull().default(0),
    computedAt: instantColumn('computed_at').notNull().defaultNow(),
    createdAt: createdAtColumn(),
  },
  (table) => [
    uniqueIndex('budget_line_actuals_line_idx').on(table.budgetLineId),
    index('budget_line_actuals_period_idx').on(table.budgetPeriodId),
    index('budget_line_actuals_user_idx').on(table.userId),
  ],
);

export type BudgetLineRow = typeof budgetLines.$inferSelect;
export type NewBudgetLineRow = typeof budgetLines.$inferInsert;
export type BudgetLineActualsRow = typeof budgetLineActuals.$inferSelect;
export type NewBudgetLineActualsRow = typeof budgetLineActuals.$inferInsert;
