// SPDX-License-Identifier: MIT
/**
 * The read models the budget screen, the reports screen and the insight engine
 * all go through.
 *
 * Everything here returns `Money`, never minor units and never a `number`. The
 * API layer serialises with `Money.toJSON` (minor units as a *string*) and the
 * UI formats; no client-side money arithmetic beyond formatting, which is what
 * WP 2.9's evidence has to demonstrate. A reader that handed out `bigint`s
 * would push that decision outwards to every caller.
 */
import { Money, type DateOnly as DateOnlyType, type Money as MoneyType } from '@core/kernel';
import { and, asc, eq, gt } from 'drizzle-orm';
import {
  budgetLineActuals,
  budgetLines,
  budgetPeriods,
  budgets,
  type AlertThreshold,
  type BudgetClass,
  type GoalType,
  type LineKind,
  type PeriodKind,
  type PeriodStatus,
  type RolloverPolicy,
} from '../schema/index.ts';
import { neededThisPeriod, underfunded } from './envelope.ts';
import { toStayOnTrack } from './auto-assign.ts';
import { gridOf } from './service.ts';
import { periodsRemainingInclusive } from './periods.ts';
import type { BudgetingExecutor } from './db.ts';

export interface BudgetLineView {
  readonly id: string;
  readonly kind: LineKind;
  readonly categoryId: string | null;
  readonly creditAccountId: string | null;
  readonly name: string | null;
  readonly carryover: MoneyType;
  readonly assigned: MoneyType;
  readonly activity: MoneyType;
  readonly available: MoneyType;
  /** 07 §1.3's red half. Cash has already left a depository account. */
  readonly cashOverspend: MoneyType;
  /** 07 §1.3's yellow half. Borrowed on a card; no cash has moved. */
  readonly creditOverspend: MoneyType;
  readonly rolloverPolicy: RolloverPolicy;
  readonly goalType: GoalType;
  readonly neededThisPeriod: MoneyType;
  /** 07 §1.8 line 224. What drives "assign $X more to stay on track". */
  readonly underfunded: MoneyType;
  readonly priority: number;
  readonly class: BudgetClass | null;
  readonly transferExcludedCount: number;
  readonly refundNettedCount: number;
}

export interface BudgetPeriodView {
  readonly id: string;
  readonly budgetId: string;
  readonly kind: PeriodKind;
  readonly startDate: DateOnlyType;
  /** **Exclusive.** */
  readonly endDate: DateOnlyType;
  readonly sequence: number;
  readonly status: PeriodStatus;
  readonly readyToAssign: MoneyType;
  readonly income: MoneyType;
  readonly dirty: boolean;
  readonly lines: readonly BudgetLineView[];
  /** 07 §1.8 line 227: "to stay on track this month, assign $X more". */
  readonly toStayOnTrack: MoneyType;
  /** Σ of every category line's available. The left of identity I. */
  readonly totalCategoryAvailable: MoneyType;
  /** Σ of every CCP line's available. Deliberately *not* in identity I. */
  readonly totalCreditCardPaymentAvailable: MoneyType;
  /**
   * WP 10.11's "Left to budget" card: Σ `assigned` over the category lines that are **not** planned savings
   * (`isPlannedSavings`). With `plannedSavings` it partitions Σ assigned of every category line exactly.
   */
  readonly budgetedExpenses: MoneyType;
  /** Σ `assigned` over the category lines `isPlannedSavings` names. */
  readonly plannedSavings: MoneyType;
  /**
   * Σ `carryover` over the category lines: what the previous period's rollover policies brought into this one
   * (07 §1.2's `rollover_fn`, applied at the roll). Negative only under `ROLLOVER_ALLOW_NEGATIVE`.
   */
  readonly rolledOver: MoneyType;
}

/**
 * A category line whose assignment is money **set aside** rather than budgeted to spend (WP 10.11): the holder's
 * 50/30/20 class says `SAVINGS`, or — with no class — the line saves toward a dated target (`TARGET_BY_DATE`,
 * 07 §1.8's sinking fund). An explicit `NEED`/`WANT` class always wins over the goal type. CCP lines are neither.
 */
export function isPlannedSavings(
  line: Pick<BudgetLineView, 'kind' | 'class' | 'goalType'>,
): boolean {
  if (line.kind !== 'category') return false;
  if (line.class !== null) return line.class === 'SAVINGS';
  return line.goalType === 'TARGET_BY_DATE';
}

