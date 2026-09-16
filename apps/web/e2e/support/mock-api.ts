// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * Mocks every REST/SSE call the walkthrough spec's screens make, entirely
 * client-side (`page.route`) — no live `apps/api`, no database. This suite
 * proves the *frontend* is wired correctly (the real contract shapes, the
 * real request/response cycle, real accessibility) in a real browser; a
 * live-backend walkthrough (real Postgres, real WebAuthn verification) is a
 * phase-level gate concern (see docs/evidence/phase-1/wp1.6-ui.md's "left
 * open" section), not this work package's e2e harness.
 *
 * Requests to anything other than the API paths below fall through to the
 * real dev server (JS bundles, CSS, fonts, the SPA's own HTML).
 */

const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'totp',
  trustedDevice: true,
  fresh: true,
  idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

const ACCOUNT = {
  id: 'acct_1',
  connectionId: 'conn_1',
  provider: 'manual',
  name: 'Everyday Checking',
  officialName: null,
  type: 'depository',
  subtype: null,
  classification: 'asset',
  currency: 'USD',
  mask: '4321',
  closedAt: null,
  includeInNetWorth: true,
  balance: {
    current: { minor: '542312', currency: 'USD' },
    available: null,
    limit: null,
    asOf: new Date().toISOString(),
    source: 'provider',
  },
};

const TRANSACTION = {
  id: 'txn_1',
  accountId: 'acct_1',
  factId: 'fact_1',
  date: new Date().toISOString().slice(0, 10),
  amount: { minor: '-1250', currency: 'USD' },
  name: 'Blue Bottle Coffee',
  merchantId: 'merch_1',
  merchantName: 'Blue Bottle Coffee',
  pending: false,
  excluded: false,
  categoryId: 'cat_dining',
  note: null,
  isTransfer: false,
  transferLinkId: null,
  refundOfId: null,
  refundConfidence: null,
  supersededById: null,
  supersededReason: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

/**
 * `GET /categories` (gate condition D-6, finding N-3).
 *
 * The re-gate's own note about this walkthrough was that "the mocked Playwright
 * walkthrough cannot see that because its mock serves a category list the real
 * API does not have" — which was true: the mock served nothing, so the
 * walkthrough's category step could only ever clear a category, and the empty
 * picker in the real deployment was invisible here. This shape is the one
 * `apps/api/src/routes/categories.ts` emits, including `assignable: false` on
 * the heading, so a picker that started offering headings would fail the
 * walkthrough rather than pass it.
 */
const CATEGORIES = [
  {
    id: 'cat_dining',
    key: 'dining',
    parentId: null,
    label: 'Dining',
    description: 'Eating out.',
    kind: 'expense',
    icon: 'utensils',
    sort: 100,
    isSystem: true,
    archivedAt: null,
    assignable: false,
  },
  {
    id: 'cat_dining_coffee',
    key: 'dining.coffee',
    parentId: 'cat_dining',
    label: 'Coffee Shops',
    description: 'Coffee and tea.',
    kind: 'expense',
    icon: 'coffee',
    sort: 101,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
  {
    id: 'cat_dining_restaurants',
    key: 'dining.restaurants',
    parentId: 'cat_dining',
    label: 'Restaurants',
    description: 'Sit-down meals.',
    kind: 'expense',
    icon: 'utensils',
    sort: 102,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
  {
    id: 'cat_uncategorised',
    key: 'uncategorised',
    parentId: null,
    label: 'Uncategorised',
    description: 'We do not know yet.',
    kind: 'other',
    icon: 'circle-help',
    sort: 900,
    isSystem: true,
    archivedAt: null,
    assignable: true,
  },
];

const MANUAL_CONNECTOR = {
  provider: 'manual',
  displayName: 'Manual account',
  description: 'An account you maintain yourself.',
  iconKey: 'pencil',
  linkKind: 'manual_entry',
  docsUrl: null,
  capabilities: {
    supports: ['accounts', 'balances', 'transactions'],
    historyWindowDays: 'unbounded',
    minSyncIntervalSeconds: 0,
    refreshBudgetPerDay: null,
    supportsWebhooks: false,
    reconnectFlow: 'none',
    consentWindowDays: null,
    currencies: 'multi',
  },
};

export interface MockApiState {
  authenticated: boolean;
  connections: unknown[];
  steppedUp: boolean;
  lastPatchBody: unknown;
  lastCreateConnectionBody: unknown;
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

export async function installApiMocks(page: Page): Promise<MockApiState> {
  const state: MockApiState = {
    authenticated: false,
    connections: [],
    steppedUp: false,
    lastPatchBody: null,
    lastCreateConnectionBody: null,
  };

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/auth/session') {
      if (!state.authenticated) {
        return route.fulfill(
          json({ code: 'unauthenticated', title: 'Unauthenticated', status: 401 }, 401),
        );
      }
      return route.fulfill(json(SESSION));
    }

    if (path === '/api/auth/login/options' && method === 'POST') {
      return route.fulfill(json({ options: {} }));
    }

    if (path === '/api/auth/totp/verify' && method === 'POST') {
      state.authenticated = true;
      return route.fulfill(json({ ok: true }));
    }

    if (path === '/api/auth/step-up/options' && method === 'POST') {
      // A minimal-but-valid PublicKeyCredentialRequestOptionsJSON:
      // `@simplewebauthn/browser`'s `startAuthentication` base64url-decodes
      // `challenge` before it ever calls `navigator.credentials.get` (see
      // `e2e/app-walkthrough.spec.ts`'s `installFakeWebAuthnAssertion`),
      // so this has to be real base64url, not a placeholder string.
      return route.fulfill(
        json({
          options: {
            challenge: 'dGVzdC1jaGFsbGVuZ2U',
            rpId: 'localhost',
            timeout: 60_000,
            userVerification: 'preferred',
          },
        }),
      );
    }

    if (path === '/api/auth/step-up/verify' && method === 'POST') {
      state.steppedUp = true;
      return route.fulfill(json({ freshUntil: new Date(Date.now() + 300_000).toISOString() }));
    }

    if (path === '/api/accounts' && method === 'GET') {
      return route.fulfill(json({ accounts: [ACCOUNT] }));
    }

    if (path === '/api/net-worth') {
      return route.fulfill(
        json({
          asOf: new Date().toISOString(),
          totals: [
            {
              currency: 'USD',
              assets: { minor: '542312', currency: 'USD' },
              liabilities: { minor: '0', currency: 'USD' },
              net: { minor: '542312', currency: 'USD' },
            },
          ],
          inputs: [],
        }),
      );
    }

    if (path === '/api/transactions' && method === 'GET') {
      return route.fulfill(
        json({ items: [TRANSACTION], nextCursor: null, summary: { count: 1, totals: [] } }),
      );
    }

    if (path === '/api/transactions/txn_1' && method === 'GET') {
      return route.fulfill(
        json({
          ...TRANSACTION,
          provenance: {
            factId: 'fact_1',
            provider: 'manual',
            providerTransactionId: 'p_1',
            pendingTransactionId: null,
            postedDate: TRANSACTION.date,
            authorizedDate: null,
            providerName: TRANSACTION.name,
            providerMerchantName: null,
            providerAmount: TRANSACTION.amount,
            paymentChannel: null,
            pending: false,
            revision: 1,
            firstSeenAt: TRANSACTION.createdAt,
            lastSeenAt: TRANSACTION.updatedAt,
            removedAt: null,
          },
          splits: [],
          transfer: null,
          removedAt: null,
        }),
      );
    }

    if (path === '/api/transactions/txn_1' && method === 'PATCH') {
      state.lastPatchBody = request.postDataJSON();
      return route.fulfill(json({ ...TRANSACTION, categoryId: null }));
    }

    if (path === '/api/categories' && method === 'GET') {
      return route.fulfill(json({ categories: CATEGORIES }));
    }

    if (path === '/api/connectors') {
      return route.fulfill(json({ connectors: [MANUAL_CONNECTOR] }));
    }

    if (path === '/api/connections' && method === 'GET') {
      return route.fulfill(json({ connections: state.connections }));
    }

    if (path === '/api/connections' && method === 'POST') {
      state.lastCreateConnectionBody = request.postDataJSON();
      if (!state.steppedUp) {
        return route.fulfill(
          json(
            {
              type: 'about:blank',
              title: 'Step-up required',
              status: 403,
              code: 'step_up_required',
              correlationId: 'corr_1',
            },
            403,
          ),
        );
      }
      state.connections = [
        {
          id: 'conn_new',
          provider: 'manual',
          displayName: 'Rental property',
          status: 'active',
          capabilities: MANUAL_CONNECTOR.capabilities,
          accountCount: 1,
          lastSyncedAt: null,
          consentExpiresAt: null,
          errorSince: null,
          lastErrorKind: null,
          createdAt: new Date().toISOString(),
        },
      ];
      return route.fulfill(
        json(
          {
            connectionId: 'conn_new',
            relinked: false,
            accountIds: ['acct_new'],
            syncJobId: null,
            syncRunId: null,
          },
          201,
        ),
      );
    }

    if (path === '/api/sync/stream' || path.endsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }

    return route.continue();
  });

  return state;
}
