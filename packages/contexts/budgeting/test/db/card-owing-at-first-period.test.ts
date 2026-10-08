// SPDX-License-Identifier: MIT
/**
 * WP 9.14 / O-94-1 (WP 9.4 §10 item 3, WP 9.11 §7): a card that already owes
 * when its first budget period is computed dead-lettered `budgeting.actuals@v1`
 * on identity II — `owed 350.00 ≠ available 0.00 + unfunded 0.00`.
 *
 * ```
 * owed(card) = available(CCP[card]) + unfundedDebt(CCP[card])
 * ```
 *
 * The cascade starts a card's first payment line at zero, so debt that existed
 * before the budget did was in `owed` and in neither right-hand term. It is
 * exactly what `unfundedDebt` means — money borrowed with no envelope behind it
 * — so a card's first line opens with the debt the card carried when the period
 * began. A real card always carries a balance, so on the soak install this
 * stopped the consumer the first time a card was linked under a budget.
 *
 * The opening debt is derived from the ledger, not from the cascade: the
 * card's balance now, less every movement on the card since the period began.
 * Taking it as `owed − (available + unfunded)` would make identity II true by
 * construction and the control worthless, so the last test below proves the
 * identity still bites: a card row the cascade does not explain still fails it.
 */
import { DateOnly, Money } from '@core/kernel';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetLines } from '../../schema/index.ts';
import { cardIdentityHolds } from '../../src/credit.ts';
import { recomputeDirty, rollPeriod } from '../../src/service.ts';
import {
  NO_DATABASE,
  USD,
  budgetingDatabase,
  openWithLines,
  post,
  scenario,
  settle,
  transfer,
  usd,
  type Scenario,
  type TestDatabase,
} from '../harness.ts';

const d = DateOnly.parse;

describe.skipIf(NO_DATABASE)(
  'a card already owing when its first period is computed (O-94-1)',
  () => {
    let database: TestDatabase;

    beforeAll(async () => {
      database = await budgetingDatabase('card_owing_first');
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

    it('opens the card line with the debt the card carried, and identity II holds', async () => {
      await database.truncate();
      // $350.00 owed before the budget exists.
      const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: -35_000n });
      const period = await openWithLines(state, d('2026-06-05'), [
        { categoryId: state.categories.groceries, priority: 10 },
      ]);

      await settle(state, d('2026-06-01'));

      const ccp = await cardLine(period.id, state.card);
      expect(ccp.unfundedDebtMinor).toBe(35_000n);
      expect(ccp.availableMinor).toBe(0n);
      expect(await identity(state, period.id)).toBe(true);
    });

    it('keeps holding as the period moves: a charge, a statement payment, and the roll into the next period', async () => {
      await database.truncate();
      const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: -35_000n });
      const { groceries } = state.categories;
      const period = await openWithLines(state, d('2026-06-05'), [
        { categoryId: groceries, priority: 10 },
      ]);
      await settle(state, d('2026-06-01'));

      // A $50 charge on an empty envelope: all of it borrowed. Debt is $350 + $50.
      post(state, {
        accountId: state.card,
        date: d('2026-06-08'),
        minor: -5_000n,
        categoryId: groceries,
      });
      await settle(state, d('2026-06-08'));
      expect((await cardLine(period.id, state.card)).unfundedDebtMinor).toBe(40_000n);
      expect(await identity(state, period.id)).toBe(true);

      // Pay $100 of the statement from checking: a paired transfer, no category.
      transfer(state, {
        fromAccountId: state.checking,
        toAccountId: state.card,
        date: d('2026-06-12'),
        minor: 10_000n,
      });
      await settle(state, d('2026-06-12'));
      expect(await identity(state, period.id)).toBe(true);

      // Roll: the next period's line carries the debt in its carryover and must
      // NOT add the card's starting debt a second time.
      const rolled = await rollPeriod(
        database.db,
        state.context,
        { port: state.ledger.port },
        { budgetId: state.budget.id, periodId: period.id },
      );
      await recomputeDirty(
        database.db,
        state.context,
        { port: state.ledger.port },
        state.budget.id,
      );
      const next = await cardLine(rolled.toPeriodId, state.card);
      expect(next.carryoverUnfundedDebtMinor).toBe(40_000n);
      expect(next.unfundedDebtMinor).toBe(40_000n);
      expect(await identity(state, rolled.toPeriodId)).toBe(true);
    });

    it('a card with no balance behind it is unchanged (the starting debt is zero)', async () => {
      await database.truncate();
      const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
      const period = await openWithLines(state, d('2026-06-05'), [
        { categoryId: state.categories.groceries, priority: 10 },
      ]);
      await settle(state, d('2026-06-01'));
      expect((await cardLine(period.id, state.card)).unfundedDebtMinor).toBe(0n);
      expect(await identity(state, period.id)).toBe(true);
    });

    it('identity II still bites: a card movement the cascade cannot explain still fails it', async () => {
      await database.truncate();
      const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: -35_000n });
      await openWithLines(state, d('2026-06-05'), [
        { categoryId: state.categories.groceries, priority: 10 },
      ]);
      await settle(state, d('2026-06-01'));

      // A $50 charge the holder excluded from totals: the ledger has the row
      // and the balance moved, but the cascade (rightly) ignores it. The starting
      // debt is derived from rows, so it cannot absorb this, and the recompute
      // must refuse rather than agree.
      state.ledger.addTransaction({
        id: 'excluded-charge',
        accountId: state.card,
        budgetDate: d('2026-06-08'),
        amount: usd(-5_000n),
        categoryId: null,
        funding: 'CREDIT',
        transferLinkId: null,
        isTransfer: false,
        refundOfId: null,
        excluded: true,
      });
      state.ledger.setBalance(state.card, usd(-40_000n));
      await expect(settle(state, d('2026-06-01'))).rejects.toMatchObject({
        code: 'budgeting.card_identity_violation',
      });
    });
  },
);