/**
 * One period with its envelopes, ready to render.
 *
 * `neededThisPeriod` and `underfunded` are computed here rather than stored,
 * because they are functions of a goal, a carryover and an activity total that
 * are all already on the row — storing them would add two more cached numbers
 * to keep in step with the cascade, for no read that is cheaper.
 */
export async function getPeriod(
  executor: BudgetingExecutor,
  input: { readonly userId: string; readonly periodId: string },
): Promise<BudgetPeriodView | null> {
  const periodRows = await executor
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.id, input.periodId), eq(budgetPeriods.userId, input.userId)));
  const period = periodRows[0];
  if (period === undefined) return null;

  const budgetRows = await executor
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, period.budgetId), eq(budgets.userId, input.userId)));
  const budget = budgetRows[0];
  if (budget === undefined) return null;

  const code = budget.currency;
  const zero = Money.zero(code);

  const lineRows = await executor
    .select()
    .from(budgetLines)
    .where(and(eq(budgetLines.budgetPeriodId, period.id), eq(budgetLines.userId, input.userId)))
    .orderBy(asc(budgetLines.priority), asc(budgetLines.id));

  const actualsRows = await executor
    .select()
    .from(budgetLineActuals)
    .where(eq(budgetLineActuals.budgetPeriodId, period.id));
  const actualsOf = new Map(actualsRows.map((row) => [row.budgetLineId, row] as const));

  const grid = gridOf(budget);
  const bounds = {
    startDate: period.startDate as DateOnlyType,
    endDate: period.endDate as DateOnlyType,
  };

  const lines: BudgetLineView[] = lineRows.map((row) => {
    const actuals = actualsOf.get(row.id);
    const activity = Money.of(actuals?.activityMinor ?? 0n, code);
    const needed = neededThisPeriod({
      goalType: row.goalType,
      goalAmount: row.goalAmountMinor === null ? null : Money.of(row.goalAmountMinor, code),
      periodsRemainingInclusive:
        row.goalTargetDate === null
          ? 1
          : periodsRemainingInclusive(grid, bounds, row.goalTargetDate as DateOnlyType),
      goalPercent: row.goalPercent,
      periodIncome: Money.of(period.incomeMinor, code),
      carryover: Money.of(row.carryoverMinor, code),
      activity,
      scheduledInflows: zero,
      currency: code,
    });
    const assigned = Money.of(row.assignedMinor, code);
    return {
      id: row.id,
      kind: row.kind,
      categoryId: row.categoryId,
      creditAccountId: row.creditAccountId,
      name: row.name,
      carryover: Money.of(row.carryoverMinor, code),
      assigned,
      activity,
      available: Money.of(row.availableMinor, code),
      cashOverspend: Money.of(row.cashOverspendMinor, code),
      creditOverspend: Money.of(row.creditOverspendMinor, code),
      rolloverPolicy: row.rolloverPolicy,
      goalType: row.goalType,
      neededThisPeriod: needed,
      underfunded: underfunded(needed, assigned),
      priority: row.priority,
      class: row.class,
      transferExcludedCount: actuals?.transferExcludedCount ?? 0,
      refundNettedCount: actuals?.refundNettedCount ?? 0,
    };
  });

  return {
    id: period.id,
    budgetId: period.budgetId,
    kind: period.kind,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    sequence: period.sequence,
    status: period.status,
    readyToAssign: Money.of(period.readyToAssignMinor, code),
    income: Money.of(period.incomeMinor, code),
    dirty: period.dirty,
    lines,
    toStayOnTrack: toStayOnTrack(
      lines
        .filter((line) => line.kind === 'category')
        .map((line) => ({
          lineId: line.id,
          priority: line.priority,
          underfunded: line.underfunded,
          assigned: line.assigned,
        })),
      code,
    ),
    totalCategoryAvailable: Money.sum(
      lines.filter((line) => line.kind === 'category').map((line) => line.available),
      code,
    ),
    totalCreditCardPaymentAvailable: Money.sum(
      lines.filter((line) => line.kind === 'credit_card_payment').map((line) => line.available),
      code,
    ),
    budgetedExpenses: Money.sum(
      lines
        .filter((line) => line.kind === 'category' && !isPlannedSavings(line))
        .map((line) => line.assigned),
      code,
    ),
    plannedSavings: Money.sum(
      lines.filter((line) => isPlannedSavings(line)).map((line) => line.assigned),
      code,
    ),
    rolledOver: Money.sum(
      lines.filter((line) => line.kind === 'category').map((line) => line.carryover),
      code,
    ),
  };
}

