// SPDX-License-Identifier: MIT
/**
 * 07 §1.3's funding rule, against a real Postgres.
 *
 * > ```
 * > on_categorized_spend(txn) where txn.account.type == CREDIT and txn.category == c:
 * >     fundable = min(|txn.amount|, max(0, available(c, p)))
 * >     available(c, p)            -= |txn.amount|          # always
 * >     available(CCP[card], p)    += fundable              # only the funded part moves
 * >     credit_overspend(c, p)     += |txn.amount| - fundable
 * > ```
 * > — 07 §1.3, lines 112–116
 *
 * "Only the funded part moves" is the whole claim, and it is the one a clone
 * gets wrong by moving the entire charge into `CCP[card]`. Doing that makes the
 * Credit Card Payment envelope say the statement can be paid in full when it
 * cannot — the single number this envelope exists to produce, reported wrong in
 * the direction that costs the user an interest charge.
 *
 * ## Why this is a different colour from a cash overspend
 *
 * 07 §1.3 opens by saying the distinction most clones get wrong is **which asset
 * actually moved**. A $500 charge against a $300 envelope leaves the same
 * −$200 in both cases, and they are not the same fact:
 *
 * | | cash | credit |
 * |---|---|---|
 * | what moved | $500 left a depository account | $500 of debt appeared |
 * | `available(c, p)` | −$200 | −$200 |
 * | `cash_overspend` | $200 | $0 |
 * | `credit_overspend` | $0 | $200 |
 * | `available(CCP[card])` | — | +$300, not +$500 |
 * | colour | red | yellow |
 * | what the user must do | find $200 | fund $200 before the statement |
 *
 * Both rows of the split are asserted below, because
 * `|min(available,0)| = cash_overspend + credit_overspend` is a `CHECK` on
 * `budget_lines` and a constraint that is never exercised is not a constraint.
 */
import { DateOnly, Money } from '@core/kernel';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetLines } from '../../schema/index.ts';
import { cardIdentityHolds } from '../../src/credit.ts';
import { assign } from '../../src/service.ts';
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

