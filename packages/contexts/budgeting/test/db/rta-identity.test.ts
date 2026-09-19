// SPDX-License-Identifier: MIT
/**
 * The balance-sheet identity, against a real Postgres.
 *
 * 07 §1.2 line 82 calls this "the single most valuable test in the budgeting
 * module" and line 88 says to assert it "after every mutation in dev". Both are
 * taken literally: `assertIdentity` runs after every single mutation below, not
 * once at the end, because an identity that is only checked at the end tells you
 * something broke and not what.
 *
 * ## What makes it a real check rather than a restatement
 *
 * `readyToAssign` is *defined* by identity I, so asserting it against freshly
 * computed terms would be a tautology. Every term here is therefore read from a
 * different place after the fact:
 *
 *   * `Σ available` and `RTA` from this context's **persisted** columns
 *     (`identityTermsOf`), which is where a dirty-flag cascade that failed to
 *     fire leaves a stale number;
 *   * `Σ balance` from the **ledger**, through the port, as of right now.
 *
 * So the thing under test is not the algebra, it is the cache — 07 §1.4 rule 6's
 * "never as source of truth".
 *
 * Identity II is asserted in the same helper and is the one with genuinely
 * independent sides: `owed` is the card's balance in the ledger,
 * `available(CCP) + unfundedDebt` comes from this context's cascade. It is what
 * goes red when the credit-card payment auto-line is sabotaged, and the sabotage
 * is recorded in `docs/evidence/phase-2/wp2.1-budgeting.md` §5.
 */
import { Money, DateOnly, type Money as MoneyType } from '@core/kernel';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { budgetLines, budgetPeriods, rollovers } from '../../schema/index.ts';
import { ROLLOVER_POLICIES, type RolloverPolicy } from '../../schema/index.ts';
import { absorbedByRta, rolloverOut } from '../../src/envelope.ts';
import { onBudgetBalances } from '../../src/ledger-port.ts';
import { cardIdentityTermsOf, identityTermsOf } from '../../src/read.ts';
import { assign, recomputeDirty, recomputePeriod, rollPeriod } from '../../src/service.ts';
import { and, eq } from 'drizzle-orm';
import {
  NO_DATABASE,
  USD,
  budgetingDatabase,
  openWithLines,
  post,
  scenario,
  transfer,
  usd,
  type Scenario,
  type TestDatabase,
} from '../harness.ts';

const d = DateOnly.parse;

