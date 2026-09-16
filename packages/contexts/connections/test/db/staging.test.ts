// SPDX-License-Identifier: MIT
/**
 * `connection_staged_facts` (decision D-5, migration `0008_connections_staging.sql`),
 * against a real Postgres.
 *
 * `createManualStagingStore`/`createCsvStagingStore` (`../../src/staging.ts`)
 * hold no state of their own — every method is a plain query or a single
 * insert against the table — so the properties worth proving here are
 * properties of the table, not of the function that builds a handle onto it:
 *
 *   * a **second, independent call** to `createManualStagingStore` sees
 *     exactly what an earlier one wrote (the "restart" this decision exists
 *     for is nothing more than "a new object, same database");
 *   * `appendTransactions` is idempotent on `provider_transaction_id`, so
 *     replaying a page — a crash between the flush and the caller advancing
 *     its own "already flushed" counter, or a CSV re-import — stages nothing
 *     twice;
 *   * two connections, even two connections belonging to two different
 *     users, never see each other's rows through the same store object.
 *
 * `createManualStagingStore` and `createCsvStagingStore` are exercised
 * interchangeably below except where noted: both are `buildStagingStore`
 * under two names (`../../src/staging.ts`), so a property proven against one
 * is a property of the shared implementation.
 */
import { DateOnly, money, newId } from '@core/kernel';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connections } from '../../schema/connections.ts';
import { connectionStagedFacts } from '../../schema/staging.ts';
import { createCsvStagingStore, createManualStagingStore } from '../../src/staging.ts';
import {
  NO_DATABASE,
  TEST_ACCOUNT,
  connectionsDatabase,
  manualTransaction,
  type TestDatabase,
} from '../harness.ts';

