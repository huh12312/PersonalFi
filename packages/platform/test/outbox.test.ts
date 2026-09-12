// SPDX-License-Identifier: MIT
import { newId, systemClock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { appendEvent, appendEvents } from '../src/events/outbox.ts';
import { defineEvent } from '../src/events/registry.ts';
import { createMetrics } from '../src/metrics.ts';
import { ADMIN_URL, createTestDatabase, type TestDatabase } from './harness.ts';

const describeWithDb = ADMIN_URL === undefined ? describe.skip : describe;

const TransactionsUpserted = defineEvent({
  type: 'ledger.TransactionsUpserted',
  aggregateType: 'account',
  description: 'Ids only. Consumers re-read current state through the ledger reader.',
  schema: z.object({ accountId: z.uuid(), count: z.int() }),
});

describeWithDb('domain_events outbox', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp03_outbox');
  }, 60_000);

  afterAll(async () => {
    await database.drop();
  }, 30_000);

  beforeEach(async () => {
    await database.truncate();
  });

  function event(count = 3): ReturnType<typeof TransactionsUpserted.create> {
    return TransactionsUpserted.create(
      { accountId: newId(), count },
      { userId: database.userId, correlationId: newId() },
      systemClock,
    );
  }

  it('assigns a seq and returns the recorded envelope', async () => {
    const metrics = createMetrics();
    const recorded = await appendEvent(database.db, event(), { metrics });

    expect(recorded.seq).toBeGreaterThan(0n);
    expect(recorded.recordedAt).toBeInstanceOf(Date);
    expect(
      metrics.snapshot().counters['platform.events.appended{type=ledger.TransactionsUpserted}'],
    ).toBe(1);
  });

  /**
   * The single most important test in this work package.
   *
   * If an event can outlive the transaction that produced it, the log is no
   * longer a record of what happened: it is a record of what was attempted, and
   * every consumer downstream acts on data that does not exist.
   */
  it('leaves no trace of an event appended in a transaction that rolled back', async () => {
    const doomed = event();

    await expect(
      database.db.transaction(async (tx) => {
        await appendEvent(tx, doomed);
        // A constraint violation, a provider timeout, a bug — the cause does not
        // matter. What matters is that the event goes with it.
        throw new Error('the write that justified this event failed');
      }),
    ).rejects.toThrow('the write that justified this event failed');

    const rows = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM domain_events WHERE id = ${doomed.id}::uuid`,
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('commits the event with the data, as one atom', async () => {
    const flagKey = 'module.ledger';
    const committed = event();

    await database.db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO feature_flags (user_id, key, enabled)
        VALUES (${database.userId}::uuid, ${flagKey}, true)
      `);
      await appendEvent(tx, committed);
    });

    const flags = await database.db.execute<{ key: string }>(
      sql`SELECT key FROM feature_flags WHERE user_id = ${database.userId}::uuid`,
    );
    const events = await database.db.execute<{ id: string }>(
      sql`SELECT id FROM domain_events WHERE id = ${committed.id}::uuid`,
    );
    expect(flags.rows).toHaveLength(1);
    expect(events.rows).toHaveLength(1);
  });

  /**
   * `seq` must be commit order, not merely assignment order.
   *
   * Without the ordering lock, two concurrent publishers can take 5 and 6 and
   * commit in the other order; a consumer that read 6 first would advance its
   * offset past 5 and never see it again. This test forces exactly that
   * interleaving: A appends first, B appends and commits first, and A commits
   * last. A's seq must still be the lower one *and* must not already be visible
   * when B commits.
   */
  it('serialises seq assignment so a late committer cannot hold a lower seq', async () => {
    const clientA = await database.pool.connect();
    const clientB = await database.pool.connect();
    try {
      await clientA.query('BEGIN');
      await clientB.query('BEGIN');

      const first = event(1);
      const appendSql = `
        SELECT out_seq FROM append_domain_event(
          $1::uuid, $2::uuid, 'account', NULL, 'ledger.TransactionsUpserted', 1,
          $3::jsonb, now(), $4::uuid, NULL, 'none')`;

      const a = await clientA.query<{ out_seq: string }>(appendSql, [
        first.id,
        database.userId,
        JSON.stringify(first.payload),
        first.correlationId,
      ]);

      // B now tries to append while A still holds the ordering lock. It must
      // block, so this promise cannot settle before A commits.
      const second = event(2);
      let bResolved = false;
      const bAppend = clientB
        .query<{ out_seq: string }>(appendSql, [
          second.id,
          database.userId,
          JSON.stringify(second.payload),
          second.correlationId,
        ])
        .then((result) => {
          bResolved = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(bResolved, 'B must block on the ordering lock while A holds it').toBe(false);

      await clientA.query('COMMIT');
      const b = await bAppend;
      await clientB.query('COMMIT');

      expect(BigInt(a.rows[0]?.out_seq ?? '0')).toBeLessThan(BigInt(b.rows[0]?.out_seq ?? '0'));
    } finally {
      await clientA.query('ROLLBACK').catch(() => undefined);
      await clientB.query('ROLLBACK').catch(() => undefined);
      clientA.release();
      clientB.release();
    }
  }, 30_000);

  it('appends a batch in the order given', async () => {
    const batch = [event(1), event(2), event(3)];
    const recorded = await appendEvents(database.db, batch);
    expect(recorded.map((e) => e.seq)).toEqual(
      [...recorded].sort((a, b) => Number(a.seq - b.seq)).map((e) => e.seq),
    );
    expect(recorded[0]!.seq).toBeLessThan(recorded[2]!.seq);
  });

  it('rejects an event whose envelope is malformed before it reaches SQL', async () => {
    const broken = { ...event(), correlationId: 'not-a-uuid' };
    await expect(appendEvent(database.db, broken)).rejects.toThrow(/correlationId/);
  });

  it('refuses a duplicate event id, so a retried append cannot double-publish', async () => {
    const once = event();
    await appendEvent(database.db, once);
    await expect(appendEvent(database.db, once)).rejects.toThrow();
  });

  it('cascades events away when the account holder is deleted', async () => {
    const other = await database.createUser();
    await appendEvent(database.db, {
      ...event(),
      userId: other,
    });
    await database.db.execute(sql`DELETE FROM users WHERE id = ${other}::uuid`);
    const rows = await database.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM domain_events WHERE user_id = ${other}::uuid`,
    );
    expect(rows.rows[0]?.count).toBe('0');
  });
});
