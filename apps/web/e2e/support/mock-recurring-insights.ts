// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

import { createExplainState, handleExplain } from './mock-explain.ts';

/**
 * A self-contained network mock for `recurring-insights.spec.ts`, entirely
 * separate from `e2e/support/mock-api.ts` (WP 2.10's own instructions: this
 * WP does not edit that shared file or `app-walkthrough.spec.ts` — the same
 * collision-avoidance reasoning `mock-api.ts`'s own header gives for why
 * WP 2.11 extended it in place rather than forking it, applied the other
 * direction here to keep two concurrently-built work packages' e2e fixtures
 * from touching the same file). Mocks every REST call this suite's screens
 * make: login, the app shell's sync pill, `/recurring/*`, `/insights/*` and
 * `/advisors/*`, plus a small `/transactions` + `/categories` fixture so a
 * click-through from an evidence panel lands on a real, filterable
 * transaction rather than a 404.
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

const CATEGORIES = [
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

interface MockCandidate {
  candidateId: string;
  seriesId: string | null;
  merchantId: string;
  streamKey: string;
  cadence: string;
  type: string;
  confidence: number;
  amount: { minor: string; currency: string };
  proposedAt: string;
}

interface MockSeries {
  id: string;
  streamKey: string;
  merchantId: string;
  state: string;
  status: string;
  userConfirmed: boolean;
  cadence: string;
  type: string;
  sign: 'OUTFLOW' | 'INFLOW';
  confidence: number;
  typicalAmount: { minor: string; currency: string };
  observedMin: { minor: string; currency: string };
  observedMax: { minor: string; currency: string };
  nextDueDate: string | null;
  firstSeen: string;
  lastSeen: string;
  duplicateNode: string | null;
}

interface MockInsight {
  id: string;
  advisorId: string;
  key: string;
  period: string;
  type: string;
  severity: string;
  severityClamped: boolean;
  title: string;
  summaryMd: string;
  confidence: number;
  confidenceBasis: string;
  horizon: string;
  status: 'pending_review' | 'accepted' | 'dismissed' | 'snoozed';
  annualizedImpact: { minor: string; currency: string } | null;
  oneTimeImpact: { minor: string; currency: string } | null;
  impactBasis: string;
  caveats: string[];
  inputDigest: string;
  firstProposedAt: string;
  lastProposedAt: string;
  expiresAt: string | null;
  evidence: Array<{
    position: number;
    kind: string;
    label: string;
    value: string | null;
    sourceRef: string | null;
    resolvedDisplay: string | null;
    href: string | null;
  }>;
  actions: Array<{
    position: number;
    kind: string;
    label: string;
    rationaleMd: string;
    url: string | null;
  }>;
  /** WP 10.15: the card's persisted state and its mentions. Absent = none; filled in by `wire()`. */
  bookmarkedAt?: string | null;
  feedback?: 'helpful' | 'not_helpful' | null;
  feedbackReason?: string | null;
  mentions?: Array<{
    text: string;
    entityType: string;
    entityId: string;
    evidencePosition: number;
  }>;
  titleSegments?: Array<{ text: string; entityType?: string; entityId?: string }>;
  bodySegments?: Array<{ text: string; entityType?: string; entityId?: string }>;
  contextLine?: Array<{ text: string; entityType?: string; entityId?: string }> | null;
}

/**
 * WP 10.15: an insight as `GET /insights` serves it — the card fields default to "nothing bookmarked, nothing
 * answered, no mentions" (title and body as one plain segment each), exactly what the api sends for an insight
 * whose evidence cites no entity.
 */
function wire(insight: MockInsight): Required<MockInsight> {
  return {
    bookmarkedAt: null,
    feedback: null,
    feedbackReason: null,
    mentions: [],
    titleSegments: [{ text: insight.title }],
    bodySegments: [{ text: insight.summaryMd }],
    contextLine: null,
    ...insight,
  };
}

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
  note: string | null;
  isTransfer: boolean;
  transferLinkId: string | null;
  refundOfId: null;
  refundConfidence: null;
  supersededById: null;
  supersededReason: null;
  createdAt: string;
  updatedAt: string;
}

