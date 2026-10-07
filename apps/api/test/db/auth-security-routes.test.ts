// SPDX-License-Identifier: MIT
/**
 * WP 9.11 — the auth and step-up gaps WP 9.10 found green under sabotage,
 * proved at the HTTP route (the real `buildApp`, guards, CSRF gate and
 * serialisers over a scratch database):
 *
 * - **G-10** `GET /export` and `POST /import` refuse a stale session (SAB-16
 *   stayed green: every export test drove a fresh one), and nothing is
 *   streamed or loaded.
 * - **G-11** the auth-factor routes — `POST /auth/recovery-codes`,
 *   `/auth/totp/enroll`, `/auth/totp/confirm`, `/auth/register/options`
 *   (no token) — and `POST /connections/:id/complete` refuse a stale session
 *   with no state change (SAB-17: 219/219 green with the guard removed).
 * - **G-13** logout revokes server-side: the old access and refresh cookies are
 *   dead afterwards, not merely cleared (SAB-24 green).
 * - **G-02** the holder can list and end sessions (`GET`/`DELETE
 *   /auth/sessions[/:familyId]`), behind step-up.
 * - **G-12** `DELETE /auth/totp` revokes the seed, behind step-up.
 * - **G-25** export, import and step-up refusals are security events.
 *
 * Every refusal case has its positive control on the same route with a fresh
 * session, so a 403 here is the guard and not a broken route; and "no state
 * change" is asserted on the rows, not inferred from the status (Phase 1 §4.1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REFRESH_COOKIE, SESSION_COOKIE } from '../../src/auth/cookies.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  TEST_ORIGIN,
  type ApiHarness,
  type TestSession,
} from '../helpers/api-harness.ts';

describe.skipIf(NO_DATABASE)('WP 9.11 auth routes: step-up, sessions, logout', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp911_auth' });
  }, 120_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  async function count(table: string): Promise<number> {
    const result = await h.database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table}`,
    );
    return result.rows[0]?.n ?? -1;
  }

  async function eventKinds(): Promise<string[]> {
    const result = await h.database.pool.query<{ kind: string }>(
      'SELECT kind FROM security_events ORDER BY occurred_at, id',
    );
    return result.rows.map((row) => row.kind);
  }

  function expectStepUpRefusal(response: Awaited<ReturnType<ApiHarness['request']>>): void {
    expectStatus(response, 403);
    expect(problemOf(response)['code']).toBe('step_up_required');
  }

  /** A session issued directly, with its refresh token and family id. */
  async function issueFull(fresh: boolean, userId = h.userId) {
    const issued = await h.security.requireIdentity().sessions.issue({
      userId,
      authMethod: 'webauthn',
      fresh,
    });
    const csrf = 'c'.repeat(43);
    const session: TestSession = { accessToken: issued.accessToken, csrf, fresh };
    return {
      session,
      refreshToken: issued.refreshToken,
      familyId: issued.session.familyId,
    };
  }

  // ------------------------------------------------------------- G-10

  it('G-10: GET /export refuses a stale session, streams nothing, and records the refusal', async () => {
    const before = (await eventKinds()).length;
    const refused = await h.request({ method: 'GET', url: '/export', session: h.stale });
    expectStepUpRefusal(refused);
    expect(refused.headers['content-disposition']).toBeUndefined();
    expect(refused.body).not.toContain('"manifest"');
    const kinds = (await eventKinds()).slice(before);
    expect(kinds).toContain('auth.step_up_refused');
    expect(kinds).not.toContain('export.downloaded');

    const allowed = await h.request({ method: 'GET', url: '/export', session: h.fresh });
    expectStatus(allowed, 200);
    expect(allowed.headers['content-disposition']).toContain('personalfi-export.jsonl');
    // G-05: the bundle is the holder's whole ledger; no cache may keep it.
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(await eventKinds()).toContain('export.downloaded');
  }, 60_000);

  it('G-10: POST /import refuses a stale session and loads nothing', async () => {
    const accounts = await count('accounts');
    const refused = await h.request({
      method: 'POST',
      url: '/import',
      session: h.stale,
      headers: { 'content-type': 'application/x-ndjson' },
      body: '{"not":"a bundle"}\n',
    });
    expectStepUpRefusal(refused);
    expect(await count('accounts')).toBe(accounts);
    expect(await eventKinds()).not.toContain('import.loaded');

    // Positive control: the same request, fresh, gets past the guard to the
    // bundle's own validation.
    const allowed = await h.request({
      method: 'POST',
      url: '/import',
      session: h.fresh,
      headers: { 'content-type': 'application/x-ndjson' },
      body: '{"not":"a bundle"}\n',
    });
    expect(allowed.statusCode).not.toBe(403);
    expect(await count('accounts')).toBe(accounts);
  }, 60_000);

  // ------------------------------------------------------------- G-11

  it('G-11: POST /auth/recovery-codes refuses a stale session and mints nothing', async () => {
    const refused = await h.request({
      method: 'POST',
      url: '/auth/recovery-codes',
      session: h.stale,
    });
    expectStepUpRefusal(refused);
    expect(await count('recovery_codes')).toBe(0);

    const allowed = await h.request({
      method: 'POST',
      url: '/auth/recovery-codes',
      session: h.fresh,
    });
    expectStatus(allowed, 200);
    expect(await count('recovery_codes')).toBe(10);
  }, 60_000);

  it('G-11: POST /auth/totp/enroll and /auth/totp/confirm refuse a stale session and enrol nothing', async () => {
    const seeds = await count('totp_secrets');
    expectStepUpRefusal(
      await h.request({ method: 'POST', url: '/auth/totp/enroll', session: h.stale }),
    );
    expectStepUpRefusal(
      await h.request({
        method: 'POST',
        url: '/auth/totp/confirm',
        session: h.stale,
        body: { enrolmentId: '01920000-0000-7000-8000-0000000a0911', token: '123456' },
      }),
    );
    expect(await count('totp_secrets')).toBe(seeds);

    const enrolled = await h.request({
      method: 'POST',
      url: '/auth/totp/enroll',
      session: h.fresh,
    });
    expectStatus(enrolled, 200);
    expect(await count('totp_secrets')).toBe(seeds + 1);
    const confirm = await h.request({
      method: 'POST',
      url: '/auth/totp/confirm',
      session: h.fresh,
      body: {
        enrolmentId: (enrolled.json() as { enrolmentId: string }).enrolmentId,
        token: '000000',
      },
    });
    // Past the guard: the code is wrong, which is a credential refusal, not step-up.
    expect(problemOf(confirm)['code']).not.toBe('step_up_required');
  }, 60_000);

  it('G-11: POST /auth/register/options without a token refuses a stale session and opens no ceremony', async () => {
    const challenges = await count('webauthn_challenges');
    expectStepUpRefusal(
      await h.request({
        method: 'POST',
        url: '/auth/register/options',
        session: h.stale,
        body: {},
      }),
    );
    expect(await count('webauthn_challenges')).toBe(challenges);

    const allowed = await h.request({
      method: 'POST',
      url: '/auth/register/options',
      session: h.fresh,
      body: {},
    });
    expectStatus(allowed, 200);
    expect(await count('webauthn_challenges')).toBe(challenges + 1);
  }, 60_000);

  it('G-11: POST /connections/:id/complete refuses a stale session and links nothing', async () => {
    const connections = await count('connections');
    const url = '/connections/01920000-0000-7000-8000-0000000c0911/complete';
    expectStepUpRefusal(
      await h.request({ method: 'POST', url, session: h.stale, body: { input: {} } }),
    );
    expect(await count('connections')).toBe(connections);

    // Positive control: fresh reaches the route, which does not know the id.
    const allowed = await h.request({ method: 'POST', url, session: h.fresh, body: { input: {} } });
    expectStatus(allowed, 404);
    expect(await count('connections')).toBe(connections);
  }, 60_000);

  // ------------------------------------------------------------- G-12

  it('G-12: DELETE /auth/totp needs step-up, then revokes the seed and says so', async () => {
    const enrolled = await h.request({
      method: 'POST',
      url: '/auth/totp/enroll',
      session: h.fresh,
    });
    expectStatus(enrolled, 200);
    const seeds = await count('totp_secrets');
    expect(seeds).toBeGreaterThan(0);

    expectStepUpRefusal(await h.request({ method: 'DELETE', url: '/auth/totp', session: h.stale }));
    expect(await count('totp_secrets')).toBe(seeds);

    expectStatus(await h.request({ method: 'DELETE', url: '/auth/totp', session: h.fresh }), 200);
    expect(await count('totp_secrets')).toBe(0);
    expect(await eventKinds()).toContain('totp.removed');
  }, 60_000);

  // ------------------------------------------------------------- G-13

  it('G-13: after POST /auth/logout the old access and refresh cookies are dead at the server', async () => {
    const { session, refreshToken } = await issueFull(false);
    expectStatus(await h.request({ method: 'GET', url: '/auth/session', session }), 200);

    expectStatus(await h.request({ method: 'POST', url: '/auth/logout', session }), 200);

    // A copied access cookie, replayed.
    expectStatus(await h.request({ method: 'GET', url: '/auth/session', session }), 401);
    // A copied refresh cookie, replayed.
    const refresh = await h.app.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: {
        origin: TEST_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'x-csrf-token': session.csrf,
        cookie: `${REFRESH_COOKIE}=${refreshToken}; __Host-pfi_csrf=${session.csrf}`,
      },
    });
    expect(refresh.statusCode).toBe(401);
    expect(refresh.headers['set-cookie']?.toString() ?? '').not.toMatch(
      new RegExp(`${SESSION_COOKIE}=[^;]{10,}`),
    );
  }, 60_000);

  // ------------------------------------------------------------- G-02

  it('G-02: GET /auth/sessions needs step-up and lists the holder’s live families, the caller flagged', async () => {
    const other = await issueFull(false);
    expectStepUpRefusal(
      await h.request({ method: 'GET', url: '/auth/sessions', session: h.stale }),
    );

    const listed = await h.request({ method: 'GET', url: '/auth/sessions', session: h.fresh });
    expectStatus(listed, 200);
    const sessions = (listed.json() as { sessions: { familyId: string; current: boolean }[] })
      .sessions;
    expect(sessions.map((entry) => entry.familyId)).toContain(other.familyId);
    expect(sessions.filter((entry) => entry.current)).toHaveLength(1);
    expect(JSON.stringify(listed.json())).not.toMatch(/token|hash/i);
  }, 60_000);

  it('G-02: DELETE /auth/sessions/:familyId needs step-up, ends that family only, and 404s another holder’s', async () => {
    const victim = await issueFull(false);
    const url = `/auth/sessions/${victim.familyId}`;
    expectStepUpRefusal(await h.request({ method: 'DELETE', url, session: victim.session }));
    expectStatus(
      await h.request({ method: 'GET', url: '/auth/session', session: victim.session }),
      200,
    );

    expectStatus(await h.request({ method: 'DELETE', url, session: h.fresh }), 200);
    expectStatus(
      await h.request({ method: 'GET', url: '/auth/session', session: victim.session }),
      401,
    );
    expectStatus(await h.request({ method: 'GET', url: '/auth/session', session: h.fresh }), 200);
    expect(await eventKinds()).toContain('session.revoked');

    const stranger = await h.database.createUser('Stranger');
    const theirs = await issueFull(false, stranger);
    expectStatus(
      await h.request({
        method: 'DELETE',
        url: `/auth/sessions/${theirs.familyId}`,
        session: h.fresh,
      }),
      404,
    );
    expectStatus(
      await h.request({ method: 'GET', url: '/auth/session', session: theirs.session }),
      200,
    );
  }, 60_000);

  // Last: it ends every other session, `h.stale` included.
  it('G-02: DELETE /auth/sessions needs step-up and ends every other family but the caller’s', async () => {
    const a = await issueFull(false);
    const b = await issueFull(false);
    expectStepUpRefusal(
      await h.request({ method: 'DELETE', url: '/auth/sessions', session: a.session }),
    );
    expectStatus(await h.request({ method: 'GET', url: '/auth/session', session: b.session }), 200);

    const revoked = await h.request({ method: 'DELETE', url: '/auth/sessions', session: h.fresh });
    expectStatus(revoked, 200);
    expect((revoked.json() as { revoked: number }).revoked).toBeGreaterThanOrEqual(2);
    for (const session of [a.session, b.session, h.stale]) {
      expectStatus(await h.request({ method: 'GET', url: '/auth/session', session }), 401);
    }
    expectStatus(await h.request({ method: 'GET', url: '/auth/session', session: h.fresh }), 200);
  }, 60_000);
});
