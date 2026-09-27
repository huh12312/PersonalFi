// SPDX-License-Identifier: MIT
/**
 * `/advisors/{id}/scopes` and `/advisors/{id}/grants` (WP 4.8) — the
 * scope-consent route, over a real database.
 *
 * `grantScopes` has never had a production caller before this route
 * (`wp2.6-insights.md` §6, `wp3.10a-snapshot-readers.md` §7.1) — every other
 * suite that needs a grant calls the domain function directly
 * (`insights-routes.test.ts`'s own `beforeAll`). This file drives the route
 * instead, over `apps/api/src/app.ts`'s real boot hook — which registers the
 * builtin catalogue for `h.userId` at `app.ready()` (`bootstrap-seed.ts`'s
 * `seedUserState`, run once per existing user) — so `findAdvisor` sees a real
 * row with no manual insert.
 */
import { newId, systemClock } from '@core/kernel';
import { listGrants, registerAdvisor, type AdvisorManifest } from '@ctx/insights';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const CASH_ADVISOR_ID = 'builtin.cash.emergency_fund_short';

interface ScopeDefinitionWire {
  readonly scope: string;
  readonly sensitivity: number;
  readonly externalAllowed: boolean;
  readonly granted: boolean;
}

interface ScopesResponse {
  readonly advisorId: string;
  readonly kind: string;
  readonly scopes: readonly ScopeDefinitionWire[];
}

interface GrantsResponse {
  readonly advisorId: string;
  readonly granted: readonly string[];
  readonly revoked: readonly string[];
}

function externalManifest(advisorId: string): AdvisorManifest {
  return {
    advisor_id: advisorId,
    version: '1.0.0',
    contract_version: 1,
    kind: 'external',
    display_name: 'Test external advisor',
    purpose: 'A fixture advisor for WP 4.8’s scope-consent route tests.',
    requires_scopes: ['cash.summary'],
    triggers: [{ type: 'schedule', cron: '0 4 * * *' }],
    capabilities: {
      deterministic: false,
      produces_impact: false,
      narrates_only: false,
      max_severity: 'notable',
    },
    limits: { timeout_ms: 30_000, max_insights: 10, max_response_bytes: 65_536 },
    egress_allowlist: ['example.com'],
  };
}

