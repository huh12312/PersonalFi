// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 11.1's network layer: the Inbox's one-line "why" (`GET /transactions/explanations`) and a pending
 * `spending.rule_suggestion` insight, layered **on top of** `installApiMocks` (or `installSweepMocks`) — registered
 * after them, so it runs first and `route.fallback()`s everything it does not answer. It does not edit the shared
 * fixtures: it answers `GET /insights` with its own two insights (the suggestion, and an S3 `spending.uncategorised`
 * whose `create_rule_draft` must stay inert), serves the suggestion's cited transaction, and *records* — then hands on
 * to `mock-api.ts` — every `POST /transactions/{id}/rule`, so a spec can assert the rule was created through the
 * dialog's own route with the suggested category.
 *
 * The category is `mock-api.ts`'s own Groceries (`cat_groceries` / `groceries`), so the dialog's picker can show it.
 */

export const RULE_SUGGESTION_INSIGHT_ID = '0190b000-0000-7000-8000-00000000e2e1';
export const S3_INSIGHT_ID = '0190b000-0000-7000-8000-00000000e2e2';
export const CITED_TRANSACTION_ID = 'txn_tj';
export const SUGGESTED_CATEGORY_ID = 'cat_groceries';
export const SUGGESTED_CATEGORY_KEY = 'groceries';
export const CITED_MERCHANT = "Trader Joe's";

/** `mock-api.ts`'s `txn_1` (Blue Bottle Coffee): every tier abstained. */
export const ABSTAINED_LINE =
  'Every tier abstained: none of your 4 rules matched, merchant confirmed 1 of 3 times needed, no bank category, classifier 41 % below its 60 % floor.';
/** Any other row: nothing recorded yet, said in the server's own words. */
export const NOT_RECORDED_LINE = 'No categorisation pass has recorded its working for this yet.';

export interface RuleSuggestionMockState {
  /** `POST /insights/{id}/review` bodies, in order. */
  readonly reviews: Array<{ insightId: string; body: Record<string, unknown> }>;
  /** `POST /transactions/{id}/rule` bodies, in order (each also answered by `mock-api.ts`). */
  readonly ruleCreates: Array<{ transactionId: string; body: Record<string, unknown> }>;
  /** The `ids` of every `GET /transactions/explanations`. */
  readonly explanationBatches: string[];
}

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function explanationFor(transactionId: string) {
  if (transactionId === 'txn_1') {
    return {
      transactionId,
      status: 'abstained',
      source: 'none',
      categoryKey: null,
      confidence: null,
      decidedAt: '2026-10-20T08:00:00.000Z',
      line: ABSTAINED_LINE,
      tiers: [
        { source: 'rule', won: false, detail: 'No rule matched.' },
        { source: 'merchant_default', won: false, detail: 'Merchant confirmed 1 of 3 times.' },
        { source: 'provider', won: false, detail: 'No bank category.' },
        { source: 'classifier', won: false, detail: 'Below the confidence floor.' },
      ],
    };
  }
  return {
    transactionId,
    status: 'not_recorded',
    source: null,
    categoryKey: null,
    confidence: null,
    decidedAt: null,
    line: NOT_RECORDED_LINE,
    tiers: [],
  };
}

function insight<T extends { readonly id: string; readonly status: string }>(overrides: T) {
  return {
    advisorVersion: '1.0.0',
    period: '2026-10',
    severity: 'info',
    severityClamped: false,
    confidence: 1,
    confidenceBasis: 'deterministic',
    horizon: 'this_month',
    annualizedImpact: null,
    oneTimeImpact: null,
    impactBasis: '',
    caveats: [],
    inputDigest: 'sha256:e2e',
    firstProposedAt: '2026-10-20T08:00:00.000Z',
    lastProposedAt: '2026-10-20T08:00:00.000Z',
    expiresAt: null,
    bookmarkedAt: null,
    feedback: null,
    feedbackReason: null,
    mentions: [],
    titleSegments: [],
    bodySegments: [],
    contextLine: null,
    ...overrides,
  };
}

function suggestionInsight(status: string) {
  return insight({
    id: RULE_SUGGESTION_INSIGHT_ID,
    advisorId: 'builtin.spending.rule_suggestion',
    key: 'spending.rule_suggestion.merch_tj',
    type: 'spending.rule_suggestion',
    status,
    title: 'A merchant you always file the same way',
    summaryMd:
      'You have filed this merchant under groceries 4 times by hand. A rule would file it there automatically from now on — nothing changes until you save one.',
    evidence: [
      {
        position: 0,
        kind: 'metric',
        label: 'Times you filed it this way',
        value: null,
        sourceRef: 'snapshot:rule_candidates.merchants[0].confirmations',
        resolvedDisplay: '4',
        href: null,
      },
      {
        position: 1,
        kind: 'metric',
        label: 'The category',
        value: null,
        sourceRef: 'snapshot:rule_candidates.merchants[0].category_ref',
        resolvedDisplay: SUGGESTED_CATEGORY_ID,
        href: null,
      },
      {
        position: 2,
        kind: 'transaction',
        label: 'Filed by hand',
        value: null,
        sourceRef: 'snapshot:rule_candidates.merchants[0].transactions[0].transaction_ref',
        resolvedDisplay: CITED_TRANSACTION_ID,
        href: null,
      },
    ],
    actions: [
      {
        position: 0,
        kind: 'create_rule_draft',
        label: 'Create rule',
        rationaleMd: 'A rule files this merchant automatically from now on.',
        url: null,
      },
    ],
  });
}

