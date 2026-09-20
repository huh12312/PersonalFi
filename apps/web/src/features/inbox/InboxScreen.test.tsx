// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTransaction,
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { InboxScreen } from './InboxScreen.tsx';

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
