// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

import {
  createMarketDataKeysState,
  createMarketDataRefreshState,
  handleMarketDataKeys,
  handleMarketDataRefresh,
  type MarketDataKeysMockState,
  type MarketDataRefreshMockState,
} from './mock-market-data-keys.ts';
import {
  createCategorySuggestionsState,
  handleCategorySuggestions,
  type CategorySuggestionsMockState,
} from './mock-category-suggestions.ts';
import { createNarratorState, handleNarrator, type NarratorMockState } from './mock-narrator.ts';

/**
 * Mocks every REST/SSE call the walkthrough spec's screens make, entirely
 * client-side (`page.route`) — no live `apps/api`, no database. This suite
 * proves the *frontend* is wired correctly (the real contract shapes, the
 * real request/response cycle, real accessibility) in a real browser; a
 * live-backend walkthrough (real Postgres, real WebAuthn verification) is a
 * phase-level gate concern (see docs/evidence/phase-1/wp1.6-ui.md's "left
 * open" section), not this work package's e2e harness.
 *
 * WP 2.11 extends this with an in-memory transaction/rule/transfer/
 * notification store so `app-walkthrough.spec.ts`, `inbox.spec.ts`,
 * `splits.spec.ts`, `rule-from-transaction.spec.ts`, `category-filter.spec.ts`
 * and `notification-settings.spec.ts` can all drive real mutations against a
 * consistent, queryable fixture rather than one hard-coded response per path.
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

const ACCOUNT_2 = {
  id: 'acct_2',
  connectionId: 'conn_1',
  provider: 'manual',
  name: 'Savings',
  officialName: null,
  type: 'depository',
  subtype: null,
  classification: 'asset',
  currency: 'USD',
  mask: '9911',
  closedAt: null,
  includeInNetWorth: true,
  balance: {
    current: { minor: '1200000', currency: 'USD' },
    available: null,
    limit: null,
    asOf: new Date().toISOString(),
    source: 'provider',
  },
};

interface MockTransaction {
  id: string;
  accountId: string;
  factId: string;
  date: string;
  amount: { minor: string; currency: string };
  name: string;
  merchantId: string | null;
  merchantName: string | null;
  pending: boolean;
  excluded: boolean;
  categoryId: string | null;
  /** WP 11.2b: which tier the category came from; absent = the holder's pick when a category is set. */
  categorySource?: 'user' | 'rule' | 'auto' | null;
  /** WP 11.2b: the provenance of an automatic placement (`categorySource: 'auto'`). */
  autoCategory?: { tier: string; confidence: number; decidedAt: string } | null;
  note: string | null;
  isTransfer: boolean;
  transferLinkId: string | null;
  refundOfId: null;
  refundConfidence: null;
  supersededById: null;
  supersededReason: null;
  createdAt: string;
  updatedAt: string;
  splits: Array<{
    id: string;
    position: number;
    amount: { minor: string; currency: string };
    userCategoryId: string | null;
    note: string | null;
  }>;
}

const today = new Date().toISOString().slice(0, 10);

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function makeTransaction(
  overrides: Partial<MockTransaction> & Pick<MockTransaction, 'id'>,
): MockTransaction {
  return {
    accountId: 'acct_1',
    factId: `fact_${overrides.id}`,
    date: today,
    amount: { minor: '-1250', currency: 'USD' },
    name: 'Row',
    merchantId: null,
    merchantName: null,
    pending: false,
    excluded: false,
    categoryId: null,
    note: null,
    isTransfer: false,
    transferLinkId: null,
    refundOfId: null,
    refundConfidence: null,
    supersededById: null,
    supersededReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    splits: [],
    ...overrides,
  };
}

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
    id: 'cat_groceries',
    key: 'groceries',
    parentId: null,
    label: 'Groceries',
    description: 'Food at home.',
    kind: 'expense',
    icon: 'shopping-cart',
    sort: 200,
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

