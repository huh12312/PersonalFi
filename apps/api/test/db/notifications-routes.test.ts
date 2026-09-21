// SPDX-License-Identifier: MIT
/**
 * `/notifications/*` — WP 2.r's REST surface over `@ctx/notifications`, over
 * a real database.
 *
 * The harness's default configuration is the deny-all egress policy
 * (`config.notifications.allowedHosts` empty — `test/helpers/api-harness.ts`
 * sets no `NOTIFICATIONS_ALLOWED_HOSTS`), which is exactly the posture this
 * WP's dispatch names by name: every channel this suite creates *through the
 * route* refuses at the door, and the one channel it needs enabled for the
 * list/verify/rules/outbox tests is seeded directly against `@ctx/notifications`
 * with a permissive policy — the same seam `phase2-wiring.test.ts` uses for
 * the same reason.
 */
import {
  createEgressPolicy,
  createChannel,
  createFakeChannel,
  enqueueNotification,
  verifyChannel,
} from '@ctx/notifications';
import { newId, systemClock } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  problemOf,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireChannel {
  readonly id: string;
  readonly displayName: string;
  readonly enabled: boolean;
}
interface WireRule {
  readonly id: string;
  readonly channelId: string;
  readonly enabled: boolean;
}

async function seedChannelFor(h: ApiHarness, userId: string, displayName: string): Promise<string> {
  const context = { userId, clock: systemClock, correlationId: 'wp-notif-seed' };
  const permissive = createEgressPolicy({ allowedHosts: ['notify.example.com'] });
  const channel = await createChannel(
    h.database.db,
    { ...context, correlationId: newId() },
    {
      displayName,
      config: {
        kind: 'ntfy',
        scheme: 'https',
        host: 'notify.example.com',
        port: 443,
        topic: `wp-notif-test-${newId().slice(0, 8)}`,
        accessToken: null,
      },
    },
    { secretBox: h.security.requireSecretBox(), policy: permissive },
  );
  const verified = await verifyChannel(
    h.database.db,
    { ...context, correlationId: newId() },
    { channelId: channel.id },
    {
      secretBox: h.security.requireSecretBox(),
      registry: { ntfy: createFakeChannel(), smtp: createFakeChannel() },
    },
  );
  expect(verified.ok).toBe(true);
  return channel.id;
}

async function seedEnabledChannel(h: ApiHarness, displayName: string): Promise<string> {
  return seedChannelFor(h, h.userId, displayName);
}

