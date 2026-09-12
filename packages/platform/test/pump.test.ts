// SPDX-License-Identifier: MIT
import { newId, systemClock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appendEvent } from '../src/events/outbox.ts';
import {
  createConsumerPump,
  outboxHealth,
  registerConsumer,
  replayConsumer,
  setConsumerStatus,
  skipFailedEvent,
} from '../src/events/pump.ts';
import { defineEvent } from '../src/events/registry.ts';
import { createMetrics } from '../src/metrics.ts';
import {
  ADMIN_URL,
  createTestDatabase,
  recordingLogger,
  waitFor,
  type TestDatabase,
} from './harness.ts';

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

describeWithDb('consumer pump', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp03_pump');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
  });

  async function publish(count = 1): Promise<bigint[]> {
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

  it('delivers events in seq order and advances the offset', async () => {
    const seen: bigint[] = [];
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [registerConsumer('test.order@v1', (event) => void seen.push(event.seq))],
    });

    const seqs = await publish(5);
    expect(await pump.drain()).toBe(5);
    expect(seen).toEqual(seqs);

    const offset = await database.db.execute<{ last_seq: bigint }>(
      sql`SELECT last_seq FROM event_consumer_offsets WHERE consumer_name = 'test.order@v1'`,
    );
    expect(BigInt(offset.rows[0]!.last_seq)).toBe(seqs.at(-1));

    // A second drain with nothing new must do nothing at all.
    expect(await pump.drain()).toBe(0);
  });

  /**
   * Idempotency is the property that makes at-least-once delivery survivable.
   *
   * The scenario simulated here is the real one: the handler ran and committed,
   * but the process died before anything downstream learned about it, so the
   * event is delivered again. The receipt in `processed_events` is what makes the
   * second delivery a no-op — and because it was written in the *same*
   * transaction as the side effect, it cannot disagree with it.
   */
  it('does not re-run a side effect on a duplicate delivery', async () => {
    let sideEffects = 0;
    const consumer = registerConsumer('test.idempotent@v1', async (event, { tx }) => {
      sideEffects += 1;
      await tx.execute(sql`
        INSERT INTO feature_flags (user_id, key, enabled)
        VALUES (${database.userId}::uuid, ${`seen.${String(event.seq)}`}, true)
        ON CONFLICT (user_id, key) DO NOTHING
      `);
    });
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [consumer],
    });

    await publish(3);
    await pump.drain();
    expect(sideEffects).toBe(3);

    // Rewind the offset without clearing the receipts: exactly what a crash
    // between COMMIT and the in-memory bookkeeping would leave behind.
    await database.db.execute(
      sql`UPDATE event_consumer_offsets SET last_seq = 0 WHERE consumer_name = 'test.idempotent@v1'`,
    );

    const metrics = createMetrics();
    const second = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [consumer],
      metrics,
    });
    await second.drain();

    expect(sideEffects, 'the handler must not run again').toBe(3);
    expect(
      metrics.snapshot().counters['platform.events.skipped_duplicate{consumer=test.idempotent@v1}'],
    ).toBe(3);

    // And the offset still advanced, so the consumer is not stuck in a loop.
    const offset = await database.db.execute<{ last_seq: bigint }>(
      sql`SELECT last_seq FROM event_consumer_offsets WHERE consumer_name = 'test.idempotent@v1'`,
    );
    expect(BigInt(offset.rows[0]!.last_seq)).toBeGreaterThan(0n);
  });

  it('rolls the receipt back with the handler, so a failed handler is retried', async () => {
    let attempts = 0;
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [
        registerConsumer('test.rollback@v1', () => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient');
        }),
      ],
      random: () => 0,
    });

    await publish(1);
    await pump.drain();
    expect(attempts).toBe(1);

    const receipts = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM processed_events WHERE consumer_name = 'test.rollback@v1'`,
    );
    expect(receipts.rows[0]?.count, 'a failed handler must leave no receipt').toBe('0');

    await pump.drain();
    expect(attempts).toBe(2);
  });

  it('honours a type filter and ignores everything else', async () => {
    const seen: string[] = [];
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [
        registerConsumer('test.filtered@v1', (event) => void seen.push(event.eventType), {
          filter: ['investments.PricesUpdated'],
        }),
      ],
    });

    await publish(2);
    await appendEvent(
      database.db,
      PricesUpdated.create(
        { securityIds: [newId()] },
        { userId: database.userId, correlationId: newId() },
        systemClock,
      ),
    );

    expect(await pump.drain()).toBe(1);
    expect(seen).toEqual(['investments.PricesUpdated']);
  });

  /**
   * Retry, then stop. Not retry, then skip.
   *
   * A consumer that skips a poison event leaves a read model that is quietly
   * wrong, which a solo operator will not notice for months. A consumer that
   * stops is a red dot on the maintenance page today.
   */
  it('retries with backoff and then dead-letters, without skipping the event', async () => {
    const logger = recordingLogger();
    let attempts = 0;
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      logger,
      random: () => 0, // full jitter drawn at zero: retry immediately
      consumers: [
        registerConsumer(
          'test.poison@v1',
          () => {
            attempts += 1;
            throw new Error('this event can never be handled');
          },
          { maxAttempts: 3 },
        ),
      ],
    });

    const [poisonSeq] = await publish(1);
    await publish(1); // a healthy event behind the poison one

    for (let round = 0; round < 5; round += 1) await pump.drain();

    expect(attempts).toBe(3);

    const offset = await database.db.execute<{
      status: string;
      last_seq: bigint;
      failed_seq: bigint;
      failed_count: number;
      failed_error: string;
    }>(sql`
      SELECT status, last_seq, failed_seq, failed_count, failed_error
      FROM event_consumer_offsets WHERE consumer_name = 'test.poison@v1'
    `);
    const row = offset.rows[0]!;
    expect(row.status).toBe('failed');
    expect(BigInt(row.failed_seq)).toBe(poisonSeq);
    expect(row.failed_count).toBe(3);
    expect(row.failed_error).toContain('never be handled');
    // Crucially: it did NOT advance past the poison event.
    expect(BigInt(row.last_seq)).toBe(0n);
    expect(
      logger.lines.some((line) => line.level === 'error' && line.msg?.includes('dead-lettered')),
    ).toBe(true);
  });

  it('lets an operator skip a dead-lettered event, deliberately and explicitly', async () => {
    // `seq` is whatever the sequence hands out. Asserting on the literal 1n
    // silently depends on `TRUNCATE … RESTART IDENTITY` having run first, which
    // makes the test a hostage to suite ordering; the published seqs are right
    // here, so use them.
    const poison: { seq: bigint | undefined } = { seq: undefined };
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      random: () => 0,
      consumers: [
        registerConsumer(
          'test.skippable@v1',
          (event) => {
            if (event.seq === poison.seq) throw new Error('poison');
          },
          { maxAttempts: 2 },
        ),
      ],
    });

    const seqs = await publish(3);
    poison.seq = seqs[0];
    for (let round = 0; round < 4; round += 1) await pump.drain();

    expect(await skipFailedEvent(database.db, 'test.skippable@v1')).toBe(true);
    await pump.drain();

    const offset = await database.db.execute<{ status: string; last_seq: bigint }>(
      sql`SELECT status, last_seq FROM event_consumer_offsets WHERE consumer_name = 'test.skippable@v1'`,
    );
    expect(offset.rows[0]!.status).toBe('running');
    expect(BigInt(offset.rows[0]!.last_seq)).toBe(seqs[2]!);
  });

  it('does nothing while a consumer is paused', async () => {
    const seen: bigint[] = [];
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [registerConsumer('test.pausable@v1', (event) => void seen.push(event.seq))],
    });
    await publish(2);
    await pump.drain();
    expect(seen).toHaveLength(2);

    await setConsumerStatus(database.db, 'test.pausable@v1', 'paused');
    await publish(2);
    expect(await pump.drain()).toBe(0);

    await setConsumerStatus(database.db, 'test.pausable@v1', 'running');
    expect(await pump.drain()).toBe(2);
  });

  /**
   * Replay is the reason the log is worth its one table: a bad consumer becomes
   * a one-line fix rather than a data-repair script.
   */
  it('replays from a chosen seq, clearing receipts so handlers actually re-run', async () => {
    const seen: bigint[] = [];
    const consumer = registerConsumer('test.replay@v1', (event) => void seen.push(event.seq));
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [consumer],
    });

    const seqs = await publish(4);
    await pump.drain();
    expect(seen).toHaveLength(4);

    await replayConsumer(database.db, 'test.replay@v1', seqs[1]!);
    expect(await pump.drain()).toBe(2);
    expect(seen).toEqual([...seqs, seqs[2], seqs[3]]);
  });

  it('replays a brand-new consumer over the whole history on first boot', async () => {
    await publish(6);
    const seen: bigint[] = [];
    // A context added in Phase 3 starts at seq 0 and catches up. No special case,
    // no backfill script — the offset row simply does not exist yet.
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [
        registerConsumer('investments.holdings@v1', (event) => void seen.push(event.seq)),
      ],
    });
    expect(await pump.runConsumerOnce('investments.holdings@v1')).toBe(6);
    expect(seen).toHaveLength(6);
  });

  it('isolates consumers: one failing does not stop the others', async () => {
    const healthy: bigint[] = [];
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      random: () => 0,
      consumers: [
        registerConsumer(
          'test.broken@v1',
          () => {
            throw new Error('always');
          },
          { maxAttempts: 1 },
        ),
        registerConsumer('test.healthy@v1', (event) => void healthy.push(event.seq)),
      ],
    });

    await publish(3);
    await pump.drain();
    await pump.drain();

    expect(healthy).toHaveLength(3);
    const statuses = await database.db.execute<{ consumer_name: string; status: string }>(
      sql`SELECT consumer_name, status FROM event_consumer_offsets ORDER BY consumer_name`,
    );
    expect(statuses.rows.map((r) => [r.consumer_name, r.status])).toEqual([
      ['test.broken@v1', 'failed'],
      ['test.healthy@v1', 'running'],
    ]);
  });

  it('wakes on NOTIFY rather than waiting out the poll interval', async () => {
    const seen: bigint[] = [];
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      // 60s: if the notification does not arrive, this test times out and says so.
      pollIntervalMs: 60_000,
      consumers: [registerConsumer('test.notify@v1', (event) => void seen.push(event.seq))],
    });

    await pump.start();
    try {
      await waitFor(() => seen.length === 0, {
        timeoutMs: 1_000,
        what: 'the pump to settle',
      }).catch(() => undefined);
      await publish(1);
      await waitFor(() => seen.length === 1, {
        timeoutMs: 8_000,
        what: 'a NOTIFY-driven delivery',
      });
    } finally {
      await pump.stop();
    }
  }, 30_000);

  it('reports lag and failed consumers for /ready', async () => {
    const pump = createConsumerPump({
      pool: database.pool,
      db: database.db,
      consumers: [registerConsumer('test.lagging@v1', () => undefined)],
    });
    await pump.runConsumerOnce('test.lagging@v1');
    const seqs = await publish(4);

    const health = await outboxHealth(database.db);
    expect(health.maxSeq).toBe(seqs[3]!);
    expect(health.maxLagEvents).toBe(4);
    expect(health.failedConsumers).toEqual([]);
    expect(health.oldestUnprocessedAgeSeconds).toBeGreaterThanOrEqual(0);

    await pump.drain();
    expect((await outboxHealth(database.db)).maxLagEvents).toBe(0);
  });
});