describe.skipIf(NO_DATABASE)('durable staging (decision D-5)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await connectionsDatabase('staging');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  afterEach(async () => {
    await database.truncate();
  });

  /** A real `connections` row, so the table's foreign keys are satisfied. */
  async function insertConnection(userId: string, providerConnectionId: string): Promise<string> {
    const id = newId();
    await database.db.insert(connections).values({
      id,
      userId,
      provider: 'manual',
      providerConnectionId,
      displayName: `Test connection ${providerConnectionId}`,
      status: 'active',
    });
    return id;
  }

  function transactionOn(providerAccountId: string, providerTransactionId: string, day: string) {
    return manualTransaction({
      providerAccountId,
      providerTransactionId,
      amount: money(-1_234n, 'USD'),
      postedDate: DateOnly.parse(day),
      name: `MERCHANT ${providerTransactionId}`,
    });
  }

  // -------------------------------------------------------------------------
  // Restart survival
  // -------------------------------------------------------------------------

  it('a fresh store instance sees exactly what an earlier one staged (restart survival)', async () => {
    const connectionId = await insertConnection(database.userId, 'restart-1');
    const before = createManualStagingStore(database.db);
    await before.open(connectionId, database.userId);
    await before.putAccounts(connectionId, database.userId, [TEST_ACCOUNT]);
    await before.putBalances(connectionId, database.userId, [
      {
        providerAccountId: TEST_ACCOUNT.providerAccountId,
        current: money(50_000n, 'USD'),
        available: null,
        limit: null,
        asOf: new Date('2026-06-01T00:00:00.000Z'),
      },
    ]);
    const fact = transactionOn(TEST_ACCOUNT.providerAccountId, 'txn-restart-1', '2026-06-01');
    await before.appendTransactions(connectionId, database.userId, [
      {
        kind: 'added',
        providerAccountId: fact.providerAccountId,
        providerTransactionId: fact.providerTransactionId,
        fact,
      },
    ]);

    // A brand-new store object — nothing shared with `before` except the
    // database connection, exactly the shape `apps/api/src/domain.ts`'s
    // `attachDurableStaging` builds fresh on every process boot.
    const after = createManualStagingStore(database.db);

    expect(await after.has(connectionId)).toBe(true);
    expect(await after.accounts(connectionId)).toEqual([TEST_ACCOUNT]);
    const balances = await after.balances(connectionId);
    expect(balances).toHaveLength(1);
    expect(balances[0]?.current.minor).toBe(50_000n);

    const entries = await after.entriesAfter(connectionId, 0, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: 'added',
      providerTransactionId: fact.providerTransactionId,
      providerAccountId: fact.providerAccountId,
    });
    expect(await after.highestSeq(connectionId)).toBe(entries[0]?.seq);
  });

  it('the CSV staging store, not just the manual one, survives a fresh instance the same way', async () => {
    const connectionId = await insertConnection(database.userId, 'restart-csv-1');
    const before = createCsvStagingStore(database.db);
    await before.open(connectionId, database.userId);
    await before.putAccounts(connectionId, database.userId, [TEST_ACCOUNT]);
    const fact = transactionOn(TEST_ACCOUNT.providerAccountId, 'txn-restart-csv-1', '2026-06-02');
    await before.appendTransactions(connectionId, database.userId, [
      {
        kind: 'added',
        providerAccountId: fact.providerAccountId,
        providerTransactionId: fact.providerTransactionId,
        fact,
      },
    ]);

    const after = createCsvStagingStore(database.db);
    expect(await after.accounts(connectionId)).toEqual([TEST_ACCOUNT]);
    expect(
      (await after.entriesAfter(connectionId, 0, 10)).map((e) => e.providerTransactionId),
    ).toEqual([fact.providerTransactionId]);
  });

  // -------------------------------------------------------------------------
  // Idempotence — a staged row is consumed exactly once
  // -------------------------------------------------------------------------

  it('appendTransactions is idempotent on provider_transaction_id — replaying a batch stages nothing twice', async () => {
    const connectionId = await insertConnection(database.userId, 'idem-1');
    const store = createManualStagingStore(database.db);
    await store.open(connectionId, database.userId);
    const fact = transactionOn(TEST_ACCOUNT.providerAccountId, 'txn-idem-1', '2026-06-03');
    const input = [
      {
        kind: 'added' as const,
        providerAccountId: fact.providerAccountId,
        providerTransactionId: fact.providerTransactionId,
        fact,
      },
    ];

    const first = await store.appendTransactions(connectionId, database.userId, input);
    expect(first).toEqual({ staged: 1, skipped: 0 });

    // A second sync run replays exactly the same page — a crash between the
    // flush and the caller advancing its own "already flushed" watermark, or
    // a CSV file re-imported. Neither should grow the log.
    const second = await store.appendTransactions(connectionId, database.userId, input);
    expect(second).toEqual({ staged: 0, skipped: 1 });

    const entries = await store.entriesAfter(connectionId, 0, 10);
    expect(entries).toHaveLength(1);
  });

  it('two sync runs each consume only the rows staged since their own cursor — none twice, none missed', async () => {
    const connectionId = await insertConnection(database.userId, 'idem-2');
    const store = createManualStagingStore(database.db);
    await store.open(connectionId, database.userId);

    const first = transactionOn(TEST_ACCOUNT.providerAccountId, 'txn-run-1', '2026-06-04');
    await store.appendTransactions(connectionId, database.userId, [
      {
        kind: 'added',
        providerAccountId: first.providerAccountId,
        providerTransactionId: first.providerTransactionId,
        fact: first,
      },
    ]);

    // Run 1 reads from the beginning of the log and advances its cursor to
    // the highest seq it saw.
    const runOne = await store.entriesAfter(connectionId, 0, 10);
    expect(runOne.map((e) => e.providerTransactionId)).toEqual([first.providerTransactionId]);
    const cursorAfterRunOne = runOne.at(-1)?.seq ?? 0;

    // Run 2 starts from run 1's cursor before anything new has been staged:
    // it must see nothing, not a repeat of run 1's row.
    expect(await store.entriesAfter(connectionId, cursorAfterRunOne, 10)).toEqual([]);

    const second = transactionOn(TEST_ACCOUNT.providerAccountId, 'txn-run-2', '2026-06-05');
    await store.appendTransactions(connectionId, database.userId, [
      {
        kind: 'added',
        providerAccountId: second.providerAccountId,
        providerTransactionId: second.providerTransactionId,
        fact: second,
      },
    ]);

    // Now run 2 sees exactly the new row — never run 1's again.
    const runTwo = await store.entriesAfter(connectionId, cursorAfterRunOne, 10);
    expect(runTwo.map((e) => e.providerTransactionId)).toEqual([second.providerTransactionId]);

    // Read from zero, the full log holds each row exactly once, in order.
    const full = await store.entriesAfter(connectionId, 0, 10);
    expect(full.map((e) => e.providerTransactionId)).toEqual([
      first.providerTransactionId,
      second.providerTransactionId,
    ]);
  });

  // -------------------------------------------------------------------------
  // User scoping — a connection's rows are visible only through its own id
  // -------------------------------------------------------------------------

  it("a second user's staged rows never appear under the first user's connection, or vice versa", async () => {
    const secondUserId = await database.createUser('Second Holder');
    const connA = await insertConnection(database.userId, 'scope-a');
    const connB = await insertConnection(secondUserId, 'scope-b');
    const store = createManualStagingStore(database.db);

    await store.open(connA, database.userId);
    await store.open(connB, secondUserId);
    await store.putAccounts(connA, database.userId, [TEST_ACCOUNT]);
    const secondAccount = { ...TEST_ACCOUNT, providerAccountId: 'second-holder-checking' };
    await store.putAccounts(connB, secondUserId, [secondAccount]);

    const factA = transactionOn(TEST_ACCOUNT.providerAccountId, 'txn-scope-a', '2026-06-06');
    const factB = transactionOn(secondAccount.providerAccountId, 'txn-scope-b', '2026-06-06');
    await store.appendTransactions(connA, database.userId, [
      {
        kind: 'added',
        providerAccountId: factA.providerAccountId,
        providerTransactionId: factA.providerTransactionId,
        fact: factA,
      },
    ]);
    await store.appendTransactions(connB, secondUserId, [
      {
        kind: 'added',
        providerAccountId: factB.providerAccountId,
        providerTransactionId: factB.providerTransactionId,
        fact: factB,
      },
    ]);

    expect((await store.accounts(connA)).map((a) => a.providerAccountId)).toEqual([
      TEST_ACCOUNT.providerAccountId,
    ]);
    expect((await store.accounts(connB)).map((a) => a.providerAccountId)).toEqual([
      secondAccount.providerAccountId,
    ]);

    const entriesA = await store.entriesAfter(connA, 0, 10);
    const entriesB = await store.entriesAfter(connB, 0, 10);
    expect(entriesA.map((e) => e.providerTransactionId)).toEqual([factA.providerTransactionId]);
    expect(entriesB.map((e) => e.providerTransactionId)).toEqual([factB.providerTransactionId]);

    // Defense in depth: the row this store wrote for `connA` is stamped with
    // user A's id, never user B's. The column exists so a future read model
    // could filter by `(user_id, connection_id)` rather than trusting
    // `connection_id` alone, and a bug that stamped the wrong owner would be
    // silent without this.
    const rowsForA = await database.db
      .select()
      .from(connectionStagedFacts)
      .where(eq(connectionStagedFacts.connectionId, connA));
    expect(rowsForA.length).toBeGreaterThan(0);
    expect(rowsForA.every((row) => row.userId === database.userId)).toBe(true);

    const rowsForB = await database.db
      .select()
      .from(connectionStagedFacts)
      .where(eq(connectionStagedFacts.connectionId, connB));
    expect(rowsForB.length).toBeGreaterThan(0);
    expect(rowsForB.every((row) => row.userId === secondUserId)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // `close()` — disconnect's durable half
  // -------------------------------------------------------------------------

  it('close() purges everything staged for a connection, and only that connection', async () => {
    const connA = await insertConnection(database.userId, 'close-a');
    const connB = await insertConnection(database.userId, 'close-b');
    const store = createManualStagingStore(database.db);
    await store.open(connA, database.userId);
    await store.open(connB, database.userId);
    await store.putAccounts(connA, database.userId, [TEST_ACCOUNT]);
    await store.putAccounts(connB, database.userId, [TEST_ACCOUNT]);

    await store.close(connA);

    expect(await store.has(connA)).toBe(false);
    expect(await store.accounts(connA)).toEqual([]);
    // The other connection's rows are untouched.
    expect(await store.has(connB)).toBe(true);
    expect(await store.accounts(connB)).toEqual([TEST_ACCOUNT]);
  });
});
