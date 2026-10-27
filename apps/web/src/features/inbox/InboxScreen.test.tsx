// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CategoryExplanation } from '../../api/generated/types.gen.ts';
import {
  buildTransaction,
  buildTransactionDetail,
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import {
  buildRuleSuggestionInsight,
  CITED_TRANSACTION_ID,
  createdRuleResponse,
  insightsFeedRoute,
  previewRoute,
  reviewResponse,
  SUGGESTED_CATEGORY_ID,
  SUGGESTED_CATEGORY_KEY,
  SUGGESTION_ID,
} from '../../test-support/insight-fixtures.ts';
import {
  ABSTAINED_LINE,
  buildExplanation,
  SUGGESTED_ID,
  SUGGESTED_LABEL,
  SUGGESTED_REASON,
} from '../../test-support/suggestion-fixtures.ts';
import { InboxScreen } from './InboxScreen.tsx';

/** `GET /transactions/explanations`, recording every batch of ids it was asked for. */
function explanationsRoute(
  items: readonly CategoryExplanation[] = [],
  calls: string[] = [],
): FetchRoute {
  return {
    match: '/api/transactions/explanations',
    method: 'GET',
    handle: ({ url }) => {
      calls.push(url.searchParams.getAll('ids').join(','));
      return jsonResponse({ items });
    },
  };
}

/** The transaction-list routes for an inbox holding `uncategorized` and no transfer pool. */
function transactionsRoute(uncategorized: ReturnType<typeof buildTransaction>[]): FetchRoute {
  return {
    match: '/api/transactions',
    method: 'GET',
    handle: (context) => {
      const uncategorizedOnly = context.url.searchParams.get('uncategorized') === 'true';
      return jsonResponse({
        items: uncategorizedOnly ? uncategorized : [],
        nextCursor: null,
        summary: { count: uncategorizedOnly ? uncategorized.length : 0, totals: [] },
      });
    },
  };
}

function renderInbox() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <InboxScreen />
    </QueryClientProvider>,
  );
}

describe('InboxScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the all-caught-up empty state when nothing needs review', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      explanationsRoute(),
      insightsFeedRoute(() => []),
      {
        match: '/api/transactions',
        method: 'GET',
        handle: () =>
          jsonResponse({ items: [], nextCursor: null, summary: { count: 0, totals: [] } }),
      },
    ]);

    renderInbox();

    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });

  it('lists an uncategorized transaction and resolves it when a category is chosen', async () => {
    const uncategorized = buildTransaction({
      id: 'txn_1',
      name: 'Blue Bottle Coffee',
      categoryId: null,
    });
    let patchedBody: unknown = null;
    stubFetchRoutes([
      categoriesRoute(),
      explanationsRoute(),
      insightsFeedRoute(() => []),
      {
        match: '/api/transactions',
        method: 'GET',
        handle: (context) => {
          const uncategorizedOnly = context.url.searchParams.get('uncategorized') === 'true';
          return jsonResponse({
            items: uncategorizedOnly ? [uncategorized] : [],
            nextCursor: null,
            summary: { count: uncategorizedOnly ? 1 : 0, totals: [] },
          });
        },
      },
      {
        match: '/api/transactions/txn_1',
        method: 'PATCH',
        handle: async ({ request }) => {
          patchedBody = await request.json();
          return jsonResponse({ ...uncategorized, categoryId: 'cat_dining_coffee' });
        },
      },
    ]);

    renderInbox();
    const user = userEvent.setup();

    expect(await screen.findByText('Blue Bottle Coffee')).toBeInTheDocument();
    expect(screen.getByText('1 item to review')).toBeInTheDocument();

    const combobox = screen.getByRole('combobox', { name: 'Category' });
    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: 'Coffee Shops' }));

    await waitFor(() => expect(patchedBody).toEqual({ categoryId: 'cat_dining_coffee' }));
    await waitFor(() => expect(screen.queryByText('Blue Bottle Coffee')).not.toBeInTheDocument());
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });

  it('suggests a transfer pair and resolves it on accept', async () => {
    const outflow = buildTransaction({
      id: 'txn_out',
      accountId: 'acct_checking',
      amount: { minor: '-5000', currency: 'USD' },
      date: '2026-06-10',
      name: 'To Savings',
      merchantName: null,
    });
    const inflow = buildTransaction({
      id: 'txn_in',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-10',
      name: 'From Checking',
      merchantName: null,
    });
    let pairBody: unknown = null;
    stubFetchRoutes([
      categoriesRoute(),
      explanationsRoute(),
      insightsFeedRoute(() => []),
      {
        match: '/api/transactions',
        method: 'GET',
        handle: (context) => {
          const uncategorizedOnly = context.url.searchParams.get('uncategorized') === 'true';
          return jsonResponse({
            items: uncategorizedOnly ? [] : [outflow, inflow],
            nextCursor: null,
            summary: { count: 0, totals: [] },
          });
        },
      },
      {
        match: '/api/transfers/pair',
        method: 'POST',
        handle: async ({ request }) => {
          pairBody = await request.json();
          return jsonResponse({ transferLinkId: 'link_1' });
        },
      },
    ]);

    renderInbox();
    const user = userEvent.setup();

    expect(await screen.findByText(/To Savings ↔ From Checking/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() =>
      expect(pairBody).toEqual({ outflowTransactionId: 'txn_out', inflowTransactionId: 'txn_in' }),
    );
    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });
});

