// SPDX-License-Identifier: MIT
/**
 * The `@ctx/budgeting` test harness.
 *
 * `@core/testkit`, `@core/seed` and `fast-check` are dev-only dependencies of
 * this context, allowed by the `budgeting` entry in
 * `scripts/eslint-boundaries.js` rather than by an `eslint-disable` here — so
 * the looseness is visible in the policy instead of hidden at the top of a test
 * file. No file under `src/` imports any of them.
 *
 * ## The `LedgerPort` double, and what it can and cannot prove
 *
 * The boundary lint denies `@ctx/budgeting` → `@ctx/ledger` unconditionally, so
 * these suites cannot call the real `listTransactions`. `createFakeLedger` is
 * the stand-in and it lives in `src/ledger-port.ts`, not here, on purpose: the
 * Phase 2 gate's standard is that an independent reviewer re-runs the
 * load-bearing proofs, and a fake they have to re-implement is a fake that will
 * differ from this one in whichever direction makes the proof pass.
 *
 * What it cannot prove is that the real ledger's signatures still satisfy the
 * port. That check belongs at the composition root, where the adapter is
 * written; the exact lines `apps/api/src/domain.ts` needs are in the evidence
 * note, and the orchestrator compiling them is the check.
 *
 * ## Scratch databases
 *
 * One per suite, named from the suite, so nothing depends on execution order and
 * a failed suite leaves the others alone. `budgeting-db` runs with
 * `fileParallelism: false` (vitest.config.ts) because these are real databases
 * and the scratch-create/drop is the expensive part.
 */
import {
  Money,
  newId,
  type Clock,
  type DateOnly as DateOnlyType,
  type Money as MoneyType,
} from '@core/kernel';
import { ADMIN_URL, createTestDatabase, fixedClock, type TestDatabase } from '@core/testkit';
import { createBudget, type CreateBudgetInput } from '../src/budget.ts';
import { upsertLine } from '../src/budget.ts';
import { createFakeLedger, type BudgetAccount, type FakeLedger } from '../src/ledger-port.ts';
import type { BudgetingContext } from '../src/db.ts';
import { openPeriod } from '../src/service.ts';
import type { BudgetRow, BudgetPeriodRow } from '../schema/index.ts';

export { ADMIN_URL, createFakeLedger, type FakeLedger, type TestDatabase };

/** `describe.skipIf(NO_DATABASE)` — the guard every `*-db` suite uses. */
export const NO_DATABASE = ADMIN_URL === undefined;

/** The instant every suite starts at, so a failure message reads the same twice. */
export const EPOCH = '2026-06-01T12:00:00.000Z';
export const CORRELATION_ID = '01920000-0000-7000-8000-0000000000b1';
export const USD = 'USD';

/**
 * `America/New_York`, and not by accident.
 *
 * It is the zone the DST suite needs — 2026-03-08 is 23 hours long there and
 * 2026-11-01 is 25 — and using it as the *default* for every suite means the
 * DST-safety of the period grid is exercised by every test in the package
 * rather than only by the one named after it.
 */
export const ZONE = 'America/New_York';

export function usd(minor: bigint): MoneyType {
  return Money.of(minor, USD);
}

/** The scratch database name a suite gets. One per file. */
export async function budgetingDatabase(suite: string): Promise<TestDatabase> {
  return createTestDatabase(`personalfi_wp_budget_${suite}`);
}

export function clockAt(instant: string = EPOCH): Clock {
  return fixedClock(instant);
}

export function contextFor(userId: string, clock: Clock = clockAt()): BudgetingContext {
  return { userId, clock, correlationId: CORRELATION_ID, causationId: null };
}

export function cashAccount(id: string, balanceMinor: bigint): BudgetAccount {
  return {
    id,
    type: 'depository',
    role: 'CASH',
    workingBalance: usd(balanceMinor),
    closed: false,
  };
}

/** A card. House sign convention: owing $500 is `-50_000`, never `50_000`. */
export function creditAccount(id: string, balanceMinor: bigint): BudgetAccount {
  return { id, type: 'credit', role: 'CREDIT', workingBalance: usd(balanceMinor), closed: false };
}

export interface Scenario {
  readonly database: TestDatabase;
  readonly ledger: FakeLedger;
  readonly budget: BudgetRow;
  readonly context: BudgetingContext;
  readonly checking: string;
  readonly card: string;
  readonly categories: Readonly<Record<string, string>>;
}

/**
 * A household: one checking account, one card, four envelopes.
 *
 * Deliberately small. The 50k-transaction run that the evidence note reports is
 * built on top of this by `seedTransactions`, and a scenario that starts big
 * makes every failure message unreadable.
 */
