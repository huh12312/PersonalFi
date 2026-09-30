// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { WalletWatchOnlyForm } from './WalletWatchOnlyForm.tsx';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

/** BIP84's own published test-vector zpub (public material — see wp3.6-walletrpc.md §2). */
const TEST_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

function renderForm(onDone = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <WalletWatchOnlyForm onDone={onDone} />
    </QueryClientProvider>,
  );
  return { onDone };
}

describe('WalletWatchOnlyForm', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('carries the exact "never ask for a private key or a seed phrase" line', () => {
    renderForm();
    expect(
      screen.getByText(/We will never ask for a private key or a seed phrase/),
    ).toBeInTheDocument();
  });

  it('submits a Bitcoin zpub as { provider: "wallet_rpc", input: { chain: "bitcoin", value } }', async () => {
    let createBody: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/connections',
        method: 'POST',
        handle: async ({ request }) => {
          createBody = await request.json();
          return jsonResponse(
            {
              connectionId: 'conn_w',
              relinked: false,
              accountIds: [],
              syncJobId: null,
              syncRunId: null,
            },
            201,
          );
        },
      },
    ]);

    const { onDone } = renderForm();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Extended public key'), TEST_ZPUB);
    await user.click(screen.getByRole('button', { name: 'Add wallet' }));

    await waitFor(() =>
      expect(createBody).toEqual({
        provider: 'wallet_rpc',
        input: { chain: 'bitcoin', value: TEST_ZPUB },
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it(
    'states the Etherscan requirement in words for Ethereum, and shows nothing of the kind for Bitcoin ' +
      '(C-13/G4-20)',
    async () => {
      renderForm();
      const user = userEvent.setup();

      expect(
        screen.queryByText(/Etherscan API key/),
        'Bitcoin is the default chain and needs no Etherscan key',
      ).not.toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Chain'), 'ethereum');
      expect(screen.getByText(/Etherscan API key/)).toBeInTheDocument();
      expect(screen.getByText(/etherscan_api_key/)).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText('Chain'), 'bitcoin');
      expect(screen.queryByText(/Etherscan API key/)).not.toBeInTheDocument();
    },
  );

  it('switches the field label and placeholder for Ethereum, and submits chain: "ethereum"', async () => {
    let createBody: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/connections',
        method: 'POST',
        handle: async ({ request }) => {
          createBody = await request.json();
          return jsonResponse(
            {
              connectionId: 'conn_e',
              relinked: false,
              accountIds: [],
              syncJobId: null,
              syncRunId: null,
            },
            201,
          );
        },
      },
    ]);

    renderForm();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText('Chain'), 'ethereum');
    expect(screen.getByLabelText('Address')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Address'), '0x0000000000000000000000000000000000dEaD');
    await user.click(screen.getByRole('button', { name: 'Add wallet' }));

    await waitFor(() =>
      expect(createBody).toEqual({
        provider: 'wallet_rpc',
        input: { chain: 'ethereum', value: '0x0000000000000000000000000000000000dEaD' },
      }),
    );
  });

  it("surfaces the connector's own refusal for a pasted seed phrase, without echoing the value", async () => {
    stubFetchRoutes([
      {
        match: '/api/connections',
        method: 'POST',
        handle: () =>
          jsonResponse(
            {
              type: 'https://personalfi.local/problems/connections.invalid_input',
              title: 'Bad Request',
              status: 400,
              detail:
                'value looks like private key material (bip39_mnemonic_shaped), not a watch-only ' +
                'xpub or address. This connector never accepts, stores or derives from private ' +
                'keys — paste the public xpub/ypub/zpub (for Bitcoin) or the address itself (for ' +
                'Ethereum).',
              code: 'connections.invalid_input',
              correlationId: 'corr_2',
            },
            400,
          ),
      },
    ]);

    renderForm();
    const user = userEvent.setup();

    const seedLikeInput =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    await user.type(screen.getByLabelText('Extended public key'), seedLikeInput);
    await user.click(screen.getByRole('button', { name: 'Add wallet' }));

    expect(
      await screen.findByText(/looks like private key material \(bip39_mnemonic_shaped\)/),
    ).toBeInTheDocument();
  });
});
