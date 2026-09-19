// SPDX-License-Identifier: MIT
/**
 * Quiet hours hold. They never drop.
 *
 * The distinction is the whole feature: a notification suppressed at 00:30 and
 * a notification *deleted* at 00:30 are indistinguishable until 07:00, and only
 * one of them is what the user asked for. `notification_outbox` has no
 * `dropped` status and no DELETE on the hold path — the row goes to `held` with
 * `not_before` set forward — and this suite asserts the row is still there,
 * still claimable, and actually delivered once the window ends.
 *
 * ## Why the boundary is a DST boundary
 *
 * 2026-03-08 in `America/New_York` is 23 hours long: the clock jumps 02:00 EST
 * → 03:00 EDT. A notification that arrives at 00:30 local is inside the
 * 22:00–07:00 window, and the two plausible ways to compute its release differ
 * by exactly one hour:
 *
 *   * **"now + the remaining minutes"** — 00:30 to 07:00 is 390 minutes, so
 *     05:30Z + 390 min = **12:00Z**, which is 08:00 local. An hour late.
 *   * **"the next instant the wall clock reads 07:00"** — 07:00 EDT =
 *     **11:00Z**. Correct.
 *
 * Only the second is what a user who wrote "hold these until 07:00" meant, and
 * the assertion below pins the instant rather than the elapsed time, so the
 * naive implementation cannot pass. The autumn direction is the dangerous one
 * and is asserted too: on 2026-11-01 the same arithmetic releases an hour
 * *early*, which is to say inside quiet hours — the one thing the feature
 * exists to prevent.
 */
import { appendEvent } from '@core/platform';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notificationOutbox } from '../../schema/index.ts';
import { outboxOf } from '../../src/db.ts';
import { quietHoursReleaseAt } from '../../src/time.ts';
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

/** 2026-03-08 00:30 in America/New_York, still EST. Spring forward is at 02:00. */
const ARRIVES_AT = '2026-03-08T05:30:00.000Z';
/** 07:00 EDT the same morning. */
const RELEASES_AT = '2026-03-08T11:00:00.000Z';
/** What "now + 390 minutes" would have produced: 08:00 local, an hour late. */
const NAIVE_RELEASE = '2026-03-08T12:00:00.000Z';

describe.skipIf(NO_DATABASE)('quiet hours', () => {
  let database: TestDatabase;
  let secretBox: SecretBox;
  const clock = clockAt(ARRIVES_AT);
  const channel: FakeChannel = createFakeChannel();

  beforeAll(async () => {
    database = await notificationsDatabase('quiet_hours');
    secretBox = await unlockedSecretBox(database, clock);
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it('a quiet-hours notification is held, not dropped, across a DST boundary', async () => {
    channel.reset();
    clock.setTo(ARRIVES_AT);
    await database.truncate();

    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox);
    await ruleFor(database, context, {
      channelId,
      eventType: 'budgeting.BudgetThresholdCrossed',
      deliveryClass: 'PROMPT',
      quietHoursEnabled: true,
    });

    await appendEvent(
      outboxOf(database.db),
      BudgetThresholdCrossed.create(
        thresholdPayload({
          budgetId: database.userId,
          periodId: '01920000-0000-7000-8000-00000000f001',
          lineId: '01920000-0000-7000-8000-00000000f002',
          threshold: 'OVERSPENT_CASH',
        }),
        { userId: database.userId, correlationId: CORRELATION_ID },
        clock,
      ),
    );

    const pump = pumpFor(database, clock);
    expect(await pump.drain()).toBe(1);

    // Held — the row exists, which is the half a `DELETE` would fail.
    const [held] = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, database.userId));
    expect(held, 'the notification was held, not dropped').toBeDefined();
    expect(held?.status).toBe('held');
    expect(held?.heldReason).toBe('quiet_hours');

    // The instant, not the elapsed time.
    expect(held?.notBefore?.toISOString()).toBe(RELEASES_AT);
    expect(held?.notBefore?.toISOString()).not.toBe(NAIVE_RELEASE);

    // Nothing leaves while the window is open — asserted at 06:59:59 local, a
    // second before the release, so "it was never sent at all" cannot pass.
    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    clock.setTo(new Date(Date.parse(RELEASES_AT) - 1_000));
    expect(await drainOnce(dependencies, database.userId)).toBe(0);
    expect(channel.deliveries).toHaveLength(0);

    const stillThere = await database.db.execute<{ count: string; status: string }>(sql`
      SELECT count(*)::text AS count, max(status) AS status FROM notification_outbox
      WHERE user_id = ${database.userId}::uuid
    `);
    expect(stillThere.rows[0]?.count, 'nothing on the hold path deletes a row').toBe('1');
    expect(stillThere.rows[0]?.status).toBe('held');

    // And at the release instant it is claimed and delivered. The release is a
    // comparison on `not_before`, not a second job that has to remember.
    clock.setTo(RELEASES_AT);
    expect(await drainOnce(dependencies, database.userId)).toBe(1);
    expect(channel.deliveries).toHaveLength(1);

    const [delivered] = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, database.userId));
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.heldReason).toBeNull();
  });

  it('the autumn boundary does not release an hour early, inside the window', () => {
    // 2026-11-01 is 25 hours long in America/New_York: 02:00 EDT → 01:00 EST.
    // A notification arriving at 00:30 EDT (04:30Z) is in quiet hours; "now +
    // 390 minutes" is 11:00Z, which is 06:00 EST — still inside the window.
    const arrives = new Date('2026-11-01T04:30:00.000Z');
    const release = quietHoursReleaseAt(arrives, {
      enabled: true,
      timeZone: ZONE,
      startMinute: 1320,
      endMinute: 420,
    });
    expect(release.toISOString()).toBe('2026-11-01T12:00:00.000Z'); // 07:00 EST
    expect(release.getTime() - arrives.getTime()).toBe(450 * 60_000); // 7.5 wall hours
  });

  it('a P0_SAFETY rule is not held at all', async () => {
    channel.reset();
    clock.setTo(ARRIVES_AT);
    await database.truncate();

    const context = contextFor(database.userId, clock);
    const channelId = await enabledChannel(database, context, secretBox);
    // `notification_rules_p0_ignores_quiet_hours` refuses the contradiction in
    // SQL; `createRule` defaults it off so a caller need not know that.
    await ruleFor(database, context, {
      channelId,
      eventType: 'budgeting.BudgetThresholdCrossed',
      deliveryClass: 'P0_SAFETY',
      quietHoursEnabled: true,
    });

    await appendEvent(
      outboxOf(database.db),
      BudgetThresholdCrossed.create(
        thresholdPayload({
          budgetId: database.userId,
          periodId: '01920000-0000-7000-8000-00000000f011',
          lineId: '01920000-0000-7000-8000-00000000f012',
          threshold: 'OVERSPENT_CREDIT',
        }),
        { userId: database.userId, correlationId: CORRELATION_ID },
        clock,
      ),
    );
    expect(await pumpFor(database, clock).drain()).toBe(1);

    const [row] = await database.db
      .select()
      .from(notificationOutbox)
      .where(eq(notificationOutbox.userId, database.userId));
    expect(row?.status, 'overdraft at 00:30 is the case immediacy is reserved for').toBe('pending');
    expect(row?.heldReason).toBeNull();

    const dependencies = deliveryDependencies(database, clock, channel, secretBox);
    expect(await drainOnce(dependencies, database.userId)).toBe(1);
    expect(channel.deliveries).toHaveLength(1);
  });
});