describe.skipIf(NO_DATABASE)('/advisors/{id}/scopes and /advisors/{id}/grants (WP 4.8)', () => {
  let h: ApiHarness;
  let externalAdvisorId: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp48-advisor-grants' });
    externalAdvisorId = `test.external.${newId().replaceAll('-', '').slice(0, 8)}`;
    await registerAdvisor(
      h.database.db,
      { userId: h.userId, clock: systemClock, correlationId: newId() },
      { manifest: externalManifest(externalAdvisorId), enabled: false },
    );
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('401s every route without a session', async () => {
    const noSession = { accessToken: 'not-a-real-token', csrf: 'x'.repeat(40), fresh: false };
    const scopes = await h.request({
      method: 'GET',
      url: `/advisors/${CASH_ADVISOR_ID}/scopes`,
      session: noSession,
    });
    expect(scopes.statusCode).toBe(401);
    const grants = await h.request({
      method: 'PUT',
      url: `/advisors/${CASH_ADVISOR_ID}/grants`,
      session: noSession,
      body: { scopes: ['cash.summary'] },
    });
    expect(grants.statusCode).toBe(401);
  });

  it('404s an advisor the caller has none of', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/advisors/builtin.does.not_exist/scopes',
      session: h.stale,
    });
    expect(response.statusCode).toBe(404);
    expect(problemOf(response)['code']).toBe('insights.advisor_not_found');
  });

  it('lists the builtin catalogue with nothing granted yet', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/advisors/${CASH_ADVISOR_ID}/scopes`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as ScopesResponse;
    expect(body.advisorId).toBe(CASH_ADVISOR_ID);
    expect(body.kind).toBe('builtin');
    expect(body.scopes.length).toBeGreaterThan(0);
    expect(body.scopes.every((row) => !row.granted)).toBe(true);
    // A builtin advisor may hold every published scope (`externalAllowed`
    // only excludes an `external` advisor).
    expect(body.scopes.some((row) => row.scope === 'transactions.raw')).toBe(true);
  });

  it('granting a scope requires a fresh session', async () => {
    const stale = await h.request({
      method: 'PUT',
      url: `/advisors/${CASH_ADVISOR_ID}/grants`,
      session: h.stale,
      body: { scopes: ['cash.summary'] },
    });
    expect(stale.statusCode).toBe(403);
    expect(problemOf(stale)['code']).toBe('step_up_required');

    const fresh = await h.request({
      method: 'PUT',
      url: `/advisors/${CASH_ADVISOR_ID}/grants`,
      session: h.fresh,
      body: { scopes: ['cash.summary'] },
    });
    expectStatus(fresh, 200);
    const body = fresh.json() as GrantsResponse;
    expect(body.granted).toEqual(['cash.summary']);
    expect(body.revoked).toEqual([]);

    const stored = await listGrants(h.database.db, h.userId, CASH_ADVISOR_ID);
    expect([...stored]).toEqual(['cash.summary']);
  });

  it('PUT replaces the standing grant set: adds what is new, revokes what is dropped', async () => {
    const first = await h.request({
      method: 'PUT',
      url: `/advisors/${CASH_ADVISOR_ID}/grants`,
      session: h.fresh,
      body: { scopes: ['cash.summary', 'cashflow.monthly'] },
    });
    expectStatus(first, 200);
    expect([...(first.json() as GrantsResponse).granted].sort()).toEqual(['cashflow.monthly']);

    const second = await h.request({
      method: 'PUT',
      url: `/advisors/${CASH_ADVISOR_ID}/grants`,
      session: h.fresh,
      body: { scopes: ['cashflow.monthly'] },
    });
    expectStatus(second, 200);
    const body = second.json() as GrantsResponse;
    expect(body.granted).toEqual([]);
    expect(body.revoked).toEqual(['cash.summary']);

    const stored = await listGrants(h.database.db, h.userId, CASH_ADVISOR_ID);
    expect([...stored]).toEqual(['cashflow.monthly']);

    const scopes = (
      await h.request({
        method: 'GET',
        url: `/advisors/${CASH_ADVISOR_ID}/scopes`,
        session: h.stale,
      })
    ).json() as ScopesResponse;
    const cashSummary = scopes.scopes.find((row) => row.scope === 'cash.summary');
    const cashflow = scopes.scopes.find((row) => row.scope === 'cashflow.monthly');
    expect(cashSummary?.granted).toBe(false);
    expect(cashflow?.granted).toBe(true);
  });

  it('a scope absent from the published catalogue is refused by the route before the database refuses it', async () => {
    // Not one of `ADVISOR_SCOPES` at all — the zod `z.enum` on the body
    // refuses it (400) before the handler runs, so `grantScopes` is never
    // called and no statement reaches `snapshot_grants`.
    const response = await h.request({
      method: 'PUT',
      url: `/advisors/${CASH_ADVISOR_ID}/grants`,
      session: h.fresh,
      body: { scopes: ['not.a.real.scope'] },
    });
    expect(response.statusCode).toBe(400);
    const stored = await listGrants(h.database.db, h.userId, CASH_ADVISOR_ID);
    expect([...stored]).toEqual(['cashflow.monthly']); // unchanged from the previous test
  });

  it('a published scope not permitted for an external advisor is refused by the route, before the database', async () => {
    // `transactions.raw` is published (`ADVISOR_SCOPES`) but `externalAllowed:
    // false` — a scope the wire type accepts but this advisor's kind may not
    // hold. `SCOPE_CATALOGUE`'s own rule, read here, must fire before
    // `grantScopes` is ever called.
    const response = await h.request({
      method: 'PUT',
      url: `/advisors/${externalAdvisorId}/grants`,
      session: h.fresh,
      body: { scopes: ['transactions.raw'] },
    });
    expect(response.statusCode).toBe(422);
    expect(problemOf(response)['code']).toBe('insights.scope_not_permitted_for_kind');
    const stored = await listGrants(h.database.db, h.userId, externalAdvisorId);
    expect([...stored]).toEqual([]);
  });

  it('the external advisor’s scope list never offers a scope it could not be granted', async () => {
    const response = await h.request({
      method: 'GET',
      url: `/advisors/${externalAdvisorId}/scopes`,
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as ScopesResponse;
    expect(body.kind).toBe('external');
    expect(body.scopes.some((row) => row.scope === 'transactions.raw')).toBe(false);
    expect(body.scopes.every((row) => row.externalAllowed)).toBe(true);
    // A permitted scope still grants normally.
    const grant = await h.request({
      method: 'PUT',
      url: `/advisors/${externalAdvisorId}/grants`,
      session: h.fresh,
      body: { scopes: ['cash.summary'] },
    });
    expectStatus(grant, 200);
    expect((grant.json() as GrantsResponse).granted).toEqual(['cash.summary']);
  });

  it("refuses another user's advisor and never reads or changes their grants", async () => {
    const otherUserId = await h.database.createUser('Second Holder');
    const theirs = await h.issueSession({ userId: otherUserId, fresh: true });

    const scopes = await h.request({
      method: 'GET',
      url: `/advisors/${CASH_ADVISOR_ID}/scopes`,
      session: theirs,
    });
    // Bob has no `advisors` row for this id (the catalogue is only seeded
    // for a user that existed when the app booted) — the same 404 as an id
    // that never existed, so a probe cannot learn that Alice holds it.
    expect(scopes.statusCode).toBe(404);

    const grant = await h.request({
      method: 'PUT',
      url: `/advisors/${CASH_ADVISOR_ID}/grants`,
      session: theirs,
      body: { scopes: ['cash.summary'] },
    });
    expect(grant.statusCode).toBe(404);

    // Alice's own grants are untouched by Bob's refused attempt.
    const stillAlices = await listGrants(h.database.db, h.userId, CASH_ADVISOR_ID);
    expect([...stillAlices]).toEqual(['cashflow.monthly']);
  });
});
