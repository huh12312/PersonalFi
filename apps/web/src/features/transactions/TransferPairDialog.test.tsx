// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTransaction,
  buildTransactionDetail,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { TransferPairDialog } from './TransferPairDialog.tsx';

const ACCOUNT_NAMES: Record<string, string> = { acct_1: 'Everyday Checking', acct_2: 'Savings' };

function renderDialog() {
  const transaction = buildTransactionDetail({
    id: 'txn_out',
    accountId: 'acct_1',
    amount: { minor: '-5000', currency: 'USD' },
    date: '2026-06-10',
  });
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransferPairDialog
        transaction={transaction}
        accountName={(id) => ACCOUNT_NAMES[id] ?? id}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('TransferPairDialog', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows a matching same-amount opposite-sign candidate from another account', async () => {
    const candidate = buildTransaction({
      id: 'txn_in',
      accountId: 'acct_2',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-11',
      name: 'Transfer from Checking',
      merchantName: null,
    });
    stubFetchRoutes([
      {
        match: '/api/transactions',
        method: 'GET',
        handle: () =>
          jsonResponse({ items: [candidate], nextCursor: null, summary: { count: 1, totals: [] } }),
      },
    ]);

    renderDialog();

    expect(await screen.findByText('Transfer from Checking')).toBeInTheDocument();
    expect(screen.getByText(/Savings/)).toBeInTheDocument();
  });

  it('shows an empty state when nothing matches', async () => {
    stubFetchRoutes([
      {
        match: '/api/transactions',
        method: 'GET',
        handle: () =>
          jsonResponse({ items: [], nextCursor: null, summary: { count: 0, totals: [] } }),
      },
    ]);

    renderDialog();

    expect(await screen.findByText(/No matching transaction/)).toBeInTheDocument();
  });

  it('pairing calls POST /transfers/pair with the outflow/inflow oriented correctly', async () => {
    const candidate = buildTransaction({
      id: 'txn_in',
      accountId: 'acct_2',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-11',
      name: 'Transfer from Checking',
      merchantName: null,
    });
    let pairBody: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/transactions',
        method: 'GET',
        handle: () =>
          jsonResponse({ items: [candidate], nextCursor: null, summary: { count: 1, totals: [] } }),
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

    const { onOpenChange } = renderDialog();
    const user = userEvent.setup();

    await user.click(await screen.findByText('Transfer from Checking'));

    await waitFor(() =>
      expect(pairBody).toEqual({ outflowTransactionId: 'txn_out', inflowTransactionId: 'txn_in' }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