export async function scenario(
  database: TestDatabase,
  options: {
    readonly clock?: Clock;
    readonly budget?: Partial<CreateBudgetInput>;
    readonly checkingMinor?: bigint;
    readonly cardMinor?: bigint;
  } = {},
): Promise<Scenario> {
  const clock = options.clock ?? clockAt();
  const context = contextFor(database.userId, clock);

  const ledger = createFakeLedger({ pageSize: 200 });
  const checking = newId();
  const card = newId();
  ledger.addAccount(cashAccount(checking, options.checkingMinor ?? 500_000n));
  ledger.addAccount(creditAccount(card, options.cardMinor ?? 0n));

  const budget = await createBudget(database.db, context, {
    name: 'Household',
    currency: USD,
    timezone: ZONE,
    ...options.budget,
  });

  const categories = {
    groceries: newId(),
    rent: newId(),
    fun: newId(),
    income: newId(),
  };

  return { database, ledger, budget, context, checking, card, categories };
}

/**
 * Open a period and give it one envelope per category.
 *
 * The lines are created *after* the period because they belong to it: one row
 * per `(period, category)` is what freezes a target per period, so there is no
 * "the category's line" to reuse.
 */
export async function openWithLines(
  scenarioState: Scenario,
  on: DateOnlyType,
  lines: readonly {
    readonly categoryId: string;
    readonly priority?: number;
    readonly rolloverPolicy?: 'ROLLOVER' | 'RESET' | 'ROLLOVER_ALLOW_NEGATIVE';
    readonly goalType?: 'NONE' | 'MONTHLY_TARGET' | 'TARGET_BY_DATE' | 'MINIMUM_BALANCE' | 'PCT_OF_INCOME' | 'REFILL_UP_TO';
    readonly goalAmountMinor?: bigint | null;
    readonly goalTargetDate?: DateOnlyType | null;
    readonly goalPercent?: string | null;
  }[],
): Promise<BudgetPeriodRow> {
  const period = await openPeriod(scenarioState.database.db, scenarioState.context, {
    budgetId: scenarioState.budget.id,
    on,
  });
  for (const line of lines) {
    await upsertLine(scenarioState.database.db, scenarioState.context, {
      budgetId: scenarioState.budget.id,
      periodId: period.id,
      categoryId: line.categoryId,
      priority: line.priority ?? 100,
      rolloverPolicy: line.rolloverPolicy ?? 'ROLLOVER',
      goalType: line.goalType ?? 'NONE',
      goalAmountMinor: line.goalAmountMinor ?? null,
      goalTargetDate: line.goalTargetDate ?? null,
      goalPercent: line.goalPercent ?? null,
    });
  }
  return period;
}

let sequence = 0;

/**
 * Put a transaction in the fake ledger **and move the matching balance**.
 *
 * Moving the balance is the whole point. Identity I compares this context's
 * cached envelopes against the ledger's own balances, so a helper that added a
 * transaction without moving the balance would make the identity trivially
 * false and every suite would start by working around it. This is the one place
 * the two stay in step, which also means a test *can* deliberately desynchronise
 * them — and `rta-identity.test.ts` does exactly that, to prove the assertion
 * bites.
 */
export function post(
  scenarioState: Scenario,
  input: {
    readonly accountId: string;
    readonly date: DateOnlyType;
    readonly minor: bigint;
    readonly categoryId?: string | null;
    readonly transferLinkId?: string | null;
    readonly isTransfer?: boolean;
    readonly refundOfId?: string | null;
    readonly id?: string;
  },
): string {
  sequence += 1;
  const account = scenarioState.ledger
    .accounts()
    .find((candidate) => candidate.id === input.accountId);
  if (account === undefined) throw new Error(`no fake account ${input.accountId}`);

  const id = input.id ?? newId();
  scenarioState.ledger.addTransaction({
    id,
    accountId: input.accountId,
    budgetDate: input.date,
    amount: usd(input.minor),
    categoryId: input.categoryId ?? null,
    funding: account.role === 'CREDIT' ? 'CREDIT' : 'CASH',
    transferLinkId: input.transferLinkId ?? null,
    isTransfer: input.isTransfer ?? input.transferLinkId !== undefined,
    refundOfId: input.refundOfId ?? null,
    excluded: false,
  });
  scenarioState.ledger.setBalance(
    input.accountId,
    Money.add(account.workingBalance ?? usd(0n), usd(input.minor)),
  );
  void sequence;
  return id;
}

/** A paired internal transfer: two legs, one link id, both invisible to budgets. */
export function transfer(
  scenarioState: Scenario,
  input: {
    readonly fromAccountId: string;
    readonly toAccountId: string;
    readonly date: DateOnlyType;
    readonly minor: bigint;
  },
): { readonly outflowId: string; readonly inflowId: string; readonly linkId: string } {
  const linkId = newId();
  const outflowId = post(scenarioState, {
    accountId: input.fromAccountId,
    date: input.date,
    minor: -input.minor,
    transferLinkId: linkId,
    isTransfer: true,
  });
  const inflowId = post(scenarioState, {
    accountId: input.toAccountId,
    date: input.date,
    minor: input.minor,
    transferLinkId: linkId,
    isTransfer: true,
  });
  return { outflowId, inflowId, linkId };
}