/**
 * WP 11.1: the one-line "why" under each uncategorised row is the server's `line`, verbatim — read, never composed
 * on this side from the `tiers` that arrive beside it.
 */
describe('InboxScreen › the explanation line', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Deliberately *disagrees* with its own tiers: a screen that rebuilt the line from `tiers` would print
  // "2 rules matched…" / "Filed by the classifier…" and not this sentence.
  const SERVER_LINE =
    'Every tier abstained: none of your 4 rules matched, merchant confirmed 1 of 3 times needed, no bank category, classifier 41 % below its 60 % floor.';

  it('renders the server line verbatim, not a line rebuilt from the tiers, from one batched request', async () => {
    const first = buildTransaction({ id: 'txn_b', name: 'Corner Deli', merchantName: null });
    const second = buildTransaction({ id: 'txn_a', name: 'Hardware Barn', merchantName: null });
    const calls: string[] = [];
    stubFetchRoutes([
      categoriesRoute(),
      insightsFeedRoute(() => []),
      explanationsRoute(
        [
          {
            transactionId: 'txn_b',
            status: 'abstained',
            source: 'none',
            categoryKey: null,
            confidence: null,
            decidedAt: '2026-10-20T00:00:00.000Z',
            line: SERVER_LINE,
            tiers: [
              { source: 'rule', won: false, detail: '2 rules matched but none set a category' },
              { source: 'classifier', won: true, detail: 'Groceries at 99 %' },
            ],
            suggestion: null,
          },
          {
            transactionId: 'txn_a',
            status: 'not_recorded',
            source: null,
            categoryKey: null,
            confidence: null,
            decidedAt: null,
            line: 'No categorisation pass has recorded its working for this yet.',
            tiers: [],
            suggestion: null,
          },
        ],
        calls,
      ),
      transactionsRoute([first, second]),
    ]);

    renderInbox();

    expect(await screen.findByText('Corner Deli')).toBeInTheDocument();
    const lines = await screen.findAllByTestId('inbox-why');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent(`Why: ${SERVER_LINE}`, { normalizeWhitespace: true });
    expect(lines[0]?.textContent).toBe(`Why: ${SERVER_LINE}`);
    expect(screen.queryByText(/2 rules matched/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Groceries at 99 %/)).not.toBeInTheDocument();
    // `not_recorded` says so, honestly, in its own words.
    expect(lines[1]?.textContent).toBe(
      'Why: No categorisation pass has recorded its working for this yet.',
    );
    // One batch for the rows on screen, ids in a stable order.
    expect(calls).toEqual(['txn_a,txn_b']);
  });

  it('shows no line while the explanations fail, and the row still works', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      insightsFeedRoute(() => []),
      {
        match: '/api/transactions/explanations',
        method: 'GET',
        handle: () => jsonResponse({ code: 'unavailable', status: 503 }, 503),
      },
      transactionsRoute([
        buildTransaction({ id: 'txn_1', name: 'Corner Deli', merchantName: null }),
      ]),
    ]);

    renderInbox();

    expect(await screen.findByText('Corner Deli')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Category' })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('inbox-why')).not.toBeInTheDocument());
  });
});

