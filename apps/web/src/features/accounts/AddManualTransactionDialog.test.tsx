// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { AddManualTransactionDialog } from './AddManualTransactionDialog.tsx';
import { DEFAULT_OVERLAY } from './fixtures.ts';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

const ACCOUNT: Account = {
  id: 'acct_1',
  connectionId: null,
  provider: 'manual',
  name: 'Cash envelope',
  officialName: null,
  type: 'depository',
  subtype: null,
  classification: 'asset',
  currency: 'USD',
  mask: null,
  closedAt: null,
  includeInNetWorth: true,
  balance: null,
  overlay: DEFAULT_OVERLAY,
};

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <AddManualTransactionDialog account={ACCOUNT} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('AddManualTransactionDialog', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds a signed manual transaction through POST /accounts/{id}/transactions', async () => {
    let body: unknown = null;
    stubFetchRoutes([
      { match: '/api/auth/step-up/options', handle: () => jsonResponse({ options: {} }) },
      {
        match: '/api/auth/step-up/verify',
        handle: () => jsonResponse({ freshUntil: new Date(Date.now() + 300_000).toISOString() }),
      },
      {
        match: '/api/accounts/acct_1/transactions',
        method: 'POST',
        handle: async ({ request }) => {
          body = await request.json();
          return jsonResponse({ addedTransactionIds: ['txn_new'], updatedTransactionIds: [] }, 201);
        },
      },
    ]);

    const { onOpenChange } = renderDialog();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Description'), 'Cash tip');
    await user.type(screen.getByLabelText(/amount/i), '-12.50');
    await user.click(screen.getByRole('button', { name: 'Add transaction' }));

    await waitFor(() =>
      expect(body).toMatchObject({
        transactions: [
          {
            amount: { minor: '-1250', currency: 'USD' },
            name: 'Cash tip',
          },
        ],
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('will not submit without an amount or description', async () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Add transaction' })).toBeDisabled();
  });
});
