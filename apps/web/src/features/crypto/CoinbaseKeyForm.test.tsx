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
import { CoinbaseKeyForm } from './CoinbaseKeyForm.tsx';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
}));

/** Structurally key-shaped but never a real Coinbase credential — a test fixture only. */
const TEST_KEY_NAME =
  'organizations/11111111-1111-1111-1111-111111111111/apiKeys/22222222-2222-2222-2222-222222222222';
const TEST_PRIVATE_KEY =
  '-----BEGIN EC PRIVATE KEY-----\nsynthetic-test-fixture-only\n-----END EC PRIVATE KEY-----';

function renderForm(onDone = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <CoinbaseKeyForm onDone={onDone} />
    </QueryClientProvider>,
  );
  return { onDone };
}

describe('CoinbaseKeyForm', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the view-only warning up front', () => {
    renderForm();
    expect(screen.getByText(/view-only/)).toBeInTheDocument();
    expect(screen.getByText(/can_view/)).toBeInTheDocument();
  });

  it('submits { provider: "coinbase", input: { keyName, privateKey } } and clears the key field on submit', async () => {
    let createBody: unknown = null;

    stubFetchRoutes([
      {
        match: '/api/connections',
        method: 'POST',
        handle: async ({ request }) => {
          createBody = await request.json();
          return jsonResponse(
            {
              connectionId: 'conn_cb',
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

    await user.type(screen.getByLabelText('CDP key name'), TEST_KEY_NAME);
    await user.type(screen.getByLabelText('Ed25519 private key (PEM)'), TEST_PRIVATE_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Coinbase' }));

    await waitFor(() =>
      expect(createBody).toEqual({
        provider: 'coinbase',
        input: { keyName: TEST_KEY_NAME, privateKey: TEST_PRIVATE_KEY },
      }),
    );
    await waitFor(() => expect(onDone).toHaveBeenCalled());

    // Cleared on submit, and never echoed back anywhere on screen afterwards.
    expect((screen.getByLabelText('Ed25519 private key (PEM)') as HTMLTextAreaElement).value).toBe(
      '',
    );
    expect(document.body.textContent).not.toContain(TEST_PRIVATE_KEY);
  });

  it("surfaces the API's own refusal message on failure, never a generic error swallowing it", async () => {
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
                'a coinbase connection needs a CDP key name of the form organizations/{org_uuid}/apiKeys/{key_uuid} and the matching Ed25519 private key',
              code: 'connections.invalid_input',
              correlationId: 'corr_1',
            },
            400,
          ),
      },
    ]);

    renderForm();
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('CDP key name'), 'not-a-real-key-name');
    await user.type(screen.getByLabelText('Ed25519 private key (PEM)'), TEST_PRIVATE_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect Coinbase' }));

    expect(
      await screen.findByText(/a coinbase connection needs a CDP key name of the form/),
    ).toBeInTheDocument();
  });
});
