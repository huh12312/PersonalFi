// SPDX-License-Identifier: MIT
/**
 * `/connections/plaid/*` — WP 1.3b.
 *
 * `PlaidConnector` is real; only the network is a double. `FakePlaidApi`
 * (`@connector/plaid/test`) is the same hermetic fake `packages/connectors/plaid`
 * proves itself against (conformance, pins, error map, log hygiene) and the live
 * Sandbox smoke — not a second fake built one layer up that could quietly stop
 * matching real Plaid behaviour.
 *
 * The claims:
 *
 * 1. **`POST /connections/plaid/link-token` puts the D16 pins on the wire** —
 *    the three products, `days_requested: 730`, PFC v2 is the connector's own
 *    concern (asserted in `packages/connectors/plaid/test/pins.test.ts`); this
 *    suite asserts the *route* forwards `clientUserId` and that the response
 *    shape matches what `apps/web/src/lib/plaid-link.ts` expects.
 * 2. **`POST /connections/plaid/exchange` stores the access token encrypted,
 *    never as plaintext** — read the raw `connections.sealed_credentials`
 *    column exactly as `psql` would (WP 0.2's P0-1 pattern) and assert the
 *    token substring is absent.
 * 3. **`POST /connections/{id}/plaid/update-link-token` omits `products`** —
 *    01 §1.7: populating it in update mode re-initialises the Item's product
 *    set and can re-bill it.
 * 4. **The D16 ten-Item ratchet** refuses an eleventh Plaid connection.
 * 5. **Step-up gates exchange and update-link-token**; link-token needs only a
 *    session.
 */
import { PLAID_MANIFEST, PlaidConnector } from '@connector/plaid';
import {
  ACCOUNTS,
  fakePlaidItem,
  FakePlaidApi,
  linkSettings,
  testClock,
} from '@connector/plaid/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface LinkTokenBody {
  readonly linkToken: string;
  readonly expiresAt: string;
}

interface LinkResultBody {
  readonly connectionId: string;
  readonly relinked: boolean;
  readonly accountIds: string[];
  readonly syncJobId: string | null;
  readonly syncRunId: string | null;
}

/** A request body the fake recorded, loosely typed — see the file comment. */
type RecordedRequest = Record<string, unknown>;

