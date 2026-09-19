// SPDX-License-Identifier: MIT
/**
 * The §5 exit criterion: "a 2,000-transaction backfill yields one coalesced
 * notification".
 *
 * 02-phase-2-dispatch.md §3 is explicit about where the assertion goes — "on
 * the outbox and not on the adapter" — and the distinction is the whole test.
 * An adapter-level count of 1 is satisfied by an outbox holding 2,000 rows and
 * something downstream dropping 1,999 of them, which is a data-loss bug wearing
 * a passing test's clothes. So the first assertion below is a `SELECT count(*)`
 * over `notification_outbox`, and the delivery is checked afterwards as a
 * separate fact.
 *
 * ## What is actually doing the coalescing
 *
 * Not the consumer, and not the rule. `notification_outbox_group_idx UNIQUE
 * (user_id, channel_id, group_key, group_window_start)` and the derived dedupe
 * key `digest:<groupKey>:<windowStart>` mean the 2,000th insert collides with
 * the first for the same reason the 2nd did. 08 §4.5: "enforced by the outbox,
 * not by each rule remembering to do it." The second test proves the other half
 * — that the window is a *window* and not a permanent sink: one event after the
 * boundary derives a different `group_window_start`, and therefore a different
 * dedupe key, and therefore a second row.
 */
import { appendEvent } from '@core/platform';
import { newId } from '@core/kernel';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationOutbox } from '../../schema/index.ts';
import { outboxOf } from '../../src/db.ts';
import { closeDigestWindows } from '../../src/jobs.ts';
import { digestWindowFor } from '../../src/time.ts';
import {
  BudgetThresholdCrossed,
  CORRELATION_ID,
  NO_DATABASE,
  ZONE,
  clockAt,
  contextFor,
  createFakeChannel,
  deliveryDependencies,
  drainOnce,
  enabledChannel,
  notificationsDatabase,
  pumpFor,
  ruleFor,
  thresholdPayload,
  unlockedSecretBox,
  type FakeChannel,
  type TestDatabase,
} from '../harness.ts';
import type { SecretBox } from '@core/secretbox';

/** A Wednesday, mid-window, so there is room either side of it. */
const EPOCH = '2026-06-10T15:00:00.000Z';
const BACKFILL_SIZE = 2_000;

describe.skipIf(NO_DATABASE)('digest coalescing', () => {
  let database: TestDatabase;
  let secretBox: SecretBox;
  const clock = clockAt(EPOCH);
  const channel: FakeChannel = createFakeChannel();

  beforeAll(async () => {
    database = await notificationsDatabase('coalescing');
    secretBox = await unlockedSecretBox(database, clock);
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it('a 2,000-transaction backfill yields exactly one notification', async () => {
    channel.reset();
    clock.setTo(EPOCH);
    await database.truncate();

    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox);
    await ruleFor(database, context, {
      channelId,
      eventType: 'budgeting.BudgetThresholdCrossed',
      deliveryClass: 'DIGEST',
      digestCadence: 'WEEKLY',
    });

    // 2,000 *distinct* facts — a backfill crosses thresholds on many lines at
    // once, so every one of these has its own natural dedupe key. If the
    // grouping were not overriding it, this would be 2,000 rows.
    const periodId = newId();
    for (let i = 0; i < BACKFILL_SIZE; i += 1) {
      await appendEvent(
        outboxOf(database.db),
        BudgetThresholdCrossed.create(
          thresholdPayload({
            budgetId: database.userId,
            periodId,
            lineId: newId(),
            threshold: i % 2 === 0 ? 'PCT_100' : 'OVERSPENT_CASH',
          }),
          { userId: database.userId, correlationId: CORRELATION_ID },
          clock,
        ),
      );
    }

    const pump = pumpFor(database, clock);
    expect(await pump.drain(), 'every envelope reached the consumer').toBe(BACKFILL_SIZE);

    // The exit criterion, on the outbox.
    const rows = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, database.userId));
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row?.groupCount).toBe(BACKFILL_SIZE);
    expect(row?.groupKey).toBe('budgeting.thresholds');
    expect(row?.status).toBe('held');
    expect(row?.heldReason).toBe('digest_window');

    const window = digestWindowFor(new Date(EPOCH), ZONE, 'WEEKLY');
    expect(row?.dedupeKey).toBe(`digest:budgeting.thresholds:${window.start.toISOString()}`);
    // The window's *end* is when it may be sent. A digest that could be sent
    // mid-window would not be a digest.
    expect(row?.notBefore?.toISOString()).toBe(window.end.toISOString());

    // One announcement, not 2,000: `NotificationQueued` fires on the insert.
    const queued = await database.db.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count FROM domain_events
        WHERE event_type = 'notifications.NotificationQueued'
      `);
    expect(queued.rows[0]?.count).toBe('1');

    // Nothing is due while the window is open.
    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    expect(await drainOnce(dependencies, database.userId)).toBe(0);
    expect(channel.deliveries).toHaveLength(0);

    // Close the window, drain, and read what the user would actually have
    // received: one message that says how many facts it stands for.
    clock.setTo(window.end);
    expect(await closeDigestWindows(database.db, database.userId, clock.now())).toHaveLength(1);
    expect(await drainOnce(dependencies, database.userId)).toBe(1);
    expect(channel.deliveries).toHaveLength(1);
    expect(channel.deliveries[0]?.notification.bodyMd).toContain(String(BACKFILL_SIZE));
  }, 180_000);

  it('an event one minute after the window boundary opens a second digest', async () => {
    channel.reset();
    clock.setTo(EPOCH);
    await database.truncate();

    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox);
    await ruleFor(database, context, {
      channelId,
      eventType: 'budgeting.BudgetThresholdCrossed',
      deliveryClass: 'DIGEST',
      digestCadence: 'WEEKLY',
    });

    const window = digestWindowFor(new Date(EPOCH), ZONE, 'WEEKLY');
    const pump = pumpFor(database, clock);
    const periodId = newId();

    const crossOne = async (): Promise<void> => {
      await appendEvent(
        outboxOf(database.db),
        BudgetThresholdCrossed.create(
          thresholdPayload({
            budgetId: database.userId,
            periodId,
            lineId: newId(),
            threshold: 'PCT_80',
          }),
          { userId: database.userId, correlationId: CORRELATION_ID },
          clock,
        ),
      );
      await pump.drain();
    };

    // One minute *before* the boundary, twice: still one row, count 2.
    clock.setTo(new Date(window.end.getTime() - 60_000));
    await crossOne();
    await crossOne();

    // One minute *after* it: a different window start, a different dedupe key.
    clock.setTo(new Date(window.end.getTime() + 60_000));
    await crossOne();

    const rows = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, database.userId))
      .orderBy(asc(notificationOutbox.groupWindowStart));
    expect(rows, 'the boundary separated the third event from the first two').toHaveLength(2);
    expect(rows[0]?.groupCount).toBe(2);
    expect(rows[1]?.groupCount).toBe(1);
    expect(rows[0]?.groupWindowEnd?.toISOString()).toBe(window.end.toISOString());
    expect(rows[1]?.groupWindowStart?.toISOString()).toBe(window.end.toISOString());
  });
});
