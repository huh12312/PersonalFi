// SPDX-License-Identifier: MIT
/**
 * WP 11.8 — a filtered consumer with nothing to do is not "behind".
 *
 * Found on production 2026-10-31: a consumer with a `filter` advanced
 * `last_seq` only when it handled a matching event, so one whose filter
 * matched nothing in the outbox (`insights.advisors@v1` on an install whose
 * 763 events were all ledger/connections events) sat at its first offset
 * forever, and `outboxHealth` counted every event after it as lag — past
 * `READINESS_MAX_OUTBOX_LAG_EVENTS` that reads `degraded` for no reason.
 *
 * The pump now advances such a consumer past events it would skip anyway, to
 * the highest `seq` visible in the same statement that proves none of the
 * skipped events matches. That is safe because `append_domain_event` takes
 * the `PFEVTSEQ` transaction-scoped advisory lock before it draws a `seq`
 * (migration 0003): `seq` order is commit order, so an event not yet visible
 * always has a higher `seq` than every visible one. The second test below is
 * that hazard made concrete — a matching event drawn and still in flight when
 * the pump passes is not skipped.
 *
 * Nothing here reads `processed_events` to decide anything: lag is
 * `outboxHealth`'s, and the idle pass is asserted to have written no receipt.
 */
import { newId, systemClock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appendEvent } from '../src/events/outbox.ts';
import {
  createConsumerPump,
  outboxHealth,
  registerConsumer,
  setConsumerStatus,
} from '../src/events/pump.ts';
import { defineEvent } from '../src/events/registry.ts';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const TransactionsUpserted = defineEvent({
  type: 'ledger.TransactionsUpserted',
  aggregateType: 'account',
  description: 'Ids only.',
  schema: z.object({ accountId: z.uuid(), count: z.int() }),
});

const PricesUpdated = defineEvent({
  type: 'investments.PricesUpdated',
  aggregateType: 'security',
  description: 'Ids only.',
  schema: z.object({ securityIds: z.array(z.uuid()) }),
});

const NAME = 'test.filtered_idle@v1';

