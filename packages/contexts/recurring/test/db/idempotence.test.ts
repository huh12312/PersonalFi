// SPDX-License-Identifier: MIT
/**
 * Replay safety, asserted on whole rows rather than on a hand-picked subset.
 *
 * The consumer's contract with `@core/platform` is that running it five times
 * is identical to running it once: the pump retries after a crash between the
 * work and the offset advance, and `registerConsumer`'s whole replay story —
 * bump the version, replay from seq 0, rebuild the read model — depends on it.
 * Detection makes that easy to claim and easy to get wrong, because it is a
 * deterministic function of current state: a replay re-derives every stream,
 * and the temptation is to write them all back and announce them all again.
 *
 * ## What "identical" means here
 *
 * Every column of every row of all five tables, plus the `domain_events` count.
 * Not a chosen subset — `updated_at` and `last_detected_at` are *included*, and
 * they are the interesting ones. A `SET ... updated_at = now()` on an unchanged
 * row is invisible to any assertion that skips timestamps, and it is exactly
 * what a naive `ON CONFLICT DO UPDATE` produces. `store.ts` reads before it
 * writes and skips when nothing differs precisely so that this comparison can
 * be total, and a new column added later is covered by this test the day it is
 * added rather than the day somebody remembers to add it here.
 *
 * `domain_events` is counted rather than dumped because its `id` and `seq` are
 * generated per append: if the count is unchanged, nothing was appended, which
 * is the property (edge-triggered emission) the events file promises.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecurringConsumer } from '../../src/consumer.ts';
import { runDetection } from '../../src/service.ts';
import {
  EPOCH,
  LATER_SAME_DAY,
  NO_DATABASE,
  SEED_NUMBER,
  ZONE,
  clockAt,
  consumerContext,
  contextFor,
  countRows,
  dumpTable,
  inMemoryLedgerPort,
  recurringDatabase,
  rowsAsOf,
  seedDataset,
  TODAY,
  upsertedEnvelope,
  type TestDatabase,
} from './harness.ts';

/** Every table this context owns, with an order that is stable across runs. */
const OWNED_TABLES: readonly (readonly [string, string])[] = [
  ['recurring_series', 'stream_key'],
  ['recurring_occurrences', 'transaction_id'],
  ['recurring_candidates', 'stream_key'],
  ['subscription_metadata', 'series_id'],
  ['price_change_events', 'series_id, effective_date, direction'],
];

async function snapshot(
  database: TestDatabase,
): Promise<Record<string, readonly Record<string, unknown>[]>> {
  const out: Record<string, readonly Record<string, unknown>[]> = {};
  for (const [table, order] of OWNED_TABLES) {
    out[table] = await dumpTable(database, table, order);
  }
  return out;
}

describe.skipIf(NO_DATABASE)('consumer replay', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await recurringDatabase('idempotence');
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it('replaying the consumer twice produces identical rows', async () => {
    await database.truncate();

    const dataset = seedDataset(SEED_NUMBER);
    const rows = rowsAsOf(dataset, TODAY);
    const consumer = createRecurringConsumer({
      database: database.db,
      port: inMemoryLedgerPort(rows),
      options: { timeZone: ZONE },
    });

    // The *same* envelope both times — same id, same payload. This is a replay,
    // not a second sync: the pump redelivering an event it already delivered is
    // the case that must be free, and it is the one a retry after a crash
    // produces.
    const envelope = upsertedEnvelope({
      userId: database.userId,
      accountId: dataset.accounts[0]?.id ?? '',
      transactionIds: rows.map((row) => row.id),
    });
    const context = consumerContext(clockAt(EPOCH));

    await consumer.handler(envelope, context);

    const first = await snapshot(database);
    const eventsAfterFirst = await countRows(database, 'domain_events');
    expect(first['recurring_series']?.length, 'the first run wrote something').toBeGreaterThan(5);
    expect(eventsAfterFirst, 'and announced it').toBeGreaterThan(0);

    await consumer.handler(envelope, context);

    const second = await snapshot(database);
    for (const [table] of OWNED_TABLES) {
      expect(second[table], `${table} is byte-for-byte unchanged by the replay`).toEqual(
        first[table],
      );
    }
    expect(
      await countRows(database, 'domain_events'),
      'a replay announces nothing: every event is emitted from a transition',
    ).toBe(eventsAfterFirst);

    // A third delivery, for the same reason a retry loop does not stop at two.
    await consumer.handler(envelope, context);
    const third = await snapshot(database);
    for (const [table] of OWNED_TABLES) {
      expect(third[table], `${table} is still unchanged after a third delivery`).toEqual(
        first[table],
      );
    }
    expect(await countRows(database, 'domain_events')).toBe(eventsAfterFirst);
  });

  it('a direct re-run of the service is idempotent too, and on a later clock', async () => {
    // The consumer is one caller; "re-detect everything" is another, and it
    // does not go through an envelope. A later wall clock is included because
    // `updated_at` and `last_detected_at` are written from `context.clock`: if
    // the write path bumped them unconditionally, moving the clock forward
    // would be enough to make an unchanged pass look like a change — which is
    // precisely the bug that makes replay-safety hard to keep.
    const dataset = seedDataset(SEED_NUMBER);
    const port = inMemoryLedgerPort(rowsAsOf(dataset, TODAY));

    const before = await snapshot(database);
    const later = contextFor(database.userId, clockAt(LATER_SAME_DAY));
    const result = await runDetection(database.db, later, { port }, { timeZone: ZONE });

    expect(result.seriesInserted).toBe(0);
    expect(result.seriesChanged, 'nothing moved, so nothing was written').toBe(0);
    expect(result.candidatesProposed).toBe(0);
    expect(result.eventsAppended).toBe(0);

    const after = await snapshot(database);
    for (const [table] of OWNED_TABLES) {
      expect(after[table], `${table} survived a re-run on a later clock`).toEqual(before[table]);
    }
  });
});
