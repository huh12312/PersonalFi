// SPDX-License-Identifier: MIT
/**
 * WP 9.6 item 5 (O-9) and G5-3 — the consent route's history, and what the
 * consent screen offers.
 *
 * `snapshot_grants` is the state of a consent and is updated on revoke and
 * re-grant. `snapshot_grant_events` (migration 0038) is the record: one row
 * per grant, revoke and re-grant, written in the transaction that makes the
 * change, never updated. This file drives it through the real app's consent
 * route (`PUT /advisors/{id}/grants`, `GET /advisors/{id}/grant-events`) and
 * the store functions behind it, over a real database.
 *
 * ## The predicate matrix
 *
 * Every query that reads or writes the table is scoped by `userId`, and the
 * history read by `advisorId` as well. Each predicate is tested ALONE — the
 * data is built so that a query that kept one and dropped the other returns a
 * row the right answer excludes (the same advisor under another holder; the
 * same holder's other advisor) — and the two together (§ "sabotage log").
 */
import { newId, systemClock } from '@core/kernel';
import {
  grantScopes,
  listGrantEvents,
  listGrants,
  registerAdvisor,
  revokeScopes,
  NARRATOR_MANIFEST,
  type AdvisorManifest,
  type InsightsContext,
} from '@ctx/insights';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

const CASH_ADVISOR_ID = 'builtin.cash.emergency_fund_short';

interface EventWire {
  readonly id: string;
  readonly advisorId: string;
  readonly scope: string;
  readonly event: 'granted' | 'revoked' | 're_granted';
  readonly perRunConsent: boolean;
  readonly stepUpSessionId: string | null;
  readonly occurredAt: string;
}

function contextOf(userId: string, clock = systemClock): InsightsContext {
  return { userId, clock, correlationId: newId() };
}