/**
 * WP 11.1: a pending `spending.rule_suggestion` is offered in the Inbox — merchant (from the cited transaction),
 * category and count; Create rule opens the existing rule dialog pre-filled, and the insight is accepted once the
 * rule exists; Not now dismisses it with the existing reason dialog.
 */
describe('InboxScreen › rule suggestions', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function suggestionRoutes(state: { pending: boolean }, extra: FetchRoute[] = []): FetchRoute[] {
    return [
      categoriesRoute(),
      explanationsRoute(),
      insightsFeedRoute(() => (state.pending ? [buildRuleSuggestionInsight()] : [])),
      {
        match: `/api/transactions/${CITED_TRANSACTION_ID}`,
        method: 'GET',
        handle: () =>
          jsonResponse(
            buildTransactionDetail({
              id: CITED_TRANSACTION_ID,
              name: 'TRADER JOES 552',
              merchantName: "Trader Joe's",
              categoryId: SUGGESTED_CATEGORY_ID,
            }),
          ),
      },
      ...extra,
      transactionsRoute([]),
    ];
  }

  it('lists the suggestion with its merchant, category and count', async () => {
    stubFetchRoutes(suggestionRoutes({ pending: true }));
    renderInbox();

    const row = await screen.findByTestId('rule-suggestion');
    expect(screen.getByRole('heading', { name: 'Rule suggestions' })).toBeInTheDocument();
    expect(await within(row).findByText("Trader Joe's")).toBeInTheDocument();
    expect(within(row).getByText('Coffee Shops')).toBeInTheDocument();
    expect(within(row).getByTestId('rule-suggestion-count')).toHaveTextContent('4');
    expect(within(row).getByRole('button', { name: 'Create rule' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('Create rule opens the rule dialog pre-filled with the suggested category, creating nothing yet', async () => {
    let createCalls = 0;
    stubFetchRoutes(
      suggestionRoutes({ pending: true }, [
        {
          match: `/api/transactions/${CITED_TRANSACTION_ID}/rule`,
          method: 'POST',
          handle: () => {
            createCalls += 1;
            return createdRuleResponse(CITED_TRANSACTION_ID, SUGGESTED_CATEGORY_KEY);
          },
        },
      ]),
    );
    renderInbox();
    const user = userEvent.setup();

    const row = await screen.findByTestId('rule-suggestion');
    await within(row).findByText("Trader Joe's");
    await user.click(within(row).getByRole('button', { name: 'Create rule' }));

    const dialog = await screen.findByRole('dialog', { name: 'Always categorize like this' });
    expect(within(dialog).getByRole('combobox', { name: 'Category' })).toHaveValue('Coffee Shops');
    expect(within(dialog).getByText(/Trader Joe's/)).toBeInTheDocument();
    expect(createCalls).toBe(0);
  });

  it('creating the rule posts it with the suggested category, then accepts the insight and drops the suggestion', async () => {
    const state = { pending: true };
    let createBody: unknown = null;
    let reviewBody: unknown = null;
    stubFetchRoutes(
      suggestionRoutes(state, [
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
            state.pending = false;
            return reviewResponse(SUGGESTION_ID, 'accepted');
          },
        },
      ]),
    );
    renderInbox();
    const user = userEvent.setup();

    const row = await screen.findByTestId('rule-suggestion');
    await within(row).findByText("Trader Joe's");
    await user.click(within(row).getByRole('button', { name: 'Create rule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Always categorize like this' });
    await user.click(within(dialog).getByRole('button', { name: 'Preview' }));

    await waitFor(() =>
      expect(createBody).toEqual({ categoryKey: SUGGESTED_CATEGORY_KEY, name: expect.any(String) }),
    );
    await waitFor(() => expect(reviewBody).toEqual({ action: 'accept' }));
    // Still on screen until the holder is done with the dialog (apply or just save).
    expect(screen.getByTestId('rule-suggestion')).toBeInTheDocument();

    await user.click(await within(dialog).findByRole('button', { name: 'Just save the rule' }));
    await waitFor(() => expect(screen.queryByTestId('rule-suggestion')).not.toBeInTheDocument());
  });

  it('Not now dismisses the suggestion through the reason dialog', async () => {
    const state = { pending: true };
    let reviewBody: unknown = null;
    stubFetchRoutes(
      suggestionRoutes(state, [
        {
          match: `/api/insights/${SUGGESTION_ID}/review`,
          method: 'POST',
          handle: async ({ request }) => {
            reviewBody = await request.json();
            state.pending = false;
            return reviewResponse(SUGGESTION_ID, 'dismissed');
          },
        },
      ]),
    );
    renderInbox();
    const user = userEvent.setup();

    const row = await screen.findByTestId('rule-suggestion');
    await user.click(within(row).getByRole('button', { name: 'Not now' }));
    const dialog = await screen.findByRole('dialog', { name: 'Dismiss this insight?' });
    await user.click(within(dialog).getByRole('radio', { name: 'True, but I already knew' }));
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() =>
      expect(reviewBody).toEqual({ action: 'dismiss', reasonCode: 'ALREADY_KNOW', reason: null }),
    );
    await waitFor(() => expect(screen.queryByTestId('rule-suggestion')).not.toBeInTheDocument());
  });
});

/**
 * WP 11.2: an abstained row whose explanation carries the model's suggestion shows the chip — the source stated, the
 * reason verbatim — under the row, which still reads uncategorised. Confirm is the row's normal pick (`PATCH` with
 * the suggested category, then the row resolves); Not this posts the rejection, assigns nothing, and the explanations
 * are read again. Nothing is applied on render.
 */
describe('InboxScreen › the model’s suggestion', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  interface Recorded {
    patches: unknown[];
    rejects: string[];
    explanationCalls: string[];
  }

  function suggestionRoutes(
    rows: ReturnType<typeof buildTransaction>[],
    recorded: Recorded,
    options: { rejected?: () => boolean } = {},
  ): FetchRoute[] {
    let categorised = new Set<string>();
    return [
      categoriesRoute(),
      insightsFeedRoute(() => []),
      {
        match: '/api/transactions/explanations',
        method: 'GET',
        handle: ({ url }) => {
          const ids = url.searchParams.getAll('ids').join(',').split(',');
          recorded.explanationCalls.push(ids.join(','));
          const rejected = options.rejected?.() ?? recorded.rejects.length > 0;
          return jsonResponse({
            items: ids.map((id) => buildExplanation(id, rejected ? { suggestion: null } : {})),
          });
        },
      },
      {
        match: /^\/api\/transactions\/[^/]+\/suggestion\/reject$/,
        method: 'POST',
        handle: ({ url }) => {
          recorded.rejects.push(url.pathname.split('/')[3] ?? '');
          return jsonResponse({ outcome: 'rejected' });
        },
      },
      {
        match: /^\/api\/transactions\/[^/]+$/,
        method: 'PATCH',
        handle: async ({ request, url }) => {
          const body = (await request.json()) as { categoryId: string };
          recorded.patches.push(body);
          const id = url.pathname.split('/')[3] ?? '';
          categorised = new Set([...categorised, id]);
          const row = rows.find((t) => t.id === id);
          return jsonResponse({ ...row, categoryId: body.categoryId });
        },
      },
      {
        match: '/api/transactions',
        method: 'GET',
        handle: (context) => {
          const uncategorizedOnly = context.url.searchParams.get('uncategorized') === 'true';
          const items = uncategorizedOnly ? rows.filter((t) => !categorised.has(t.id)) : [];
          return jsonResponse({
            items,
            nextCursor: null,
            summary: { count: items.length, totals: [] },
          });
        },
      },
    ];
  }

  const CHIP = `Suggested by the model: ${SUGGESTED_LABEL} — ${SUGGESTED_REASON}`;

  it('shows the chip with the source and the reason verbatim, and the row still reads uncategorised; nothing is applied', async () => {
    const recorded: Recorded = { patches: [], rejects: [], explanationCalls: [] };
    stubFetchRoutes(
      suggestionRoutes(
        [buildTransaction({ id: 'txn_1', name: 'Corner Roastery', merchantName: null })],
        recorded,
      ),
    );

    renderInbox();

    const chip = await screen.findByTestId('suggestion-chip');
    expect(within(chip).getByTestId('suggestion-chip-text').textContent).toBe(CHIP);
    // Still a suggestion, not an assignment: the row says uncategorised and keeps its "why".
    const row = screen.getByRole('listitem');
    expect(within(row).getByText(/· Uncategorized$/)).toBeInTheDocument();
    expect(within(row).getByTestId('inbox-why').textContent).toBe(`Why: ${ABSTAINED_LINE}`);
    expect(within(chip).getByRole('button', { name: `Confirm ${SUGGESTED_LABEL}` })).toBeVisible();
    expect(within(chip).getByRole('button', { name: 'Not this' })).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Uncategorized');
    expect(recorded.patches).toEqual([]);
    expect(recorded.rejects).toEqual([]);
  });

  it('Confirm writes the suggested category through the normal pick, and the row leaves the queue', async () => {
    const recorded: Recorded = { patches: [], rejects: [], explanationCalls: [] };
    stubFetchRoutes(
      suggestionRoutes(
        [
          buildTransaction({ id: 'txn_1', name: 'Corner Roastery', merchantName: null }),
          buildTransaction({ id: 'txn_2', name: 'Hardware Barn', merchantName: null }),
        ],
        recorded,
      ),
    );
    renderInbox();
    const user = userEvent.setup();

    expect(await screen.findByText('2 items to review')).toBeInTheDocument();
    const rows = await screen.findAllByTestId('suggestion-chip');
    await user.click(within(rows[0]!).getByRole('button', { name: `Confirm ${SUGGESTED_LABEL}` }));

    await waitFor(() => expect(recorded.patches).toEqual([{ categoryId: SUGGESTED_ID }]));
    expect(await screen.findByText('1 item to review')).toBeInTheDocument();
    expect(screen.queryByText('Corner Roastery')).not.toBeInTheDocument();
    expect(screen.getByText('Hardware Barn')).toBeInTheDocument();
    expect(recorded.rejects).toEqual([]);
  });

  it('Not this posts the rejection, reads the explanations again, and the chip is gone with the row still uncategorised', async () => {
    const recorded: Recorded = { patches: [], rejects: [], explanationCalls: [] };
    stubFetchRoutes(
      suggestionRoutes(
        [buildTransaction({ id: 'txn_1', name: 'Corner Roastery', merchantName: null })],
        recorded,
      ),
    );
    renderInbox();
    const user = userEvent.setup();

    const chip = await screen.findByTestId('suggestion-chip');
    expect(recorded.explanationCalls).toHaveLength(1);
    await user.click(within(chip).getByRole('button', { name: 'Not this' }));

    await waitFor(() => expect(recorded.rejects).toEqual(['txn_1']));
    await waitFor(() => expect(screen.queryByTestId('suggestion-chip')).not.toBeInTheDocument());
    expect(recorded.explanationCalls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Corner Roastery')).toBeInTheDocument();
    expect(screen.getByText('1 item to review')).toBeInTheDocument();
    expect(recorded.patches).toEqual([]);
    // Focus goes to the row, not the document body.
    expect(document.activeElement).toBe(screen.getByRole('listitem'));
  });

  it('shows no chip for a row whose explanation has no suggestion', async () => {
    const recorded: Recorded = { patches: [], rejects: [], explanationCalls: [] };
    stubFetchRoutes(
      suggestionRoutes(
        [buildTransaction({ id: 'txn_1', name: 'Corner Roastery', merchantName: null })],
        recorded,
        { rejected: () => true },
      ),
    );
    renderInbox();

    expect(await screen.findByTestId('inbox-why')).toBeInTheDocument();
    expect(screen.queryByTestId('suggestion-chip')).not.toBeInTheDocument();
  });
});
