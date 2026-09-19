// SPDX-License-Identifier: MIT
/**
 * Creating a budget, and the envelopes that hang off it.
 *
 * Separate from `service.ts` because the two have different shapes: this is the
 * setup path, called once and then rarely, and everything in `service.ts` runs
 * on every sync page.
 */
import { Money, newId, type DateOnly as DateOnlyType } from '@core/kernel';
import { and, eq } from 'drizzle-orm';
import {
  budgetLines,
  budgets,
  type BudgetClass,
  type BudgetMode,
  type BudgetRow,
  type GoalType,
  type PeriodKind,
  type RolloverPolicy,
} from '../schema/index.ts';
import type { BudgetingContext, BudgetingExecutor } from './db.ts';
import { BudgetingError } from './errors.ts';

export interface CreateBudgetInput {
  readonly name: string;
  readonly currency: string;
  /** IANA zone. Every period boundary is a calendar date in *this* zone. */
  readonly timezone: string;
  readonly mode?: BudgetMode;
  readonly periodKind?: PeriodKind;
  readonly periodAnchorDate?: DateOnlyType | null;
  readonly periodLengthDays?: number | null;
  readonly semimonthlySecondDay?: number;
  readonly autoAssign?: boolean;
  readonly offBudgetAccountIds?: readonly string[];
}

/**
 * The dispatch's §6 question 2 default, in one object:
 * `ENVELOPE_LITE`, rollover on, auto-assign from targets, `CALENDAR_MONTH`.
 *
 * Stated here rather than only in the column defaults so that a caller who has
 * to construct one explicitly — a test, a seed, an import — gets the same
 * answer the database would have given, instead of quietly picking `ENVELOPE`
 * because it sounded stricter.
 */
export const DEFAULT_BUDGET = Object.freeze({
  mode: 'ENVELOPE_LITE' as BudgetMode,
  periodKind: 'CALENDAR_MONTH' as PeriodKind,
  autoAssign: true,
  semimonthlySecondDay: 16,
});

export async function createBudget(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  input: CreateBudgetInput,
): Promise<BudgetRow> {
  const periodKind = input.periodKind ?? DEFAULT_BUDGET.periodKind;
  if (
    (periodKind === 'BIWEEKLY' || periodKind === 'WEEKLY' || periodKind === 'CUSTOM') &&
    (input.periodAnchorDate ?? null) === null
  ) {
    // Refused here as well as by the `CHECK`, so the message names the setting
    // rather than the constraint. 07 §1.7: a non-calendar grid is "anchored to
    // an actual payday", and without one there is no grid at all.
    throw new BudgetingError(
      'budgeting.currency_mismatch',
      `period kind ${periodKind} requires an anchor date`,
    );
  }

  const id = newId();
  const rows = await executor
    .insert(budgets)
    .values({
      id,
      userId: context.userId,
      name: input.name,
      currency: Money.zero(input.currency).currency,
      timezone: input.timezone,
      mode: input.mode ?? DEFAULT_BUDGET.mode,
      periodKind,
      periodAnchorDate: input.periodAnchorDate ?? null,
      periodLengthDays: periodKind === 'CUSTOM' ? (input.periodLengthDays ?? null) : null,
      semimonthlySecondDay: input.semimonthlySecondDay ?? DEFAULT_BUDGET.semimonthlySecondDay,
      autoAssign: input.autoAssign ?? DEFAULT_BUDGET.autoAssign,
      offBudgetAccountIds: input.offBudgetAccountIds ?? [],
      createdAt: context.clock.now(),
      updatedAt: context.clock.now(),
    })
    .returning();

  const budget = rows[0];
  if (budget === undefined) {
    throw new BudgetingError('budgeting.budget_not_found', `insert returned no row for ${id}`);
  }
  return budget;
}

export interface UpsertLineInput {
  readonly budgetId: string;
  readonly periodId: string;
  /** `@ctx/categorization`'s id. Opaque here — no foreign key (decision D8). */
  readonly categoryId: string;
  readonly rolloverPolicy?: RolloverPolicy;
  readonly goalType?: GoalType;
  readonly goalAmountMinor?: bigint | null;
  readonly goalTargetDate?: DateOnlyType | null;
  /** A decimal **string**, `'0.1500'`. Never a number — see `envelope.ts`. */
  readonly goalPercent?: string | null;
  readonly priority?: number;
  readonly class?: BudgetClass | null;
}

/**
 * Create or update the envelope for one category in one period.
 *
 * Upsert rather than insert-or-fail because the budget screen's edit affordance
 * and the roll both land here, and the roll has already created the row.
 */
export async function upsertLine(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  input: UpsertLineInput,
) {
  const budgetRows = await executor
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, input.budgetId), eq(budgets.userId, context.userId)));
  const budget = budgetRows[0];
  if (budget === undefined) {
    throw new BudgetingError('budgeting.budget_not_found', `no budget ${input.budgetId}`);
  }

  const existing = await executor
    .select()
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetPeriodId, input.periodId),
        eq(budgetLines.categoryId, input.categoryId),
        eq(budgetLines.userId, context.userId),
      ),
    );

  const patch = {
    rolloverPolicy: input.rolloverPolicy ?? 'ROLLOVER',
    goalType: input.goalType ?? 'NONE',
    goalAmountMinor: input.goalAmountMinor ?? null,
    goalTargetDate: input.goalTargetDate ?? null,
    goalPercent: input.goalPercent ?? null,
    priority: input.priority ?? 100,
    class: input.class ?? null,
    dirty: true,
    updatedAt: context.clock.now(),
  };

  const found = existing[0];
  if (found !== undefined) {
    const updated = await executor
      .update(budgetLines)
      .set(patch)
      .where(eq(budgetLines.id, found.id))
      .returning();
    return updated[0];
  }

  const inserted = await executor
    .insert(budgetLines)
    .values({
      id: newId(),
      userId: context.userId,
      budgetId: budget.id,
      budgetPeriodId: input.periodId,
      kind: 'category',
      categoryId: input.categoryId,
      creditAccountId: null,
      currency: budget.currency,
      ...patch,
    })
    .returning();
  return inserted[0];
}
