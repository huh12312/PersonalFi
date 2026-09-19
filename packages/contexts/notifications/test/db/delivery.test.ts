// SPDX-License-Identifier: MIT
/**
 * The backoff ladder, the dead letter, and the walk back out of it.
 *
 * 08 §4.5 asks for "exponential backoff and a dead-letter state visible in the
 * UI". Visible is only half of it — a dead-letter view that cannot be acted on
 * is a list of things you now know are broken — so this suite walks the whole
 * loop: five attempts, dead, `listDeadLetters` showing every rung and why it
 * failed, `retryNotification`, delivery, and the history still attached.
 *
 * ## `refused` never climbs the ladder
 *
 * A destination does not become legitimate by waiting. An egress refusal goes
 * straight to `dead` on attempt 1, with `refusal_code` on the attempt and on
 * the row, and the distinction from `permanent` is kept all the way out to the
 * read model: "we declined to connect to that" and "their mail server said no"
 * are different operational facts, and only one of them means something is
 * trying to make this app talk to `db:5432`.
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliveryAttempts, notificationOutbox } from '../../schema/index.ts';
import { enqueueNotification, retryNotification } from '../../src/outbox.ts';
import { setChannelEnabled } from '../../src/service.ts';
import { listAttempts, listDeadLetters, listOutbox } from '../../src/read.ts';
import {
  NO_DATABASE,
  clockAt,
  contextFor,
  createFakeChannel,
  deliveryDependencies,
  drainOnce,
  enabledChannel,
  notificationsDatabase,
  unlockedSecretBox,
  type FakeChannel,
  type TestDatabase,
} from '../harness.ts';
import type { SecretBox } from '@core/secretbox';

const EPOCH = '2026-06-10T15:00:00.000Z';

describe.skipIf(NO_DATABASE)('delivery, failure and recovery', () => {
  let database: TestDatabase;
  let secretBox: SecretBox;
  const clock = clockAt(EPOCH);
  const channel: FakeChannel = createFakeChannel();

  beforeAll(async () => {
    database = await notificationsDatabase('delivery');
    secretBox = await unlockedSecretBox(database, clock);
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  async function queueOne(dedupeKey: string): Promise<{ id: string; channelId: string }> {
    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox);
    const result = await enqueueNotification(database.db, context, {
      channelId,
      ruleId: null,
      dedupeKey,
      groupKey: null,
      groupWindow: null,
      deliveryClass: 'PROMPT',
      priority: 'high',
      title: 'A budget envelope is overspent',
      bodyMd: 'Groceries is overspent in cash.',
      notBefore: clock.now(),
      heldReason: null,
    });
    return { id: result.id, channelId };
  }

  it('five retryable failures end in a visible dead letter, and a retry walks it back out', async () => {
    channel.reset();
    clock.setTo(EPOCH);
    await database.truncate();

    const { id } = await queueOne('delivery:ladder');
    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    channel.setNextResult({ outcome: 'retryable', detail: 'connection reset' });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await drainOnce(dependencies, database.userId), `attempt ${String(attempt)}`).toBe(1);
    }
    // A sixth drain finds nothing: `dead` is not a claimable status.
    expect(await drainOnce(dependencies, database.userId)).toBe(0);
    expect(channel.deliveries).toHaveLength(5);

    const [row] = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, id));
    expect(row?.status).toBe('dead');
    expect(row?.attemptCount).toBe(5);
    expect(row?.deadAt).not.toBeNull();
    // Not "retryable": what an operator needs from a dead row is that there
    // will not be a sixth attempt. The fifth attempt's own reason is still in
    // its `detail`.
    expect(row?.lastFailureCode).toBe('attempts_exhausted');

    // Every rung survived, with a next_attempt_at on the four that had one.
    const attempts = await listAttempts(database.db, database.userId, id);
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(attempts.slice(0, 4).every((attempt) => attempt.nextAttemptAt !== null)).toBe(true);
    expect(attempts[4]?.nextAttemptAt, 'the terminal rung schedules nothing').toBeNull();
    // `delivery_attempts_retryable_has_next` is the reason this is `permanent`
    // rather than `retryable`: an attempt that schedules nothing may not claim
    // it will be retried.
    expect(attempts[4]?.outcome).toBe('permanent');
    expect(attempts[4]?.detail).toContain('connection reset');
    expect(attempts[4]?.detail).toContain('exhausted');

    // The view 08 §4.5 asks for, with the history that makes it worth opening.
    const dead = await listDeadLetters(database.db, database.userId);
    expect(dead).toHaveLength(1);
    expect(dead[0]?.attempts).toHaveLength(5);
    expect(dead[0]?.title).toBe('A budget envelope is overspent');

    // A NotificationFailed per attempt, with `dead` true on the last only.
    const failures = await database.db.execute<{ payload: { dead: boolean } }>(sql`
      SELECT payload FROM domain_events
      WHERE event_type = 'notifications.NotificationFailed'
      ORDER BY seq
    `);
    expect(failures.rows).toHaveLength(5);
    expect(failures.rows.filter((event) => event.payload.dead)).toHaveLength(1);

    // Recovery: the operator fixes the channel and presses retry.
    channel.setNextResult({ outcome: 'delivered' });
    const context = contextFor(database.userId, clock);
    expect(await retryNotification(database.db, context, id)).toBe(true);
    expect(await drainOnce(dependencies, database.userId)).toBe(1);

    const [recovered] = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, id));
    expect(recovered?.status).toBe('delivered');
    expect(recovered?.deadAt).toBeNull();

    // One story, not two: the five failures are still attached, and the
    // delivery is attempt 6 rather than a second attempt 1.
    const afterRetry = await listAttempts(database.db, database.userId, id);
    expect(afterRetry.map((attempt) => attempt.attempt)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(afterRetry[5]?.outcome).toBe('delivered');
    expect(await listDeadLetters(database.db, database.userId)).toHaveLength(0);
  });

  it('an egress refusal dead-letters on the first attempt and is never retried', async () => {
    channel.reset();
    clock.setTo(EPOCH);
    await database.truncate();

    const { id } = await queueOne('delivery:refused');
    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    channel.setNextResult({
      outcome: 'refused',
      refusalCode: 'private_address',
      detail: 'db resolves to 172.18.0.2 (private)',
    });

    expect(await drainOnce(dependencies, database.userId)).toBe(1);
    // The claim that matters: there is no second attempt.
    expect(await drainOnce(dependencies, database.userId)).toBe(0);
    expect(channel.deliveries).toHaveLength(1);

    const [row] = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.id, id));
    expect(row?.status).toBe('dead');
    expect(row?.attemptCount).toBe(1);
    expect(row?.lastFailureCode, 'the refusal code, not the outcome word').toBe('private_address');

    const [attempt] = await database.db
      .select()
      .from(deliveryAttempts)
      .where(eq(deliveryAttempts.notificationId, id));
    expect(attempt?.outcome).toBe('refused');
    expect(attempt?.refusalCode).toBe('private_address');
    expect(attempt?.nextAttemptAt, 'a refusal schedules nothing').toBeNull();

    // And it reads as a refusal all the way out to the operator's screen.
    const dead = await listDeadLetters(database.db, database.userId);
    expect(dead[0]?.attempts[0]?.refusalCode).toBe('private_address');
    expect(dead[0]?.lastFailureCode).toBe('private_address');
  });

  it('a permanent failure dead-letters immediately, and is not confused with a refusal', async () => {
    channel.reset();
    clock.setTo(EPOCH);
    await database.truncate();

    const { id } = await queueOne('delivery:permanent');
    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    channel.setNextResult({ outcome: 'permanent', detail: 'SMTP 550' });

    expect(await drainOnce(dependencies, database.userId)).toBe(1);
    expect(await drainOnce(dependencies, database.userId)).toBe(0);

    const attempts = await listAttempts(database.db, database.userId, id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.outcome).toBe('permanent');
    expect(attempts[0]?.refusalCode, 'they refused us; we did not refuse them').toBeNull();
  });

  it('a notification for a disabled channel fails permanently and is never dialled', async () => {
    channel.reset();
    clock.setTo(EPOCH);
    await database.truncate();

    const { id, channelId } = await queueOne('delivery:disabled');
    const context = contextFor(database.userId, clock);
    await setChannelEnabled(database.db, context, channelId, false);

    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    expect(await drainOnce(dependencies, database.userId)).toBe(1);
    expect(channel.deliveries, 'a disabled channel is the kill switch').toHaveLength(0);

    const entries = await listOutbox(database.db, database.userId);
    expect(entries.find((entry) => entry.id === id)?.status).toBe('dead');
  });
});
