// SPDX-License-Identifier: MIT
/**
 * The actuals consumer, through the real pump, against a real Postgres.
 *
 * Three claims, and each is one of the v0.8 rung's ("budgets exclude transfers
 * and net refunds") or 07 §1.4 rule 6's:
 *
 *   1. **A paired transfer contributes zero activity.** Both legs are dropped —
 *      not relied upon to cancel — so a pair whose legs differ by a wire fee or
 *      an FX rate still contributes exactly nothing. The strong form is asserted
 *      below: a transfer leg that somebody has *categorised* is still excluded,
 *      because the exclusion is decided on `transferLinkId`/`isTransfer` at the
 *      port boundary and not on whether a category happens to be attached.
 *   2. **A netted refund reduces activity by exactly the refund.** Netting is a
 *      different operation from excluding: a $40 refund of a $100 purchase
 *      leaves $60 in the envelope, not $0 and not $100.
 *   3. **A late transaction dirties only the periods from its own forward.** A
 *      carryover flows forwards only, so a February row can change February and
 *      March and can never change January. This is the half a naive
 *      implementation gets right by accident and a clever one gets wrong, so it
 *      is asserted from two directions: the dirty set `markDirtyFrom` produces,
 *      and — the end-to-end form — that an untouched earlier period's persisted
 *      Ready-to-Assign is *not* rewritten even though the account balance it
 *      would be recomputed from has moved.
 *
 * ## Why the events are redeclared rather than imported
 *
 * `src/consumer.ts` names its five triggers as **strings**, because importing
 * `@ctx/ledger`'s or `@ctx/categorization`'s `events.ts` would be importing
 * another context and the boundary lint correctly refuses. A duplicated string
 * is the honest cost of that decoupling, and a duplicated string can be wrong.
 * The definitions below are field-for-field copies of the real ones
 * (`packages/contexts/{ledger,categorization}/src/events.ts`), so a rename on
 * either side makes this suite go quiet — which is why every test starts by
 * asserting the pump actually delivered something.
 */
import { DateOnly, Money } from '@core/kernel';
import { appendEvent, createConsumerPump, defineEvent, platformExecutor } from '@core/platform';
import { recordingLogger } from '@core/testkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { budgetLineActuals, budgetLines, budgetPeriods } from '../../schema/index.ts';
import { createBudgetingConsumer } from '../../src/consumer.ts';
import { platformOf } from '../../src/db.ts';
import { assign, dirtyPeriods, markDirtyFrom, recomputeDirty } from '../../src/service.ts';
import {
  CORRELATION_ID,
  NO_DATABASE,
  budgetingDatabase,
  clockAt,
  openWithLines,
  post,
  scenario,
  settle,
  usd,
  type Scenario,
  type TestDatabase,
} from '../harness.ts';

const d = DateOnly.parse;

const uuid = z.uuid();

/** `@ctx/ledger`'s, redeclared. Not imported — see the file header. */
const TransactionsUpserted = defineEvent({
  type: 'ledger.TransactionsUpserted',
  aggregateType: 'account',
  description: 'A sync page landed. Ids and counts only.',
  schema: z.object({
    accountId: uuid,
    addedIds: z.array(uuid),
    updatedIds: z.array(uuid),
    removedIds: z.array(uuid),
    dateFrom: z.string().nullable(),
    dateTo: z.string().nullable(),
    count: z.int().nonnegative(),
  }),
});

const TransferPaired = defineEvent({
  type: 'ledger.TransferPaired',
  aggregateType: 'transfer_link',
  description: 'Two transactions were identified as one internal movement.',
  schema: z.object({
    transferLinkId: uuid,
    outflowTransactionId: uuid,
    inflowTransactionId: uuid,
    confidence: z.number().gt(0).lte(1),
    howMatched: z.enum([
      'exact_amount_same_day',
      'exact_amount_near_date',
      'amount_within_tolerance',
      'user_confirmed',
    ]),
  }),
});

