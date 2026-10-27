// SPDX-License-Identifier: MIT
import type { Insight } from '../api/generated/types.gen.ts';
import { jsonResponse, type FetchRoute } from './api-test-utils.ts';

/**
 * WP 11.1 fixtures: a `spending.rule_suggestion` insight shaped as `GET /insights` serves it — the category it would
 * file into cited as `…category_ref`, the merchant through the transactions it was filed from (`…transaction_ref`),
 * the count as `…confirmations` — and a `spending.uncategorised` (S3) one that cites transactions but no category.
 */
export const SUGGESTION_ID = '0190b000-0000-7000-8000-0000000000a1';
export const S3_ID = '0190b000-0000-7000-8000-0000000000a2';
/** `TEST_CATEGORIES`' Coffee Shops (`dining.coffee`). */
export const SUGGESTED_CATEGORY_ID = 'cat_dining_coffee';
export const SUGGESTED_CATEGORY_KEY = 'dining.coffee';
export const CITED_TRANSACTION_ID = 'txn_cited';

function baseInsight(overrides: Partial<Insight>): Insight {
  return {
    id: SUGGESTION_ID,
    advisorId: 'builtin.spending.rule_suggestion',
    advisorVersion: '1.0.0',
    key: 'spending.rule_suggestion.merch_1',
    period: '2026-10',
    type: 'spending.rule_suggestion',
    severity: 'info',
    severityClamped: false,
    title: 'A merchant you always file the same way',
    summaryMd:
      'You have filed this merchant under dining.coffee 4 times by hand. A rule would file it there automatically from now on — nothing changes until you save one.',
    confidence: 1,
    confidenceBasis: 'deterministic',
    horizon: 'this_month',
    status: 'pending_review',
    annualizedImpact: null,
    oneTimeImpact: null,
    impactBasis: '',
    caveats: [],
    inputDigest: 'sha256:rule',
    firstProposedAt: '2026-10-20T00:00:00.000Z',
    lastProposedAt: '2026-10-20T00:00:00.000Z',
    expiresAt: null,
    evidence: [],
    actions: [],
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

export function buildRuleSuggestionInsight(overrides: Partial<Insight> = {}): Insight {
  return baseInsight({
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
    ...overrides,
  });
}

/** S3: transaction rows, no category row — its `create_rule_draft` must stay inert. */
export function buildUncategorisedInsight(overrides: Partial<Insight> = {}): Insight {
  return baseInsight({
    id: S3_ID,
    advisorId: 'builtin.spending.uncategorised',
    key: 'spending.uncategorised.2026-10', // gitleaks:allow — an insight key, not a secret
    type: 'spending.uncategorised',
    title: 'Some spending has no category',
    summaryMd: 'Two transactions this month have no category yet.',
    evidence: [
      {
        position: 0,
        kind: 'transaction',
        label: 'Uncategorised',
        value: null,
        sourceRef: 'snapshot:uncategorised.transactions[0].transaction_ref',
        resolvedDisplay: CITED_TRANSACTION_ID,
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
    ...overrides,
  });
}

/** `GET /insights` answering with whatever `insights()` returns at the time (so a refetch can drop one). */
export function insightsFeedRoute(insights: () => readonly Insight[]): FetchRoute {
  return {
    match: '/api/insights',
    method: 'GET',
    handle: () => {
      const list = insights();
      return jsonResponse({ dashboard: list, list, overflow: [], belowFloor: [] });
    },
  };
}

/** `POST /transactions/{id}/rule`'s 201 body. */
export function createdRuleResponse(transactionId: string, categoryKey: string): Response {
  return jsonResponse(
    {
      rule: {
        id: 'rule_1',
        name: 'rule',
        priority: 100,
        enabled: true,
        conditions: { all: [], any: [] },
        actions: [{ type: 'set_category', categoryKey }],
        runOnSync: true,
        stopProcessing: false,
        createdFromTransactionId: transactionId,
        lastAppliedAt: null,
        lastAppliedCount: 0,
        createdAt: '2026-10-20T00:00:00.000Z',
        updatedAt: '2026-10-20T00:00:00.000Z',
      },
    },
    201,
  );
}

export function previewRoute(): FetchRoute {
  return {
    match: '/api/rules/preview',
    method: 'POST',
    handle: () =>
      jsonResponse({
        ruleId: 'rule_1',
        runId: 'run_1',
        preview: true,
        matchedCount: 3,
        changedCount: 0,
        sample: [],
        actionsRecorded: [],
      }),
  };
}

export function reviewResponse(insightId: string, status: 'accepted' | 'dismissed'): Response {
  return jsonResponse({
    insightId,
    status,
    dismissCount: status === 'dismissed' ? 1 : 0,
    permanent: false,
    suppressedUntil: null,
  });
}
