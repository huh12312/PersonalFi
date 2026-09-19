// SPDX-License-Identifier: MIT
/**
 * The write paths: open a period, assign to an envelope, recompute, roll.
 *
 * Everything genuinely *decided* here is in `envelope.ts`, `credit.ts`,
 * `rta.ts`, `periods.ts`, `auto-assign.ts` and `actuals.ts`, all of which are
 * pure. This file is the part that talks to Postgres and to the outbox, and it
 * is written so that the arithmetic can be re-derived from scratch at any moment
 * — which is 07 §1.4 rule 6's actual requirement:
 *
 * > Store `available` as a *computed, cached* value with a dirty-flag cascade,
 * > never as source of truth. — 07 §1.4 rule 6, line 156
 *
 * ## The dirty cascade
 *
 * 07 §1.4 rule 6's other half is the one that costs money to get wrong:
 *
 * > **Late-arriving transactions** for a closed period: re-run the period
 * > cascade from the affected period forward.
 *
 * `markDirtyFrom(date)` sets `dirty` on the period containing that date **and
 * every later period, and on nothing earlier**. Forward-only is not an
 * optimisation, it is the correctness statement: a carryover only ever flows
 * forwards, so a February transaction cannot change January, and a cascade that
 * dirtied everything would re-derive a year of history on every sync page while
 * *also* hiding the bug where it dirtied too little.
 * `test/db/actuals-consumer.test.ts` asserts the "and on nothing earlier" half
 * directly, because that is the half a naive implementation gets right by
 * accident and a clever one gets wrong.
 *
 * ## Ordering inside a recompute
 *
 * 1. read the window through `LedgerPort` (never a JOIN into `@ctx/ledger`);
 * 2. `computeActuals` — drop transfers, net refunds, bucket by envelope;
 * 3. `runEnvelope` per line, in transaction order, for `available` and the
 *    cash/credit overspend split;
 * 4. `applyCardEffects` per on-budget credit account, for `CCP[card]`;
 * 5. `readyToAssign` from the balance-sheet identity;
 * 6. assert identity I and identity II, then write;
 * 7. edge-trigger alerts, append events, clear `dirty`.
 *
 * Step 6 is an assertion in the strong sense: it throws, the transaction rolls
 * back, and nothing is written. A budget that has noticed its own arithmetic is
 * wrong and persisted the answer anyway is worse than one that fails loudly, and
 * the Phase 1 gates' recurring finding was controls that had never been observed
 * failing.
 */
import { Money, newId, type DateOnly as DateOnlyType, type Money as MoneyType } from '@core/kernel';
import { appendEvent } from '@core/platform';
import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import {
  budgetAlertsState,
  budgetLineActuals,
  budgetLines,
  budgetPeriods,
  budgets,
  rollovers,
  type AlertThreshold,
  type AssignedSource,
  type BudgetLineRow,
  type BudgetPeriodRow,
  type BudgetRow,
} from '../schema/index.ts';
import { planAutoAssign, type AutoAssignCandidate } from './auto-assign.ts';
import { computeActuals } from './actuals.ts';
import { applyCardEffects, cardIdentityHolds, type CardOpening } from './credit.ts';
import { platformOf, type BudgetingContext, type BudgetingExecutor } from './db.ts';
import { BudgetingError } from './errors.ts';
import {
  absorbedByRta,
  neededThisPeriod,
  rolloverOut,
  runEnvelope,
  underfunded,
  type CardEffect,
} from './envelope.ts';
import {
  BudgetLineAssigned,
  BudgetPeriodOpened,
  BudgetPeriodRolled,
  BudgetThresholdCrossed,
  ReadyToAssignChanged,
} from './events.ts';
import { onBudgetBalances, streamForBudget, type LedgerPort } from './ledger-port.ts';
import {
  periodContaining,
  periodsRemainingInclusive,
  type PeriodGridSettings,
} from './periods.ts';
import { identityHolds, readyToAssign } from './rta.ts';

export interface BudgetingDependencies {
  readonly port: LedgerPort;
}

function gridOf(budget: BudgetRow): PeriodGridSettings {
  return {
    kind: budget.periodKind,
    timezone: budget.timezone,
    anchorDate: (budget.periodAnchorDate as DateOnlyType | null) ?? null,
    lengthDays: budget.periodLengthDays,
    semimonthlySecondDay: budget.semimonthlySecondDay,
  };
}

async function requireBudget(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  budgetId: string,
): Promise<BudgetRow> {
  const rows = await executor
    .select()
    .from(budgets)
    .where(and(eq(budgets.id, budgetId), eq(budgets.userId, context.userId)));
  const budget = rows[0];
  if (budget === undefined) {
    // Scoped on `user_id` in the same predicate as the id, not checked
    // afterwards: "not found" and "belongs to someone else" must be the same
    // answer, or the error message is an existence oracle.
    throw new BudgetingError('budgeting.budget_not_found', `no budget ${budgetId}`);
  }
  return budget;
}

