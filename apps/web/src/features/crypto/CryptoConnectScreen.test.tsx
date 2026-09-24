// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { CryptoConnectScreen } from './CryptoConnectScreen.tsx';

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CryptoConnectScreen />
    </QueryClientProvider>,
  );
}

describe('CryptoConnectScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders both forms when both connectors are registered', async () => {
    stubFetchRoutes([
      {
        match: '/api/connectors',
        method: 'GET',
        handle: () =>
          jsonResponse({
            connectors: [
              {
                provider: 'coinbase',
                displayName: 'Coinbase (read-only)',
                description: '',
                iconKey: 'crypto',
                linkKind: 'credential_form',
              },
              {
                provider: 'wallet_rpc',
                displayName: 'Bitcoin / Ethereum wallet (watch-only)',
                description: '',
                iconKey: 'crypto',
                linkKind: 'credential_form',
              },
            ],
          }),
      },
    ]);

    renderScreen();

    expect(await screen.findByLabelText('CDP key name')).toBeInTheDocument();
    expect(screen.getByLabelText('Extended public key')).toBeInTheDocument();
  });

  it('shows an honest "not available" message when a connector is not registered', async () => {
    stubFetchRoutes([
      { match: '/api/connectors', method: 'GET', handle: () => jsonResponse({ connectors: [] }) },
    ]);

    renderScreen();

    expect(await screen.findAllByText(/Not available in this deployment/)).toHaveLength(2);
    expect(screen.queryByLabelText('CDP key name')).not.toBeInTheDocument();
  });
});
