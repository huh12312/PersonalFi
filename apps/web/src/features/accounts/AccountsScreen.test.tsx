// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../../routeTree.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import type { Account, NetWorth } from '../../api/generated/types.gen.ts';

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

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'type' | 'name'>): Account {
  return {
    connectionId: null,
    provider: 'manual',
    officialName: null,
    subtype: null,
    classification: 'asset',
    currency: 'USD',
    mask: null,
    closedAt: null,
    includeInNetWorth: true,
    balance: null,
    ...overrides,
  };
}

function renderAccounts(initialPath = '/accounts') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe('AccountsScreen', () => {
  beforeEach(() => {
    ensureApiClient();
    stubFetchRoutes([{ match: '/api/auth/session', handle: () => jsonResponse(SESSION) }]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders accounts grouped by type with their latest balance', async () => {
    const accounts: Account[] = [
      account({
        id: 'chk_1',
        type: 'depository',
        name: 'Everyday Checking',
        balance: {
          current: { minor: '500000', currency: 'USD' },
          available: null,
          limit: null,
          asOf: '2026-01-01T00:00:00.000Z',
          source: 'provider',
        },
      }),
      account({
        id: 'cc_1',
        type: 'credit',
        name: 'Rewards Card',
        classification: 'liability',
        balance: {
          current: { minor: '-42000', currency: 'USD' },
          available: null,
          limit: null,
          asOf: '2026-01-01T00:00:00.000Z',
          source: 'provider',
        },
      }),
    ];
    const netWorth: NetWorth = {
      asOf: '2026-01-01T00:00:00.000Z',
      totals: [
        {
          currency: 'USD',
          assets: { minor: '500000', currency: 'USD' },
          liabilities: { minor: '-42000', currency: 'USD' },
          net: { minor: '458000', currency: 'USD' },
        },
      ],
      inputs: [],
    };

    stubFetchRoutes([
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/accounts', handle: () => jsonResponse({ accounts }) },
      { match: '/api/net-worth', handle: () => jsonResponse(netWorth) },
    ]);

    renderAccounts();

    expect(await screen.findByText('Everyday Checking')).toBeInTheDocument();
    expect(await screen.findByText('Rewards Card')).toBeInTheDocument();
    expect(screen.getByText('Cash')).toBeInTheDocument();
    expect(screen.getByText('Credit cards')).toBeInTheDocument();
  });

  it('shows an empty state with a call to action when there are no accounts', async () => {
    stubFetchRoutes([
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/accounts', handle: () => jsonResponse({ accounts: [] }) },
      {
        match: '/api/net-worth',
        handle: () => jsonResponse({ asOf: null, totals: [], inputs: [] }),
      },
    ]);

    renderAccounts();

    expect(await screen.findByText('Connect your first account')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add account' })).toBeInTheDocument();
  });

  it('shows a retry action when the accounts request fails', async () => {
    stubFetchRoutes([
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/accounts', handle: () => jsonResponse({ code: 'internal' }, 500) },
      {
        match: '/api/net-worth',
        handle: () => jsonResponse({ asOf: null, totals: [], inputs: [] }),
      },
    ]);

    renderAccounts();

    expect(await screen.findByText("Couldn't load your accounts")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
