// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Insight } from '../../api/generated/types.gen.ts';
import {
  buildTransactionDetail,
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import {
  buildRuleSuggestionInsight,
  buildUncategorisedInsight,
  CITED_TRANSACTION_ID,
  createdRuleResponse,
  previewRoute,
  reviewResponse,
  SUGGESTED_CATEGORY_ID,
  SUGGESTED_CATEGORY_KEY,
  SUGGESTION_ID,
} from '../../test-support/insight-fixtures.ts';
import { InsightCard } from './InsightCard.tsx';
import { ruleDraftOf } from './rule-draft.ts';

/**
 * WP 11.1: an insight's `create_rule_draft` is a real "Create rule" button only when its own evidence resolves both
 * the category and the transaction the rule is drafted from; it opens the existing rule dialog pre-filled and accepts
 * the insight once the rule exists. S3 (`spending.uncategorised`: transactions, no category) stays inert.
 */

function renderCard(insight: Insight) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const page = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => (
      <ul>
        <InsightCard insight={insight} />
      </ul>
    ),
  });
  const router = createRouter({
    routeTree: root.addChildren([page]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function citedTransactionRoute(): FetchRoute {
  return {
    match: `/api/transactions/${CITED_TRANSACTION_ID}`,
    method: 'GET',
    handle: () =>
      jsonResponse(
        buildTransactionDetail({
          id: CITED_TRANSACTION_ID,
          name: 'TRADER JOES 552',
          merchantName: "Trader Joe's",
          categoryId: null,
        }),
      ),
  };
}

describe('ruleDraftOf', () => {
  it('reads the transaction, category and count from the evidence', () => {
    expect(ruleDraftOf(buildRuleSuggestionInsight())).toEqual({
      transactionId: CITED_TRANSACTION_ID,
      categoryId: SUGGESTED_CATEGORY_ID,
      confirmations: '4',
    });
  });

  it('is no draft without a category row, without a transaction row, or without the action', () => {
    expect(ruleDraftOf(buildUncategorisedInsight())).toBeNull();
    const suggestion = buildRuleSuggestionInsight();
    expect(
      ruleDraftOf({
        ...suggestion,
        evidence: suggestion.evidence.filter((row) => !row.sourceRef?.endsWith('.transaction_ref')),
      }),
    ).toBeNull();
    expect(ruleDraftOf({ ...suggestion, actions: [] })).toBeNull();
  });
});

describe('InsightCard › Create rule', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows Create rule when the evidence resolves a category and a transaction', async () => {
    stubFetchRoutes([categoriesRoute(), citedTransactionRoute()]);
    renderCard(buildRuleSuggestionInsight());
    expect(await screen.findByRole('button', { name: 'Create rule' })).toBeInTheDocument();
  });

  it('keeps an S3 create_rule_draft inert: transactions but no category is no button', async () => {
    stubFetchRoutes([categoriesRoute(), citedTransactionRoute()]);
    renderCard(buildUncategorisedInsight());
    const user = userEvent.setup();
    expect(await screen.findByText('Some spending has no category')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create rule' })).not.toBeInTheDocument();
    // Still listed as the inert suggestion it always was.
    await user.click(screen.getByRole('button', { name: 'View evidence panel' }));
    expect(
      within(screen.getByTestId('evidence-panel')).getByText('Create rule'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create rule' })).not.toBeInTheDocument();
  });

  it('opens the rule dialog pre-filled, creates the rule only on Preview, then accepts the insight', async () => {
    let createBody: unknown = null;
    let reviewBody: unknown = null;
    stubFetchRoutes([
      categoriesRoute(),
      citedTransactionRoute(),
      {
        match: `/api/transactions/${CITED_TRANSACTION_ID}/rule`,
        method: 'POST',
        handle: async ({ request }) => {
          createBody = await request.json();
          return createdRuleResponse(CITED_TRANSACTION_ID, SUGGESTED_CATEGORY_KEY);
        },
      },
      previewRoute(),
      {
        match: `/api/insights/${SUGGESTION_ID}/review`,
        method: 'POST',
        handle: async ({ request }) => {
          reviewBody = await request.json();
          return reviewResponse(SUGGESTION_ID, 'accepted');
        },
      },
      {
        match: '/api/insights',
        method: 'GET',
        handle: () => jsonResponse({ dashboard: [], list: [], overflow: [], belowFloor: [] }),
      },
    ]);
    renderCard(buildRuleSuggestionInsight());
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Create rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Always categorize like this' });
    // The cited transaction itself is uncategorised here: the category is the suggestion's, not the row's.
    await waitFor(() =>
      expect(within(dialog).getByRole('combobox', { name: 'Category' })).toHaveValue(
        'Coffee Shops',
      ),
    );
    expect(createBody).toBeNull();
    expect(reviewBody).toBeNull();

    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(createBody).toEqual({ categoryKey: SUGGESTED_CATEGORY_KEY, name: expect.any(String) }),
    );
    await waitFor(() => expect(reviewBody).toEqual({ action: 'accept' }));
  });
});