describe.skipIf(NO_DATABASE)('plaid routes (wp1.3b)', () => {
  let h: ApiHarness;
  let api: FakePlaidApi;

  beforeAll(async () => {
    api = new FakePlaidApi([]);
    const connector = new PlaidConnector({ api, settings: linkSettings(), clock: testClock() });
    h = await createApiHarness({ suite: 'plaid', plaidConnector: connector });
  }, 180_000);

  afterAll(async () => {
    await h?.close();
  }, 60_000);

  // --------------------------------------------------------------- link-token

  it('registers plaid in the connector list', async () => {
    const response = await h.request({ method: 'GET', url: '/connectors', session: h.stale });
    expectStatus(response, 200);
    const body = response.json() as { connectors: { provider: string }[] };
    expect(body.connectors.map((c) => c.provider)).toContain(PLAID_MANIFEST.provider);
  });

  it('mints a link token with the D16 pins on the wire', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/connections/plaid/link-token',
      session: h.stale,
    });
    expectStatus(response, 200);
    const body = response.json() as LinkTokenBody;
    expect(body.linkToken).toMatch(/^link-sandbox-/);
    expect(new Date(body.expiresAt).toString()).not.toBe('Invalid Date');

    const requests = api.requestsTo('link/token/create') as RecordedRequest[];
    const request = requests.at(-1);
    expect(request).toBeDefined();
    expect(request?.['products']).toEqual(['transactions', 'investments', 'liabilities']);
    expect(request?.['transactions']).toEqual({ days_requested: 730 });
    expect(request?.['webhook']).toBeUndefined();
    expect(request?.['redirect_uri']).toBe(linkSettings().redirectUri);
    expect((request?.['user'] as RecordedRequest | undefined)?.['client_user_id']).toBe(h.userId);
  });

  it('refuses a link token without a session', async () => {
    // A same-origin CSRF pair with no session, exactly like
    // connections-routes.test.ts's "carries a CSRF pair but no session": past
    // the root CSRF gate (an `onRequest` hook that fires on every mutation
    // before any route runs), the route's own guard is what answers 401.
    const response = await h.request({
      method: 'POST',
      url: '/connections/plaid/link-token',
      session: { accessToken: 'not-a-real-session-token', csrf: 'x'.repeat(40), fresh: false },
    });
    expect(response.statusCode).toBe(401);
  });

  // ---------------------------------------------------------------- exchange

  it('exchanges a public token, creates the connection, schedules the first sync, and stores the token encrypted — never as plaintext (P0-1)', async () => {
    const accessToken = 'access-plaid-exchange-DO-NOT-LEAK-9f2c4d7a1b6e';
    const publicToken = 'public-plaid-exchange-DO-NOT-LEAK-3e8b1a5c9d0f';
    api.addItem(fakePlaidItem({ accessToken, publicToken, itemId: 'item-exchange-test' }));

    const response = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.fresh,
      body: { publicToken, institutionName: 'Test Bank' },
    });
    expectStatus(response, 201);
    const body = response.json() as LinkResultBody;
    expect(body.relinked).toBe(false);
    expect(body.accountIds).toHaveLength(ACCOUNTS.length);
    expect(body.syncJobId, 'plaid is not process-local: the backfill is queued').not.toBeNull();

    // The response itself must not carry the token.
    expect(response.body).not.toContain(accessToken);

    // Read the raw column exactly as `psql` would — WP 0.2's P0-1 pattern.
    const result = await h.database.pool.query(
      `SELECT sealed_credentials FROM connections WHERE id = $1`,
      [body.connectionId],
    );
    const row = result.rows[0] as { sealed_credentials: Uint8Array } | undefined;
    expect(row).toBeDefined();
    const raw = Buffer.from(row?.sealed_credentials ?? new Uint8Array());
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.toString('utf8')).not.toContain(accessToken);
    expect(raw.toString('latin1')).not.toContain(accessToken);
    for (let i = 0; i + 8 <= accessToken.length; i += 4) {
      expect(raw.toString('latin1')).not.toContain(accessToken.slice(i, i + 8));
    }
  });

  it('refuses to exchange without a step-up assertion, and creates nothing', async () => {
    const publicToken = 'public-plaid-stale-attempt-0000000000000000';
    api.addItem(
      fakePlaidItem({
        accessToken: 'access-plaid-stale-0000',
        publicToken,
        itemId: 'item-stale-attempt',
      }),
    );

    const before = await h.request({ method: 'GET', url: '/connections', session: h.stale });
    const beforeCount = (before.json() as { connections: unknown[] }).connections.length;

    const response = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.stale,
      body: { publicToken },
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('step_up_required');

    const after = await h.request({ method: 'GET', url: '/connections', session: h.stale });
    expect((after.json() as { connections: unknown[] }).connections).toHaveLength(beforeCount);
  });

  it('refuses to exchange without a session', async () => {
    const response = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: { accessToken: 'not-a-real-session-token', csrf: 'x'.repeat(40), fresh: false },
      body: { publicToken: 'public-plaid-no-session' },
    });
    expect(response.statusCode).toBe(401);
  });

  // ------------------------------------------------------------ update mode

  it('mints an update-mode link token with no products on the wire', async () => {
    const accessToken = 'access-plaid-update-mode-DO-NOT-LEAK-4b7e1c93';
    const publicToken = 'public-plaid-update-mode-4b7e1c93';
    api.addItem(fakePlaidItem({ accessToken, publicToken, itemId: 'item-update-mode' }));

    const linked = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.fresh,
      body: { publicToken },
    });
    expectStatus(linked, 201);
    const connectionId = (linked.json() as LinkResultBody).connectionId;

    const response = await h.request({
      method: 'POST',
      url: `/connections/${connectionId}/plaid/update-link-token`,
      session: h.fresh,
      body: {},
    });
    expectStatus(response, 200);
    const body = response.json() as LinkTokenBody;
    expect(body.linkToken).toMatch(/^link-sandbox-/);

    const requests = api.requestsTo('link/token/create') as RecordedRequest[];
    const request = requests.at(-1);
    expect(request?.['access_token']).toBe(accessToken);
    expect(request?.['products']).toBeUndefined();
    expect(request?.['update']).toBeUndefined();
    // The response itself must not carry the access token either.
    expect(response.body).not.toContain(accessToken);
  });

  it('refuses an update-mode token without a step-up assertion', async () => {
    const accessToken = 'access-plaid-update-stale-0000000000000000';
    const publicToken = 'public-plaid-update-stale-0000000000000000';
    api.addItem(fakePlaidItem({ accessToken, publicToken, itemId: 'item-update-stale' }));
    const linked = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session: h.fresh,
      body: { publicToken },
    });
    expectStatus(linked, 201);
    const connectionId = (linked.json() as LinkResultBody).connectionId;

    const response = await h.request({
      method: 'POST',
      url: `/connections/${connectionId}/plaid/update-link-token`,
      session: h.stale,
      body: {},
    });
    expect(response.statusCode).toBe(403);
    expect(problemOf(response)['code']).toBe('step_up_required');
  });

  it('refuses an update-mode token for a connection that is not Plaid', async () => {
    const manual = await h.request({
      method: 'POST',
      url: '/connections',
      session: h.fresh,
      body: {
        provider: 'manual',
        input: {
          displayName: 'Not Plaid',
          providerConnectionId: 'conn-not-plaid',
          accounts: [{ providerAccountId: 'x', name: 'X', type: 'depository', currency: 'USD' }],
        },
      },
    });
    expectStatus(manual, 201);
    const connectionId = (manual.json() as LinkResultBody).connectionId;

    const response = await h.request({
      method: 'POST',
      url: `/connections/${connectionId}/plaid/update-link-token`,
      session: h.fresh,
      body: {},
    });
    expect(response.statusCode).toBe(404);
  });

  // -------------------------------------------------------------- the ratchet

  it('refuses an eleventh Plaid connection (D16: Trial’s ten-Item cap)', async () => {
    const secondUserId = await h.database.createUser('Plaid Ratchet Holder');
    const session = await h.issueSession({ fresh: true, userId: secondUserId });
    const exchangesBefore = api.requestsTo('item/public_token/exchange').length;

    for (let i = 0; i < 10; i += 1) {
      const accessToken = `access-plaid-ratchet-${String(i)}-do-not-leak`;
      const publicToken = `public-plaid-ratchet-${String(i)}`;
      api.addItem(fakePlaidItem({ accessToken, publicToken, itemId: `item-ratchet-${String(i)}` }));
      const response = await h.request({
        method: 'POST',
        url: '/connections/plaid/exchange',
        session,
        body: { publicToken },
      });
      expectStatus(response, 201);
    }

    const eleventhPublicToken = 'public-plaid-ratchet-eleventh';
    api.addItem(
      fakePlaidItem({
        accessToken: 'access-plaid-ratchet-eleventh',
        publicToken: eleventhPublicToken,
        itemId: 'item-ratchet-eleventh',
      }),
    );
    const refused = await h.request({
      method: 'POST',
      url: '/connections/plaid/exchange',
      session,
      body: { publicToken: eleventhPublicToken },
    });
    expect(refused.statusCode).toBe(409);
    expect(problemOf(refused)['code']).toBe('connections.plaid_item_limit');

    // And no Item was spent on the refusal: the exchange never ran for the
    // eleventh attempt, only for the ten that were let through.
    expect(api.requestsTo('item/public_token/exchange').length - exchangesBefore).toBe(10);
  });
});
