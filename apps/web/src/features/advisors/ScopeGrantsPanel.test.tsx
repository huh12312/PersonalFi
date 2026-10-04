// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { ScopeGrantsPanel } from './ScopeGrantsPanel.tsx';

function renderPanel() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ScopeGrantsPanel advisorId="local.narrator" />
    </QueryClientProvider>,
  );
}

const SCOPES = [
  {
    scope: 'cash.summary',
    sensitivity: 2,
    key: 'cash.summary',
    yields: 'Account balances and cash totals, rounded.',
    drops: 'No transaction detail, no merchant names.',
    externalAllowed: true,
    requiresPerRunConsent: false,
    sourcedInPhase2: true,
    granted: true,
  },
  {
    scope: 'transactions.raw',
    sensitivity: 9,
    key: 'transactions.raw',
    yields: 'Every raw transaction row, including merchant free text.',
    drops: 'Nothing — this is the widest transaction scope.',
    externalAllowed: false,
    requiresPerRunConsent: true,
    sourcedInPhase2: false,
    granted: false,
  },
] as const;

describe('ScopeGrantsPanel', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it(
    'shows what every scope yields and what it drops, in sensitivity order, before any step-up ' +
      'action exists to trigger one',
    async () => {
      stubFetchRoutes([
        {
          match: '/api/advisors/local.narrator/scopes',
          method: 'GET',
          handle: () =>
            jsonResponse({ advisorId: 'local.narrator', kind: 'local_model', scopes: SCOPES }),
        },
      ]);

      renderPanel();

      const rows = await screen.findAllByTestId('scope-row');
      expect(rows).toHaveLength(2);
      // Sensitivity order, least sensitive first — rendered on mount, with
      // no grant button clicked and no mutation ever sent: the yields/drops
      // text is on screen long before any step-up could fire.
      expect(rows[0]).toHaveTextContent('cash.summary');
      expect(rows[0]).toHaveTextContent('Account balances and cash totals, rounded.');
      expect(rows[0]).toHaveTextContent('No transaction detail, no merchant names.');
      expect(rows[1]).toHaveTextContent('transactions.raw');
      expect(rows[1]).toHaveTextContent('Every raw transaction row, including merchant free text.');
      expect(rows[1]).toHaveTextContent('Nothing — this is the widest transaction scope.');
    },
  );

  it(
    'a requiresPerRunConsent scope is never offered as a plain standing grant: its own box ' +
      'carries the per-run explanation',
    async () => {
      stubFetchRoutes([
        {
          match: '/api/advisors/local.narrator/scopes',
          method: 'GET',
          handle: () =>
            jsonResponse({ advisorId: 'local.narrator', kind: 'local_model', scopes: SCOPES }),
        },
      ]);

      renderPanel();

      const rows = await screen.findAllByTestId('scope-row');
      const perRunRow = rows[1]!;
      expect(perRunRow).toHaveTextContent(
        'Consented per run only: a standing grant records that you understand this scope exists',
      );
      // The non-per-run scope carries no such notice.
      expect(rows[0]).not.toHaveTextContent('Consented per run only');
    },
  );

  it('saving a selection that includes a per-run-consent scope sends perRunConsent: true', async () => {
    let grantBody: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/advisors/local.narrator/scopes',
        method: 'GET',
        handle: () =>
          jsonResponse({ advisorId: 'local.narrator', kind: 'local_model', scopes: SCOPES }),
      },
      {
        match: '/api/advisors/local.narrator/grants',
        method: 'PUT',
        handle: async ({ request }) => {
          grantBody = await request.json();
          return jsonResponse({
            advisorId: 'local.narrator',
            granted: ['cash.summary', 'transactions.raw'],
            revoked: [],
          });
        },
      },
    ]);

    renderPanel();
    const user = userEvent.setup();

    await screen.findAllByTestId('scope-row');
    await user.click(screen.getByRole('checkbox', { name: 'Grant transactions.raw' }));
    await user.click(screen.getByRole('button', { name: 'Save grants' }));

    await screen.findByRole('status');
    expect(grantBody).toEqual({
      scopes: ['cash.summary', 'transactions.raw'],
      perRunConsent: true,
    });
  });
});
