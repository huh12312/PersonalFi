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
import { AccountOverridesPanel } from './AccountOverridesPanel.tsx';
import { DEFAULT_OVERLAY } from './fixtures.ts';

const RETIREMENT: Account = {
  id: 'acct_ira',
  connectionId: 'conn_1',
  provider: 'plaid',
  name: 'Rollover',
  officialName: null,
  type: 'investment',
  subtype: 'ira',
  classification: 'asset',
  currency: 'USD',
  mask: null,
  closedAt: null,
  includeInNetWorth: true,
  balance: null,
  overlay: {
    taxTreatment: {
      effective: 'TAX_DEFERRED',
      source: 'provider_subtype',
      override: null,
      providerDefault: 'TAX_DEFERRED',
    },
    role: { effective: null, source: 'none' },
    valuation: { effective: 'holdings', source: 'default' },
  },
};

function renderPanel(account: Account) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountOverridesPanel account={account} />
    </QueryClientProvider>,
  );
}

describe('AccountOverridesPanel', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the effective value and where it came from, and sends the full replacement by keyboard', async () => {
    let putBody: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/accounts/acct_ira/overrides',
        method: 'PUT',
        handle: async ({ request }) => {
          putBody = await request.json();
          return jsonResponse({ account: RETIREMENT, changed: true });
        },
      },
    ]);
    renderPanel(RETIREMENT);
    const user = userEvent.setup();

    expect(screen.getByText(/Now: Tax-deferred .* — from Plaid: ira/u)).toBeInTheDocument();
    // Nothing is dirty yet, so there is nothing to save.
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();

    // jsdom has no type-ahead on a native <select>, so the choice is made with
    // `selectOptions`; the keyboard path itself is `e2e/accounts-overrides.spec.ts`.
    // Submitting is by keyboard here: focus the button and press Enter.
    await user.selectOptions(screen.getByLabelText('Tax treatment'), 'ROTH');
    expect(screen.getByLabelText('Tax treatment')).toHaveValue('ROTH');
    screen.getByRole('button', { name: 'Save settings' }).focus();
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(putBody).toEqual({ taxTreatment: 'ROTH', role: null, valuation: null }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(/out of date/u);
  });

  it('offers a way back to the provider’s settings only when something is set', () => {
    renderPanel(RETIREMENT);
    expect(
      screen.queryByRole('button', { name: 'Use the provider’s settings' }),
    ).not.toBeInTheDocument();
  });

  it('resets through DELETE', async () => {
    let deleted = false;
    stubFetchRoutes([
      {
        match: '/api/accounts/acct_ira/overrides',
        method: 'DELETE',
        handle: () => {
          deleted = true;
          return jsonResponse({ account: RETIREMENT, changed: true });
        },
      },
    ]);
    renderPanel({
      ...RETIREMENT,
      overlay: {
        ...RETIREMENT.overlay,
        taxTreatment: {
          effective: 'ROTH',
          source: 'holder',
          override: 'ROTH',
          providerDefault: 'TAX_DEFERRED',
        },
      },
    });
    const user = userEvent.setup();
    expect(screen.getByText(/Now: Roth \(tax-free\) — set by you/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use the provider’s settings' }));
    await waitFor(() => expect(deleted).toBe(true));
  });

  it('shows only the fields the account can take', () => {
    renderPanel({
      ...RETIREMENT,
      type: 'credit',
      classification: 'liability',
      overlay: DEFAULT_OVERLAY,
    });
    expect(screen.queryByLabelText('Tax treatment')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Valued by')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Role')).toBeInTheDocument();
  });

  it('says why a save failed', async () => {
    stubFetchRoutes([
      {
        match: '/api/accounts/acct_ira/overrides',
        method: 'PUT',
        handle: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Unprocessable Content',
              status: 422,
              code: 'ledger.override_not_applicable',
              detail: 'nope',
            },
            422,
          ),
      },
    ]);
    renderPanel(RETIREMENT);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Role'), 'savings');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});