/** `@ctx/categorization`'s, redeclared. */
const AssignmentsChanged = defineEvent({
  type: 'categorization.AssignmentsChanged',
  aggregateType: 'transaction',
  description: 'One or more transactions were categorised or recategorised.',
  schema: z.object({
    transactionIds: z.array(uuid),
    count: z.int().nonnegative(),
    bySource: z.record(z.string(), z.int().nonnegative()),
    trigger: z.enum(['sync', 'rule_apply', 'confirm', 'backfill', 'model_retrain']),
    ruleId: uuid.nullable(),
  }),
});

describe.skipIf(NO_DATABASE)('the budgeting actuals consumer', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await budgetingDatabase('actuals');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  const clock = clockAt();

  /** The real pump, wired to the real consumer over the scenario's fake ledger. */
  function pumpFor(state: Scenario) {
    const logger = recordingLogger();
    const pump = createConsumerPump({
      pool: database.pool,
      db: platformExecutor(database.db),
      clock,
      logger,
      consumers: [createBudgetingConsumer({ database: database.db, port: state.ledger.port })],
    });
    return { pump, logger };
  }

  async function publishUpserted(
    state: Scenario,
    window: { readonly from: string; readonly to: string; readonly ids: readonly string[] },
  ): Promise<void> {
    await appendEvent(
      platformOf(database.db),
      TransactionsUpserted.create(
        {
          accountId: state.checking,
          addedIds: [...window.ids],
          updatedIds: [],
          removedIds: [],
          dateFrom: window.from,
          dateTo: window.to,
          count: window.ids.length,
        },
        { userId: database.userId, correlationId: CORRELATION_ID },
        clock,
      ),
    );
  }

  const actualsFor = async (lineId: string) => {
    const rows = await database.db
      .select()
      .from(budgetLineActuals)
      .where(eq(budgetLineActuals.budgetLineId, lineId));
    return rows[0];
  };

  const lineFor = async (periodId: string, categoryId: string) => {
    const rows = await database.db
      .select()
      .from(budgetLines)
      .where(and(eq(budgetLines.budgetPeriodId, periodId), eq(budgetLines.categoryId, categoryId)));
    const row = rows[0];
    if (row === undefined) throw new Error(`no line for ${categoryId} in ${periodId}`);
    return row;
  };

  it('a paired transfer contributes zero activity', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const { groceries } = state.categories;
    const { pump } = pumpFor(state);

    const period = await openWithLines(state, d('2026-06-05'), [
      { categoryId: groceries, priority: 10 },
    ]);
    await settle(state, d('2026-06-01'));
    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: period.id,
      lineId: (await lineFor(period.id, groceries)).id,
      assigned: usd(40_000n),
    });
    await settle(state, d('2026-06-01'));

    // A real, categorised expense first, so "zero activity" is distinguishable
    // from "the consumer did nothing at all".
    const spend = post(state, {
      accountId: state.checking,
      date: d('2026-06-06'),
      minor: -11_000n,
      categoryId: groceries,
    });
    await publishUpserted(state, { from: '2026-06-01', to: '2026-06-30', ids: [spend] });
    expect(await pump.drain()).toBe(1);

    const baseline = await actualsFor((await lineFor(period.id, groceries)).id);
    expect(baseline?.activityMinor).toBe(-11_000n);
    expect(baseline?.transferExcludedCount).toBe(0);

    // --- the transfer -----------------------------------------------------
    //
    // Both legs carry `groceries` as their category. That is the strong form of
    // the claim: the exclusion is decided on the transfer linkage, so a leg
    // somebody has categorised — by hand, or by a rule that matched the payee —
    // must still contribute nothing. A budget that excluded only *uncategorised*
    // transfers would pass a weaker test and be wrong on real data.
    const linkId = crypto.randomUUID();
    const outflow = post(state, {
      accountId: state.checking,
      date: d('2026-06-10'),
      minor: -25_000n,
      categoryId: groceries,
      transferLinkId: linkId,
      isTransfer: true,
    });
    const inflow = post(state, {
      accountId: state.card,
      date: d('2026-06-10'),
      minor: 25_000n,
      categoryId: groceries,
      transferLinkId: linkId,
      isTransfer: true,
    });

    await appendEvent(
      platformOf(database.db),
      TransferPaired.create(
        {
          transferLinkId: linkId,
          outflowTransactionId: outflow,
          inflowTransactionId: inflow,
          confidence: 1,
          howMatched: 'exact_amount_same_day',
        },
        { userId: database.userId, correlationId: CORRELATION_ID },
        clock,
      ),
    );
    expect(await pump.drain()).toBe(1);

    const after = await actualsFor((await lineFor(period.id, groceries)).id);
    // Unchanged to the cent: the pair moved $250 between two accounts the user
    // owns and the envelope did not notice.
    expect(after?.activityMinor).toBe(-11_000n);
    // …and the exclusion is *observable* rather than merely true. Both legs
    // counted: the outflow on checking and the inflow on the card.
    expect(after?.transferExcludedCount).toBe(2);
    expect(after?.transactionCount).toBe(1);

    // The envelope's available moved by the real spend only.
    expect((await lineFor(period.id, groceries)).availableMinor).toBe(40_000n - 11_000n);
  }, 180_000);

  it('a netted refund reduces activity by exactly the refund', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const { fun } = state.categories;
    const { pump } = pumpFor(state);

    const period = await openWithLines(state, d('2026-06-05'), [{ categoryId: fun, priority: 10 }]);
    await settle(state, d('2026-06-01'));
    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: period.id,
      lineId: (await lineFor(period.id, fun)).id,
      assigned: usd(30_000n),
    });
    await settle(state, d('2026-06-01'));

    const purchase = post(state, {
      accountId: state.checking,
      date: d('2026-06-07'),
      minor: -10_000n,
      categoryId: fun,
    });
    await publishUpserted(state, { from: '2026-06-01', to: '2026-06-30', ids: [purchase] });
    expect(await pump.drain()).toBe(1);

    const beforeRefund = await actualsFor((await lineFor(period.id, fun)).id);
    expect(beforeRefund?.activityMinor).toBe(-10_000n);
    expect(beforeRefund?.refundNettedCount).toBe(0);

    // A $40 refund of the $100 purchase.
    const refund = post(state, {
      accountId: state.checking,
      date: d('2026-06-12'),
      minor: 4_000n,
      categoryId: fun,
      refundOfId: purchase,
    });
    await publishUpserted(state, { from: '2026-06-01', to: '2026-06-30', ids: [refund] });
    expect(await pump.drain()).toBe(1);

    const afterRefund = await actualsFor((await lineFor(period.id, fun)).id);

    // "Reduces activity by exactly the refund" — stated as the difference, which
    // is the thing the claim is about, rather than only as the new total.
    const delta = (afterRefund?.activityMinor ?? 0n) - (beforeRefund?.activityMinor ?? 0n);
    expect(delta).toBe(4_000n);
    // Netted, not excluded: $100 spent less $40 back leaves $60 in the envelope.
    expect(afterRefund?.activityMinor).toBe(-6_000n);
    expect(afterRefund?.refundMinor).toBe(4_000n);
    expect(afterRefund?.refundNettedCount).toBe(1);
    // A refund is not income. Both rows are still counted as transactions.
    expect(afterRefund?.transactionCount).toBe(2);
    expect(afterRefund?.inflowMinor).toBe(4_000n);

    const line = await lineFor(period.id, fun);
    expect(line.availableMinor).toBe(30_000n - 6_000n);

    // The period's income must not have absorbed the refund — `PCT_OF_INCOME`
    // goals would otherwise grow every time a merchant handed money back.
    const periodRow = await database.db
      .select()
      .from(budgetPeriods)
      .where(eq(budgetPeriods.id, period.id));
    expect(periodRow[0]?.incomeMinor).toBe(0n);
  }, 180_000);

  /**
   * WP 2.12 sabotage finding: the test above always posts its refund row with
   * `categoryId: fun` — the *same* category the purchase already carries — so
   * `resolveCategory`'s fallback path (`row.categoryId === null` -> look up
   * `categoryOfPurchase.get(row.refundOfId)`) is never exercised. Deleting
   * that fallback entirely (`resolveCategory` returning only `row.categoryId`)
   * left the test above green — a control that could not observe its own
   * absence, in the exact shape wp1.7-quality.md's read.ts/L6 finding warned
   * about. This test posts a refund with **no category of its own** — the
   * common real shape, since a provider's refund posting rarely repeats the
   * original purchase's category — and asserts it still nets against the
   * *purchase's* envelope via `categoryOfPurchase`, not the uncategorised one.
   */
  it("an uncategorised refund still nets into the purchase's own envelope", async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const { fun } = state.categories;
    const { pump } = pumpFor(state);

    const period = await openWithLines(state, d('2026-06-05'), [{ categoryId: fun, priority: 10 }]);
    await settle(state, d('2026-06-01'));
    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: period.id,
      lineId: (await lineFor(period.id, fun)).id,
      assigned: usd(30_000n),
    });
    await settle(state, d('2026-06-01'));

    const purchase = post(state, {
      accountId: state.checking,
      date: d('2026-06-07'),
      minor: -10_000n,
      categoryId: fun,
    });
    await publishUpserted(state, { from: '2026-06-01', to: '2026-06-30', ids: [purchase] });
    expect(await pump.drain()).toBe(1);

    // A $40 refund, posted with NO category of its own — the shape that only
    // `categoryOfPurchase`'s fallback can resolve.
    const refund = post(state, {
      accountId: state.checking,
      date: d('2026-06-12'),
      minor: 4_000n,
      categoryId: null,
      refundOfId: purchase,
    });
    await publishUpserted(state, { from: '2026-06-01', to: '2026-06-30', ids: [refund] });
    expect(await pump.drain()).toBe(1);

    const funLine = await actualsFor((await lineFor(period.id, fun)).id);
    // Netted into `fun`, the purchase's own envelope — not excluded (which
    // would leave -10,000 unaffected by the refund) and not uncategorised
    // (which would leave `fun` at -10,000 with -4,000 sitting on some other
    // line's actuals instead).
    expect(funLine?.activityMinor).toBe(-6_000n);
    expect(funLine?.refundNettedCount).toBe(1);

    // Every other line in the period must show zero activity: if the refund
    // had missed `categoryOfPurchase`'s fallback and landed in the
    // uncategorised bucket, `fun` would stay at -10,000 and some other
    // `budget_line_actuals` row would carry the +4,000 instead — summing
    // every line's activity for this period is what catches that shape
    // without assuming where a null-category row would even persist.
    const allLinesInPeriod = await database.db
      .select({ id: budgetLines.id })
      .from(budgetLines)
      .where(eq(budgetLines.budgetPeriodId, period.id));
    let totalActivityMinor = 0n;
    for (const { id } of allLinesInPeriod) {
      totalActivityMinor += (await actualsFor(id))?.activityMinor ?? 0n;
    }
    expect(totalActivityMinor).toBe(-6_000n);
  }, 180_000);

  it('a late transaction dirties only the periods from its own forward', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 900_000n, cardMinor: 0n });
    const { groceries } = state.categories;
    const { pump } = pumpFor(state);

    // Three consecutive months, all opened and all clean.
    const january = await openWithLines(state, d('2026-01-10'), [
      { categoryId: groceries, priority: 10 },
    ]);
    const february = await openWithLines(state, d('2026-02-10'), [
      { categoryId: groceries, priority: 10 },
    ]);
    const march = await openWithLines(state, d('2026-03-10'), [
      { categoryId: groceries, priority: 10 },
    ]);
    await settle(state, d('2026-01-01'));

    const statusOf = async () => {
      const rows = await database.db
        .select()
        .from(budgetPeriods)
        .where(eq(budgetPeriods.budgetId, state.budget.id));
      return new Map(rows.map((row) => [row.id, row] as const));
    };

    const clean = await statusOf();
    expect([...clean.values()].every((row) => !row.dirty)).toBe(true);
    const januaryRtaBefore = clean.get(january.id)?.readyToAssignMinor;

    // --- direction 1: the dirty set itself ---------------------------------
    //
    // Asserted before any recompute clears the flags, which is the only moment
    // the set is observable. February's window is [2026-02-01, 2026-03-01), so a
    // row dated 2026-02-14 must dirty February and March and leave January
    // alone.
    await markDirtyFrom(database.db, state.context, {
      budgetId: state.budget.id,
      date: d('2026-02-14'),
    });
    const marked = await dirtyPeriods(database.db, state.context, state.budget.id);
    expect(marked.map((row) => row.id).sort()).toEqual([february.id, march.id].sort());
    expect(marked.map((row) => row.id)).not.toContain(january.id);
    // Oldest first: period n's closing available is period n+1's carryover, so
    // the recompute order is the cascade order and not an arbitrary one.
    expect(marked.map((row) => row.sequence)).toEqual(
      [...marked.map((row) => row.sequence)].sort((a, b) => a - b),
    );

    await recomputeDirty(database.db, state.context, { port: state.ledger.port }, state.budget.id);

    // --- direction 2: end to end, through the consumer ---------------------
    //
    // A transaction arriving late for February. It moves the checking balance,
    // so *any* period that is recomputed from here on gets a different Ready to
    // Assign. That is what makes January's RTA a witness: if it is unchanged,
    // January was not recomputed, and the only way it was not recomputed is that
    // it was never dirtied.
    const late = post(state, {
      accountId: state.checking,
      date: d('2026-02-14'),
      minor: -13_000n,
      categoryId: groceries,
    });
    await publishUpserted(state, { from: '2026-02-14', to: '2026-02-28', ids: [late] });
    expect(await pump.drain()).toBe(1);

    const after = await statusOf();
    expect([...after.values()].every((row) => !row.dirty)).toBe(true);

    // January: untouched.
    expect(after.get(january.id)?.readyToAssignMinor).toBe(januaryRtaBefore);
    expect(after.get(january.id)?.recomputedAt?.getTime()).toBe(
      clean.get(january.id)?.recomputedAt?.getTime(),
    );

    // February: it holds the spending.
    const februaryLine = await lineFor(february.id, groceries);
    expect(februaryLine.availableMinor).toBe(-13_000n);
    expect((await actualsFor(februaryLine.id))?.activityMinor).toBe(-13_000n);

    // January never saw it.
    const januaryLine = await lineFor(january.id, groceries);
    expect(januaryLine.availableMinor).toBe(0n);

    // March: recomputed, and its RTA reflects the balance that moved.
    expect(after.get(march.id)?.readyToAssignMinor).toBe(900_000n - 13_000n);

    // --- and the same forward-only rule for a categorisation change --------
    //
    // `categorization.AssignmentsChanged` names ids and no window, so the
    // consumer asks the port for their dates. The answer must be the same: the
    // row is dated in February, so January stays clean.
    await appendEvent(
      platformOf(database.db),
      AssignmentsChanged.create(
        {
          transactionIds: [late],
          count: 1,
          bySource: { user: 1 },
          trigger: 'confirm',
          ruleId: null,
        },
        { userId: database.userId, correlationId: CORRELATION_ID },
        clock,
      ),
    );
    expect(await pump.drain()).toBe(1);

    const afterRecategorise = await statusOf();
    expect(afterRecategorise.get(january.id)?.readyToAssignMinor).toBe(januaryRtaBefore);
    expect(afterRecategorise.get(january.id)?.recomputedAt?.getTime()).toBe(
      clean.get(january.id)?.recomputedAt?.getTime(),
    );
    // Idempotent: replaying a recompute over unchanged data lands on the same
    // numbers, which is what makes the consumer safe to replay from seq 0.
    expect(
      Money.formatAmount(
        Money.of(afterRecategorise.get(march.id)?.readyToAssignMinor ?? 0n, 'USD'),
      ),
    ).toBe('8870.00');
  }, 180_000);
});
