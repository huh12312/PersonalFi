// SPDX-License-Identifier: MIT
/**
 * Decision D25's guard, at the database.
 *
 * A `merchants` row means "a payee was involved". `@ctx/ledger` decides that,
 * with a named, enumerable gate, and the answer is a `merchantId`. A detector
 * that minted rows from descriptors would undo that silently: `TRANSFER TO
 * SAVINGS` and `CHECK 1234` would become merchants — and then *subscriptions*,
 * with budget lines and price-change alerts hanging off them — and nobody would
 * notice until the budget looked wrong for reasons no screen could explain.
 *
 * Three layers stop it, and this file asserts the outcome of all three:
 *
 *   1. **No vocabulary.** The engine's `RecurringInput` has a `merchantId` and
 *      no descriptor. WP 2.2's `no-merchant-writes.test.ts` runs a whole pass
 *      behind a `Proxy` that throws if the engine reads a key the contract does
 *      not name, with `descriptor`/`payee`/`merchantName` present as decoys.
 *   2. **No capability.** `LedgerPort` is read-only — not "has no write we
 *      use", but has no write method at all, so there is nothing to call.
 *   3. **No permission.** `scripts/check-schema-ownership.ts` refuses any
 *      non-test file in this package that names `merchants` in SQL.
 *
 * What is left is the empirical claim, and it is the one this file makes: run a
 * full detection pass over two years of realistic history, through the real
 * consumer, and the `merchants` table is byte-for-byte what it was — **count
 * and ids**. The count alone would pass a pipeline that deleted one row and
 * invented another, which is exactly the failure that would be hardest to see.
 *
 * ## Sabotage
 *
 * This assertion is only worth the lines if it can go red. `docs/evidence/
 * phase-2/wp2.3-recurring.md` §3 records the run where a raw-SQL merchant
 * insert was added to the consumer: this suite failed on both halves (count and
 * ids), `check-schema-ownership.ts` failed independently, and the sabotage was
 * then reverted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recurringSeries } from '../../schema/index.ts';
import { createRecurringConsumer } from '../../src/consumer.ts';
import { eq } from 'drizzle-orm';
import {
  EPOCH,
  NO_DATABASE,
  SEED_NUMBER,
  ZONE,
  clockAt,
  consumerContext,
  countRows,
  inMemoryLedgerPort,
  merchantSnapshot,
  recurringDatabase,
  rowsAsOf,
  seedDataset,
  seedMerchants,
  TODAY,
  upsertedEnvelope,
  type TestDatabase,
} from './harness.ts';

describe.skipIf(NO_DATABASE)('detection never creates a merchant (D25)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await recurringDatabase('nomerchant');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it('a full detection pass leaves merchants row count and ids unchanged', async () => {
    await database.truncate();

    // A populated table, not an empty one. "Zero before, zero after" would pass
    // for a pipeline that cannot write to Postgres at all, which is not the
    // claim — the claim is that a pipeline which demonstrably *can* write to
    // this database leaves this particular table alone.
    const dataset = seedDataset(SEED_NUMBER);
    const seededIds = await seedMerchants(database, dataset);
    const before = await merchantSnapshot(database);
    expect(before.count, 'the guard needs merchants to be unchanged *about*').toBeGreaterThan(5);
    expect(before.ids).toEqual(seededIds);

    const rows = rowsAsOf(dataset, TODAY);
    expect(rows.length, 'two years of history').toBeGreaterThan(500);

    // Through the real consumer, not a direct service call: the consumer is the
    // only thing that runs unattended, and it is where a well-meaning "just
    // create the merchant if it is missing" would be written.
    const consumer = createRecurringConsumer({
      database: database.db,
      port: inMemoryLedgerPort(rows),
      options: { timeZone: ZONE },
    });
    const accountId = dataset.accounts[0]?.id ?? '';
    await consumer.handler(
      upsertedEnvelope({
        userId: database.userId,
        accountId,
        transactionIds: rows.map((row) => row.id),
      }),
      consumerContext(clockAt(EPOCH)),
    );

    // The pass did real work. Without this the assertion below is satisfied by
    // a consumer that threw, returned early, or was never wired to anything.
    const series = await database.db
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.userId, database.userId));
    expect(series.length, 'the pass detected streams').toBeGreaterThan(5);
    expect(await countRows(database, 'recurring_occurrences')).toBeGreaterThan(50);

    const after = await merchantSnapshot(database);
    expect(after.count, 'row count unchanged').toBe(before.count);
    expect(after.ids, 'and the ids themselves, not merely how many').toEqual(before.ids);
  });

  it('every merchant a series points at was already in the table', async () => {
    // The other direction, and the one a count-and-ids check cannot see: a
    // series whose `merchant_id` is not in `merchants` would mean the detector
    // invented an identity without persisting it — the same bug, hidden by the
    // deliberate absence of a foreign key (D25: this context may not reference
    // another context's table).
    const known = new Set((await merchantSnapshot(database)).ids);
    const series = await database.db
      .select()
      .from(recurringSeries)
      .where(eq(recurringSeries.userId, database.userId));
    expect(series.length).toBeGreaterThan(0);

    const invented = series.map((row) => row.merchantId).filter((id) => !known.has(id));
    expect(invented, 'every series points at a merchant the ledger already had').toEqual([]);
  });
});