export interface BudgetPeriodSummary {
  readonly id: string;
  readonly kind: PeriodKind;
  readonly startDate: DateOnlyType;
  readonly endDate: DateOnlyType;
  readonly sequence: number;
  readonly status: PeriodStatus;
  readonly readyToAssign: MoneyType;
  readonly dirty: boolean;
}

/** Every period of a budget, oldest first. The period picker's data. */
export async function listPeriods(
  executor: BudgetingExecutor,
  input: { readonly userId: string; readonly budgetId: string },
): Promise<BudgetPeriodSummary[]> {
  const rows = await executor
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.budgetId, input.budgetId), eq(budgetPeriods.userId, input.userId)))
    .orderBy(asc(budgetPeriods.sequence));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    startDate: row.startDate as DateOnlyType,
    endDate: row.endDate as DateOnlyType,
    sequence: row.sequence,
    status: row.status,
    readyToAssign: Money.of(row.readyToAssignMinor, row.currency),
    dirty: row.dirty,
  }));
}

export async function listBudgets(executor: BudgetingExecutor, input: { readonly userId: string }) {
  return executor
    .select()
    .from(budgets)
    .where(eq(budgets.userId, input.userId))
    .orderBy(asc(budgets.createdAt));
}

/**
 * The terms of identity I, read back from what was persisted.
 *
 * Exported because the assertion belongs to *callers* as much as to the
 * recompute: `test/db/rta-identity.test.ts` asserts it after every mutation,
 * and the Phase 2 gate re-runs it. Each term comes from a different place —
 * available and RTA from this context's cached columns, balances from the ledger
 * through the port — which is what makes it catch a dirty cascade that failed to
 * fire rather than restating its own definition.
 */
export interface IdentityTerms {
  readonly categoryAvailable: readonly MoneyType[];
  readonly readyToAssign: MoneyType;
  readonly futureAssignments: readonly MoneyType[];
  readonly currency: string;
}

export async function identityTermsOf(
  executor: BudgetingExecutor,
  input: { readonly userId: string; readonly periodId: string },
): Promise<IdentityTerms | null> {
  const periodRows = await executor
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.id, input.periodId), eq(budgetPeriods.userId, input.userId)));
  const period = periodRows[0];
  if (period === undefined) return null;
  const code = period.currency;

  const lineRows = await executor
    .select({ availableMinor: budgetLines.availableMinor })
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetPeriodId, period.id),
        eq(budgetLines.userId, input.userId),
        eq(budgetLines.kind, 'category'),
      ),
    );

  const futureRows = await executor
    .select({ assignedMinor: budgetLines.assignedMinor })
    .from(budgetLines)
    .innerJoin(budgetPeriods, eq(budgetLines.budgetPeriodId, budgetPeriods.id))
    .where(
      and(
        eq(budgetPeriods.budgetId, period.budgetId),
        eq(budgetLines.userId, input.userId),
        eq(budgetLines.kind, 'category'),
        gt(budgetPeriods.sequence, period.sequence),
      ),
    );

  return {
    categoryAvailable: lineRows.map((row) => Money.of(row.availableMinor, code)),
    readyToAssign: Money.of(period.readyToAssignMinor, code),
    futureAssignments: futureRows.map((row) => Money.of(row.assignedMinor, code)),
    currency: code,
  };
}

export interface CardIdentityTerm {
  readonly creditAccountId: string;
  readonly available: MoneyType;
  readonly unfundedDebt: MoneyType;
}

/** The left-hand side of identity II, per card, read back from `budget_lines`. */
export async function cardIdentityTermsOf(
  executor: BudgetingExecutor,
  input: { readonly userId: string; readonly periodId: string },
): Promise<CardIdentityTerm[]> {
  const rows = await executor
    .select()
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetPeriodId, input.periodId),
        eq(budgetLines.userId, input.userId),
        eq(budgetLines.kind, 'credit_card_payment'),
      ),
    );
  return rows
    .filter((row): row is typeof row & { creditAccountId: string } => row.creditAccountId !== null)
    .map((row) => ({
      creditAccountId: row.creditAccountId,
      available: Money.of(row.availableMinor, row.currency),
      unfundedDebt: Money.of(row.unfundedDebtMinor, row.currency),
    }));
}

export type { AlertThreshold };