describe.skipIf(NO_DATABASE)('credit overspend', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await budgetingDatabase('credit');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  const categoryLine = async (periodId: string, categoryId: string) => {
    const rows = await database.db
      .select()
      .from(budgetLines)
      .where(and(eq(budgetLines.budgetPeriodId, periodId), eq(budgetLines.categoryId, categoryId)));
    const row = rows[0];
    if (row === undefined) throw new Error(`no line for ${categoryId} in ${periodId}`);
    return row;
  };

  const cardLine = async (periodId: string, creditAccountId: string) => {
    const rows = await database.db
      .select()
      .from(budgetLines)
      .where(
        and(
          eq(budgetLines.budgetPeriodId, periodId),
          eq(budgetLines.creditAccountId, creditAccountId),
        ),
      );
    const row = rows[0];
    if (row === undefined) throw new Error(`no CCP line for card ${creditAccountId}`);
    return row;
  };

  /** Identity II, from the ledger's balance against this context's cascade. */
  const assertCardIdentity = async (state: Scenario, periodId: string, label: string) => {
    const accounts = await state.ledger.port.listBudgetAccounts({
      userId: state.context.userId,
    });
    const account = accounts.find((candidate) => candidate.id === state.card);
    const ccp = await cardLine(periodId, state.card);
    const owed = Money.negate(account?.workingBalance ?? usd(0n));
    expect(
      cardIdentityHolds(owed, {
        creditAccountId: state.card,
        available: Money.of(ccp.availableMinor, USD),
        unfundedDebt: Money.of(ccp.unfundedDebtMinor, USD),
        funded: Money.of(ccp.fundedMinor, USD),
        payments: Money.of(ccp.paymentsMinor, USD),
      }),
      `${label}: owed ${Money.formatAmount(owed)} must equal available(CCP) ` +
        `${Money.formatAmount(Money.of(ccp.availableMinor, USD))} + unfunded ` +
        `${Money.formatAmount(Money.of(ccp.unfundedDebtMinor, USD))}`,
    ).toBe(true);
  };

  it('credit overspend funds CCP only up to available', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const { groceries, fun } = state.categories;

    const period = await openWithLines(state, d('2026-06-05'), [
      { categoryId: groceries, priority: 10 },
      { categoryId: fun, priority: 20 },
    ]);
    await settle(state, d('2026-06-01'));

    // $300 in the groceries envelope, $300 in fun. Fun is the cash control.
    for (const categoryId of [groceries, fun]) {
      await assign(database.db, state.context, {
        budgetId: state.budget.id,
        periodId: period.id,
        lineId: (await categoryLine(period.id, categoryId)).id,
        assigned: usd(30_000n),
      });
    }
    await settle(state, d('2026-06-01'));
    expect((await categoryLine(period.id, groceries)).availableMinor).toBe(30_000n);

    // --- the charge: $500 on the card against a $300 envelope --------------
    post(state, {
      accountId: state.card,
      date: d('2026-06-08'),
      minor: -50_000n,
      categoryId: groceries,
    });
    await settle(state, d('2026-06-08'));

    const overspent = await categoryLine(period.id, groceries);
    const ccp = await cardLine(period.id, state.card);

    // `available(c, p) -= |txn.amount|`, always: $300 − $500.
    expect(overspent.availableMinor).toBe(-20_000n);

    // **The claim.** `fundable = min(500, max(0, 300)) = 300`, so the CCP
    // envelope receives $300 and not the $500 that was charged. A clone that
    // moved the whole charge would show $500 here and tell the user the
    // statement is covered when $200 of it is not.
    expect(ccp.fundedMinor).toBe(30_000n);
    expect(ccp.availableMinor).toBe(30_000n);

    // `credit_overspend(c, p) += |txn.amount| - fundable` — the $200 that was
    // borrowed with no envelope behind it, recorded on both sides.
    expect(overspent.creditOverspendMinor).toBe(20_000n);
    expect(ccp.unfundedDebtMinor).toBe(20_000n);

    // Yellow, not red: no cash left a depository account.
    expect(overspent.cashOverspendMinor).toBe(0n);

    // The `CHECK` on `budget_lines`, restated: the split is exhaustive.
    expect(overspent.cashOverspendMinor + overspent.creditOverspendMinor).toBe(
      -overspent.availableMinor,
    );

    // Identity II: $500 is owed on the card, $300 of it earmarked and $200 not.
    await assertCardIdentity(state, period.id, 'after a $500 charge on a $300 envelope');

    // --- the cash control: same shortfall, different colour ----------------
    post(state, {
      accountId: state.checking,
      date: d('2026-06-09'),
      minor: -50_000n,
      categoryId: fun,
    });
    await settle(state, d('2026-06-09'));

    const cashOverspent = await categoryLine(period.id, fun);
    expect(cashOverspent.availableMinor).toBe(-20_000n);
    // Red: the money has already gone.
    expect(cashOverspent.cashOverspendMinor).toBe(20_000n);
    expect(cashOverspent.creditOverspendMinor).toBe(0n);
    // A cash overspend moves nothing into any card's payment envelope.
    expect((await cardLine(period.id, state.card)).fundedMinor).toBe(30_000n);

    // --- a second charge on an already-negative envelope -------------------
    //
    // `max(0, available)` is zero now, so `fundable` is zero: nothing moves into
    // CCP and the whole $50 is borrowed. This is the clause that a `min` without
    // the `max(0, …)` gets wrong — it would fund a *negative* amount and quietly
    // take money back out of the card's payment envelope.
    post(state, {
      accountId: state.card,
      date: d('2026-06-11'),
      minor: -5_000n,
      categoryId: groceries,
    });
    await settle(state, d('2026-06-11'));

    const deeper = await categoryLine(period.id, groceries);
    const ccpAfter = await cardLine(period.id, state.card);
    expect(deeper.availableMinor).toBe(-25_000n);
    // Unchanged: the funded total did not move, and did not go backwards.
    expect(ccpAfter.fundedMinor).toBe(30_000n);
    expect(ccpAfter.availableMinor).toBe(30_000n);
    expect(deeper.creditOverspendMinor).toBe(25_000n);
    expect(ccpAfter.unfundedDebtMinor).toBe(25_000n);
    await assertCardIdentity(state, period.id, 'after a second charge on a negative envelope');

    // --- funding the shortfall retires the unfunded debt -------------------
    //
    // The user does what the yellow is asking for: assigns $250 more to
    // groceries. The envelope goes back to zero and the borrowing becomes funded
    // — which is the whole point of distinguishing yellow from red, because this
    // move is available to the user and no equivalent exists for cash.
    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: period.id,
      lineId: deeper.id,
      assigned: usd(30_000n + 25_000n),
    });
    await settle(state, d('2026-06-01'));

    const repaired = await categoryLine(period.id, groceries);
    const ccpRepaired = await cardLine(period.id, state.card);
    expect(repaired.availableMinor).toBe(0n);
    expect(repaired.creditOverspendMinor).toBe(0n);
    expect(repaired.cashOverspendMinor).toBe(0n);
    // Now the full $550 of card spending is funded, and nothing is unfunded.
    expect(ccpRepaired.fundedMinor).toBe(55_000n);
    expect(ccpRepaired.availableMinor).toBe(55_000n);
    expect(ccpRepaired.unfundedDebtMinor).toBe(0n);
    await assertCardIdentity(state, period.id, 'after funding the shortfall');
  }, 180_000);
});
