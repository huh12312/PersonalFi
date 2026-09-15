// SPDX-License-Identifier: MIT
/**
 * The request pins, asserted on the bodies that actually leave the adapter.
 *
 * Every pin here is a decision that is invisible at runtime and expensive to get
 * wrong, in most cases irrecoverably:
 *
 *   * `transactions.days_requested: 730` fixes the Item's history window **for
 *     the life of the Item** (01 §5.1). Ship 90 and the only repair is
 *     `/item/remove` plus a re-link — and on Trial that costs a slot forever
 *     (D16), because `/item/remove` does not free one.
 *   * `Plaid-Version` decides the response *shape*. Omit it and, per 01 §1.9,
 *     "the Dashboard-configured default applies" — a checkbox in a browser
 *     silently choosing which decoder is correct.
 *   * `products` in **update mode** re-initialises the Item's product set and
 *     can re-bill it. 01 §1.7: "Do not populate `products` during standard
 *     update mode."
 *   * `personal_finance_category_version` decides which taxonomy the classifier
 *     in WP 1.4 is reading.
 *
 * None of these can be caught by a type, none show up in a green sync, and each
 * one is asserted against the request object the fake recorded rather than
 * against the source line that built it.
 */
import { todayIn } from '@core/kernel';
import type {
  InvestmentsTransactionsGetRequest,
  LinkTokenCreateRequest,
  TransactionsSyncRequest,
} from 'plaid';
import { describe, expect, it } from 'vitest';
import {
  PLAID_API_VERSION,
  PLAID_MAX_HISTORY_DAYS,
  PLAID_MAX_PAGE_SIZE,
  PLAID_PFC_VERSION,
  PLAID_PRODUCTS,
} from '../src/provider.ts';
import { plaidBasePath, plaidRequestHeaders } from '../src/client.ts';
import { harness, syncOptions, testClock } from './harness.ts';

const CLIENT_USER_ID = '01920000-0000-7000-8000-0000000000aa';

function linkRequests(api: {
  requestsTo: (endpoint: string) => unknown[];
}): LinkTokenCreateRequest[] {
  return api.requestsTo('link/token/create') as LinkTokenCreateRequest[];
}

// ---------------------------------------------------------------------------
// /link/token/create
// ---------------------------------------------------------------------------

describe('pins: /link/token/create', () => {
  it('requests exactly the three D16 products and 730 days of history', async () => {
    const { api, connector } = harness();
    await connector.createLinkToken({ clientUserId: CLIENT_USER_ID });

    const [request] = linkRequests(api);
    expect(request).toBeDefined();
    // Exactly these, in this order. Not `auth`, not `identity`: 01 §1.5 — Auth
    // exists to move money by ACH and we never move money; Identity verifies an
    // account owner who, in a single-user app, is the user.
    expect(request?.products).toEqual([...PLAID_PRODUCTS]);
    expect(PLAID_PRODUCTS).toEqual(['transactions', 'investments', 'liabilities']);
    expect(request?.transactions?.days_requested).toBe(730);
    expect(PLAID_MAX_HISTORY_DAYS).toBe(730);
  });

  it('carries the deployment fields and the app user id, never an email', async () => {
    const { api, connector } = harness();
    await connector.createLinkToken({ clientUserId: CLIENT_USER_ID });

    const [request] = linkRequests(api);
    expect(request?.client_name).toBe('PersonalFi');
    expect(request?.language).toBe('en');
    expect(request?.country_codes).toEqual(['US']);
    expect(request?.user).toEqual({ client_user_id: CLIENT_USER_ID });
    expect(JSON.stringify(request?.user)).not.toContain('@');
  });

  it('sends redirect_uri when one is configured and omits the key entirely when not', async () => {
    const withUri = harness();
    await withUri.connector.createLinkToken({ clientUserId: CLIENT_USER_ID });
    expect(linkRequests(withUri.api)[0]?.redirect_uri).toBe(
      'https://nuc.tailnet-fake.ts.net/link/oauth',
    );

    // D12: a LAN-only deployment has no browser-reachable HTTPS redirect. The
    // key must be *absent*, not null or empty — Plaid rejects an empty
    // `redirect_uri` with INVALID_FIELD, which fails linking outright.
    const without = harness({ settings: { redirectUri: null } });
    await without.connector.createLinkToken({ clientUserId: CLIENT_USER_ID });
    expect(linkRequests(without.api)[0]).not.toHaveProperty('redirect_uri');
  });

  it('omits webhook by default and sends it only when a URL is configured', async () => {
    // D12: polling is the ingestion path; webhooks are an optional compose
    // profile. Registering a URL we do not serve makes Plaid retry deliveries
    // into a black hole.
    const polling = harness();
    await polling.connector.createLinkToken({ clientUserId: CLIENT_USER_ID });
    expect(linkRequests(polling.api)[0]).not.toHaveProperty('webhook');
    expect(polling.connector.capabilities().supportsWebhooks).toBe(false);
    expect(polling.connector.capabilities().supports).not.toContain('webhooks');

    const pushed = harness({
      settings: { webhookUrl: 'https://nuc.tailnet-fake.ts.net/plaid/hook' },
    });
    await pushed.connector.createLinkToken({ clientUserId: CLIENT_USER_ID });
    expect(linkRequests(pushed.api)[0]?.webhook).toBe('https://nuc.tailnet-fake.ts.net/plaid/hook');
    expect(pushed.connector.capabilities().supportsWebhooks).toBe(true);
    expect(pushed.connector.capabilities().supports).toContain('webhooks');
  });
});

// ---------------------------------------------------------------------------
// /link/token/create, update mode
// ---------------------------------------------------------------------------