describe.skipIf(NO_DATABASE)('the Ready-to-Assign identity', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await budgetingDatabase('rta');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  /**
   * Both identities, from independently sourced terms. Called after *every*
   * mutation in the test below.
   */
  async function assertIdentity(state: Scenario, periodId: string, label: string): Promise<void> {
    const terms = await identityTermsOf(state.database.db, {
      userId: state.context.userId,
      periodId,
    });
    expect(terms, label).not.toBeNull();
    if (terms === null) return;

    const accounts = await state.ledger.port.listBudgetAccounts({
      userId: state.context.userId,
    });
    const { balances } = onBudgetBalances(accounts, USD);

    const left = Money.add(
      Money.add(Money.sum(terms.categoryAvailable, USD), terms.readyToAssign),
      Money.sum(terms.futureAssignments, USD),
    );
    expect(
      Money.formatAmount(left),
      `${label}: Σ available + RTA + future assignments must equal Σ on-budget balances`,
    ).toBe(Money.formatAmount(Money.sum(balances, USD)));

    // Identity II, per card: what is owed is either earmarked or borrowed.
    const cards = await cardIdentityTermsOf(state.database.db, {
      userId: state.context.userId,
      periodId,
    });
    for (const card of cards) {
      const account = accounts.find((candidate) => candidate.id === card.creditAccountId);
      if (account?.workingBalance == null) continue;
      const owed = Money.absolute(Money.min(account.workingBalance, Money.zero(USD)));
      expect(
        Money.formatAmount(Money.add(card.available, card.unfundedDebt)),
        `${label}: owed on ${card.creditAccountId} must equal available(CCP) + unfundedDebt`,
      ).toBe(Money.formatAmount(owed));
    }
  }

  it('Σ available + RTA + future assignments equals Σ on-budget balances', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const { groceries, rent, fun } = state.categories;

    // --- open the first period -------------------------------------------
    const march = await openWithLines(state, d('2026-03-10'), [
      { categoryId: groceries, priority: 10 },
      { categoryId: rent, priority: 5 },
      { categoryId: fun, priority: 50 },
    ]);
    await recomputePeriod(database.db, state.context, { port: state.ledger.port }, march.id);
    await assertIdentity(state, march.id, 'after opening March');

    // Nothing assigned yet, so every dollar of the $5,000 is Ready to Assign.
    const opening = await identityTermsOf(database.db, {
      userId: state.context.userId,
      periodId: march.id,
    });
    expect(Money.formatAmount(opening?.readyToAssign ?? usd(0n))).toBe('5000.00');

    const lineOf = async (periodId: string, categoryId: string) => {
      const rows = await database.db
        .select()
        .from(budgetLines)
        .where(
          and(eq(budgetLines.budgetPeriodId, periodId), eq(budgetLines.categoryId, categoryId)),
        );
      const row = rows[0];
      if (row === undefined) throw new Error(`no line for ${categoryId} in ${periodId}`);
      return row;
    };

    // --- mutation 1: assign ------------------------------------------------
    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: march.id,
      lineId: (await lineOf(march.id, rent)).id,
      assigned: usd(180_000n),
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
    await assertIdentity(state, march.id, 'after assigning $1,800 to rent');

    // Assigning moves RTA by exactly that amount — the property WP 2.9's e2e
    // asserts from the browser, proven here at the source.
    const afterAssign = await identityTermsOf(database.db, {
      userId: state.context.userId,
      periodId: march.id,
    });
    expect(Money.formatAmount(afterAssign?.readyToAssign ?? usd(0n))).toBe('3200.00');

    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: march.id,
      lineId: (await lineOf(march.id, groceries)).id,
      assigned: usd(60_000n),
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
    await assertIdentity(state, march.id, 'after assigning $600 to groceries');

    // --- mutation 2: cash spending ----------------------------------------
    post(state, {
      accountId: state.checking,
      date: d('2026-03-12'),
      minor: -180_000n,
      categoryId: rent,
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
    await assertIdentity(state, march.id, 'after paying rent in cash');

    // --- mutation 3: credit spending, which is where CCP earns its keep ----
    post(state, {
      accountId: state.card,
      date: d('2026-03-14'),
      minor: -25_000n,
      categoryId: groceries,
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
    await assertIdentity(state, march.id, 'after $250 of groceries on the card');

    // --- mutation 4: a refund ---------------------------------------------
    const purchase = post(state, {
      accountId: state.checking,
      date: d('2026-03-16'),
      minor: -10_000n,
      categoryId: fun,
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
    await assertIdentity(state, march.id, 'after a $100 night out');

    post(state, {
      accountId: state.checking,
      date: d('2026-03-18'),
      minor: 4_000n,
      categoryId: fun,
      refundOfId: purchase,
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
    await assertIdentity(state, march.id, 'after a $40 refund');

    // --- mutation 5: a card payment (a transfer, so zero activity) ---------
    transfer(state, {
      fromAccountId: state.checking,
      toAccountId: state.card,
      date: d('2026-03-20'),
      minor: 25_000n,
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
    await assertIdentity(state, march.id, 'after paying the card');

    // --- mutation 6: a credit overspend -----------------------------------
    post(state, {
      accountId: state.card,
      date: d('2026-03-22'),
      minor: -50_000n,
      categoryId: fun,
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
    await assertIdentity(state, march.id, 'after a $500 credit overspend on fun');

    // --- mutation 7..N: thirteen consecutive rolls, one per period ---------
    //
    // Thirteen because the evidence note's run is thirteen and because twelve
    // would let a bug that is annual rather than monthly hide: the thirteenth
    // period is the first one whose predecessor is a year old.
    let current = march.id;
    for (let index = 0; index < 13; index += 1) {
      const rolled = await rollPeriod(database.db, state.context, { port: state.ledger.port }, {
        budgetId: state.budget.id,
        periodId: current,
      });
      current = rolled.toPeriodId;

      // A little spending in every period, so no roll is a no-op.
      const period = await database.db
        .select()
        .from(budgetPeriods)
        .where(eq(budgetPeriods.id, current));
      const start = period[0]?.startDate;
      if (start !== undefined) {
        post(state, {
          accountId: index % 2 === 0 ? state.checking : state.card,
          date: DateOnly.addDays(DateOnly.parse(start), 3),
          minor: -7_500n,
          categoryId: groceries,
        });
      }
      await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);
      await assertIdentity(state, current, `after roll ${index + 1} of 13`);
      await assertIdentity(state, march.id, `March still holds after roll ${index + 1}`);
    }
  }, 180_000);

  it('conservation: Σ rolloverOut(n) = Σ rolloverIn(n+1)', () => {
    // A property of the pure function first: for any closing balance and any
    // policy, what leaves a period is exactly what arrives in the next, and
    // what the policy discarded is exactly the remainder. Both halves together
    // are `rollovers`' two CHECK constraints, so a counterexample here is a row
    // Postgres would refuse — which is the point of stating it twice.
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.bigInt({ min: -50_000_000n, max: 50_000_000n }),
            fc.constantFrom<RolloverPolicy>(...ROLLOVER_POLICIES),
          ),
          { minLength: 1, maxLength: 40 },
        ),
        (lines) => {
          let out = Money.zero(USD);
          let absorbed = Money.zero(USD);
          let closing = Money.zero(USD);
          const arrivals: MoneyType[] = [];

          for (const [minor, policy] of lines) {
            const available = Money.of(minor, USD);
            closing = Money.add(closing, available);
            const rolled = rolloverOut(available, policy);
            out = Money.add(out, rolled);
            absorbed = Money.add(absorbed, absorbedByRta(available, policy));
            // `rollover_in = rollover_out` is a CHECK, so the arriving carryover
            // is the leaving one by construction — modelled here as the next
            // period's opening line.
            arrivals.push(rolled);
          }

          expect(Money.sum(arrivals, USD).minor).toBe(out.minor);
          expect(Money.add(out, absorbed).minor).toBe(closing.minor);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('conservation holds of the rows a real roll writes, not just the function', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 300_000n });
    const { groceries, fun } = state.categories;

    const first = await openWithLines(state, d('2026-04-05'), [
      { categoryId: groceries, priority: 10 },
      // A RESET envelope and a debt-like one, so all three policies are present
      // in the rows the roll writes.
      { categoryId: fun, priority: 20, rolloverPolicy: 'RESET' },
    ]);
    await recomputePeriod(database.db, state.context, { port: state.ledger.port }, first.id);

    const lines = await database.db
      .select()
      .from(budgetLines)
      .where(eq(budgetLines.budgetPeriodId, first.id));
    for (const line of lines) {
      if (line.kind !== 'category') continue;
      await assign(database.db, state.context, {
        budgetId: state.budget.id,
        periodId: first.id,
        lineId: line.id,
        assigned: usd(20_000n),
      });
    }
    // Overspend one of them so a negative `available` is in the mix.
    post(state, {
      accountId: state.checking,
      date: d('2026-04-10'),
      minor: -30_000n,
      categoryId: groceries,
    });
    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);

    const rolled = await rollPeriod(database.db, state.context, { port: state.ledger.port }, {
      budgetId: state.budget.id,
      periodId: first.id,
    });

    const rows = await database.db
      .select()
      .from(rollovers)
      .where(eq(rollovers.fromPeriodId, first.id));
    expect(rows.length).toBe(rolled.lineCount);

    const out = rows.reduce((total, row) => total + row.rolloverOutMinor, 0n);
    const inward = rows.reduce((total, row) => total + row.rolloverInMinor, 0n);
    const available = rows.reduce((total, row) => total + row.availableMinor, 0n);
    const absorbed = rows.reduce((total, row) => total + row.absorbedByRtaMinor, 0n);

    expect(inward).toBe(out);
    expect(out + absorbed).toBe(available);

    // And the carryover actually landed on the next period's lines.
    const next = await database.db
      .select()
      .from(budgetLines)
      .where(eq(budgetLines.budgetPeriodId, rolled.toPeriodId));
    expect(next.reduce((total, row) => total + row.carryoverMinor, 0n)).toBe(out);
  }, 120_000);
});
