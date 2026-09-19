// SPDX-License-Identifier: MIT
/**
 * At-most-once delivery, asserted where it is actually enforced.
 *
 * 08 §4.5: "the consumer inserts into `notification_outbox` (idempotent via
 * `dedupeKey`)". The mechanism is `notification_outbox_dedupe_idx UNIQUE
 * (user_id, dedupe_key)` and an `ON CONFLICT … DO UPDATE`, so the claim this
 * suite has to make is not "the insert was skipped" — that is visible from the
 * index and proves nothing about what the user received — but **the adapter was
 * called once**.
 *
 * Three different ways the same fact can arrive twice are exercised, because
 * they fail differently:
 *
 *   1. the upstream context emits the same fact in two envelopes (a recompute
 *      that ran twice);
 *   2. the consumer is replayed from `seq = 0` (the operational recovery the
 *      event log exists for);
 *   3. the drain runs twice over a `delivered` row.
 *
 * The dedupe key is derived from the *fact* — `(period, line, threshold)` — and
 * never from `domain_events.id`, which is what makes (1) and (2) collide at all.
 * A key built from the event id would make every replay a fresh notification
 * and this suite would pass on (3) alone.
 */
import { appendEvent } from '@core/platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationOutbox } from '../../schema/index.ts';
import { outboxOf } from '../../src/db.ts';
import {
  BudgetThresholdCrossed,
  ConnectionStatusChanged,
  CORRELATION_ID,
  NO_DATABASE,
  clockAt,
  contextFor,
  createFakeChannel,
  deliveryDependencies,
  drainOnce,
  enabledChannel,
  notificationsDatabase,
  pumpFor,
  ruleFor,
  statusPayload,
  thresholdPayload,
  unlockedSecretBox,
  type FakeChannel,
  type TestDatabase,
} from '../harness.ts';
import type { SecretBox } from '@core/secretbox';

const EPOCH = '2026-06-10T15:00:00.000Z';