export const MANUAL_CONNECTOR = {
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
  lastSplitsBody: unknown;
  lastRuleCreateBody: unknown;
  lastRuleApplyBody: unknown;
  lastTransferPairBody: unknown;
  lastNotificationTestChannelId: string | null;
  /** WP 10.4: Settings › Market data's key cards (`mock-market-data-keys.ts`). */
  marketDataKeys: MarketDataKeysMockState;
  /** WP 10.5: `POST /market-data/refresh` ("Refresh prices"), `mock-market-data-keys.ts`. */
  marketDataRefresh: MarketDataRefreshMockState;
  /** WP 10.6: Settings › Language model (`mock-narrator.ts`). */
  narrator: NarratorMockState;
  /** WP 11.2: Settings › Language model › Category suggestions (`mock-category-suggestions.ts`). */
  categorySuggestions: CategorySuggestionsMockState;
  /** WP 11.2b: the Inbox's "Auto-categorised, unreviewed" switch (`/api/inbox/preferences`), and what was saved. */
  inboxPreferences: { showAutoReview: boolean; puts: Array<{ showAutoReview: boolean }> };
  /** WP 11.2b: adds a transaction to the general fixture (an automatic placement, say). */
  addTransaction(overrides: Record<string, unknown> & { id: string }): void;
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function matchesAmountRange(amountMinor: bigint, min?: string, max?: string): boolean {
  if (min !== undefined && amountMinor < BigInt(min)) return false;
  if (max !== undefined && amountMinor > BigInt(max)) return false;
  return true;
}

export async function installApiMocks(page: Page): Promise<MockApiState> {
  const state: MockApiState = {
    authenticated: false,
    connections: [],
    steppedUp: false,
    lastPatchBody: null,
    lastCreateConnectionBody: null,
    lastSplitsBody: null,
    lastRuleCreateBody: null,
    lastRuleApplyBody: null,
    lastTransferPairBody: null,
    lastNotificationTestChannelId: null,
    marketDataKeys: createMarketDataKeysState(),
    marketDataRefresh: createMarketDataRefreshState(),
    narrator: createNarratorState(),
    categorySuggestions: createCategorySuggestionsState(),
    inboxPreferences: { showAutoReview: true, puts: [] },
    addTransaction: () => undefined,
  };

  const transactions = new Map<string, MockTransaction>([
    [
      'txn_1',
      makeTransaction({
        id: 'txn_1',
        accountId: 'acct_1',
        date: today,
        amount: { minor: '-1250', currency: 'USD' },
        name: 'Blue Bottle Coffee',
        merchantId: 'merch_1',
        merchantName: 'Blue Bottle Coffee',
        categoryId: null,
      }),
    ],
    [
      'txn_2',
      makeTransaction({
        id: 'txn_2',
        accountId: 'acct_1',
        date: daysAgo(1),
        amount: { minor: '-3400', currency: 'USD' },
        name: 'Farmers Market',
        merchantId: 'merch_2',
        merchantName: 'Farmers Market',
        categoryId: null,
      }),
    ],
    [
      'txn_out',
      makeTransaction({
        id: 'txn_out',
        accountId: 'acct_1',
        date: daysAgo(2),
        amount: { minor: '-20000', currency: 'USD' },
        name: 'Transfer to Savings',
        merchantId: null,
        merchantName: null,
        categoryId: null,
      }),
    ],
    [
      'txn_in',
      makeTransaction({
        id: 'txn_in',
        accountId: 'acct_2',
        date: daysAgo(2),
        amount: { minor: '20000', currency: 'USD' },
        name: 'Transfer from Checking',
        merchantId: null,
        merchantName: null,
        categoryId: null,
      }),
    ],
  ]);

  state.addTransaction = (overrides) => {
    transactions.set(
      overrides.id,
      makeTransaction(overrides as Partial<MockTransaction> & { id: string }),
    );
  };

  interface MockRule {
    id: string;
    name: string;
    priority: number;
    enabled: boolean;
    conditions: { all: unknown[]; any: unknown[] };
    actions: Array<{ type: string; categoryKey?: string }>;
    runOnSync: boolean;
    stopProcessing: boolean;
    createdFromTransactionId: string | null;
    lastAppliedAt: string | null;
    lastAppliedCount: number;
    createdAt: string;
    updatedAt: string;
  }
  const rules = new Map<string, MockRule>();
  let ruleSeq = 0;

  interface MockChannel {
    id: string;
    kind: string;
    displayName: string;
    enabled: boolean;
    destination: string;
    lastTestResult: { ok: boolean; message: string; testedAt: string } | null;
  }
  const channels = new Map<string, MockChannel>();

  function transactionResponse(t: MockTransaction) {
    return {
      id: t.id,
      accountId: t.accountId,
      factId: t.factId,
      date: t.date,
      amount: t.amount,
      name: t.name,
      merchantId: t.merchantId,
      merchantName: t.merchantName,
      pending: t.pending,
      excluded: t.excluded,
      categoryId: t.categoryId,
      // WP 11.2b
      categorySource: t.categorySource ?? (t.categoryId === null ? null : 'user'),
      autoCategory: t.autoCategory ?? null,
      note: t.note,
      isTransfer: t.isTransfer,
      transferLinkId: t.transferLinkId,
      refundOfId: t.refundOfId,
      refundConfidence: t.refundConfidence,
      supersededById: t.supersededById,
      supersededReason: t.supersededReason,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
  }

  function transactionDetailResponse(t: MockTransaction) {
    return {
      ...transactionResponse(t),
      provenance: {
        factId: t.factId,
        provider: 'manual',
        providerTransactionId: `p_${t.id}`,
        pendingTransactionId: null,
        postedDate: t.date,
        authorizedDate: null,
        providerName: t.name,
        providerMerchantName: null,
        providerAmount: t.amount,
        paymentChannel: null,
        pending: t.pending,
        revision: 1,
        firstSeenAt: t.createdAt,
        lastSeenAt: t.updatedAt,
        removedAt: null,
      },
      splits: t.splits,
      transfer: null,
      removedAt: null,
    };
  }

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    // WP 10.4: the market-data key cards (GET per provider; PUT/DELETE behind the step-up).
    if (
      await handleMarketDataKeys(route, path, method, state.marketDataKeys, () => state.steppedUp)
    ) {
      return;
    }

    // WP 10.5: Refresh prices (accepted once, then the api's ten-minute 409).
    if (await handleMarketDataRefresh(route, path, method, state.marketDataRefresh)) return;

    // WP 10.6: Settings › Language model (GET; every write but Test behind the step-up).
    if (await handleNarrator(route, path, method, state.narrator, () => state.steppedUp)) return;

    // WP 11.2: the category-suggestion settings (GET; every write behind the step-up).
    if (
      await handleCategorySuggestions(
        route,
        path,
        method,
        state.categorySuggestions,
        () => state.steppedUp,
      )
    ) {
      return;
    }

    if (path === '/api/auth/session') {
      if (!state.authenticated) {
        return route.fulfill(
          json({ code: 'unauthenticated', title: 'Unauthenticated', status: 401 }, 401),
        );
      }
      return route.fulfill(json(SESSION));
    }

    // WP 9.1 (09 §4 batch 10): the dashboard's backup-status line. Unmocked it
    // reads as a quiet "Backup status unknown"; mocked, a screenshot is
    // deterministic.
    // WP 10.1: the Add connection dialog's Plaid path reads the stored-credentials
    // status; unmocked it would fall through to the Vite proxy and the tab would
    // vanish from the a11y sweep.
    if (path === '/api/connections/providers/plaid/credentials' && method === 'GET') {
      return route.fulfill(
        json({
          configured: false,
          source: 'none',
          env: null,
          clientIdHint: null,
          rotatedAt: null,
          productionAllowed: false,
        }),
      );
    }

    if (path === '/api/ops/backup-status' && method === 'GET') {
      return route.fulfill(
        json({
          lastAttemptStatus: 'ok',
          lastAttemptAt: '2026-10-20T08:00:00.000Z',
          lastSuccessfulBackupAt: '2026-10-20T08:00:00.000Z',
          lastSuccessfulBackupAgeSeconds: 14_400,
          backupOverdue: false,
          lastDrillVerdict: 'pass',
          lastDrillAt: '2026-10-13T10:00:00.000Z',
          lastDrillAgeDays: 7,
          drillOverdue: false,
        }),
      );
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
      return route.fulfill(json({ accounts: [ACCOUNT, ACCOUNT_2] }));
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

    if (path === '/api/inbox/preferences') {
      if (method === 'PUT') {
        const body = request.postDataJSON() as { showAutoReview: boolean };
        state.inboxPreferences.showAutoReview = body.showAutoReview;
        state.inboxPreferences.puts.push({ showAutoReview: body.showAutoReview });
      }
      return route.fulfill(json({ showAutoReview: state.inboxPreferences.showAutoReview }));
    }

    if (path === '/api/transactions' && method === 'GET') {
      const q = url.searchParams;
      let items = [...transactions.values()];

      const uncategorized = q.get('uncategorized');
      if (uncategorized === 'true') items = items.filter((t) => t.categoryId === null);

      // WP 11.2b: the Inbox's review rows are the ones an automatic tier placed.
      if (q.get('autoReview') === 'true') items = items.filter((t) => t.categorySource === 'auto');

      const transfers = q.get('transfers');
      if (transfers === 'exclude') items = items.filter((t) => !t.isTransfer);
      else if (transfers === 'only') items = items.filter((t) => t.isTransfer);

      const categoryIds = q.getAll('categoryIds');
      if (categoryIds.length > 0) {
        items = items.filter((t) => t.categoryId !== null && categoryIds.includes(t.categoryId));
      }

      const accountIds = q.getAll('accountIds');
      if (accountIds.length > 0) items = items.filter((t) => accountIds.includes(t.accountId));

      const amountMin = q.get('amountMin') ?? undefined;
      const amountMax = q.get('amountMax') ?? undefined;
      if (amountMin !== undefined || amountMax !== undefined) {
        items = items.filter((t) =>
          matchesAmountRange(BigInt(t.amount.minor), amountMin, amountMax),
        );
      }

      const from = q.get('from');
      const to = q.get('to');
      if (from !== null) items = items.filter((t) => t.date >= from);
      if (to !== null) items = items.filter((t) => t.date <= to);

      return route.fulfill(
        json({
          items: items.map(transactionResponse),
          nextCursor: null,
          summary: { count: items.length, totals: [] },
        }),
      );
    }

    const transactionDetailMatch = /^\/api\/transactions\/([^/]+)$/.exec(path);
    if (transactionDetailMatch && method === 'GET') {
      const t = transactions.get(transactionDetailMatch[1]!);
      if (t === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      return route.fulfill(json(transactionDetailResponse(t)));
    }

    if (transactionDetailMatch && method === 'PATCH') {
      const t = transactions.get(transactionDetailMatch[1]!);
      if (t === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      const patch = request.postDataJSON() as Record<string, unknown>;
      state.lastPatchBody = patch;
      Object.assign(t, patch);
      // WP 11.2b: a category the holder just picked is theirs, and carries no chip.
      if (typeof patch['categoryId'] === 'string') {
        t.categorySource = 'user';
        t.autoCategory = null;
      }
      return route.fulfill(json(transactionResponse(t)));
    }

    const splitsMatch = /^\/api\/transactions\/([^/]+)\/splits$/.exec(path);
    if (splitsMatch && method === 'POST') {
      const t = transactions.get(splitsMatch[1]!);
      if (t === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      const body = request.postDataJSON() as {
        splits: Array<{
          amount: { minor: string; currency: string };
          userCategoryId: string | null;
          note: string | null;
        }>;
      };
      state.lastSplitsBody = body;
      const total = BigInt(t.amount.minor);
      const sum = body.splits.reduce((acc, s) => acc + BigInt(s.amount.minor), 0n);
      if (sum !== total) {
        return route.fulfill(
          json(
            {
              type: 'about:blank',
              title: 'Splits do not sum',
              status: 422,
              code: 'ledger.splits_do_not_sum',
              correlationId: 'corr_splits',
            },
            422,
          ),
        );
      }
      t.splits = body.splits.map((s, index) => ({
        id: `split_${t.id}_${String(index)}`,
        position: index,
        amount: s.amount,
        userCategoryId: s.userCategoryId,
        note: s.note,
      }));
      return route.fulfill(json({ splits: t.splits }));
    }

    if (splitsMatch && method === 'DELETE') {
      const t = transactions.get(splitsMatch[1]!);
      if (t !== undefined) t.splits = [];
      return route.fulfill(json({ deleted: true }));
    }

    const ruleFromTxnMatch = /^\/api\/transactions\/([^/]+)\/rule$/.exec(path);
    if (ruleFromTxnMatch && method === 'POST') {
      const body = request.postDataJSON() as { categoryKey: string; name?: string };
      state.lastRuleCreateBody = body;
      ruleSeq += 1;
      const id = `rule_${String(ruleSeq)}`;
      const rule: MockRule = {
        id,
        name: body.name ?? `Rule ${String(ruleSeq)}`,
        priority: 100,
        enabled: true,
        conditions: { all: [], any: [] },
        actions: [{ type: 'set_category', categoryKey: body.categoryKey }],
        runOnSync: true,
        stopProcessing: false,
        createdFromTransactionId: ruleFromTxnMatch[1]!,
        lastAppliedAt: null,
        lastAppliedCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      rules.set(id, rule);
      return route.fulfill(json({ rule }, 201));
    }

    if (path === '/api/rules' && method === 'GET') {
      return route.fulfill(json({ rules: [...rules.values()] }));
    }

    if (path === '/api/rules/preview' && method === 'POST') {
      const body = request.postDataJSON() as { ruleId: string };
      return route.fulfill(
        json({
          ruleId: body.ruleId,
          runId: 'run_preview',
          preview: true,
          matchedCount: 2,
          changedCount: 2,
          sample: [],
          actionsRecorded: [],
        }),
      );
    }

    const applyMatch = /^\/api\/rules\/([^/]+)\/apply$/.exec(path);
    if (applyMatch && method === 'POST') {
      state.lastRuleApplyBody = request.postDataJSON();
      const rule = rules.get(applyMatch[1]!);
      if (rule !== undefined) {
        rule.lastAppliedAt = new Date().toISOString();
        rule.lastAppliedCount = 2;
      }
      // The same count `preview` reported — this is the exit test's own
      // assertion ("the preview count matches the count after apply").
      return route.fulfill(
        json({
          ruleId: applyMatch[1],
          runId: 'run_apply',
          preview: false,
          matchedCount: 2,
          changedCount: 2,
          sample: [],
          actionsRecorded: [],
        }),
      );
    }

    if (path === '/api/transfers/pair' && method === 'POST') {
      const body = request.postDataJSON() as {
        outflowTransactionId: string;
        inflowTransactionId: string;
      };
      state.lastTransferPairBody = body;
      const linkId = 'link_1';
      const out = transactions.get(body.outflowTransactionId);
      const inflow = transactions.get(body.inflowTransactionId);
      if (out !== undefined) {
        out.isTransfer = true;
        out.transferLinkId = linkId;
      }
      if (inflow !== undefined) {
        inflow.isTransfer = true;
        inflow.transferLinkId = linkId;
      }
      return route.fulfill(json({ transferLinkId: linkId }));
    }

    const rejectMatch = /^\/api\/transfers\/([^/]+)\/reject$/.exec(path);
    if (rejectMatch && method === 'POST') {
      return route.fulfill(json({ unlinked: true }));
    }

    if (path === '/api/categories' && method === 'GET') {
      return route.fulfill(json({ categories: CATEGORIES }));
    }

    if (path === '/api/notifications/channels' && method === 'GET') {
      return route.fulfill(json({ channels: [...channels.values()] }));
    }

    if (path === '/api/notifications/channels' && method === 'POST') {
      const body = request.postDataJSON() as {
        kind: string;
        displayName: string;
        destination: string;
      };
      const id = `chan_${String(channels.size + 1)}`;
      const channel: MockChannel = { id, ...body, enabled: true, lastTestResult: null };
      channels.set(id, channel);
      return route.fulfill(json({ channel }, 201));
    }

    // `/verify`, not `/test`: `apps/api/src/routes/notifications.ts`'s real
    // route (operationId `verifyNotificationChannel`) is what the generated
    // SDK's `verifyNotificationChannel()` actually calls
    // (`src/features/notifications/api-pending.ts`'s `sendTestNotification`)
    // — the WP 2.11 stub's own guessed `/test` path this mock was originally
    // written against never existed on the wire once WP 2.r's real route
    // landed. Left unmatched, this fell through to `route.continue()`
    // against the bare Vite dev server (no `/api` backend of its own), so
    // `notification-settings.spec.ts`'s `page.waitForResponse` predicate for
    // `/test$` never matched anything and timed out at 30s on every
    // attempt — deterministic on any runner, not a CI-only flake.
    const testChannelMatch = /^\/api\/notifications\/channels\/([^/]+)\/verify$/.exec(path);
    if (testChannelMatch && method === 'POST') {
      state.lastNotificationTestChannelId = testChannelMatch[1]!;
      const channel = channels.get(testChannelMatch[1]!);
      const result = {
        ok: true,
        message: `Delivered to ${channel?.displayName ?? 'channel'}`,
        testedAt: new Date().toISOString(),
      };
      if (channel !== undefined) channel.lastTestResult = result;
      return route.fulfill(json({ result }));
    }

    if (path === '/api/notifications/rules' && method === 'GET') {
      return route.fulfill(json({ rules: [] }));
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

    // WP 10.3: the Activity tab and the by-management comparison, answered as
    // an install with no investment activity would answer them. The screen's
    // own fixtures (a Sandbox-shaped portfolio) are `mock-investments.ts`'s.
    if (path === '/api/investments/transactions' && method === 'GET') {
      return route.fulfill(
        json({
          from: url.searchParams.get('from') ?? '2025-10-14',
          to: url.searchParams.get('to') ?? '2026-10-13',
          items: [],
          nextCursor: null,
          total: 0,
          accounts: [],
        }),
      );
    }
    if (path === '/api/investments/performance/by-management' && method === 'GET') {
      return route.fulfill(
        json({
          from: url.searchParams.get('from') ?? '2025-10-13',
          to: '2026-10-13',
          currency: 'USD',
          rows: [],
        }),
      );
    }

    if (path === '/api/sync/stream' || path.endsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }

    return route.fallback();
  });

  return state;
}