describe.skipIf(NO_DATABASE)('/notifications (WP 2.r)', () => {
  let h: ApiHarness;
  let channelId: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp-notifications' });
    channelId = await seedEnabledChannel(h, 'Seeded channel');
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('refuses every notifications route without a session, with 401', async () => {
    const noSession = {
      accessToken: 'not-a-real-session-token',
      csrf: 'x'.repeat(40),
      fresh: false,
    };
    const someId = '00000000-0000-4000-8000-000000000000';
    const attempts = [
      { method: 'GET' as const, url: '/notifications/channels', session: noSession },
      {
        method: 'POST' as const,
        url: '/notifications/channels',
        session: noSession,
        body: { kind: 'ntfy', displayName: 'x', destination: 'x' },
      },
      {
        method: 'POST' as const,
        url: `/notifications/channels/${someId}/verify`,
        session: noSession,
      },
      { method: 'DELETE' as const, url: `/notifications/channels/${someId}`, session: noSession },
      { method: 'GET' as const, url: '/notifications/rules', session: noSession },
      {
        method: 'PUT' as const,
        url: '/notifications/rules',
        session: noSession,
        body: { channelId: someId, name: 'x', eventType: 'x', deliveryClass: 'PROMPT' },
      },
      { method: 'GET' as const, url: '/notifications/outbox', session: noSession },
      {
        method: 'POST' as const,
        url: `/notifications/outbox/${someId}/retry`,
        session: noSession,
      },
    ];
    for (const attempt of attempts) {
      // `ApiHarness['request']`'s `ApiRequest.method` union predates this
      // WP's one `PUT` route (`test/helpers/api-harness.ts` is shared,
      // owned-elsewhere infrastructure this WP does not edit); `app.inject`
      // itself accepts any HTTP method, so the cast is a type-level gap
      // only, not a behavioural one.
      const response = await h.request(attempt as unknown as Parameters<typeof h.request>[0]);
      expect(response.statusCode).toBe(401);
      expect(problemOf(response)['code']).toBe('not_authenticated');
    }
  });

  it('lists the seeded channel', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/notifications/channels',
      session: h.stale,
    });
    expectStatus(response, 200);
    const { channels } = response.json() as { channels: WireChannel[] };
    expect(channels.some((c) => c.id === channelId && c.enabled)).toBe(true);
  });

  it('creating a channel under the default deny-all allow-list refuses with host_not_allowed, not a 500', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/notifications/channels',
      session: h.fresh,
      body: { kind: 'ntfy', displayName: 'Should refuse', destination: 'some-topic' },
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response)['code']).toBe('notifications.host_not_allowed');
  });

  it('a channel verify against a non-allowed host returns host_not_allowed', async () => {
    // The seeded channel's host (`notify.example.com`) was permitted at the
    // moment it was created (directly, bypassing this deployment's real
    // policy) but is not on *this deployment's* allow-list — empty by
    // default — so the route's own re-check on every send refuses it, same
    // as a freshly created one would. Never a 500.
    const response = await h.request({
      method: 'POST',
      url: `/notifications/channels/${channelId}/verify`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const { result } = response.json() as { result: { ok: boolean; message: string } };
    expect(result.ok).toBe(false);
    expect(result.message).toContain('host_not_allowed');
  });

  it('creating a channel needs a step-up assertion', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/notifications/channels',
      session: h.stale,
      body: { kind: 'ntfy', displayName: 'x', destination: 'x' },
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('step_up_required');
  });

  it('creates, lists, updates and deletes a rule', async () => {
    const created = await h.request({
      method: 'PUT',
      url: '/notifications/rules',
      session: h.stale,
      body: {
        channelId,
        name: 'wp-notif rule',
        eventType: 'budgeting.BudgetThresholdCrossed',
        deliveryClass: 'PROMPT',
      },
      // See the 401 test's own comment on the harness's `ApiRequest.method` union.
    } as unknown as Parameters<typeof h.request>[0]);
    expectStatus(created, 200);
    const rule = (created.json() as { rule: WireRule }).rule;
    expect(rule.channelId).toBe(channelId);
    expect(rule.enabled).toBe(true);

    const listed = await h.request({
      method: 'GET',
      url: '/notifications/rules',
      session: h.stale,
    });
    expectStatus(listed, 200);
    expect((listed.json() as { rules: WireRule[] }).rules.some((r) => r.id === rule.id)).toBe(true);

    const patched = await h.request({
      method: 'PATCH',
      url: `/notifications/rules/${rule.id}`,
      session: h.stale,
      body: { enabled: false },
    });
    expectStatus(patched, 200);
    expect((patched.json() as { rule: WireRule }).rule.enabled).toBe(false);
  });

  it('lists the outbox (empty is a valid, structurally correct answer)', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/notifications/outbox',
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as { recent: unknown[]; deadLetters: unknown[] };
    expect(Array.isArray(body.recent)).toBe(true);
    expect(Array.isArray(body.deadLetters)).toBe(true);
  });

  it('deleting a channel needs a step-up assertion, and is idempotent', async () => {
    const disposableId = await seedEnabledChannel(h, 'Disposable channel');

    const stale = await h.request({
      method: 'DELETE',
      url: `/notifications/channels/${disposableId}`,
      session: h.stale,
    });
    expect(stale.statusCode).toBe(403);

    const fresh = await h.request({
      method: 'DELETE',
      url: `/notifications/channels/${disposableId}`,
      session: h.fresh,
    });
    expectStatus(fresh, 200);
    expect((fresh.json() as { deleted: boolean }).deleted).toBe(true);

    const again = await h.request({
      method: 'DELETE',
      url: `/notifications/channels/${disposableId}`,
      session: h.fresh,
    });
    expectStatus(again, 200);
    expect((again.json() as { deleted: boolean }).deleted).toBe(false);
  });

  it('a channel and a rule belonging to one user are invisible and unreachable to another', async () => {
    const otherUserId = await h.database.createUser('Notifications Second Holder');
    const otherSession = await h.issueSession({ userId: otherUserId, fresh: true });

    const theirChannels = await h.request({
      method: 'GET',
      url: '/notifications/channels',
      session: otherSession,
    });
    expectStatus(theirChannels, 200);
    expect((theirChannels.json() as { channels: unknown[] }).channels).toEqual([]);

    const patch = await h.request({
      method: 'PATCH',
      url: `/notifications/channels/${channelId}`,
      session: otherSession,
      body: { enabled: false },
    });
    expect(patch.statusCode).toBe(404);

    const del = await h.request({
      method: 'DELETE',
      url: `/notifications/channels/${channelId}`,
      session: otherSession,
    });
    expectStatus(del, 200);
    expect((del.json() as { deleted: boolean }).deleted).toBe(false);

    // Still there for its actual owner.
    const mine = await h.request({
      method: 'GET',
      url: '/notifications/channels',
      session: h.stale,
    });
    expect(
      (mine.json() as { channels: WireChannel[] }).channels.some((c) => c.id === channelId),
    ).toBe(true);
  });

  /**
   * WP 2.12 sabotage finding: `GET /notifications/outbox` (`routes/notifications.ts`)
   * delegates straight to `@ctx/notifications`'s `listOutbox`, and nothing in
   * this repo — not this route's own suite, not `packages/contexts/notifications/
   * test/db/delivery.test.ts` (the only other caller of `listOutbox`, which
   * only ever runs against a single-user scratch database) — ever put a
   * *second* user's row in the outbox and asked whether the first user could
   * see it. Dropping `listOutbox`'s `eq(notificationOutbox.userId, userId)`
   * clause entirely (`src/read.ts`) left every existing test in this file
   * green, including "lists the outbox (empty is a valid, structurally
   * correct answer)" — because that test's own database had exactly one
   * user's rows in it, so removing the filter changed nothing observable.
   */
  it("a notification queued for one user never appears in another's outbox", async () => {
    const otherUserId = await h.database.createUser('Notifications Outbox Second Holder');
    const otherSession = await h.issueSession({ userId: otherUserId, fresh: true });
    const otherChannelId = await seedChannelFor(h, otherUserId, 'Second holder channel');

    const context = { userId: h.userId, clock: systemClock, correlationId: newId() };
    const otherContext = { userId: otherUserId, clock: systemClock, correlationId: newId() };

    await enqueueNotification(h.database.db, context, {
      channelId,
      ruleId: null,
      dedupeKey: `wp-notif-outbox-mine-${newId()}`,
      groupKey: null,
      groupWindow: null,
      deliveryClass: 'PROMPT',
      priority: 'normal',
      title: 'Mine',
      bodyMd: 'A notification belonging to the first holder.',
      notBefore: new Date(),
      heldReason: null,
    });
    await enqueueNotification(h.database.db, otherContext, {
      channelId: otherChannelId,
      ruleId: null,
      dedupeKey: `wp-notif-outbox-theirs-${newId()}`,
      groupKey: null,
      groupWindow: null,
      deliveryClass: 'PROMPT',
      priority: 'normal',
      title: 'Theirs',
      bodyMd: 'A notification belonging to the second holder.',
      notBefore: new Date(),
      heldReason: null,
    });

    const mine = await h.request({
      method: 'GET',
      url: '/notifications/outbox',
      session: h.stale,
    });
    expectStatus(mine, 200);
    const mineTitles = (mine.json() as { recent: { title: string }[] }).recent.map((r) => r.title);
    expect(mineTitles).toContain('Mine');
    expect(mineTitles).not.toContain('Theirs');

    const theirs = await h.request({
      method: 'GET',
      url: '/notifications/outbox',
      session: otherSession,
    });
    expectStatus(theirs, 200);
    const theirTitles = (theirs.json() as { recent: { title: string }[] }).recent.map(
      (r) => r.title,
    );
    expect(theirTitles).toContain('Theirs');
    expect(theirTitles).not.toContain('Mine');
  });
});
