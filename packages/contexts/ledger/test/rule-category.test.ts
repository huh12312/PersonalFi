// SPDX-License-Identifier: MIT
/**
 * `setRuleCategory` against a real Postgres.
 *
 * `resolveCategoryId`'s tier order (`effective.test.ts`) is already proven pure
 * and in-memory; what only a real database can show is that the *write path*
 * honours it end to end — that a rule's write survives a read back through
 * `getTransaction`/`listTransactions`, that it never touches the `user_*`
 * columns it sits beside, and that a later rule write cannot dislodge a user's
 * own edit once one exists. `effective-invariant.test.ts`-style rehydration is
 * exactly what `resolveCategoryId` inside `effectiveOf` is exercising here.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { transactions } from '../schema/index.ts';
import { applyProviderTransactions } from '../src/apply.ts';
import { setRuleCategory, setTransactionOverlay } from '../src/overlay.ts';
import { getTransaction, listTransactions } from '../src/read.ts';
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

const RULE_CATEGORY_A = '01920000-0000-7000-8000-0000000000d1';
const RULE_CATEGORY_B = '01920000-0000-7000-8000-0000000000d2';
const USER_CATEGORY = '01920000-0000-7000-8000-0000000000d3';

describe.skipIf(NO_DATABASE)('setRuleCategory', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;
  let accountId: string;
  let transactionId: string;

  beforeAll(async () => {
    database = await ledgerDatabase('rule_category');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    accountId = await seedAccount(database, clock);

    const result = await database.db.transaction(async (tx) =>
      applyProviderTransactions(tx, {
        userId: database.userId,
        accountId,
        provider: 'plaid',
        clock,
        correlationId: CORRELATION_ID,
        added: [providerTransaction({ providerTransactionId: 'tx-1' })],
      }),
    );
    transactionId = result.addedTransactionIds[0] ?? '';
    expect(transactionId).not.toBe('');
  });

  it('has no category before anything has spoken — the provider/classifier tiers live in @ctx/categorization', async () => {
    const detail = await getTransaction(database.db, {
      userId: database.userId,
      transactionId,
    });
    expect(detail.effective.categoryId).toBeNull();
  });

  it('a rule answers when nothing else has', async () => {
    await database.db.transaction(async (tx) =>
      setRuleCategory(
        tx,
        { userId: database.userId, transactionId, ruleCategoryId: RULE_CATEGORY_A },
        writeContext(clock),
      ),
    );

    const detail = await getTransaction(database.db, {
      userId: database.userId,
      transactionId,
    });
    expect(detail.effective.categoryId).toBe(RULE_CATEGORY_A);

    const page = await listTransactions(database.db, { userId: database.userId });
    expect(page.items[0]?.effective.categoryId).toBe(RULE_CATEGORY_A);
  });

  it('the user beats the rule, whichever was written first', async () => {
    // Rule first, then the user overrides it.
    await database.db.transaction(async (tx) =>
      setRuleCategory(
        tx,
        { userId: database.userId, transactionId, ruleCategoryId: RULE_CATEGORY_A },
        writeContext(clock),
      ),
    );
    await database.db.transaction(async (tx) =>
      setTransactionOverlay(
        tx,
        { userId: database.userId, transactionId, patch: { userCategoryId: USER_CATEGORY } },
        writeContext(clock),
      ),
    );

    const afterUser = await getTransaction(database.db, {
      userId: database.userId,
      transactionId,
    });
    expect(afterUser.effective.categoryId).toBe(USER_CATEGORY);
  });

  it('a rule write never overwrites — or is visible over — an existing user override', async () => {
    await database.db.transaction(async (tx) =>
      setTransactionOverlay(
        tx,
        { userId: database.userId, transactionId, patch: { userCategoryId: USER_CATEGORY } },
        writeContext(clock),
      ),
    );

    // A later rule decision (a different rule, a re-sync, whatever) must not
    // change what the user sees, and must not touch user_category_id itself.
    await database.db.transaction(async (tx) =>
      setRuleCategory(
        tx,
        { userId: database.userId, transactionId, ruleCategoryId: RULE_CATEGORY_B },
        writeContext(clock),
      ),
    );

    const detail = await getTransaction(database.db, {
      userId: database.userId,
      transactionId,
    });
    expect(detail.effective.categoryId).toBe(USER_CATEGORY);

    const rows = await database.db
      .select({
        userCategoryId: transactions.userCategoryId,
        ruleCategoryId: transactions.ruleCategoryId,
      })
      .from(transactions)
      .where(eq(transactions.id, transactionId));
    // The rule write landed in its own column — proof it wrote *something* —
    // but user_category_id, the column that actually wins, is untouched.
    expect(rows[0]?.userCategoryId).toBe(USER_CATEGORY);
    expect(rows[0]?.ruleCategoryId).toBe(RULE_CATEGORY_B);
  });

  it('a rule can be cleared (ruleCategoryId: null) without touching the user column', async () => {
    await database.db.transaction(async (tx) =>
      setRuleCategory(
        tx,
        { userId: database.userId, transactionId, ruleCategoryId: RULE_CATEGORY_A },
        writeContext(clock),
      ),
    );
    await database.db.transaction(async (tx) =>
      setRuleCategory(
        tx,
        { userId: database.userId, transactionId, ruleCategoryId: null },
        writeContext(clock),
      ),
    );

    const detail = await getTransaction(database.db, {
      userId: database.userId,
      transactionId,
    });
    expect(detail.effective.categoryId).toBeNull();

    const rows = await database.db
      .select({ userCategoryId: transactions.userCategoryId })
      .from(transactions)
      .where(eq(transactions.id, transactionId));
    expect(rows[0]?.userCategoryId).toBeNull();
  });

  it('refuses to write a rule category for another user’s transaction', async () => {
    await expect(
      database.db.transaction(async (tx) =>
        setRuleCategory(
          tx,
          {
            userId: '01920000-0000-7000-8000-000000000fff',
            transactionId,
            ruleCategoryId: RULE_CATEGORY_A,
          },
          writeContext(clock),
        ),
      ),
    ).rejects.toThrow(/no transaction/);
  });
});