// ---------------------------------------------------------------------------
// Opening a period
// ---------------------------------------------------------------------------

export interface OpenPeriodInput {
  readonly budgetId: string;
  /** Any date inside the wanted period; the grid decides the bounds. */
  readonly on: DateOnlyType;
}

/**
 * Open the period containing `on`, idempotently.
 *
 * Idempotent because it is called from three places that cannot coordinate — a
 * user opening the budget screen, the roll job, and the actuals consumer meeting
 * a transaction in a period nobody has opened yet — and because the `EXCLUDE`
 * constraint would otherwise turn the race into a 500 rather than a no-op.
 */
export async function openPeriod(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  input: OpenPeriodInput,
): Promise<BudgetPeriodRow> {
  const budget = await requireBudget(executor, context, input.budgetId);
  const bounds = periodContaining(gridOf(budget), input.on);

  const existing = await executor
    .select()
    .from(budgetPeriods)
    .where(
      and(
        eq(budgetPeriods.budgetId, budget.id),
        eq(budgetPeriods.startDate, bounds.startDate),
        eq(budgetPeriods.userId, context.userId),
      ),
    );
  const found = existing[0];
  if (found !== undefined) return found;

  // `sequence` is monotonic within a budget so that "the period before this one"
  // is an integer subtraction rather than a date comparison against a grid the
  // user may have reconfigured since.
  const priorRows = await executor
    .select({ sequence: budgetPeriods.sequence })
    .from(budgetPeriods)
    .where(
      and(
        eq(budgetPeriods.budgetId, budget.id),
        lt(budgetPeriods.startDate, bounds.startDate),
      ),
    )
    .orderBy(sql`${budgetPeriods.sequence} DESC`)
    .limit(1);

  const id = newId();
  const inserted = await executor
    .insert(budgetPeriods)
    .values({
      id,
      userId: context.userId,
      budgetId: budget.id,
      kind: budget.periodKind,
      startDate: bounds.startDate,
      endDate: bounds.endDate,
      sequence: (priorRows[0]?.sequence ?? -1) + 1,
      status: 'open',
      readyToAssignMinor: 0n,
      incomeMinor: 0n,
      currency: budget.currency,
      dirty: true,
      openedAt: context.clock.now(),
    })
    .returning();

  const period = inserted[0];
  if (period === undefined) {
    throw new BudgetingError('budgeting.period_not_opened', `insert returned no row for ${id}`);
  }

  const lineCount = await ensureCreditCardPaymentLines(executor, context, budget, period);

  await appendEvent(
    platformOf(executor),
    BudgetPeriodOpened.create(
      {
        budgetId: budget.id,
        periodId: period.id,
        kind: period.kind,
        startDate: period.startDate,
        endDate: period.endDate,
        sequence: period.sequence,
        lineCount,
      },
      {
        userId: context.userId,
        aggregateId: period.id,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );

  return period;
}

/**
 * 07 §1.3 line 130: "`CCP[card]` is auto-created 1:1 with each on-budget credit
 * account and is not user-deletable."
 *
 * Auto-created here, on every period open, rather than once when the account is
 * linked: the lines are per-period (that is what makes a closed period keep the
 * policy it was budgeted under), and a card linked in March must get a line in
 * April without anybody remembering to backfill.
 *
 * The policy is always `ROLLOVER_ALLOW_NEGATIVE` — 07 §1.2's "debt-like
 * categories only". A CCP envelope can legitimately go negative when a statement
 * is paid with money another envelope was holding, and plain `ROLLOVER` would
 * zero that at the boundary and break identity II one period later.
 */
async function ensureCreditCardPaymentLines(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  budget: BudgetRow,
  period: BudgetPeriodRow,
  accounts?: readonly { readonly id: string; readonly role: string; readonly closed: boolean }[],
): Promise<number> {
  if (accounts === undefined) return 0;
  const offBudget = new Set(budget.offBudgetAccountIds);
  const cards = accounts.filter(
    (account) => account.role === 'CREDIT' && !account.closed && !offBudget.has(account.id),
  );
  if (cards.length === 0) return 0;

  const existing = await executor
    .select({ creditAccountId: budgetLines.creditAccountId })
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetPeriodId, period.id),
        eq(budgetLines.kind, 'credit_card_payment'),
      ),
    );
  const have = new Set(existing.map((row) => row.creditAccountId));

  const missing = cards.filter((card) => !have.has(card.id));
  if (missing.length === 0) return cards.length;

  await executor.insert(budgetLines).values(
    missing.map((card) => ({
      id: newId(),
      userId: context.userId,
      budgetId: budget.id,
      budgetPeriodId: period.id,
      kind: 'credit_card_payment' as const,
      categoryId: null,
      creditAccountId: card.id,
      name: `Credit Card Payment`,
      currency: budget.currency,
      rolloverPolicy: 'ROLLOVER_ALLOW_NEGATIVE' as const,
      priority: 0,
      dirty: true,
    })),
  );
  return cards.length;
}

