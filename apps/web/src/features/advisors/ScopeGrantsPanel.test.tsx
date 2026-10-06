// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
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
    requested: true,
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
    requested: true,
  },
] as const;

const NO_EVENTS: FetchRoute = {
  match: '/api/advisors/local.narrator/grant-events',
  method: 'GET',
  handle: () => jsonResponse({ advisorId: 'local.narrator', events: [] }),
};

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
        NO_EVENTS,
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
        NO_EVENTS,
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
      NO_EVENTS,
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
            notRequested: [],
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

  describe('G5-3: which scopes the advisor requests', () => {
    // The narrator-style shape: it requests cash.summary and not transactions.raw.
    const NOT_ALL_REQUESTED = [
      SCOPES[0],
      { ...SCOPES[1], requested: false, requiresPerRunConsent: false },
    ];

    function scopesRoute(kind: string, scopes: readonly unknown[]): FetchRoute {
      return {
        match: '/api/advisors/local.narrator/scopes',
        method: 'GET',
        handle: () => jsonResponse({ advisorId: 'local.narrator', kind, scopes }),
      };
    }

    it('marks each scope as requested or not, and counts them', async () => {
      stubFetchRoutes([NO_EVENTS, scopesRoute('local_model', NOT_ALL_REQUESTED)]);
      renderPanel();

      const rows = await screen.findAllByTestId('scope-row');
      const marks = rows.map((row) => within(row).getByTestId('scope-requested'));
      expect(marks[0]).toHaveAttribute('data-requested', 'true');
      expect(marks[0]).toHaveTextContent('Requested by this advisor.');
      expect(marks[1]).toHaveAttribute('data-requested', 'false');
      expect(marks[1]).toHaveTextContent('Not requested by this advisor');
      expect(screen.getByTestId('requested-summary')).toHaveTextContent(
        'requests 1 of the 2 scopes listed',
      );
    });

    it('a local-model advisor cannot be newly granted a scope it does not request', async () => {
      stubFetchRoutes([NO_EVENTS, scopesRoute('local_model', NOT_ALL_REQUESTED)]);
      renderPanel();

      const rows = await screen.findAllByTestId('scope-row');
      expect(within(rows[1]!).getByRole('checkbox')).toBeDisabled();
      expect(rows[1]).toHaveTextContent('so it cannot be granted');
      expect(within(rows[0]!).getByRole('checkbox')).toBeEnabled();
    });

    it('a scope already granted but not requested stays revocable', async () => {
      stubFetchRoutes([
        NO_EVENTS,
        scopesRoute('local_model', [SCOPES[0], { ...SCOPES[1], requested: false, granted: true }]),
      ]);
      renderPanel();

      const rows = await screen.findAllByTestId('scope-row');
      expect(within(rows[1]!).getByRole('checkbox')).toBeEnabled();
    });

    it('a builtin may be offered the box but the row says it is not requested, and a save that grants it is flagged', async () => {
      stubFetchRoutes([
        NO_EVENTS,
        scopesRoute('builtin', NOT_ALL_REQUESTED),
        {
          match: '/api/advisors/local.narrator/grants',
          method: 'PUT',
          handle: () =>
            jsonResponse({
              advisorId: 'local.narrator',
              granted: ['transactions.raw'],
              revoked: [],
              notRequested: ['transactions.raw'],
            }),
        },
      ]);
      renderPanel();
      const user = userEvent.setup();

      const rows = await screen.findAllByTestId('scope-row');
      expect(within(rows[1]!).getByRole('checkbox')).toBeEnabled();
      expect(rows[1]).toHaveTextContent('it never reads this scope, whatever is granted');

      await user.click(within(rows[1]!).getByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: 'Save grants' }));

      expect(await screen.findByTestId('not-requested-flag')).toHaveTextContent(
        'this advisor does not request transactions.raw, so it will never read it',
      );
    });
  });

  describe('O-9: the consent history', () => {
    const EVENTS = [
      {
        id: '00000000-0000-4000-8000-000000000003',
        advisorId: 'local.narrator',
        scope: 'cash.summary',
        event: 're_granted',
        perRunConsent: false,
        stepUpSessionId: '11111111-2222-4333-8444-555555555555',
        occurredAt: '2026-10-03T12:00:00.000Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        advisorId: 'local.narrator',
        scope: 'cash.summary',
        event: 'revoked',
        perRunConsent: false,
        stepUpSessionId: null,
        occurredAt: '2026-10-02T12:00:00.000Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000001',
        advisorId: 'local.narrator',
        scope: 'cash.summary',
        event: 'granted',
        perRunConsent: true,
        stepUpSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        occurredAt: '2026-10-01T12:00:00.000Z',
      },
    ];

    it('lists every grant, revoke and re-grant newest first, with the session that authorised it', async () => {
      stubFetchRoutes([
        {
          match: '/api/advisors/local.narrator/scopes',
          method: 'GET',
          handle: () =>
            jsonResponse({ advisorId: 'local.narrator', kind: 'local_model', scopes: SCOPES }),
        },
        {
          match: '/api/advisors/local.narrator/grant-events',
          method: 'GET',
          handle: () => jsonResponse({ advisorId: 'local.narrator', events: EVENTS }),
        },
      ]);
      renderPanel();

      const items = await screen.findAllByTestId('grant-event');
      expect(items.map((item) => item.getAttribute('data-event'))).toEqual([
        're_granted',
        'revoked',
        'granted',
      ]);
      expect(items[0]).toHaveTextContent('Granted again cash.summary');
      expect(items[0]).toHaveTextContent('authorised in sign-in session 11111111');
      expect(items[1]).toHaveTextContent('Revoked cash.summary');
      expect(items[1]).toHaveTextContent('made outside a sign-in session');
      expect(items[2]).toHaveTextContent('Granted cash.summary (consented per run)');
    });

    it('says plainly when nothing has been granted yet', async () => {
      stubFetchRoutes([
        {
          match: '/api/advisors/local.narrator/scopes',
          method: 'GET',
          handle: () =>
            jsonResponse({ advisorId: 'local.narrator', kind: 'local_model', scopes: SCOPES }),
        },
        NO_EVENTS,
      ]);
      renderPanel();

      expect(await screen.findByTestId('grant-history-empty')).toHaveTextContent(
        'Nothing has been granted to this advisor yet.',
      );
    });
  });
});