/** A clock that moves only when told to, so event order is by time and not by luck. */
function steppingClock(start: string) {
  let now = new Date(start).getTime();
  return {
    now: () => new Date(now),
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe.skipIf(NO_DATABASE)(
  'snapshot_grant_events (WP 9.6, O-9) and the consent screen (G5-3)',
  () => {
    let h: ApiHarness;
    let other: string;

    async function sessionIdOf(session: TestSession): Promise<string> {
      const record = await h.security.requireIdentity().sessions.authenticate(session.accessToken);
      if (record === null) throw new Error('the harness session did not authenticate');
      return record.id;
    }

    async function put(
      advisorId: string,
      scopes: readonly string[],
      session: TestSession = h.fresh,
      perRunConsent?: boolean,
    ) {
      return h.request({
        method: 'PUT',
        url: `/advisors/${advisorId}/grants`,
        session,
        body: { scopes, ...(perRunConsent === undefined ? {} : { perRunConsent }) },
      });
    }

    async function events(advisorId: string, session: TestSession = h.stale): Promise<EventWire[]> {
      const response = await h.request({
        method: 'GET',
        url: `/advisors/${advisorId}/grant-events`,
        session,
      });
      expectStatus(response, 200);
      return (response.json() as { events: EventWire[] }).events;
    }

    beforeAll(async () => {
      h = await createApiHarness({ suite: 'wp96-grant-history' });
      other = await h.database.createUser('a second holder');
      // The same advisors for both holders: the builtin catalogue for the
      // harness's holder arrives with `app.ready()`; the second holder gets the
      // narrator and one builtin-like row of their own below, where a test needs
      // them. The history read does not need an `advisors` row at all.
    }, 120_000);

    afterAll(async () => {
      await h.close();
    });

    it('every grant, revoke and re-grant is recorded and never overwritten', async () => {
      // The step-up session is the one that authorised the change.
      const freshId = await sessionIdOf(h.fresh);

      // 1. Grant two scopes.
      expectStatus(await put(CASH_ADVISOR_ID, ['cash.summary', 'cashflow.monthly']), 200);
      let log = await events(CASH_ADVISOR_ID);
      expect(log.map((e) => [e.scope, e.event]).sort()).toEqual([
        ['cash.summary', 'granted'],
        ['cashflow.monthly', 'granted'],
      ]);
      for (const event of log) {
        expect(event.stepUpSessionId).toBe(freshId);
        expect(event.advisorId).toBe(CASH_ADVISOR_ID);
        expect(event.perRunConsent).toBe(false);
      }
      const firstGrants = log.map((e) => ({ id: e.id, occurredAt: e.occurredAt }));

      // 2. A call that changes nothing records nothing.
      expectStatus(await put(CASH_ADVISOR_ID, ['cash.summary', 'cashflow.monthly']), 200);
      expect(await events(CASH_ADVISOR_ID)).toHaveLength(2);

      // 3. Revoke one.
      expectStatus(await put(CASH_ADVISOR_ID, ['cashflow.monthly']), 200);
      log = await events(CASH_ADVISOR_ID);
      expect(log).toHaveLength(3);
      expect(log[0]).toMatchObject({ scope: 'cash.summary', event: 'revoked' });
      expect(log[0]?.stepUpSessionId).toBe(freshId);

      // 4. Re-grant it. The state row is updated in place (revoked_at cleared,
      //    granted_at re-stamped) — the history is not.
      expectStatus(await put(CASH_ADVISOR_ID, ['cash.summary', 'cashflow.monthly']), 200);
      log = await events(CASH_ADVISOR_ID);
      expect(log).toHaveLength(4);
      // Newest first: the re-grant leads, the revoke follows, the original grant is still there.
      expect(log[0]).toMatchObject({ scope: 'cash.summary', event: 're_granted' });
      expect(log.filter((e) => e.scope === 'cash.summary').map((e) => e.event)).toEqual([
        're_granted',
        'revoked',
        'granted',
      ]);

      // The original grant rows are exactly what they were: same id, same instant.
      for (const original of firstGrants) {
        const still = log.find((e) => e.id === original.id);
        expect(still?.event).toBe('granted');
        expect(still?.occurredAt).toBe(original.occurredAt);
      }

      // 5. "Never overwritten" is a property of the table, not of the writer: an
      //    UPDATE is refused by the database itself.
      const refused = await h.database.db
        .execute(sql`UPDATE snapshot_grant_events SET event = 'granted'`)
        .then(
          () => null,
          (error: unknown) => error as { cause?: { code?: string; message?: string } },
        );
      expect(refused).not.toBeNull();
      expect(refused?.cause?.code).toBe('23514');
      expect(refused?.cause?.message).toMatch(/may never be updated/);
      expect(await events(CASH_ADVISOR_ID)).toHaveLength(4);
    }, 60_000);

    it('a standing per-run-consent grant records that it was one', async () => {
      const advisorId = `test.external.${newId().replaceAll('-', '').slice(0, 8)}`;
      const manifest: AdvisorManifest = {
        ...NARRATOR_MANIFEST,
        advisor_id: advisorId,
        kind: 'local_model',
        requires_scopes: ['transactions.raw'],
        capabilities: { ...NARRATOR_MANIFEST.capabilities, narrates_only: false },
      };
      await registerAdvisor(h.database.db, contextOf(h.userId), { manifest, enabled: false });
      expectStatus(await put(advisorId, ['transactions.raw'], h.fresh, true), 200);
      const [event] = await events(advisorId);
      expect(event).toMatchObject({
        scope: 'transactions.raw',
        event: 'granted',
        perRunConsent: true,
      });
    }, 60_000);

    it('the route is a step-up act to write and a session to read', async () => {
      expect((await put(CASH_ADVISOR_ID, ['cash.summary'], h.stale)).statusCode).toBe(403);
      const unauthenticated = await h.request({
        method: 'GET',
        url: `/advisors/${CASH_ADVISOR_ID}/grant-events`,
      });
      expect(unauthenticated.statusCode).toBe(401);
      const unknown = await h.request({
        method: 'GET',
        url: '/advisors/builtin.does.not_exist/grant-events',
        session: h.stale,
      });
      expect(unknown.statusCode).toBe(404);
      expect(problemOf(unknown)['code']).toBe('insights.advisor_not_found');
    }, 60_000);

    describe('the predicate matrix, every query alone and together', () => {
      const ADVISOR_X = 'test.history.x';
      const ADVISOR_Y = 'test.history.y';
      const clock = steppingClock('2026-10-06T12:00:00.000Z');

      beforeAll(async () => {
        // Same advisor ids under both holders (a cross-user query that dropped
        // `userId` finds the other holder's row), and a second advisor under the
        // first holder (a query that dropped `advisorId` finds it).
        const mine = contextOf(h.userId, clock);
        const theirs = contextOf(other, clock);
        for (const [context, advisorId] of [
          [mine, ADVISOR_X],
          [mine, ADVISOR_Y],
          [theirs, ADVISOR_X],
        ] as const) {
          await registerAdvisor(h.database.db, context, {
            manifest: {
              ...NARRATOR_MANIFEST,
              advisor_id: advisorId,
              kind: 'builtin',
              requires_scopes: ['cash.summary'],
              capabilities: { ...NARRATOR_MANIFEST.capabilities, narrates_only: false },
              limits: { timeout_ms: 30_000, max_insights: 5, max_response_bytes: 65_536 },
            },
            enabled: false,
          });
        }
        await grantScopes(h.database.db, mine, ADVISOR_X, ['cash.summary']);
        clock.advance(1000);
        await grantScopes(h.database.db, theirs, ADVISOR_X, ['networth.summary']);
        clock.advance(1000);
        await grantScopes(h.database.db, mine, ADVISOR_Y, ['cashflow.monthly']);
        clock.advance(1000);
        await revokeScopes(h.database.db, theirs, ADVISOR_X, ['networth.summary']);
      }, 60_000);

      it('listGrantEvents: userId alone, advisorId alone, and both', async () => {
        const mine = await listGrantEvents(h.database.db, h.userId, ADVISOR_X);
        // Both predicates hold: my events for X, and nothing else.
        expect(mine.map((e) => [e.advisorId, e.scope, e.event])).toEqual([
          [ADVISOR_X, 'cash.summary', 'granted'],
        ]);
        // userId alone is what keeps the other holder's X events out ...
        expect(mine.some((e) => e.scope === 'networth.summary')).toBe(false);
        // ... advisorId alone is what keeps my own Y events out.
        expect(mine.some((e) => e.advisorId === ADVISOR_Y)).toBe(false);

        const theirs = await listGrantEvents(h.database.db, other, ADVISOR_X);
        expect(theirs.map((e) => [e.scope, e.event])).toEqual([
          ['networth.summary', 'revoked'],
          ['networth.summary', 'granted'],
        ]);
        // A holder with nothing sees nothing, whatever the advisor.
        expect(await listGrantEvents(h.database.db, newId(), ADVISOR_X)).toEqual([]);
      });

      it('the route answers for the caller only', async () => {
        const mine = await events(ADVISOR_X);
        expect(mine.map((e) => e.scope)).toEqual(['cash.summary']);
        const theirSession = await h.issueSession({ userId: other });
        const theirs = await h.request({
          method: 'GET',
          url: `/advisors/${ADVISOR_X}/grant-events`,
          session: theirSession,
        });
        expectStatus(theirs, 200);
        expect(
          (theirs.json() as { events: EventWire[] }).events.map((e) => [e.scope, e.event]),
        ).toEqual([
          ['networth.summary', 'revoked'],
          ['networth.summary', 'granted'],
        ]);
      });

      it('writes are the writer’s own: events carry the context’s holder, never another', async () => {
        const rows = await h.database.db.execute<{ user_id: string; advisor_id: string }>(sql`
        SELECT user_id::text, advisor_id FROM snapshot_grant_events
         WHERE advisor_id IN (${ADVISOR_X}, ${ADVISOR_Y}) ORDER BY occurred_at, id
      `);
        expect(
          rows.rows.map((r) => [r.user_id === h.userId ? 'me' : 'them', r.advisor_id]),
        ).toEqual([
          ['me', ADVISOR_X],
          ['them', ADVISOR_X],
          ['me', ADVISOR_Y],
          ['them', ADVISOR_X],
        ]);
      });

      it('revokeScopes: userId alone — my revoke never touches, or records against, their grant', async () => {
        const theirs = contextOf(other, clock);
        clock.advance(1000);
        await grantScopes(h.database.db, theirs, ADVISOR_X, ['networth.summary']); // re-grant
        expect(await listGrants(h.database.db, other, ADVISOR_X)).toEqual(['networth.summary']);
        const before = (await listGrantEvents(h.database.db, other, ADVISOR_X)).length;

        // I revoke a scope I never held, on the advisor id we share.
        clock.advance(1000);
        await revokeScopes(h.database.db, contextOf(h.userId, clock), ADVISOR_X, [
          'networth.summary',
        ]);

        expect(await listGrants(h.database.db, other, ADVISOR_X)).toEqual(['networth.summary']);
        expect((await listGrantEvents(h.database.db, other, ADVISOR_X)).length).toBe(before);
        expect(await listGrants(h.database.db, h.userId, ADVISOR_X)).toEqual(['cash.summary']);
      });

      it('a call that changes nothing records nothing, at the store as well as at the route', async () => {
        const ADVISOR_Z = 'test.history.z';
        const context = contextOf(h.userId, clock);
        await registerAdvisor(h.database.db, context, {
          manifest: {
            ...NARRATOR_MANIFEST,
            advisor_id: ADVISOR_Z,
            kind: 'builtin',
            requires_scopes: ['cash.summary'],
            capabilities: { ...NARRATOR_MANIFEST.capabilities, narrates_only: false },
            limits: { timeout_ms: 30_000, max_insights: 5, max_response_bytes: 65_536 },
          },
          enabled: false,
        });
        const count = async () =>
          (await listGrantEvents(h.database.db, h.userId, ADVISOR_Z)).map((e) => e.event);
        clock.advance(1000);
        await grantScopes(h.database.db, context, ADVISOR_Z, ['cash.summary']);
        expect(await count()).toEqual(['granted']);
        // Granting a live grant again: no change of consent, no event.
        clock.advance(1000);
        await grantScopes(h.database.db, context, ADVISOR_Z, ['cash.summary']);
        expect(await count()).toEqual(['granted']);
        clock.advance(1000);
        await revokeScopes(h.database.db, context, ADVISOR_Z, ['cash.summary']);
        expect(await count()).toEqual(['revoked', 'granted']);
        // Revoking a revoked grant, or one never held: no event.
        clock.advance(1000);
        await revokeScopes(h.database.db, context, ADVISOR_Z, ['cash.summary', 'networth.summary']);
        expect(await count()).toEqual(['revoked', 'granted']);
      });

      it('grantScopes: the prior-state lookup is per holder (alone) and per advisor (alone)', async () => {
        const W1 = 'test.history.w1';
        const W2 = 'test.history.w2';
        const mine = contextOf(h.userId, clock);
        const theirs = contextOf(other, clock);
        // I grant then revoke cash.summary on W1: a revoked row exists for me.
        clock.advance(1000);
        await grantScopes(h.database.db, mine, W1, ['cash.summary']);
        clock.advance(1000);
        await revokeScopes(h.database.db, mine, W1, ['cash.summary']);

        // The other holder's FIRST grant of the same scope on the same advisor id
        // is a `granted`, not a `re_granted`: my revoked row is not theirs.
        clock.advance(1000);
        await grantScopes(h.database.db, theirs, W1, ['cash.summary']);
        expect((await listGrantEvents(h.database.db, other, W1)).map((e) => e.event)).toEqual([
          'granted',
        ]);

        // My FIRST grant on another advisor is a `granted` too: my revoked row
        // on W1 is not W2's.
        clock.advance(1000);
        await grantScopes(h.database.db, mine, W2, ['cash.summary']);
        expect((await listGrantEvents(h.database.db, h.userId, W2)).map((e) => e.event)).toEqual([
          'granted',
        ]);
        // And my own re-grant on W1 is the `re_granted` it should be.
        clock.advance(1000);
        await grantScopes(h.database.db, mine, W1, ['cash.summary']);
        expect((await listGrantEvents(h.database.db, h.userId, W1)).map((e) => e.event)).toEqual([
          're_granted',
          'revoked',
          'granted',
        ]);
      });

      it('revokeScopes: advisorId alone — revoking on one advisor leaves my other advisor’s grant', async () => {
        clock.advance(1000);
        await revokeScopes(h.database.db, contextOf(h.userId, clock), ADVISOR_X, [
          'cashflow.monthly',
        ]);
        expect(await listGrants(h.database.db, h.userId, ADVISOR_Y)).toEqual(['cashflow.monthly']);
        expect(
          (await listGrantEvents(h.database.db, h.userId, ADVISOR_Y)).map((e) => e.event),
        ).toEqual(['granted']);
      });
    });

    describe('G5-3: the consent screen marks what an advisor requests; the route refuses or flags the rest', () => {
      async function scopesOf(advisorId: string) {
        const response = await h.request({
          method: 'GET',
          url: `/advisors/${advisorId}/scopes`,
          session: h.stale,
        });
        expectStatus(response, 200);
        return (
          response.json() as { scopes: { scope: string; requested: boolean; granted: boolean }[] }
        ).scopes;
      }

      it('GET marks each scope the advisor requests', async () => {
        const scopes = await scopesOf(CASH_ADVISOR_ID);
        const requested = scopes.filter((s) => s.requested).map((s) => s.scope);
        // The builtin's manifest, read — not a list the test keeps.
        expect(requested).toContain('cash.summary');
        expect(scopes.some((s) => !s.requested)).toBe(true);
        expect(requested.length).toBeLessThan(scopes.length);
      });

      it('a local-model advisor is refused a scope it never requests (422), and the refusal writes nothing', async () => {
        const advisorId = `test.local.${newId().replaceAll('-', '').slice(0, 8)}`;
        const manifest: AdvisorManifest = {
          ...NARRATOR_MANIFEST,
          advisor_id: advisorId,
          requires_scopes: ['cash.summary'],
        };
        await registerAdvisor(h.database.db, contextOf(h.userId), { manifest, enabled: false });
        const scopes = await scopesOf(advisorId);
        expect(scopes.find((s) => s.scope === 'cash.summary')?.requested).toBe(true);
        expect(scopes.find((s) => s.scope === 'budgets.status')?.requested).toBe(false);

        const refused = await put(advisorId, ['cash.summary', 'budgets.status']);
        expect(refused.statusCode).toBe(422);
        expect(problemOf(refused)['code']).toBe('insights.scope_not_requested');
        // Nothing was stored — not even the scope that was fine.
        expect(await listGrants(h.database.db, h.userId, advisorId)).toEqual([]);
        expect(await events(advisorId)).toEqual([]);

        expectStatus(await put(advisorId, ['cash.summary']), 200);
      }, 60_000);

      it('a builtin may be granted an unrequested scope — and the answer says it was never requested', async () => {
        const response = await put(CASH_ADVISOR_ID, ['cash.summary', 'budgets.status']);
        expectStatus(response, 200);
        expect((response.json() as { notRequested: string[] }).notRequested).toEqual([
          'budgets.status',
        ]);
        // Idempotent: the same call again grants nothing new, so flags nothing new.
        const again = await put(CASH_ADVISOR_ID, ['cash.summary', 'budgets.status']);
        expect((again.json() as { notRequested: string[] }).notRequested).toEqual([]);
      }, 60_000);
    });
  },
);
