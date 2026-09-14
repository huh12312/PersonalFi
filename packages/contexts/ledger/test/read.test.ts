// SPDX-License-Identifier: MIT
/**
 * The transaction list: filters, and the property that makes keyset pagination
 * worth the extra machinery — a page boundary that does not move when rows are
 * inserted above it.
 */
import { DateOnly, money } from '@core/kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyProviderTransactions } from '../src/apply.ts';
import { getTransaction, listTransactions, sumTransactions } from '../src/read.ts';
import { setTransactionOverlay } from '../src/overlay.ts';
import {
  CORRELATION_ID,
  NO_DATABASE,
  ledgerDatabase,
  providerTransaction,
  seedAccount,
  testClock,
  writeContext,
  type TestDatabase,
} from './harness.ts';

describe.skipIf(NO_DATABASE)('listTransactions', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;
  let checkingId: string;
  let cardId: string;

  beforeAll(async () => {
    database = await ledgerDatabase('read');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    checkingId = await seedAccount(database, clock, { providerAccountId: 'pa-checking' });
    cardId = await seedAccount(database, clock, {
      providerAccountId: 'pa-card',
      name: 'Rewards Visa',
      type: 'credit',
    });

    await add(checkingId, [
      item('t-coffee', '2026-05-20', -1_234n, 'SQ *BLUE BOTTLE 4471'),
      item('t-groceries', '2026-05-18', -9_900n, 'WHOLEFDS MKT #10259'),
      item('t-salary', '2026-05-01', 420_000n, 'ACME CORP PAYROLL'),
    ]);
    await add(cardId, [
      item('t-books', '2026-05-19', -3_500n, 'POWELLS BOOKS PORTLAND OR'),
      item('t-pending', '2026-05-21', -2_000n, 'SHELL OIL 57443021 PORTLAND OR', true),
    ]);
  });

  function item(
    id: string,
    date: string,
    amountMinor: bigint,
    name: string,
    pending = false,
  ): ReturnType<typeof providerTransaction> {
    return providerTransaction({
      providerTransactionId: id,
      postedDate: DateOnly.parse(date),
      amount: money(amountMinor, 'USD'),
      name,
      pending,
    });
  }

  async function add(
    accountId: string,
    added: ReturnType<typeof providerTransaction>[],
  ): Promise<string[]> {
    const result = await database.db.transaction(async (tx) =>
      applyProviderTransactions(tx, {
        userId: database.userId,
        accountId,
        provider: 'plaid',
        added,
        clock,
        correlationId: CORRELATION_ID,
      }),
    );
    return [...result.addedTransactionIds];
  }

  it('orders newest first and pages by keyset', async () => {
    const first = await listTransactions(database.db, { userId: database.userId, limit: 2 });
    expect(first.items.map((row) => row.effective.date)).toEqual(['2026-05-21', '2026-05-20']);
    expect(first.nextCursor).not.toBeNull();

    const second = await listTransactions(database.db, {
      userId: database.userId,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((row) => row.effective.date)).toEqual(['2026-05-19', '2026-05-18']);

    const third = await listTransactions(database.db, {
      userId: database.userId,
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.items.map((row) => row.effective.date)).toEqual(['2026-05-01']);
    expect(third.nextCursor).toBeNull();
  });

  it('does not skip or repeat a row when a sync inserts above the cursor', async () => {
    const first = await listTransactions(database.db, { userId: database.userId, limit: 2 });
    const seen = first.items.map((row) => row.id);

    // A nightly sync lands four new transactions dated *after* everything on
    // page one. With `OFFSET 2`, page two would start four rows further down and
    // the user would never see two of the rows they were reading.
    await add(checkingId, [
      item('t-new-1', '2026-05-25', -100n, 'NEW ONE'),
      item('t-new-2', '2026-05-26', -200n, 'NEW TWO'),
      item('t-new-3', '2026-05-27', -300n, 'NEW THREE'),
      item('t-new-4', '2026-05-28', -400n, 'NEW FOUR'),
    ]);

    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await listTransactions(database.db, {
        userId: database.userId,
        limit: 2,
        cursor,
      });
      seen.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor;
    }

    expect(new Set(seen).size).toBe(seen.length);
    // Every row that existed when paging began is still reachable.
    expect(seen).toHaveLength(5);
  });

  it('filters by account, date, amount, pending and text', async () => {
    const byAccount = await listTransactions(database.db, {
      userId: database.userId,
      filters: { accountIds: [cardId] },
    });
    expect(byAccount.items).toHaveLength(2);

    const byDate = await listTransactions(database.db, {
      userId: database.userId,
      filters: { dateFrom: DateOnly.parse('2026-05-19'), dateTo: DateOnly.parse('2026-05-20') },
    });
    expect(byDate.items.map((row) => row.effective.date)).toEqual(['2026-05-20', '2026-05-19']);

    const bigOutflows = await listTransactions(database.db, {
      userId: database.userId,
      filters: { amountMaxMinor: -3_000n },
    });
    expect(bigOutflows.items.map((row) => row.effective.amount.minor)).toEqual([-3_500n, -9_900n]);

    const pending = await listTransactions(database.db, {
      userId: database.userId,
      filters: { pending: true },
    });
    expect(pending.items).toHaveLength(1);

    // The trigram index earns its keep here: an infix match against descriptor
    // noise is what a prefix index cannot do.
    const search = await listTransactions(database.db, {
      userId: database.userId,
      filters: { search: 'wholefds' },
    });
    expect(search.items).toHaveLength(1);
    expect(search.items[0]?.effective.name).toContain('Wholefds');
  });

  it('treats a wildcard in the search box as text, not as a wildcard', async () => {
    const all = await listTransactions(database.db, {
      userId: database.userId,
      filters: { search: '%' },
    });
    expect(all.items).toHaveLength(0);
  });

  it('honours the user exclusion flag', async () => {
    const page = await listTransactions(database.db, { userId: database.userId, limit: 1 });
    const id = page.items[0]?.id ?? '';
    await database.db.transaction(async (tx) =>
      setTransactionOverlay(
        tx,
        { userId: database.userId, transactionId: id, patch: { userExcluded: true } },
        writeContext(clock),
      ),
    );

    const included = await listTransactions(database.db, {
      userId: database.userId,
      filters: { excluded: false },
    });
    expect(included.items.map((row) => row.id)).not.toContain(id);
  });

  it('sums what a filter selects, by currency', async () => {
    const totals = await sumTransactions(database.db, {
      userId: database.userId,
      filters: { accountIds: [checkingId] },
    });
    expect(totals).toEqual([{ currency: 'USD', total: money(408_866n, 'USD') }]);
  });

  it("never shows another account holder their neighbour's transactions", async () => {
    const stranger = await database.createUser('Someone Else');
    const page = await listTransactions(database.db, { userId: stranger });
    expect(page.items).toHaveLength(0);
  });

  it('refuses an unknown transaction id rather than returning an empty shell', async () => {
    await expect(
      getTransaction(database.db, {
        userId: database.userId,
        transactionId: '01920000-0000-7000-8000-00000000dead',
      }),
    ).rejects.toMatchObject({ code: 'ledger.transaction_not_found' });
  });
});