describe.skipIf(NO_DATABASE)('the notification outbox', () => {
  let database: TestDatabase;
  let secretBox: SecretBox;
  const clock = clockAt(EPOCH);
  const channel: FakeChannel = createFakeChannel();

  beforeAll(async () => {
    database = await notificationsDatabase('dedupe');
    secretBox = await unlockedSecretBox(database, clock);
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it('the same dedupeKey inserted twice delivers once', async () => {
    channel.reset();
    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox);
    await ruleFor(database, context, {
      channelId,
      eventType: 'budgeting.BudgetThresholdCrossed',
      deliveryClass: 'PROMPT',
    });

    // One fact. Two envelopes, with two different `domain_events` ids — which
    // is exactly what a recompute that ran twice produces.
    const fact = thresholdPayload({
      budgetId: database.userId,
      periodId: '01920000-0000-7000-8000-00000000e001',
      lineId: '01920000-0000-7000-8000-00000000e002',
      threshold: 'OVERSPENT_CASH',
    });
    for (let i = 0; i < 2; i += 1) {
      await appendEvent(
        outboxOf(database.db),
        BudgetThresholdCrossed.create(
          fact,
          { userId: database.userId, correlationId: CORRELATION_ID },
          clock,
        ),
      );
    }

    const pump = pumpFor(database, clock);
    expect(await pump.drain(), 'both envelopes reached the consumer').toBe(2);

    // One row, and `group_count` still 1: an ungrouped collision adds nothing,
    // because the row already says what the second event says.
    const rows = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, database.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.groupCount).toBe(1);
    expect(rows[0]?.dedupeKey).toBe(
      'budgeting.threshold:01920000-0000-7000-8000-00000000e001:01920000-0000-7000-8000-00000000e002:OVERSPENT_CASH',
    );

    // And one `NotificationQueued`: a coalesced insert announces nothing.
    const queued = await database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM domain_events
      WHERE event_type = 'notifications.NotificationQueued'
    `);
    expect(queued.rows[0]?.count).toBe('1');

    // The assertion the index cannot make for us: the adapter was called once.
    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    expect(await drainOnce(dependencies, database.userId)).toBe(1);
    expect(channel.deliveries).toHaveLength(1);

    // A second drain finds nothing: `delivered` is not a claimable status.
    expect(await drainOnce(dependencies, database.userId)).toBe(0);
    expect(channel.deliveries).toHaveLength(1);

    const delivered = await database.db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM domain_events
      WHERE event_type = 'notifications.NotificationDelivered'
    `);
    expect(delivered.rows[0]?.count).toBe('1');
  });

  it('a consumer replay from seq 0 re-derives the same row and sends nothing more', async () => {
    channel.reset();
    await database.truncate();

    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox);
    await ruleFor(database, context, {
      channelId,
      eventType: 'budgeting.BudgetThresholdCrossed',
      deliveryClass: 'PROMPT',
    });

    await appendEvent(
      outboxOf(database.db),
      BudgetThresholdCrossed.create(
        thresholdPayload({
          budgetId: database.userId,
          periodId: '01920000-0000-7000-8000-00000000e011',
          lineId: '01920000-0000-7000-8000-00000000e012',
          threshold: 'PCT_100',
        }),
        { userId: database.userId, correlationId: CORRELATION_ID },
        clock,
      ),
    );

    const pump = pumpFor(database, clock);
    expect(await pump.drain()).toBe(1);
    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    expect(await drainOnce(dependencies, database.userId)).toBe(1);
    expect(channel.deliveries).toHaveLength(1);

    // The replay button: rewind the offset and run the pump again.
    await database.db.execute(sql`DELETE FROM event_consumer_offsets`);
    await database.db.execute(sql`DELETE FROM processed_events`);
    expect(await pump.drain(), 'the replay re-delivered the envelope').toBe(1);

    const rows = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, database.userId));
    expect(rows, 'the replay collided with the row it already wrote').toHaveLength(1);
    // Still delivered, so the drain has nothing to claim and the user is not
    // told twice about a replay.
    expect(rows[0]?.status).toBe('delivered');
    expect(await drainOnce(dependencies, database.userId)).toBe(0);
    expect(channel.deliveries).toHaveLength(1);
  });

  it('two account holders may derive the same dedupeKey and both are delivered', async () => {
    channel.reset();
    await database.truncate();

    const second = await database.createUser('Second Holder');
    const firstContext = contextFor(database.userId, clock);
    const secondContext = contextFor(second, clock);
    const secondBox = await unlockedSecretBox(database, clock, second);

    for (const [context, box] of [
      [firstContext, secretBox],
      [secondContext, secondBox],
    ] as const) {
      const channelId = await enabledChannel(database, context, box, {
        displayName: `channel-${context.userId.slice(0, 8)}`,
      });
      await ruleFor(database, context, {
        channelId,
        eventType: 'connections.ConnectionStatusChanged',
        deliveryClass: 'PROMPT',
        name: `rule-${context.userId.slice(0, 8)}`,
      });
    }

    // The same public fact, stated about each holder's own connection: the
    // dedupe key is scoped to `user_id` precisely so this is two notifications
    // and not one. A globally unique key would deliver to whoever inserted
    // first and to nobody else.
    const payload = statusPayload({ connectionId: '01920000-0000-7000-8000-00000000e021' });
    for (const userId of [database.userId, second]) {
      await appendEvent(
        outboxOf(database.db),
        ConnectionStatusChanged.create(payload, { userId, correlationId: CORRELATION_ID }, clock),
      );
    }

    const pump = pumpFor(database, clock);
    expect(await pump.drain()).toBe(2);

    const rows = await database.db.select().from(notificationOutbox);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.dedupeKey)).size).toBe(1);
    expect(new Set(rows.map((row) => row.userId)).size).toBe(2);
  });
});
