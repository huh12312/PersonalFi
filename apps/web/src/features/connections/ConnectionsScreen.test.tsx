// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../../routeTree.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  categoriesRoute,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import type { ConnectionSummary, ConnectorManifest } from '../../api/generated/types.gen.ts';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

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

const MANUAL_CONNECTOR: ConnectorManifest = {
  provider: 'manual',
  displayName: 'Manual account',
  description: 'An account you maintain yourself.',
  iconKey: 'pencil',
  linkKind: 'manual_entry',
  docsUrl: null,
  capabilities: {
    supports: ['accounts', 'balances', 'transactions'],
    historyWindowDays: 'unbounded',
    minSyncIntervalSeconds: 0,
    refreshBudgetPerDay: null,
    supportsWebhooks: false,
    reconnectFlow: 'none',
    consentWindowDays: null,
    currencies: 'multi',
  },
};

function connection(
  overrides: Partial<ConnectionSummary> & Pick<ConnectionSummary, 'id' | 'displayName'>,
): ConnectionSummary {
  return {
    provider: 'manual',
    status: 'active',
    capabilities: MANUAL_CONNECTOR.capabilities,
    accountCount: 1,
    lastSyncedAt: null,
    consentExpiresAt: null,
    errorSince: null,
    lastErrorKind: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** `useSyncStatus` reads `/sync/stream` via the SSE client — an immediately-closed empty stream is enough for a component test that doesn't assert on live sync events. */
function emptySseResponse(): Response {
  return new Response('', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function renderConnections() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/accounts/connections'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe('ConnectionsScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists connections with health, last-sync, and account count', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/sync/stream', handle: () => emptySseResponse() },
      {
        match: '/api/connections',
        method: 'GET',
        handle: () =>
          jsonResponse({
            connections: [
              connection({
                id: 'conn_1',
                displayName: 'My accounts',
                status: 'active',
                lastSyncedAt: new Date().toISOString(),
              }),
              connection({
                id: 'conn_2',
                displayName: 'Old bank export',
                status: 'reauth_required',
              }),
            ],
          }),
      },
      { match: '/api/connectors', handle: () => jsonResponse({ connectors: [MANUAL_CONNECTOR] }) },
    ]);

    renderConnections();

    expect(await screen.findByText('My accounts')).toBeInTheDocument();
    expect(await screen.findByText('Old bank export')).toBeInTheDocument();
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Needs reconnection')).toBeInTheDocument();
  });

  it('shows an empty state with an "Add connection" action when there are none', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/sync/stream', handle: () => emptySseResponse() },
      { match: '/api/connections', method: 'GET', handle: () => jsonResponse({ connections: [] }) },
      { match: '/api/connectors', handle: () => jsonResponse({ connectors: [MANUAL_CONNECTOR] }) },
    ]);

    renderConnections();

    expect(await screen.findByText('No connections yet')).toBeInTheDocument();
  });

  it('adds a manual account through the step-up gated POST /connections', async () => {
    let createBody: unknown = null;
    let connections: ConnectionSummary[] = [];

    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      { match: '/api/sync/stream', handle: () => emptySseResponse() },
      { match: '/api/connections', method: 'GET', handle: () => jsonResponse({ connections }) },
      { match: '/api/connectors', handle: () => jsonResponse({ connectors: [MANUAL_CONNECTOR] }) },
      { match: '/api/auth/step-up/options', handle: () => jsonResponse({ options: {} }) },
      {
        match: '/api/auth/step-up/verify',
        handle: () => jsonResponse({ freshUntil: new Date(Date.now() + 300_000).toISOString() }),
      },
      {
        match: '/api/connections',
        method: 'POST',
        handle: async ({ request }) => {
          createBody = await request.json();
          connections = [connection({ id: 'conn_new', displayName: 'Rental property' })];
          return jsonResponse(
            {
              connectionId: 'conn_new',
              relinked: false,
              accountIds: ['acct_new'],
              syncJobId: null,
              syncRunId: null,
            },
            201,
          );
        },
      },
    ]);

    renderConnections();
    const user = userEvent.setup();

    // Both the header button and the (zero-connections) empty state's own
    // action share this accessible name; either one opens the same dialog.
    const [addButton] = await screen.findAllByRole('button', { name: 'Add connection' });
    await user.click(addButton as HTMLElement);
    await screen.findByRole('heading', { name: 'Add a connection' });

    await user.type(screen.getByLabelText('Account name'), 'Rental property');
    await user.click(screen.getByRole('button', { name: 'Add account' }));

    await waitFor(() =>
      expect(createBody).toMatchObject({
        provider: 'manual',
        input: { displayName: 'Rental property' },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Add a connection' })).not.toBeInTheDocument(),
    );
  });
});
