// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../../routeTree.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  categoriesRoute,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import type { Account, Transaction } from '../../api/generated/types.gen.ts';
import { DEFAULT_OVERLAY } from '../accounts/fixtures.ts';

const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'webauthn',
  trustedDevice: true,
  fresh: true,
  idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

const ACCOUNT: Account = {
  id: 'acct_1',
  connectionId: 'conn_1',
  provider: 'manual',
  name: 'Everyday Checking',
  officialName: null,
  type: 'depository',
  subtype: null,
  classification: 'asset',
  currency: 'USD',
  mask: '1234',
  closedAt: null,
  includeInNetWorth: true,
  balance: null,
  overlay: DEFAULT_OVERLAY,
};

function transaction(overrides: Partial<Transaction> & Pick<Transaction, 'id'>): Transaction {
  return {
    accountId: 'acct_1',
    factId: `fact_${overrides.id}`,
    date: '2026-01-15',
    amount: { minor: '-1250', currency: 'USD' },
    name: 'Coffee Shop',
    merchantId: null,
    merchantName: 'Coffee Shop',
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
    createdAt: '2026-01-15T00:00:00.000Z',
    updatedAt: '2026-01-15T00:00:00.000Z',
    ...overrides,
  };
}

function renderTransactions() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/transactions'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe('TransactionsScreen', () => {
  beforeEach(() => {
    ensureApiClient();
    // `@tanstack/virtual-core` measures its scroll element via
    // `element.offsetHeight` (not `getBoundingClientRect`), and happy-dom's
    // layout engine always reports 0 — which renders zero rows regardless of
    // `count`. Every tanstack-virtual test needs this same stub.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the transaction list with formatted amounts and account names', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/accounts', handle: () => jsonResponse({ accounts: [ACCOUNT] }) },
      {
        match: '/api/transactions',
        handle: () =>
          jsonResponse({
            items: [transaction({ id: 'txn_1' })],
            nextCursor: null,
            summary: { count: 1, totals: [] },
          }),
      },
    ]);

    renderTransactions();

    expect(await screen.findByText('Coffee Shop')).toBeInTheDocument();
    expect(screen.getAllByText('Everyday Checking').length).toBeGreaterThan(0);
    expect(screen.getByText(/\$12\.50/)).toBeInTheDocument();
  });

  it('shows pending and transfer badges', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/accounts', handle: () => jsonResponse({ accounts: [ACCOUNT] }) },
      {
        match: '/api/transactions',
        handle: () =>
          jsonResponse({
            items: [
              transaction({ id: 'txn_pending', pending: true }),
              transaction({ id: 'txn_transfer', isTransfer: true, name: 'Transfer to Savings' }),
            ],
            nextCursor: null,
            summary: { count: 2, totals: [] },
          }),
      },
    ]);

    renderTransactions();

    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(await screen.findByText('Transfer')).toBeInTheDocument();
  });

  it('shows an empty state when there are no transactions', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/accounts', handle: () => jsonResponse({ accounts: [] }) },
      {
        match: '/api/transactions',
        handle: () =>
          jsonResponse({ items: [], nextCursor: null, summary: { count: 0, totals: [] } }),
      },
    ]);

    renderTransactions();

    expect(await screen.findByText('No transactions yet')).toBeInTheDocument();
  });

  it('opens the detail sheet and saves a note edit through the overlay endpoint', async () => {
    let patchedBody: unknown = null;
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/accounts', handle: () => jsonResponse({ accounts: [ACCOUNT] }) },
      {
        match: '/api/transactions',
        method: 'GET',
        handle: () =>
          jsonResponse({
            items: [transaction({ id: 'txn_1' })],
            nextCursor: null,
            summary: { count: 1, totals: [] },
          }),
      },
      {
        match: '/api/transactions/txn_1',
        method: 'GET',
        handle: () =>
          jsonResponse({
            ...transaction({ id: 'txn_1' }),
            provenance: {
              factId: 'fact_txn_1',
              provider: 'manual',
              providerTransactionId: 'p_1',
              pendingTransactionId: null,
              postedDate: '2026-01-15',
              authorizedDate: null,
              providerName: 'Coffee Shop',
              providerMerchantName: null,
              providerAmount: { minor: '-1250', currency: 'USD' },
              paymentChannel: null,
              pending: false,
              revision: 1,
              firstSeenAt: '2026-01-15T00:00:00.000Z',
              lastSeenAt: '2026-01-15T00:00:00.000Z',
              removedAt: null,
            },
            splits: [],
            transfer: null,
            removedAt: null,
          }),
      },
      {
        match: '/api/transactions/txn_1',
        method: 'PATCH',
        handle: async ({ request }) => {
          patchedBody = await request.json();
          return jsonResponse(transaction({ id: 'txn_1', note: 'Team coffee' }));
        },
      },
    ]);

    renderTransactions();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Coffee Shop'));
    await screen.findByRole('heading', { name: 'Coffee Shop' });

    const noteField = await screen.findByLabelText('Note');
    await user.type(noteField, 'Team coffee');
    fireEvent.blur(noteField);

    await waitFor(() => expect(patchedBody).toEqual({ note: 'Team coffee' }));

    // The category half of the same sheet (gate condition D-6, finding N-3).
    // The re-gate could set a note here and *not* a category, because the picker
    // had one option; this asserts the real category id from `GET /categories`
    // reaches the same overlay endpoint.
    const categoryField = await screen.findByRole('combobox', { name: 'Category' });
    await user.click(categoryField);
    await user.click(await screen.findByRole('option', { name: 'Coffee Shops' }));

    await waitFor(() => expect(patchedBody).toEqual({ categoryId: 'cat_dining_coffee' }));
  });
});
