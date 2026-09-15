// SPDX-License-Identifier: MIT
/**
 * Phase 1 security gate — the ledger's read and write functions are scoped to
 * the user who asked, proven with a *second* user's rows in the same tables.
 *
 * ## Why this file exists
 *
 * The gate deleted the `eq(transactions.userId, input.userId)` predicate from
 * `listForCategorization` — the query that feeds the categorization consumer,
 * which is driven by an outbox event carrying transaction ids it does not own —
 * and ran everything that could plausibly notice:
 *
 * ```
 * $ vitest run --project ledger --project ledger-db \
 *     --project categorization --project categorization-db
 *  Test Files  21 passed (21)
 *       Tests  426 passed (426)
 *
 * $ vitest run --project api-db
 *  Test Files  8 passed | 1 skipped (9)
 *       Tests  85 passed | 1 skipped (86)
 * ```
 *
 * Five hundred and eleven green tests with the ownership predicate deleted from
 * a query that decides which rows a background consumer rewrites. Every suite
 * in the repo seeds exactly one user, so no test in it can distinguish "scoped
 * to the caller" from "scoped to nothing".
 *
 * D6 makes this a today problem, not a multi-user-someday problem: `user_id` is
 * on every table from the first migration precisely so that multi-user is
 * additive later. Scoping that is only ever exercised against a single user is
 * scoping nobody has tested, and it is being written now.
 *
 * ## What it asserts
 *
 * One database, two users, symmetric rows. Each read returns only the caller's
 * row; each write refuses a transaction id the caller does not own and leaves
 * the other user's row byte-identical.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transactions } from '../schema/index.ts';
import { applyProviderTransactions } from '../src/apply.ts';
import { setRuleCategory, setTransactionOverlay } from '../src/overlay.ts';
import { getTransaction, listForCategorization, listTransactions } from '../src/read.ts';
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

const FOREIGN_CATEGORY = '01920000-0000-7000-8000-0000000000e1';

describe.skipIf(NO_DATABASE)('ledger user scoping', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;

  let alice: string;
  let bob: string;
  let aliceTransactionId: string;
  let bobTransactionId: string;

  beforeAll(async () => {
    database = await ledgerDatabase('gate_user_scope');
    clock = testClock();

    alice = database.userId;
    bob = await database.createUser('Bob');

    const aliceAccount = await seedAccount(database, clock, {
      userId: alice,
      providerAccountId: 'pa-alice',
    });
    const bobAccount = await seedAccount(database, clock, {
      userId: bob,
      providerAccountId: 'pa-bob',
    });

    const write = async (userId: string, accountId: string, id: string): Promise<string> => {
      const result = await database.db.transaction(async (tx) =>
        applyProviderTransactions(tx, {
          userId,
          accountId,
          provider: 'plaid',
          clock,
          correlationId: CORRELATION_ID,
          added: [providerTransaction({ providerTransactionId: id, name: id.toUpperCase() })],
        }),
      );
      const transactionId = result.addedTransactionIds[0] ?? '';
      expect(transactionId).not.toBe('');
      return transactionId;
    };

    aliceTransactionId = await write(alice, aliceAccount, 'tx-alice');
    bobTransactionId = await write(bob, bobAccount, 'tx-bob');
    expect(aliceTransactionId).not.toBe(bobTransactionId);
  }, 180_000);

  afterAll(async () => {
    await database?.drop();
  });

  // --------------------------------------------------------------- the feeds

  it('listTransactions returns only the calling user’s rows', async () => {
    const mine = await listTransactions(database.db, { userId: alice, filters: {} });
    expect(mine.items.map((row) => row.id)).toEqual([aliceTransactionId]);

    const theirs = await listTransactions(database.db, { userId: bob, filters: {} });
    expect(theirs.items.map((row) => row.id)).toEqual([bobTransactionId]);
  });

  it('listForCategorization cannot be handed another user’s transaction ids', async () => {
    // The exact shape of the attack the consumer is exposed to: an event whose
    // payload names transaction ids, resolved against the event's `userId`.
    // Asking for Bob's row *as Alice* must return nothing, not Bob's row.
    const asAlice = await listForCategorization(database.db, {
      userId: alice,
      filters: { transactionIds: [aliceTransactionId, bobTransactionId] },
    });
    expect(asAlice.items.map((row) => row.id)).toEqual([aliceTransactionId]);

    const asBob = await listForCategorization(database.db, {
      userId: bob,
      filters: { transactionIds: [aliceTransactionId, bobTransactionId] },
    });
    expect(asBob.items.map((row) => row.id)).toEqual([bobTransactionId]);

    // And with no filter at all, each user sees only their own — the case a
    // scheduled full re-categorisation run hits.
    const everythingAlice = await listForCategorization(database.db, { userId: alice });
    expect(everythingAlice.items.map((row) => row.id)).toEqual([aliceTransactionId]);
  });

  it('getTransaction refuses another user’s id', async () => {
    await expect(
      getTransaction(database.db, { userId: alice, transactionId: bobTransactionId }),
    ).rejects.toMatchObject({ code: 'ledger.transaction_not_found' });
  });

  // -------------------------------------------------------------- the writes

  it('setRuleCategory refuses another user’s transaction and changes nothing', async () => {
    const before = await database.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, bobTransactionId));

    await expect(
      setRuleCategory(
        database.db,
        { userId: alice, transactionId: bobTransactionId, ruleCategoryId: FOREIGN_CATEGORY },
        writeContext(clock),
      ),
    ).rejects.toMatchObject({ code: 'ledger.transaction_not_found' });

    const after = await database.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, bobTransactionId));
    expect(after[0]?.ruleCategoryId).toBeNull();
    expect(after[0]?.updatedAt).toEqual(before[0]?.updatedAt);
  });

  it('setTransactionOverlay refuses another user’s transaction and changes nothing', async () => {
    await expect(
      setTransactionOverlay(
        database.db,
        {
          userId: alice,
          transactionId: bobTransactionId,
          patch: { userNote: 'written by the wrong user', userCategoryId: FOREIGN_CATEGORY },
        },
        writeContext(clock),
      ),
    ).rejects.toMatchObject({ code: 'ledger.transaction_not_found' });

    const bobRow = await getTransaction(database.db, {
      userId: bob,
      transactionId: bobTransactionId,
    });
    expect(bobRow.effective.note).toBeNull();
    expect(bobRow.effective.categoryId).toBeNull();
  });
});