describeWithDb('a filtered consumer with nothing to do (WP 11.8)', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('wp118_pump_filtered_idle');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
  });

  async function publishOther(count: number): Promise<bigint[]> {
    const seqs: bigint[] = [];
    for (let index = 0; index < count; index += 1) {
      const recorded = await appendEvent(
        database.db,
        TransactionsUpserted.create(
          { accountId: newId(), count: index },
          { userId: database.userId, correlationId: newId() },
          systemClock,
        ),
      );
      seqs.push(recorded.seq);
    }
    return seqs;
  }

  async function publishMatching(): Promise<bigint> {
    const recorded = await appendEvent(
      database.db,
      PricesUpdated.create(
        { securityIds: [newId()] },
        { userId: database.userId, correlationId: newId() },
        systemClock,
      ),
    );
    return recorded.seq;
  }

  function filteredPump(seen: bigint[], options: { fail?: () => boolean } = {}) {
    return createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [
        registerConsumer(
          NAME,
          (event) => {
            if (options.fail?.() === true) throw new Error('handler refuses');
            seen.push(event.seq);
          },
          { filter: ['investments.PricesUpdated'], maxAttempts: 5 },
        ),
      ],
    });
  }

  async function lastSeq(): Promise<bigint> {
    const rows = await database.db.execute<{ last_seq: bigint }>(
      sql`SELECT last_seq FROM event_consumer_offsets WHERE consumer_name = ${NAME}`,
    );
    return BigInt(rows.rows[0]?.last_seq ?? -1);
  }

  async function lagOf(): Promise<{ lag: number; oldest: number | null; max: number }> {
    const health = await outboxHealth(database.db);
    const consumer = health.consumers.find((entry) => entry.name === NAME);
    return {
      lag: consumer?.lagEvents ?? -1,
      oldest: health.oldestUnprocessedAgeSeconds,
      max: health.maxLagEvents,
    };
  }

  async function receipts(): Promise<number> {
    const rows = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM processed_events WHERE consumer_name = ${NAME}`,
    );
    return Number(rows.rows[0]?.count ?? '0');
  }

  it('N events its filter does not match, one pump pass: lag 0, nothing handled, no receipt; then one matching event: handled, lag 0', async () => {
    const seen: bigint[] = [];
    const pump = filteredPump(seen);
    const others = await publishOther(30);

    expect(await pump.runConsumerOnce(NAME)).toBe(0);
    expect(seen).toEqual([]);
    expect(await receipts(), 'the idle advance writes no delivery receipt').toBe(0);
    expect(await lastSeq()).toBe(others.at(-1));
    expect(await lagOf()).toEqual({ lag: 0, oldest: null, max: 0 });

    const matching = await publishMatching();
    expect(await pump.runConsumerOnce(NAME)).toBe(1);
    expect(seen).toEqual([matching]);
    expect(await lastSeq()).toBe(matching);
    expect(await lagOf()).toEqual({ lag: 0, oldest: null, max: 0 });

    // Non-matching events after the handled one: the same pass that handles a
    // short batch also advances past them.
    const trailing = await publishOther(5);
    const another = await publishMatching();
    const after = await publishOther(3);
    expect(await pump.runConsumerOnce(NAME)).toBe(1);
    expect(seen).toEqual([matching, another]);
    expect(await lastSeq()).toBe(after.at(-1));
    expect(trailing.every((seq) => seq < another)).toBe(true);
    expect((await lagOf()).lag).toBe(0);
  });

  it('the ordering hazard: a matching event whose seq is drawn but not yet committed is not skipped by the advance', async () => {
    const seen: bigint[] = [];
    const pump = filteredPump(seen);
    const before = await publishOther(10);

    // Transaction 1 appends a matching event and stays open: it holds the
    // PFEVTSEQ ordering lock and seq N, invisible to everyone else.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let drawn: (seq: bigint) => void = () => undefined;
    const inFlight = new Promise<bigint>((resolve) => (drawn = resolve));
    const t1 = database.db.transaction(async (tx) => {
      const recorded = await appendEvent(
        tx,
        PricesUpdated.create(
          { securityIds: [newId()] },
          { userId: database.userId, correlationId: newId() },
          systemClock,
        ),
      );
      drawn(recorded.seq);
      await gate;
    });
    const n = await inFlight;
    // Transaction 2, a non-matching event, queues behind the lock: it will
    // draw N+1 only once N has committed.
    const t2 = publishOther(1);

    let advanced: bigint;
    try {
      expect(await pump.runConsumerOnce(NAME)).toBe(0);
      advanced = await lastSeq();
    } finally {
      // Never leave the ordering lock held for the next test, red or green.
      release();
      await t1;
    }
    expect(advanced, 'the advance stops at the last visible event').toBe(before.at(-1));
    expect(advanced < n, 'never past the in-flight matching event').toBe(true);

    const [later] = await t2;
    expect(later).toBe(n + 1n);

    expect(await pump.runConsumerOnce(NAME)).toBe(1);
    expect(seen, 'the in-flight event is delivered, not skipped').toEqual([n]);
    expect(await lastSeq()).toBe(later);
    expect((await lagOf()).lag).toBe(0);
  });

  it('a matching event that commits after the batch was read is not skipped by the same pass', async () => {
    const seen: bigint[] = [];
    let late: bigint | undefined;
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [
        registerConsumer(
          NAME,
          async (event) => {
            seen.push(event.seq);
            // While this short batch is being handled, another writer commits
            // a matching event (its own connection, not the pump's transaction).
            if (late === undefined) late = await publishMatching();
          },
          { filter: ['investments.PricesUpdated'] },
        ),
      ],
    });
    await publishOther(3);
    const first = await publishMatching();
    await publishOther(3);

    expect(await pump.runConsumerOnce(NAME)).toBe(1);
    expect(late).toBeGreaterThan(first);
    expect(await lastSeq(), 'the advance refuses a range holding a matching event').toBe(first);

    expect(await pump.runConsumerOnce(NAME)).toBe(1);
    expect(seen).toEqual([first, late]);
    expect((await lagOf()).lag).toBe(0);
  });

  it('never advances a paused or failed consumer', async () => {
    const seen: bigint[] = [];
    const pump = filteredPump(seen);
    await pump.runConsumerOnce(NAME); // creates the offset row at 0
    await publishOther(8);

    for (const status of ['paused', 'failed'] as const) {
      await setConsumerStatus(database.db, NAME, status);
      expect(await pump.runConsumerOnce(NAME)).toBe(0);
      expect(await lastSeq(), `${status}: the offset stays`).toBe(0n);
      expect((await lagOf()).lag).toBe(8);
    }
  });

  it('never advances past a matching event its handler has not yet handled', async () => {
    const seen: bigint[] = [];
    let refusing = true;
    const pump = filteredPump(seen, { fail: () => refusing });
    await publishOther(4);
    const matching = await publishMatching();
    await publishOther(4);

    expect(await pump.runConsumerOnce(NAME)).toBe(0);
    expect(await lastSeq(), 'stops short of the event it could not handle').toBeLessThan(matching);
    expect((await lagOf()).lag).toBeGreaterThan(0);

    // Out of backoff, the handler now accepts: the event is delivered, then the rest skipped.
    refusing = false;
    await database.db.execute(
      sql`UPDATE event_consumer_offsets SET retry_after = NULL WHERE consumer_name = ${NAME}`,
    );
    expect(await pump.runConsumerOnce(NAME)).toBe(1);
    expect(seen).toEqual([matching]);
    expect((await lagOf()).lag).toBe(0);
  });
});