/** Display names for the forecast's payees (WP 10.7), answered only to a `merchantIds` lookup. */
const RECURRING_PAYEES: ReadonlyArray<readonly [string, string]> = [
  ['merch_rent', 'Maple Court Rent'],
  ['merch_power', 'City Power'],
  ['merch_phone', 'Fernwave Mobile'],
  ['merch_water', 'Metro Water'],
  ['merch_cashback', 'Card Cashback'],
  ['merch_spotify', 'Spotify'],
  ['merch_uber', 'Uber'],
];

function payeeTransaction(merchantId: string, name: string): MockTransaction {
  return {
    id: `txn_${merchantId}`,
    accountId: 'acct_1',
    factId: `fact_${merchantId}`,
    date: '2026-05-01',
    amount: { minor: '-1000', currency: 'USD' },
    name,
    merchantId,
    merchantName: name,
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
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
  };
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/** One `RecurringProjectedCharge`, signed as the route sends it (an outflow is negative). */
function projected(
  seriesId: string,
  merchantId: string,
  sign: 'OUTFLOW' | 'INFLOW',
  date: string,
  expected: number,
  low: number,
  high: number,
) {
  const usd = (minor: number) => ({ minor: String(minor), currency: 'USD' });
  return {
    seriesId,
    streamKey: `${merchantId}:${sign}:USD:0:2026-01-01`,
    merchantId,
    type: 'SUBSCRIPTION',
    cadence: 'MONTHLY',
    sign,
    status: 'ACTIVE',
    userConfirmed: true,
    confidence: 0.9,
    slot: 0,
    date,
    earliest: date,
    latest: date,
    uncertaintyDays: 1,
    expected: usd(expected),
    low: usd(low),
    high: usd(high),
  };
}

export interface MockRecurringInsightsState {
  authenticated: boolean;
  lastConfirmBody: unknown;
  lastRejectBody: unknown;
  lastReviewBody: unknown;
  /** WP 10.15: the last `POST /insights/{id}/feedback` body. */
  lastFeedbackBody: unknown;
}

export async function installRecurringInsightsMocks(
  page: Page,
): Promise<MockRecurringInsightsState> {
  const state: MockRecurringInsightsState = {
    authenticated: false,
    lastConfirmBody: null,
    lastRejectBody: null,
    lastReviewBody: null,
    lastFeedbackBody: null,
  };

  const candidates = new Map<string, MockCandidate>([
    [
      'cand_netflix',
      {
        candidateId: 'cand_netflix',
        seriesId: null,
        merchantId: 'merch_netflix',
        streamKey: 'merch_netflix:OUTFLOW:USD:0:2026-01-01',
        cadence: 'MONTHLY',
        type: 'SUBSCRIPTION',
        confidence: 0.7,
        amount: { minor: '1899', currency: 'USD' },
        proposedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
    [
      'cand_gym',
      {
        candidateId: 'cand_gym',
        seriesId: null,
        merchantId: 'merch_gym',
        streamKey: 'merch_gym:OUTFLOW:USD:0:2026-01-01',
        cadence: 'MONTHLY',
        type: 'SUBSCRIPTION',
        confidence: 0.65,
        amount: { minor: '4500', currency: 'USD' },
        proposedAt: '2026-06-01T00:00:00.000Z',
      },
    ],
  ]);

  const series = new Map<string, MockSeries>([
    [
      'series_spotify',
      {
        id: 'series_spotify',
        streamKey: 'merch_spotify:OUTFLOW:USD:0:2026-01-01',
        merchantId: 'merch_spotify',
        state: 'ACTIVE',
        status: 'ACTIVE',
        userConfirmed: true,
        cadence: 'MONTHLY',
        type: 'SUBSCRIPTION',
        sign: 'OUTFLOW',
        confidence: 0.95,
        typicalAmount: { minor: '999', currency: 'USD' },
        observedMin: { minor: '999', currency: 'USD' },
        observedMax: { minor: '999', currency: 'USD' },
        nextDueDate: '2026-07-01',
        firstSeen: '2026-01-01',
        lastSeen: '2026-06-01',
        duplicateNode: null,
      },
    ],
  ]);

  const dismissals = new Map<string, number>();

  const insights = new Map<string, MockInsight>([
    [
      'insight_price',
      {
        id: 'insight_price',
        advisorId: 'builtin.subscriptions.price_increase',
        key: 'subscription.price_increase.merch_netflix.2026-06-01',
        period: '2026-06',
        type: 'subscription.price_increase',
        severity: 'notable',
        severityClamped: false,
        title: 'A subscription went up in price',
        summaryMd: 'Netflix went from $15.99 to $18.99 a month — about $36.00 more a year.',
        confidence: 0.95,
        confidenceBasis: 'deterministic',
        horizon: 'this_year',
        status: 'pending_review',
        annualizedImpact: { minor: '3600', currency: 'USD' },
        oneTimeImpact: null,
        impactBasis: 'The monthly increase, annualized.',
        caveats: [],
        inputDigest: 'sha256:mock1',
        firstProposedAt: '2026-06-02T00:00:00.000Z',
        lastProposedAt: '2026-06-02T00:00:00.000Z',
        expiresAt: null,
        evidence: [
          {
            position: 0,
            kind: 'metric',
            label: 'New monthly price',
            value: '$18.99',
            sourceRef: 'snapshot:recurring_list.streams[0].typical_amount',
            resolvedDisplay: '$18.99',
            href: null,
          },
        ],
        actions: [
          {
            position: 0,
            kind: 'suggest_only',
            label: 'Consider whether the new price is still worth it',
            rationaleMd: '',
            url: null,
          },
        ],
      },
    ],
    [
      'insight_duplicate_charge',
      {
        id: 'insight_duplicate_charge',
        advisorId: 'builtin.spending.duplicate_charge',
        key: 'spending.duplicate_charge.txn_cafe_1.txn_cafe_2', // gitleaks:allow — an insight dedupe key, not a credential
        period: '2026-06',
        type: 'spending.duplicate_charge',
        severity: 'urgent',
        severityClamped: false,
        title: 'Possible duplicate charge',
        summaryMd:
          'Two outgoing charges at CafeSprocket Coffee landed within a few days of each other, both around $54.00.',
        confidence: 0.8,
        confidenceBasis: 'deterministic',
        horizon: 'immediate',
        status: 'pending_review',
        annualizedImpact: null,
        oneTimeImpact: { minor: '5400', currency: 'USD' },
        impactBasis: 'The amount of the second, possibly-duplicate charge.',
        caveats: ['This could be two genuine visits — check before disputing anything.'],
        inputDigest: 'sha256:mock2',
        firstProposedAt: '2026-06-07T00:00:00.000Z',
        lastProposedAt: '2026-06-07T00:00:00.000Z',
        expiresAt: null,
        evidence: [
          {
            position: 0,
            kind: 'transaction',
            label: 'Second charge at CafeSprocket Coffee',
            value: '$54.00',
            sourceRef: 'snapshot:transactions_raw.rows[1]',
            resolvedDisplay: '$54.00',
            href: '/transactions?q=CafeSprocket',
          },
        ],
        actions: [],
      },
    ],
    [
      // WP 10.15: an insight whose evidence cites a category by id, so its card names the category and links to
      // it (`cat_groceries`, the Cash Flow and categories mocks' Groceries).
      'insight_groceries',
      {
        id: 'insight_groceries',
        advisorId: 'builtin.spending.category_creep',
        key: 'spending.category_creep.cat_groceries',
        period: '2026-06',
        type: 'spending.category_creep',
        severity: 'notable',
        severityClamped: false,
        title: 'Groceries has been running higher than usual',
        summaryMd: 'Groceries has run about $420.00 a month lately, against $350.00 before.',
        confidence: 1,
        confidenceBasis: 'deterministic',
        horizon: 'this_year',
        status: 'pending_review',
        annualizedImpact: { minor: '84000', currency: 'USD' },
        oneTimeImpact: null,
        impactBasis:
          'The gap between a three-month average and the six-month average before it, annualised.',
        caveats: [],
        inputDigest: 'sha256:mock3',
        firstProposedAt: '2026-06-03T00:00:00.000Z',
        lastProposedAt: '2026-06-03T00:00:00.000Z',
        expiresAt: null,
        evidence: [
          {
            position: 0,
            kind: 'metric',
            label: 'The category',
            value: null,
            sourceRef: 'snapshot:spending_summary.by_category_month[3].category_ref',
            resolvedDisplay: 'cat_groceries',
            href: null,
          },
          {
            position: 1,
            kind: 'metric',
            label: 'A recent month',
            value: '$420.00',
            sourceRef: 'snapshot:spending_summary.by_category_month[3].amount.minor',
            resolvedDisplay: '$420.00',
            href: null,
          },
        ],
        actions: [],
        mentions: [
          {
            text: 'Groceries',
            entityType: 'category',
            entityId: 'cat_groceries',
            evidencePosition: 0,
          },
        ],
        titleSegments: [
          { text: 'Groceries', entityType: 'category', entityId: 'cat_groceries' },
          { text: ' has been running higher than usual' },
        ],
        bodySegments: [
          { text: 'Groceries', entityType: 'category', entityId: 'cat_groceries' },
          { text: ' has run about $420.00 a month lately, against $350.00 before.' },
        ],
        contextLine: [
          { text: 'About ' },
          { text: 'Groceries', entityType: 'category', entityId: 'cat_groceries' },
        ],
      },
    ],
  ]);

  const transactions = new Map<string, MockTransaction>([
    [
      'txn_cafe_1',
      {
        id: 'txn_cafe_1',
        accountId: 'acct_1',
        factId: 'fact_cafe_1',
        date: '2026-06-04',
        amount: { minor: '-5400', currency: 'USD' },
        name: 'CafeSprocket Coffee',
        merchantId: 'merch_cafe',
        merchantName: 'CafeSprocket Coffee',
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
        createdAt: '2026-06-04T00:00:00.000Z',
        updatedAt: '2026-06-04T00:00:00.000Z',
      },
    ],
    [
      'txn_cafe_2',
      {
        id: 'txn_cafe_2',
        accountId: 'acct_1',
        factId: 'fact_cafe_2',
        date: '2026-06-06',
        amount: { minor: '-5400', currency: 'USD' },
        name: 'CafeSprocket Coffee',
        merchantId: 'merch_cafe',
        merchantName: 'CafeSprocket Coffee',
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
        createdAt: '2026-06-06T00:00:00.000Z',
        updatedAt: '2026-06-06T00:00:00.000Z',
      },
    ],
  ]);

  // WP 10.7: the forward cash flow as `GET /recurring/forecast` really sends it, signed by house convention (an
  // outflow is negative, `low` its pessimistic end), so the card draws a line, a band, and a mark per charge: a
  // fixed rent on the 1st, an uncertain power bill, two charges on the 15th (stacked in the lane), a small inflow,
  // and the confirmed Spotify on the window's last day. `net`/`netLow`/`netHigh` are the sums the route computes.
  const forecast = {
    from: '2026-06-01',
    to: '2026-07-01',
    currency: 'USD',
    outflow: { minor: '-165199', currency: 'USD' },
    inflow: { minor: '2500', currency: 'USD' },
    net: { minor: '-162699', currency: 'USD' },
    netLow: { minor: '-166499', currency: 'USD' },
    netHigh: { minor: '-160099', currency: 'USD' },
    chargeCount: 6,
    charges: [
      projected('series_rent', 'merch_rent', 'OUTFLOW', '2026-06-01', -145000, -145000, -145000),
      projected('series_power', 'merch_power', 'OUTFLOW', '2026-06-08', -8500, -11000, -7000),
      projected('series_phone', 'merch_phone', 'OUTFLOW', '2026-06-15', -6500, -6500, -6500),
      projected('series_water', 'merch_water', 'OUTFLOW', '2026-06-15', -4200, -5000, -3600),
      projected('series_cashback', 'merch_cashback', 'INFLOW', '2026-06-20', 2500, 2000, 3000),
      projected('series_spotify', 'merch_spotify', 'OUTFLOW', '2026-07-01', -999, -999, -999),
    ],
  };

  // WP 11.3: every card reads where its "Explain this" stands; on its own this mock answers `idle` for each (the
  // sweep layers `mock-explain.ts` over it for the scripted states).
  const explain = createExplainState();

  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (await handleExplain(route, path, method, explain)) return;

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

    if (path === '/api/connections' && method === 'GET') {
      return route.fulfill(json({ connections: [] }));
    }

    if (path === '/api/sync/stream' || path.endsWith('/events')) {
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: '' });
    }

    if (path === '/api/categories' && method === 'GET') {
      return route.fulfill(json({ categories: CATEGORIES }));
    }

    if (path === '/api/transactions' && method === 'GET') {
      const q = url.searchParams.get('q');
      const merchantIds = url.searchParams.getAll('merchantIds').flatMap((v) => v.split(','));
      let items = [...transactions.values()];
      if (q !== null && q !== '') {
        const needle = q.toLowerCase();
        items = items.filter(
          (t) =>
            t.name.toLowerCase().includes(needle) ||
            (t.merchantName ?? '').toLowerCase().includes(needle),
        );
      }
      if (merchantIds.length > 0) {
        items = items.filter((t) => t.merchantId !== null && merchantIds.includes(t.merchantId));
        // WP 10.7: the forecast's payees are named the way the screen names any merchant, by a transaction
        // (`useMerchantNames`); only for that lookup, so no other screen's list gains rows.
        for (const [merchantId, name] of RECURRING_PAYEES) {
          if (merchantIds.includes(merchantId)) items.push(payeeTransaction(merchantId, name));
        }
      }
      return route.fulfill(
        json({ items, nextCursor: null, summary: { count: items.length, totals: [] } }),
      );
    }

    if (path === '/api/recurring/candidates' && method === 'GET') {
      return route.fulfill(json({ candidates: [...candidates.values()] }));
    }

    const confirmMatch = /^\/api\/recurring\/candidates\/([^/]+)\/confirm$/.exec(path);
    if (confirmMatch && method === 'POST') {
      state.lastConfirmBody = request.postDataJSON();
      const candidate = candidates.get(confirmMatch[1]!);
      if (candidate === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      candidates.delete(confirmMatch[1]!);
      const seriesId = `series_${candidate.merchantId}`;
      series.set(seriesId, {
        id: seriesId,
        streamKey: candidate.streamKey,
        merchantId: candidate.merchantId,
        state: 'ACTIVE',
        status: 'ACTIVE',
        userConfirmed: true,
        cadence: candidate.cadence,
        type: candidate.type,
        sign: 'OUTFLOW',
        confidence: candidate.confidence,
        typicalAmount: candidate.amount,
        observedMin: candidate.amount,
        observedMax: candidate.amount,
        nextDueDate: '2026-07-01',
        firstSeen: '2026-01-01',
        lastSeen: '2026-06-01',
        duplicateNode: null,
      });
      return route.fulfill(json({ seriesId }));
    }

    const rejectMatch = /^\/api\/recurring\/candidates\/([^/]+)\/reject$/.exec(path);
    if (rejectMatch && method === 'POST') {
      state.lastRejectBody = request.postDataJSON();
      const candidate = candidates.get(rejectMatch[1]!);
      if (candidate === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      // The permanent override: the candidate is gone for good, from this
      // mock's own in-memory state — a later GET (a manual refetch, or a
      // full reload) can never see it again, which is the client-observable
      // half of "does not return after a re-detect".
      candidates.delete(rejectMatch[1]!);
      const body = (request.postDataJSON() ?? {}) as { scope?: string };
      return route.fulfill(
        json({
          candidateId: rejectMatch[1],
          merchantId: candidate.merchantId,
          scope: body.scope ?? 'MERCHANT',
          archivedSeriesId: null,
        }),
      );
    }

    if (path === '/api/recurring/series' && method === 'GET') {
      return route.fulfill(json({ series: [...series.values()] }));
    }

    const mergeMatch = /^\/api\/recurring\/series\/([^/]+)\/merge$/.exec(path);
    if (mergeMatch && method === 'POST') {
      series.delete(mergeMatch[1]!);
      const body = request.postDataJSON() as { targetSeriesId: string };
      return route.fulfill(json({ targetSeriesId: body.targetSeriesId }));
    }

    if (path === '/api/recurring/upcoming' && method === 'GET') {
      return route.fulfill(
        json({ from: '2026-06-01', to: '2026-06-30', currency: 'USD', chargeCount: 0, days: [] }),
      );
    }

    if (path === '/api/recurring/forecast' && method === 'GET') {
      return route.fulfill(json(forecast));
    }

    if (path === '/api/recurring/safe-to-spend' && method === 'GET') {
      return route.fulfill(
        json({
          from: '2026-06-01',
          to: '2026-07-01',
          currency: 'USD',
          availableCash: { minor: '250000', currency: 'USD' },
          committed: { minor: '-165199', currency: 'USD' },
          committedWorstCase: { minor: '-168499', currency: 'USD' },
          expectedIncome: { minor: '2500', currency: 'USD' },
          safe: { minor: '81501', currency: 'USD' },
          committedCount: 5,
        }),
      );
    }

    if (path === '/api/insights' && method === 'GET') {
      const visible = [...insights.values()].filter((i) => i.status === 'pending_review').map(wire);
      return route.fulfill(
        json({ dashboard: visible, list: visible, overflow: [], belowFloor: [] }),
      );
    }

    const insightMatch = /^\/api\/insights\/([^/]+)$/.exec(path);
    if (insightMatch && method === 'GET') {
      const insight = insights.get(insightMatch[1]!);
      if (insight === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      return route.fulfill(json({ insight: wire(insight) }));
    }

    // WP 10.15: bookmark and helpfulness persist on the mock's own insight, so a reload reads them back.
    const bookmarkMatch = /^\/api\/insights\/([^/]+)\/bookmark$/.exec(path);
    if (bookmarkMatch && method === 'POST') {
      const insight = insights.get(bookmarkMatch[1]!);
      if (insight === undefined)
        return route.fulfill(json({ code: 'insights.insight_not_found' }, 404));
      const body = request.postDataJSON() as { bookmarked: boolean };
      insight.bookmarkedAt = body.bookmarked ? '2026-06-15T12:00:00.000Z' : null;
      return route.fulfill(json({ insightId: insight.id, bookmarkedAt: insight.bookmarkedAt }));
    }

    const feedbackMatch = /^\/api\/insights\/([^/]+)\/feedback$/.exec(path);
    if (feedbackMatch && method === 'POST') {
      const insight = insights.get(feedbackMatch[1]!);
      if (insight === undefined)
        return route.fulfill(json({ code: 'insights.insight_not_found' }, 404));
      const body = request.postDataJSON() as {
        feedback: 'helpful' | 'not_helpful' | null;
        reasonCode?: string | null;
      };
      insight.feedback = body.feedback;
      insight.feedbackReason = body.feedback === 'not_helpful' ? (body.reasonCode ?? null) : null;
      state.lastFeedbackBody = body;
      return route.fulfill(
        json({
          insightId: insight.id,
          feedback: insight.feedback,
          feedbackReason: insight.feedbackReason,
        }),
      );
    }

    const reviewMatch = /^\/api\/insights\/([^/]+)\/review$/.exec(path);
    if (reviewMatch && method === 'POST') {
      const insight = insights.get(reviewMatch[1]!);
      if (insight === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      const body = request.postDataJSON() as { action: string; reason?: string | null };
      state.lastReviewBody = body;
      if (body.action === 'accept') {
        insight.status = 'accepted';
        return route.fulfill(
          json({
            insightId: insight.id,
            status: 'accepted',
            dismissCount: 0,
            permanent: false,
            suppressedUntil: null,
          }),
        );
      }
      if (body.action === 'dismiss') {
        insight.status = 'dismissed';
        const count = (dismissals.get(insight.key) ?? 0) + 1;
        dismissals.set(insight.key, count);
        const permanent = count >= 3;
        const suppressedUntil = new Date(
          Date.now() + (count >= 2 ? 90 : 30) * 24 * 60 * 60 * 1000,
        ).toISOString();
        return route.fulfill(
          json({
            insightId: insight.id,
            status: 'dismissed',
            dismissCount: count,
            permanent,
            suppressedUntil: permanent ? null : suppressedUntil,
          }),
        );
      }
      return route.fulfill(
        json({
          insightId: insight.id,
          status: insight.status,
          dismissCount: 0,
          permanent: false,
          suppressedUntil: null,
        }),
      );
    }

    if (path === '/api/advisors' && method === 'GET') {
      return route.fulfill(
        json({
          advisors: [
            {
              advisorId: 'builtin.subscriptions.price_increase',
              displayName: 'Subscription price increases',
              kind: 'builtin',
              version: '1',
              enabled: true,
              quarantinedAt: null,
              quarantineReason: null,
              consecutiveFailures: 0,
              lastRunAt: null,
              grantedScopes: ['recurring.list'],
              lastRunStatus: null,
              lastRunRejected: null,
            },
          ],
        }),
      );
    }

    return route.fallback();
  });

  return state;
}