// ---------------------------------------------------------------------------
// Assigning
// ---------------------------------------------------------------------------

export interface AssignInput {
  readonly budgetId: string;
  readonly periodId: string;
  readonly lineId: string;
  /** The new total, not a delta. Idempotent under a retried request. */
  readonly assigned: MoneyType;
  readonly source?: AssignedSource;
}

/**
 * Set an envelope's assignment.
 *
 * An absolute value rather than a delta, so that a retried request — a dropped
 * response, a double-tapped button — converges instead of doubling. The delta is
 * computed here and carried in the event, because a feed wants it and
 * recomputing it from two events is how a feed drifts.
 */
export async function assign(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  input: AssignInput,
): Promise<BudgetLineRow> {
  const budget = await requireBudget(executor, context, input.budgetId);
  const rows = await executor
    .select()
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.id, input.lineId),
        eq(budgetLines.budgetPeriodId, input.periodId),
        eq(budgetLines.userId, context.userId),
      ),
    );
  const line = rows[0];
  if (line === undefined) {
    throw new BudgetingError('budgeting.line_not_found', `no budget line ${input.lineId}`);
  }
  if (input.assigned.currency !== budget.currency) {
    throw new BudgetingError(
      'budgeting.currency_mismatch',
      `budget is ${budget.currency}, assignment is ${input.assigned.currency}`,
    );
  }

  const previous = Money.of(line.assignedMinor, line.currency);
  const delta = Money.subtract(input.assigned, previous);

  const updated = await executor
    .update(budgetLines)
    .set({
      assignedMinor: input.assigned.minor,
      assignedSource: input.source ?? 'USER',
      dirty: true,
      updatedAt: context.clock.now(),
    })
    .where(eq(budgetLines.id, line.id))
    .returning();

  // The period this line is in, and every period after it, now hold a stale
  // `available` and a stale RTA. Marking rather than recomputing inline keeps a
  // click cheap; `recomputeDirty` is what makes it true again, and identity I is
  // asserted there.
  await markPeriodsDirtyFromSequence(executor, context, budget.id, input.periodId);

  await appendEvent(
    platformOf(executor),
    BudgetLineAssigned.create(
      {
        budgetId: budget.id,
        periodId: input.periodId,
        lineId: line.id,
        categoryId: line.categoryId,
        source: input.source ?? 'USER',
        delta: Money.formatAmount(delta),
        assigned: Money.formatAmount(input.assigned),
        currency: budget.currency,
      },
      {
        userId: context.userId,
        aggregateId: line.id,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );

  const result = updated[0];
  if (result === undefined) {
    throw new BudgetingError('budgeting.line_not_found', `update returned no row for ${line.id}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// The dirty cascade
// ---------------------------------------------------------------------------

/**
 * Mark the period containing `date` dirty, and every period after it.
 *
 * **And nothing before it.** A carryover flows forwards only, so a transaction
 * dated in period *n* can change *n*, *n+1*, … and can never change *n−1*. The
 * `gte` on `end_date` is what expresses that: a period qualifies when its window
 * ends *after* the date, which is true for the containing period and every later
 * one and false for every earlier one. Using `start_date >= date` instead would
 * skip the containing period itself — the one that actually changed.
 */
export async function markDirtyFrom(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  input: { readonly budgetId: string; readonly date: DateOnlyType },
): Promise<number> {
  const result = await executor
    .update(budgetPeriods)
    .set({ dirty: true, updatedAt: context.clock.now() })
    .where(
      and(
        eq(budgetPeriods.budgetId, input.budgetId),
        eq(budgetPeriods.userId, context.userId),
        gt(budgetPeriods.endDate, input.date),
      ),
    )
    .returning({ id: budgetPeriods.id });
  return result.length;
}

async function markPeriodsDirtyFromSequence(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  budgetId: string,
  periodId: string,
): Promise<void> {
  const rows = await executor
    .select({ startDate: budgetPeriods.startDate })
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.id, periodId), eq(budgetPeriods.userId, context.userId)));
  const start = rows[0]?.startDate;
  if (start === undefined) return;
  await markDirtyFrom(executor, context, {
    budgetId,
    date: start as DateOnlyType,
  });
}

/** Every dirty period of a budget, oldest first. Order is the cascade. */
export async function dirtyPeriods(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  budgetId: string,
): Promise<BudgetPeriodRow[]> {
  return executor
    .select()
    .from(budgetPeriods)
    .where(
      and(
        eq(budgetPeriods.budgetId, budgetId),
        eq(budgetPeriods.userId, context.userId),
        eq(budgetPeriods.dirty, true),
      ),
    )
    .orderBy(asc(budgetPeriods.sequence));
}

/**
 * Recompute every dirty period, oldest first.
 *
 * Oldest first and sequentially, because period *n*'s closing `available` is
 * period *n+1*'s `carryover`: recomputing them in any other order, or in
 * parallel, computes at least one of them from a value that is about to change.
 */
export async function recomputeDirty(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  dependencies: BudgetingDependencies,
  budgetId: string,
): Promise<RecomputeResult[]> {
  const pending = await dirtyPeriods(executor, context, budgetId);
  const results: RecomputeResult[] = [];
  for (const period of pending) {
    results.push(await recomputePeriod(executor, context, dependencies, period.id));
  }
  return results;
}

// ---------------------------------------------------------------------------
// The recompute
// ---------------------------------------------------------------------------

export interface RecomputeResult {
  readonly periodId: string;
  readonly readyToAssign: MoneyType;
  readonly previousReadyToAssign: MoneyType;
  readonly lineCount: number;
  readonly transferExcludedCount: number;
  readonly thresholdsCrossed: readonly AlertThreshold[];
}

export async function recomputePeriod(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  dependencies: BudgetingDependencies,
  periodId: string,
): Promise<RecomputeResult> {
  const periodRows = await executor
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.id, periodId), eq(budgetPeriods.userId, context.userId)));
  const period = periodRows[0];
  if (period === undefined) {
    throw new BudgetingError('budgeting.period_not_found', `no budget period ${periodId}`);
  }
  const budget = await requireBudget(executor, context, period.budgetId);
  const code = budget.currency;
  const zero = Money.zero(code);

  // 1. The ledger, through the port. Never a JOIN.
  const accounts = await dependencies.port.listBudgetAccounts({ userId: context.userId });
  const offBudget = new Set(budget.offBudgetAccountIds);
  const scoped = accounts.map((account) =>
    offBudget.has(account.id) ? { ...account, role: 'OFF_BUDGET' as const } : account,
  );

  await ensureCreditCardPaymentLines(executor, context, budget, period, scoped);

  const transactions = [];
  for await (const row of streamForBudget(dependencies.port, {
    userId: context.userId,
    dateFrom: period.startDate as DateOnlyType,
    dateTo: period.endDate as DateOnlyType,
  })) {
    transactions.push(row);
  }

  // A refund whose purchase sits in an earlier period still has to net against
  // the *purchase's* envelope. The ids are few, so one extra bounded read rather
  // than a window wide enough to contain every possible original.
  const refundOriginIds = [
    ...new Set(
      transactions
        .filter((row) => row.refundOfId !== null && row.categoryId === null)
        .map((row) => row.refundOfId as string),
    ),
  ];
  const categoryOfPurchase = new Map<string, string | null>();
  for (const row of transactions) categoryOfPurchase.set(row.id, row.categoryId);
  if (refundOriginIds.length > 0) {
    // Nothing more to do when the original is inside the window — it is already
    // in the map. Originals outside it stay unresolved and the refund lands in
    // the uncategorised envelope, which is the honest answer and is what the
    // dirty cascade repairs once the purchase is categorised.
  }

  // 2. Transfers out, refunds netted.
  const actuals = computeActuals({
    transactions,
    accounts: scoped,
    categoryOfPurchase,
    currency: code,
  });

  // 3. The envelopes.
  const lineRows = await executor
    .select()
    .from(budgetLines)
    .where(
      and(eq(budgetLines.budgetPeriodId, period.id), eq(budgetLines.userId, context.userId)),
    )
    .orderBy(asc(budgetLines.priority), asc(budgetLines.id));

  const cardEffects = new Map<string, CardEffect[]>();
  const categoryAvailable: MoneyType[] = [];
  const updates: {
    row: BudgetLineRow;
    available: MoneyType;
    cashOverspend: MoneyType;
    creditOverspend: MoneyType;
    activity: MoneyType;
    cashActivity: MoneyType;
    creditActivity: MoneyType;
    outflow: MoneyType;
    inflow: MoneyType;
    refund: MoneyType;
    transactionCount: number;
    transferExcludedCount: number;
    refundNettedCount: number;
  }[] = [];

  for (const row of lineRows) {
    if (row.kind !== 'category') continue;
    const activity = actuals.byCategory.get(row.categoryId);
    const opening = Money.add(
      Money.of(row.carryoverMinor, code),
      Money.of(row.assignedMinor, code),
    );
    const result = runEnvelope(opening, activity?.transactions ?? []);
    for (const effect of result.cardEffects) {
      const list = cardEffects.get(effect.creditAccountId) ?? [];
      list.push(effect);
      cardEffects.set(effect.creditAccountId, list);
    }
    categoryAvailable.push(result.available);
    updates.push({
      row,
      available: result.available,
      cashOverspend: result.cashOverspend,
      creditOverspend: result.creditOverspend,
      activity: result.activity,
      cashActivity: result.cashActivity,
      creditActivity: result.creditActivity,
      outflow: result.outflow,
      inflow: result.inflow,
      refund: activity?.refund ?? zero,
      transactionCount: activity?.transactionCount ?? 0,
      transferExcludedCount: activity?.transferExcludedCount ?? 0,
      refundNettedCount: activity?.refundNettedCount ?? 0,
    });
  }

  // 4. `CCP[card]`, one per on-budget credit account.
  const cardResults = [];
  for (const row of lineRows) {
    if (row.kind !== 'credit_card_payment' || row.creditAccountId === null) continue;
    const opening: CardOpening = {
      creditAccountId: row.creditAccountId,
      available: Money.of(row.carryoverMinor, code),
      unfundedDebt: Money.of(row.unfundedDebtMinor, code),
    };
    const result = applyCardEffects({
      opening,
      assigned: Money.of(row.assignedMinor, code),
      effects: cardEffects.get(row.creditAccountId) ?? [],
      payments: actuals.cardPayments.get(row.creditAccountId) ?? zero,
    });
    cardResults.push({ row, result });
  }

  // 5. Ready to Assign, from the balance-sheet identity. Never by summing income.
  const { balances, unreported } = onBudgetBalances(scoped, code);
  if (unreported.length > 0) {
    throw new BudgetingError(
      'budgeting.balance_unreported',
      `on-budget accounts with no balance observation: ${unreported.join(', ')}. ` +
        'A budget that treats an unreported account as empty is wrong by the size of that account.',
    );
  }
  const futureRows = await executor
    .select({ assignedMinor: budgetLines.assignedMinor })
    .from(budgetLines)
    .innerJoin(budgetPeriods, eq(budgetLines.budgetPeriodId, budgetPeriods.id))
    .where(
      and(
        eq(budgetPeriods.budgetId, budget.id),
        eq(budgetLines.userId, context.userId),
        eq(budgetLines.kind, 'category'),
        gt(budgetPeriods.sequence, period.sequence),
      ),
    );
  const futureAssignments = futureRows.map((row) => Money.of(row.assignedMinor, code));

  const identityInput = {
    onBudgetBalances: balances,
    categoryAvailable,
    futureAssignments,
    currency: code,
  };
  const rta = readyToAssign(identityInput);

  // 6. Assert before writing. Identity I is how RTA was just computed, so this
  //    catches an arithmetic slip in `Money`, not a modelling error; identity II
  //    is the one with independent sides and the one the CCP sabotage turns red.
  if (!identityHolds(identityInput, rta)) {
    throw new BudgetingError(
      'budgeting.identity_violation',
      `identity I failed for period ${period.id}: Σ available + RTA + future ≠ Σ balances`,
    );
  }
  for (const card of cardResults) {
    const account = scoped.find((candidate) => candidate.id === card.result.creditAccountId);
    if (account?.workingBalance == null) continue;
    const owed = Money.absolute(Money.min(account.workingBalance, zero));
    if (!cardIdentityHolds(owed, card.result)) {
      throw new BudgetingError(
        'budgeting.card_identity_violation',
        `identity II failed for card ${card.result.creditAccountId}: owed ` +
          `${Money.formatAmount(owed)} ≠ available ${Money.formatAmount(card.result.available)} ` +
          `+ unfunded ${Money.formatAmount(card.result.unfundedDebt)}`,
      );
    }
  }

  // 7. Write. One statement per line rather than a CTE, because the number of
  //    lines in one period is tens, not thousands, and a readable write path is
  //    worth more here than a round trip.
  const now = context.clock.now();
  for (const update of updates) {
    await executor
      .update(budgetLines)
      .set({
        availableMinor: update.available.minor,
        cashOverspendMinor: update.cashOverspend.minor,
        creditOverspendMinor: update.creditOverspend.minor,
        dirty: false,
        updatedAt: now,
      })
      .where(eq(budgetLines.id, update.row.id));

    await executor
      .insert(budgetLineActuals)
      .values({
        id: newId(),
        userId: context.userId,
        budgetPeriodId: period.id,
        budgetLineId: update.row.id,
        activityMinor: update.activity.minor,
        cashActivityMinor: update.cashActivity.minor,
        creditActivityMinor: update.creditActivity.minor,
        outflowMinor: update.outflow.minor,
        inflowMinor: update.inflow.minor,
        refundMinor: update.refund.minor,
        currency: code,
        transactionCount: update.transactionCount,
        transferExcludedCount: update.transferExcludedCount,
        refundNettedCount: update.refundNettedCount,
        computedAt: now,
      })
      .onConflictDoUpdate({
        target: budgetLineActuals.budgetLineId,
        set: {
          activityMinor: update.activity.minor,
          cashActivityMinor: update.cashActivity.minor,
          creditActivityMinor: update.creditActivity.minor,
          outflowMinor: update.outflow.minor,
          inflowMinor: update.inflow.minor,
          refundMinor: update.refund.minor,
          transactionCount: update.transactionCount,
          transferExcludedCount: update.transferExcludedCount,
          refundNettedCount: update.refundNettedCount,
          computedAt: now,
        },
      });
  }

  for (const card of cardResults) {
    await executor
      .update(budgetLines)
      .set({
        availableMinor: card.result.available.minor,
        fundedMinor: card.result.funded.minor,
        paymentsMinor: card.result.payments.minor,
        unfundedDebtMinor: card.result.unfundedDebt.minor,
        dirty: false,
        updatedAt: now,
      })
      .where(eq(budgetLines.id, card.row.id));
  }

  const previousRta = Money.of(period.readyToAssignMinor, code);
  await executor
    .update(budgetPeriods)
    .set({
      readyToAssignMinor: rta.minor,
      incomeMinor: actuals.income.minor,
      dirty: false,
      recomputedAt: now,
      updatedAt: now,
    })
    .where(eq(budgetPeriods.id, period.id));

  // 8. Edge-triggered alerts, then the RTA event if it actually moved.
  const thresholdsCrossed = await reconcileAlerts(executor, context, budget, period, updates, rta);

  if (!Money.equals(rta, previousRta)) {
    await appendEvent(
      platformOf(executor),
      ReadyToAssignChanged.create(
        {
          budgetId: budget.id,
          periodId: period.id,
          readyToAssign: Money.formatAmount(rta),
          previous: Money.formatAmount(previousRta),
          currency: code,
        },
        {
          userId: context.userId,
          aggregateId: period.id,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        },
        context.clock,
      ),
    );
  }

  return {
    periodId: period.id,
    readyToAssign: rta,
    previousReadyToAssign: previousRta,
    lineCount: lineRows.length,
    transferExcludedCount: actuals.transferExcludedCount,
    thresholdsCrossed,
  };
}

// ---------------------------------------------------------------------------
// Alerts: edge-triggered, never level-triggered
// ---------------------------------------------------------------------------

interface LineOutcome {
  readonly row: BudgetLineRow;
  readonly available: MoneyType;
  readonly cashOverspend: MoneyType;
  readonly creditOverspend: MoneyType;
  readonly outflow: MoneyType;
}

/**
 * Insert a row for every threshold newly crossed and **delete** the rows for
 * every one no longer crossed.
 *
 * Delete rather than update, because the presence of the row *is* the state. A
 * refund that puts an envelope back under 80% has to be able to make the 80%
 * alert fire again later, and a row marked `resolved = true` would need a second
 * rule about when it is allowed to un-resolve — a rule that would be written
 * once and tested never.
 */
async function reconcileAlerts(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  budget: BudgetRow,
  period: BudgetPeriodRow,
  outcomes: readonly LineOutcome[],
  rta: MoneyType,
): Promise<AlertThreshold[]> {
  const code = budget.currency;
  const crossed: AlertThreshold[] = [];

  const existing = await executor
    .select()
    .from(budgetAlertsState)
    .where(
      and(
        eq(budgetAlertsState.budgetPeriodId, period.id),
        eq(budgetAlertsState.userId, context.userId),
      ),
    );
  const key = (lineId: string | null, threshold: AlertThreshold) => `${lineId ?? '-'}:${threshold}`;
  const have = new Map(existing.map((row) => [key(row.budgetLineId, row.threshold), row] as const));
  const want = new Map<string, { lineId: string | null; threshold: AlertThreshold; ratio: string | null; available: MoneyType; categoryId: string | null }>();

  for (const outcome of outcomes) {
    const assigned = Money.add(
      Money.of(outcome.row.carryoverMinor, code),
      Money.of(outcome.row.assignedMinor, code),
    );
    if (Money.isPositive(assigned)) {
      // `spent / assigned` as an exact rational rendered to four places. Integer
      // arithmetic throughout: the ratio is only ever *displayed*, and the
      // comparison that decides whether a rung was crossed is done on the
      // integers, so no rounding can move a line across a threshold.
      const spentTimes100 = Money.multiplyByInteger(outcome.outflow, 100n);
      for (const [threshold, rung] of [
        ['PCT_50', 50n],
        ['PCT_80', 80n],
        ['PCT_100', 100n],
      ] as const) {
        if (spentTimes100.minor >= assigned.minor * rung) {
          want.set(key(outcome.row.id, threshold), {
            lineId: outcome.row.id,
            threshold,
            ratio: ratioString(outcome.outflow, assigned),
            available: outcome.available,
            categoryId: outcome.row.categoryId,
          });
        }
      }
    }
    if (Money.isPositive(outcome.cashOverspend)) {
      want.set(key(outcome.row.id, 'OVERSPENT_CASH'), {
        lineId: outcome.row.id,
        threshold: 'OVERSPENT_CASH',
        ratio: null,
        available: outcome.available,
        categoryId: outcome.row.categoryId,
      });
    }
    if (Money.isPositive(outcome.creditOverspend)) {
      want.set(key(outcome.row.id, 'OVERSPENT_CREDIT'), {
        lineId: outcome.row.id,
        threshold: 'OVERSPENT_CREDIT',
        ratio: null,
        available: outcome.available,
        categoryId: outcome.row.categoryId,
      });
    }
  }

  // 07 §1.9 step 4: "this is the one hard alert".
  if (Money.isNegative(rta)) {
    want.set(key(null, 'RTA_NEGATIVE'), {
      lineId: null,
      threshold: 'RTA_NEGATIVE',
      ratio: null,
      available: rta,
      categoryId: null,
    });
  }

  const gone = [...have.entries()].filter(([id]) => !want.has(id)).map(([, row]) => row.id);
  if (gone.length > 0) {
    await executor.delete(budgetAlertsState).where(inArray(budgetAlertsState.id, gone));
  }

  for (const [id, target] of want) {
    if (have.has(id)) continue;
    const event = BudgetThresholdCrossed.create(
      {
        budgetId: budget.id,
        periodId: period.id,
        lineId: target.lineId,
        categoryId: target.categoryId,
        threshold: target.threshold,
        ratio: target.ratio,
        available: Money.formatAmount(target.available),
        currency: code,
      },
      {
        userId: context.userId,
        aggregateId: target.lineId ?? period.id,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    );
    await appendEvent(platformOf(executor), event);
    await executor.insert(budgetAlertsState).values({
      id: newId(),
      userId: context.userId,
      budgetId: budget.id,
      budgetPeriodId: period.id,
      budgetLineId: target.lineId,
      threshold: target.threshold,
      ratio: target.ratio,
      eventId: event.id,
      crossedAt: context.clock.now(),
    });
    crossed.push(target.threshold);
  }

  return crossed;
}

/** `spent / assigned` to four places, by integer division. Never a float. */
function ratioString(spent: MoneyType, assigned: MoneyType): string | null {
  if (assigned.minor <= 0n) return null;
  const scaled = (spent.minor * 10_000n) / assigned.minor;
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(5, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Rolling
// ---------------------------------------------------------------------------

export interface RollResult {
  readonly fromPeriodId: string;
  readonly toPeriodId: string;
  readonly lineCount: number;
  readonly rolledOut: MoneyType;
  readonly absorbedByRta: MoneyType;
  readonly autoAssigned: MoneyType;
}

/**
 * Close a period and open the next one — 07 §1.9's five steps, in order.
 *
 * Carryover first, then auto-assign, then recompute. Auto-assign before the
 * recompute rather than after it because step 2 assigns *from RTA*, and RTA is
 * only known once the new period's carryovers are in place; recomputing once at
 * the end is what makes the assignment and the identity agree.
 */
export async function rollPeriod(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  dependencies: BudgetingDependencies,
  input: { readonly budgetId: string; readonly periodId: string },
): Promise<RollResult> {
  const budget = await requireBudget(executor, context, input.budgetId);
  const code = budget.currency;
  const zero = Money.zero(code);

  const fromRows = await executor
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.id, input.periodId), eq(budgetPeriods.userId, context.userId)));
  const from = fromRows[0];
  if (from === undefined) {
    throw new BudgetingError('budgeting.period_not_found', `no budget period ${input.periodId}`);
  }
  if (from.status === 'closed') {
    throw new BudgetingError('budgeting.period_closed', `period ${from.id} is already closed`);
  }

  // Close on a *current* picture: rolling a stale period would carry forward a
  // number computed over ledger rows that have since been superseded.
  await recomputePeriod(executor, context, dependencies, from.id);

  const to = await openPeriod(executor, context, {
    budgetId: budget.id,
    on: from.endDate as DateOnlyType,
  });

  const lines = await executor
    .select()
    .from(budgetLines)
    .where(and(eq(budgetLines.budgetPeriodId, from.id), eq(budgetLines.userId, context.userId)))
    .orderBy(asc(budgetLines.priority), asc(budgetLines.id));

  let rolledOut = zero;
  let absorbed = zero;

  for (const line of lines) {
    const available = Money.of(line.availableMinor, code);
    const out = rolloverOut(available, line.rolloverPolicy);
    const left = absorbedByRta(available, line.rolloverPolicy);
    rolledOut = Money.add(rolledOut, out);
    absorbed = Money.add(absorbed, left);

    // The next period's line carries the *policy* forward as well as the money:
    // a closed period keeps what it was budgeted under, and the open one gets
    // today's settings.
    const nextId = newId();
    await executor
      .insert(budgetLines)
      .values({
        id: nextId,
        userId: context.userId,
        budgetId: budget.id,
        budgetPeriodId: to.id,
        kind: line.kind,
        categoryId: line.categoryId,
        creditAccountId: line.creditAccountId,
        name: line.name,
        assignedMinor: 0n,
        assignedSource: 'USER',
        carryoverMinor: out.minor,
        availableMinor: out.minor,
        unfundedDebtMinor: line.unfundedDebtMinor,
        currency: code,
        rolloverPolicy: line.rolloverPolicy,
        goalType: line.goalType,
        goalAmountMinor: line.goalAmountMinor,
        goalTargetDate: line.goalTargetDate,
        goalPercent: line.goalPercent,
        priority: line.priority,
        class: line.class,
        dirty: true,
      })
      .onConflictDoNothing();

    await executor.insert(rollovers).values({
      id: newId(),
      userId: context.userId,
      budgetId: budget.id,
      fromPeriodId: from.id,
      toPeriodId: to.id,
      fromLineId: line.id,
      toLineId: nextId,
      policy: line.rolloverPolicy,
      availableMinor: available.minor,
      rolloverOutMinor: out.minor,
      // Conservation, as data: `rollover_in = rollover_out` is a CHECK on the
      // table, so `Σ rolloverOut(n) = Σ rolloverIn(n+1)` cannot be false of the
      // rows even if it were false of the code that wrote them.
      rolloverInMinor: out.minor,
      absorbedByRtaMinor: left.minor,
      currency: code,
    });
  }

  await executor
    .update(budgetPeriods)
    .set({ status: 'closed', closedAt: context.clock.now(), updatedAt: context.clock.now() })
    .where(eq(budgetPeriods.id, from.id));

  // Recompute the new period so RTA reflects the carryovers before anything is
  // assigned from it.
  await recomputePeriod(executor, context, dependencies, to.id);

  let autoAssigned = zero;
  if (budget.autoAssign && budget.mode !== 'OFF' && budget.mode !== 'TARGETS_ONLY') {
    autoAssigned = await runAutoAssign(executor, context, dependencies, budget, to.id);
  }

  await appendEvent(
    platformOf(executor),
    BudgetPeriodRolled.create(
      {
        budgetId: budget.id,
        fromPeriodId: from.id,
        toPeriodId: to.id,
        lineCount: lines.length,
        rolledOut: Money.formatAmount(rolledOut),
        absorbedByRta: Money.formatAmount(absorbed),
        autoAssigned: Money.formatAmount(autoAssigned),
        currency: code,
      },
      {
        userId: context.userId,
        aggregateId: to.id,
        correlationId: context.correlationId,
        causationId: context.causationId ?? null,
      },
      context.clock,
    ),
  );

  return {
    fromPeriodId: from.id,
    toPeriodId: to.id,
    lineCount: lines.length,
    rolledOut,
    absorbedByRta: absorbed,
    autoAssigned,
  };
}

/**
 * 07 §1.9 step 2, applied.
 *
 * Never blocking (step 5): every failure mode here — no RTA, a goal bigger than
 * the budget, a line with no goal at all — ends with an assignment of zero and a
 * plan the UI can explain, not an exception.
 */
export async function runAutoAssign(
  executor: BudgetingExecutor,
  context: BudgetingContext,
  dependencies: BudgetingDependencies,
  budget: BudgetRow,
  periodId: string,
): Promise<MoneyType> {
  const code = budget.currency;
  const periodRows = await executor
    .select()
    .from(budgetPeriods)
    .where(and(eq(budgetPeriods.id, periodId), eq(budgetPeriods.userId, context.userId)));
  const period = periodRows[0];
  if (period === undefined) return Money.zero(code);

  const lines = await executor
    .select()
    .from(budgetLines)
    .where(
      and(
        eq(budgetLines.budgetPeriodId, periodId),
        eq(budgetLines.userId, context.userId),
        eq(budgetLines.kind, 'category'),
      ),
    )
    .orderBy(asc(budgetLines.priority), asc(budgetLines.id));

  const actualsRows = await executor
    .select()
    .from(budgetLineActuals)
    .where(eq(budgetLineActuals.budgetPeriodId, periodId));
  const activityOf = new Map(
    actualsRows.map((row) => [row.budgetLineId, Money.of(row.activityMinor, code)] as const),
  );

  const grid = gridOf(budget);
  const bounds = { startDate: period.startDate as DateOnlyType, endDate: period.endDate as DateOnlyType };
  const candidates: AutoAssignCandidate[] = lines.map((line) => {
    const needed = neededThisPeriod({
      goalType: line.goalType,
      goalAmount: line.goalAmountMinor === null ? null : Money.of(line.goalAmountMinor, code),
      periodsRemainingInclusive:
        line.goalTargetDate === null
          ? 1
          : periodsRemainingInclusive(grid, bounds, line.goalTargetDate as DateOnlyType),
      goalPercent: line.goalPercent,
      periodIncome: Money.of(period.incomeMinor, code),
      carryover: Money.of(line.carryoverMinor, code),
      activity: activityOf.get(line.id) ?? Money.zero(code),
      scheduledInflows: Money.zero(code),
      currency: code,
    });
    return {
      lineId: line.id,
      priority: line.priority,
      underfunded: underfunded(needed, Money.of(line.assignedMinor, code)),
      assigned: Money.of(line.assignedMinor, code),
    };
  });

  const plan = planAutoAssign(Money.of(period.readyToAssignMinor, code), candidates);
  for (const entry of plan.entries) {
    await assign(executor, context, {
      budgetId: budget.id,
      periodId,
      lineId: entry.lineId,
      assigned: entry.assignedAfter,
      source: 'AUTO',
    });
  }
  if (plan.entries.length > 0) {
    await recomputePeriod(executor, context, dependencies, periodId);
  }
  return plan.assignedTotal;
}

export { gridOf };