function uncategorisedInsight(status: string) {
  return insight({
    id: S3_INSIGHT_ID,
    advisorId: 'builtin.spending.uncategorised',
    key: 'spending.uncategorised.2026-10', // gitleaks:allow — an insight key, not a secret
    type: 'spending.uncategorised',
    status,
    title: 'Some spending has no category',
    summaryMd: 'Two transactions this month have no category yet.',
    evidence: [
      {
        position: 0,
        kind: 'transaction',
        label: 'Uncategorised',
        value: null,
        sourceRef: 'snapshot:uncategorised.transactions[0].transaction_ref',
        resolvedDisplay: 'txn_2',
        href: null,
      },
    ],
    actions: [
      {
        position: 0,
        kind: 'create_rule_draft',
        label: 'Create rule',
        rationaleMd: 'Pick a category and a rule can file the rest.',
        url: null,
      },
    ],
  });
}

const CITED_TRANSACTION = {
  id: CITED_TRANSACTION_ID,
  accountId: 'acct_1',
  factId: `fact_${CITED_TRANSACTION_ID}`,
  date: '2026-10-18',
  amount: { minor: '-6412', currency: 'USD' },
  name: 'TRADER JOES 552',
  merchantId: 'merch_tj',
  merchantName: CITED_MERCHANT,
  pending: false,
  excluded: false,
  categoryId: SUGGESTED_CATEGORY_ID,
  note: null,
  isTransfer: false,
  transferLinkId: null,
  refundOfId: null,
  refundConfidence: null,
  supersededById: null,
  supersededReason: null,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
  provenance: {
    factId: `fact_${CITED_TRANSACTION_ID}`,
    provider: 'manual',
    providerTransactionId: `p_${CITED_TRANSACTION_ID}`,
    pendingTransactionId: null,
    postedDate: '2026-10-18',
    authorizedDate: null,
    providerName: 'TRADER JOES 552',
    providerMerchantName: null,
    providerAmount: { minor: '-6412', currency: 'USD' },
    paymentChannel: null,
    pending: false,
    revision: 1,
    firstSeenAt: '2026-10-18T00:00:00.000Z',
    lastSeenAt: '2026-10-18T00:00:00.000Z',
    removedAt: null,
  },
  splits: [],
  transfer: null,
  removedAt: null,
};

export async function installRuleSuggestionMocks(page: Page): Promise<RuleSuggestionMockState> {
  const state: RuleSuggestionMockState = { reviews: [], ruleCreates: [], explanationBatches: [] };
  const status = new Map<string, string>([
    [RULE_SUGGESTION_INSIGHT_ID, 'pending_review'],
    [S3_INSIGHT_ID, 'pending_review'],
  ]);
  const insights = () => [
    suggestionInsight(status.get(RULE_SUGGESTION_INSIGHT_ID) ?? 'pending_review'),
    uncategorisedInsight(status.get(S3_INSIGHT_ID) ?? 'pending_review'),
  ];

  await page.route('**/api/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/transactions/explanations' && method === 'GET') {
      const ids = url.searchParams
        .getAll('ids')
        .flatMap((value) => value.split(','))
        .filter((id) => id !== '');
      state.explanationBatches.push(ids.join(','));
      return route.fulfill(json({ items: ids.map(explanationFor) }));
    }

    if (path === `/api/transactions/${CITED_TRANSACTION_ID}` && method === 'GET') {
      return route.fulfill(json(CITED_TRANSACTION));
    }

    const ruleMatch = /^\/api\/transactions\/([^/]+)\/rule$/.exec(path);
    if (ruleMatch && method === 'POST') {
      state.ruleCreates.push({
        transactionId: ruleMatch[1]!,
        body: request.postDataJSON() as Record<string, unknown>,
      });
      return route.fallback();
    }

    if (path === '/api/insights' && method === 'GET') {
      const visible = insights().filter((i) => i.status === 'pending_review');
      return route.fulfill(
        json({ dashboard: visible, list: visible, overflow: [], belowFloor: [] }),
      );
    }

    const insightMatch = /^\/api\/insights\/([^/]+)$/.exec(path);
    if (insightMatch && method === 'GET' && status.has(insightMatch[1]!)) {
      const found = insights().find((i) => i.id === insightMatch[1]);
      return route.fulfill(json({ insight: found }));
    }

    const reviewMatch = /^\/api\/insights\/([^/]+)\/review$/.exec(path);
    if (reviewMatch && method === 'POST' && status.has(reviewMatch[1]!)) {
      const insightId = reviewMatch[1]!;
      const body = request.postDataJSON() as Record<string, unknown>;
      state.reviews.push({ insightId, body });
      const next = body['action'] === 'dismiss' ? 'dismissed' : 'accepted';
      status.set(insightId, next);
      return route.fulfill(
        json({
          insightId,
          status: next,
          dismissCount: next === 'dismissed' ? 1 : 0,
          permanent: false,
          suppressedUntil: null,
        }),
      );
    }

    return route.fallback();
  });

  return state;
}
