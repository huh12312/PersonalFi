// SPDX-License-Identifier: MIT
/**
 * WP 9.14 / P-4 (WP 9.9 `wp9.9-perf.md` §9): the budgeting consumer handled about one bulk event per second.
 * Loading the 50k corpus emitted 2,737 `ledger.TransferPaired` events; each one marked every later period
 * dirty and then recomputed ALL of them, so a backlog cost (events × periods) full recomputes where one
 * would do — the recompute is "a deterministic function of current state", so recomputing after event 1 of
 * 2,737 is work the last event throws away.
 *
 * The fix is in the consumer, not the pump: every event still marks its periods dirty (inside its own
 * transaction, so a crash or a retry loses nothing), but an event that is NOT the last unprocessed one for
 * its holder leaves the recompute to the one that is. The test drives the real pump over the real consumer
 * and counts recomputes through the ledger port, which every recompute reads exactly once.
 */
import { DateOnly } from '@core/kernel';
import { appendEvent, createConsumerPump, defineEvent, platformExecutor } from '@core/platform';
import { recordingLogger } from '@core/testkit';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { budgetLineActuals, budgetLines, budgetPeriods } from '../../schema/index.ts';
import { createBudgetingConsumer } from '../../src/consumer.ts';
import { platformOf } from '../../src/db.ts';
import type { LedgerPort } from '../../src/ledger-port.ts';
import { assign } from '../../src/service.ts';
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
  type TestDatabase,
} from '../harness.ts';

const d = DateOnly.parse;
const uuid = z.uuid();

/** `@ctx/ledger`'s, redeclared (see `actuals-consumer.test.ts` for why it is not imported). */
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

describe.skipIf(NO_DATABASE)('the budgeting consumer over a backlog (P-4)', () => {
  let database: TestDatabase;
  const clock = clockAt();

  beforeAll(async () => {
    database = await budgetingDatabase('consumer_backlog');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  /** A port that counts recomputes: `recomputePeriod` reads the account list exactly once. */
  function counting(port: LedgerPort): { port: LedgerPort; recomputes: () => number } {
    let count = 0;
    return {
      port: {
        listForBudget: (input) => port.listForBudget(input),
        listBudgetAccounts: (input) => {
          count += 1;
          return port.listBudgetAccounts(input);
        },
      },
      recomputes: () => count,
    };
  }

  async function publish(userId: string, accountId: string, ids: string[]): Promise<void> {
    await appendEvent(
      platformOf(database.db),
      TransactionsUpserted.create(
        {
          accountId,
          addedIds: ids,
          updatedIds: [],
          removedIds: [],
          dateFrom: '2026-06-01',
          dateTo: '2026-06-30',
          count: ids.length,
        },
        { userId, correlationId: CORRELATION_ID },
        clock,
      ),
    );
  }

  it('a backlog of events recomputes once, ends clean, and lands on the same envelopes one-by-one would', async () => {
    await database.truncate();
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const { groceries } = state.categories;
    const period = await openWithLines(state, d('2026-06-05'), [
      { categoryId: groceries, priority: 10 },
    ]);
    await settle(state, d('2026-06-01'));
    const line = (
      await database.db
        .select()
        .from(budgetLines)
        .where(
          and(eq(budgetLines.budgetPeriodId, period.id), eq(budgetLines.categoryId, groceries)),
        )
    )[0];
    await assign(database.db, state.context, {
      budgetId: state.budget.id,
      periodId: period.id,
      lineId: line?.id ?? '',
      assigned: usd(100_000n),
    });
    await settle(state, d('2026-06-01'));

    // Twenty sync pages' worth of events, each naming one new row.
    const EVENTS = 20;
    for (let index = 0; index < EVENTS; index += 1) {
      const id = post(state, {
        accountId: state.checking,
        date: d('2026-06-10'),
        minor: -1_000n,
        categoryId: groceries,
      });
      await publish(database.userId, state.checking, [id]);
    }

    const watched = counting(state.ledger.port);
    const pump = createConsumerPump({
      pool: database.pool,
      db: platformExecutor(database.db),
      clock,
      logger: recordingLogger(),
      consumers: [createBudgetingConsumer({ database: database.db, port: watched.port })],
    });
    expect(await pump.drain()).toBe(EVENTS);

    // One recompute for the backlog, not twenty. (A second would be tolerated by the claim; twenty is not.)
    expect(watched.recomputes()).toBeLessThanOrEqual(2);
    // Nothing is left dirty, and the envelope holds every one of the twenty rows.
    const dirty = await database.db
      .select()
      .from(budgetPeriods)
      .where(and(eq(budgetPeriods.budgetId, state.budget.id), eq(budgetPeriods.dirty, true)));
    expect(dirty).toHaveLength(0);
    const actuals = (
      await database.db
        .select()
        .from(budgetLineActuals)
        .where(eq(budgetLineActuals.budgetLineId, line?.id ?? ''))
    )[0];
    expect(actuals?.activityMinor).toBe(-1_000n * BigInt(EVENTS));
    expect(actuals?.transactionCount).toBe(EVENTS);
  });

  it("another holder's later event does not suppress this holder's recompute", async () => {
    await database.truncate();
    const other = await database.createUser('Other');
    const state = await scenario(database, { checkingMinor: 500_000n, cardMinor: 0n });
    const { groceries } = state.categories;
    const period = await openWithLines(state, d('2026-06-05'), [
      { categoryId: groceries, priority: 10 },
    ]);
    await settle(state, d('2026-06-01'));

    const id = post(state, {
      accountId: state.checking,
      date: d('2026-06-10'),
      minor: -4_200n,
      categoryId: groceries,
    });
    await publish(database.userId, state.checking, [id]);
    // The LAST event in the log belongs to somebody else.
    await publish(other, state.checking, [crypto.randomUUID()]);

    const pump = createConsumerPump({
      pool: database.pool,
      db: platformExecutor(database.db),
      clock,
      logger: recordingLogger(),
      consumers: [createBudgetingConsumer({ database: database.db, port: state.ledger.port })],
    });
    expect(await pump.drain()).toBe(2);

    const dirty = await database.db
      .select()
      .from(budgetPeriods)
      .where(and(eq(budgetPeriods.id, period.id), eq(budgetPeriods.dirty, true)));
    expect(dirty, 'the holder with the budget ends clean').toHaveLength(0);
    const line = (
      await database.db
        .select()
        .from(budgetLines)
        .where(
          and(eq(budgetLines.budgetPeriodId, period.id), eq(budgetLines.categoryId, groceries)),
        )
    )[0];
    const actuals = (
      await database.db
        .select()
        .from(budgetLineActuals)
        .where(eq(budgetLineActuals.budgetLineId, line?.id ?? ''))
    )[0];
    expect(actuals?.activityMinor).toBe(-4_200n);
  });
});
