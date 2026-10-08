// SPDX-License-Identifier: MIT
/**
 * WP 9.14, found while closing O-94-1 through the shipped routes: a credit-card
 * charge in a category the budget has NO LINE for — or no category at all —
 * dead-lettered `budgeting.actuals@v1` on identity II
 * (`owed 50.00 ≠ available 0.00 + unfunded 0.00`), with no card owing before it.
 *
 * The cascade fed `CCP[card]` only from the category lines that exist, so a
 * charge with no envelope was in the card's balance and in no term of the
 * identity. `actuals.ts` already calls that bucket "the uncategorised envelope —
 * real money with no envelope yet"; 07 §1.3 says what a charge with nothing
 * behind it is: `fundable = min(|amount|, max(0, available))` is zero, so all of
 * it is borrowed. A real budget never has a line for every category a card is
 * used in, so on the soak install this stopped the consumer on the first
 * unbudgeted card purchase.
 */
import { DateOnly, Money } from '@core/kernel';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetLines } from '../../schema/index.ts';
import { cardIdentityHolds } from '../../src/credit.ts';
import {
  NO_DATABASE,
  USD,
  budgetingDatabase,
  openWithLines,
  post,
  scenario,
  settle,
  usd,
  type Scenario,
  type TestDatabase,
} from '../harness.ts';

const d = DateOnly.parse;

describe.skipIf(NO_DATABASE)('card spending with no envelope behind it', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await budgetingDatabase('card_no_envelope');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  const cardLine = async (periodId: string, cardId: string) => {
    const rows = await database.db
      .select()
      .from(budgetLines)
      .where(
        and(eq(budgetLines.budgetPeriodId, periodId), eq(budgetLines.creditAccountId, cardId)),
      );
    const row = rows[0];
    if (row === undefined) throw new Error(`no CCP line for ${cardId}`);
    return row;
  };

  const identity = async (state: Scenario, periodId: string): Promise<boolean> => {
    const accounts = await state.ledger.port.listBudgetAccounts({ userId: state.context.userId });
    const account = accounts.find((candidate) => candidate.id === state.card);
    const ccp = await cardLine(periodId, state.card);
    return cardIdentityHolds(Money.negate(account?.workingBalance ?? usd(0n)), {
      creditAccountId: state.card,
      available: Money.of(ccp.availableMinor, USD),
      unfundedDebt: Money.of(ccp.unfundedDebtMinor, USD),
      funded: Money.of(ccp.fundedMinor, USD),
      payments: Money.of(ccp.paymentsMinor, USD),
    });
  };

  it('an uncategorised charge is borrowed: unfunded debt, and identity II holds', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const period = await openWithLines(state, d('2026-06-05'), [
      { categoryId: state.categories.groceries, priority: 10 },
    ]);
    await settle(state, d('2026-06-01'));

    post(state, { accountId: state.card, date: d('2026-06-08'), minor: -5_000n, categoryId: null });
    await settle(state, d('2026-06-08'));

    const ccp = await cardLine(period.id, state.card);
    expect(ccp.unfundedDebtMinor).toBe(5_000n);
    expect(ccp.availableMinor).toBe(0n);
    expect(await identity(state, period.id)).toBe(true);
  });

  it('a charge in a category the budget has no line for is borrowed the same way', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const period = await openWithLines(state, d('2026-06-05'), [
      { categoryId: state.categories.groceries, priority: 10 },
    ]);
    await settle(state, d('2026-06-01'));

    // `fun` has no line in this budget.
    post(state, {
      accountId: state.card,
      date: d('2026-06-08'),
      minor: -7_500n,
      categoryId: state.categories.fun,
    });
    await settle(state, d('2026-06-08'));

    const ccp = await cardLine(period.id, state.card);
    expect(ccp.unfundedDebtMinor).toBe(7_500n);
    expect(await identity(state, period.id)).toBe(true);
  });

  it('a lined charge and an unlined charge together: only the unlined one is borrowed', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const { groceries, fun } = state.categories;
    const period = await openWithLines(state, d('2026-06-05'), [
      { categoryId: groceries, priority: 10 },
    ]);
    await settle(state, d('2026-06-01'));
    const { assign } = await import('../../src/service.ts');
    const lines = await database.db
      .select()
      .from(budgetLines)
      .where(and(eq(budgetLines.budgetPeriodId, period.id), eq(budgetLines.categoryId, groceries)));
    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: period.id,
      lineId: lines[0]?.id ?? '',
      assigned: usd(30_000n),
    });
    await settle(state, d('2026-06-01'));

    post(state, {
      accountId: state.card,
      date: d('2026-06-08'),
      minor: -10_000n,
      categoryId: groceries,
    });
    post(state, { accountId: state.card, date: d('2026-06-09'), minor: -4_000n, categoryId: fun });
    await settle(state, d('2026-06-08'));

    const ccp = await cardLine(period.id, state.card);
    expect(ccp.availableMinor).toBe(10_000n); // the funded, lined charge
    expect(ccp.unfundedDebtMinor).toBe(4_000n); // the unlined one
    expect(await identity(state, period.id)).toBe(true);
  });
});