describe('pins: /link/token/create in update mode', () => {
  it('sends the access token and NO products, and returns nothing to re-seal', async () => {
    const { api, connector, handle } = harness();
    const token = await connector.createUpdateLinkToken(handle);

    const [request] = linkRequests(api);
    expect(request?.access_token).toBe(handle.secret('access_token'));
    // The pin. 01 §1.7: "Do not populate `products` during standard update
    // mode." A `products` array here re-initialises the Item's product set.
    expect(request).not.toHaveProperty('products');
    expect(request).not.toHaveProperty('transactions');

    // 01 §1.7: "the access_token does not change when using Link in update
    // mode, so there is no need to repeat the exchange token process" — so the
    // return carries a link token and no credential at all.
    expect(Object.keys(token).sort()).toEqual(['expiresAt', 'linkToken', 'requestId']);
    expect(api.countOf('item/public_token/exchange')).toBe(0);
  });

  it('leaves account selection off unless it is asked for explicitly', async () => {
    // 01 §1.7 warns that "any de-selected accounts will no longer be shared with
    // you", so a routine reauth must not be able to silently drop an account.
    const routine = harness();
    await routine.connector.createUpdateLinkToken(routine.handle);
    expect(linkRequests(routine.api)[0]).not.toHaveProperty('update');

    const newAccounts = harness();
    await newAccounts.connector.createUpdateLinkToken(newAccounts.handle, {
      accountSelectionEnabled: true,
    });
    expect(linkRequests(newAccounts.api)[0]?.update).toEqual({ account_selection_enabled: true });
  });
});

// ---------------------------------------------------------------------------
// /transactions/sync
// ---------------------------------------------------------------------------

function syncRequests(api: {
  requestsTo: (endpoint: string) => unknown[];
}): TransactionsSyncRequest[] {
  return api.requestsTo('transactions/sync') as TransactionsSyncRequest[];
}

describe('pins: /transactions/sync', () => {
  it('pins count, the PFC version, the original description and the window', async () => {
    const { api, connector, handle, options } = harness();
    await connector.syncTransactions(handle, null, options);

    const [request] = syncRequests(api);
    expect(request?.count).toBe(PLAID_MAX_PAGE_SIZE);
    expect(PLAID_MAX_PAGE_SIZE).toBe(500);
    expect(request?.options?.personal_finance_category_version).toBe(PLAID_PFC_VERSION);
    expect(PLAID_PFC_VERSION).toBe('v2');
    // The raw institution descriptor. It is what a CSV export of the same
    // account contains, and therefore what the cross-provider fingerprint keys
    // on (`map.ts`).
    expect(request?.options?.include_original_description).toBe(true);
    expect(request?.options?.days_requested).toBe(730);
  });

  it('omits cursor on the first call rather than sending null', async () => {
    // Plaid's contract is "if omitted, the entire history of updates will be
    // returned". An explicit `cursor: null` is a different request.
    const { api, connector, handle, options } = harness();
    const first = await connector.syncTransactions(handle, null, options);
    await connector.syncTransactions(handle, first.nextCursor, options);

    const [initial, second] = syncRequests(api);
    expect(initial).not.toHaveProperty('cursor');
    expect(second?.cursor).toBe('cursor-page-1');
  });

  it('clamps count to Plaid ceiling and history to 730, and never below 1', async () => {
    const clock = testClock();
    const { api, connector, handle } = harness();
    await connector.syncTransactions(
      handle,
      null,
      syncOptions(clock, { pageSize: 9_000, historyDays: 5_000 }),
    );
    await connector.syncTransactions(handle, null, syncOptions(clock, { pageSize: 0 }));

    const [big, tiny] = syncRequests(api);
    expect(big?.count).toBe(500);
    expect(big?.options?.days_requested).toBe(730);
    expect(tiny?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// /investments/transactions/get
// ---------------------------------------------------------------------------

describe('pins: /investments/transactions/get', () => {
  it('asks for a 730-day window ending today, in UTC, page 500 at a time', async () => {
    const { api, connector, handle, options, clock } = harness();
    await connector.syncInvestmentTransactions(handle, options);

    const [request] = api.requestsTo(
      'investments/transactions/get',
    ) as InvestmentsTransactionsGetRequest[];
    expect(request?.end_date).toBe(todayIn(clock, 'UTC'));
    expect(request?.end_date).toBe('2026-06-04');
    expect(request?.start_date).toBe('2024-06-04');
    expect(request?.options).toEqual({ count: 500, offset: 0 });
  });
});

// ---------------------------------------------------------------------------
// The transport pins
// ---------------------------------------------------------------------------

describe('pins: the client', () => {
  it('pins Plaid-Version on every request rather than inheriting the Dashboard default', () => {
    const headers = plaidRequestHeaders({
      clientId: 'client-id-fake',
      secret: 'secret-fake',
      environment: 'sandbox',
    });
    expect(headers['Plaid-Version']).toBe('2020-09-14');
    expect(headers['Plaid-Version']).toBe(PLAID_API_VERSION);
    expect(headers['PLAID-CLIENT-ID']).toBe('client-id-fake');
    expect(headers['PLAID-SECRET']).toBe('secret-fake');
    // Nothing else. A header we did not intend to send is a header nobody
    // reviewed.
    expect(Object.keys(headers).sort()).toEqual([
      'PLAID-CLIENT-ID',
      'PLAID-SECRET',
      'Plaid-Version',
    ]);
  });

  it('knows exactly two environments; "development" no longer exists (01 §1.2)', () => {
    expect(plaidBasePath('sandbox')).toBe('https://sandbox.plaid.com');
    expect(plaidBasePath('production')).toBe('https://production.plaid.com');
    // @ts-expect-error -- the type forbids it; this asserts the runtime does too
    expect(() => plaidBasePath('development')).toThrow(/unknown plaid environment/);
  });
});
