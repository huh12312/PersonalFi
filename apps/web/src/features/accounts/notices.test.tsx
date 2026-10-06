// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunPlanProjectionResponse } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { ProjectionOverridesNotice } from './ProjectionOverridesNotice.tsx';
import { UnvaluedAccountsNotice } from './UnvaluedAccountsNotice.tsx';

function renderIn(node: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const index = createRoute({ getParentRoute: () => root, path: '/', component: () => node });
  const account = createRoute({
    getParentRoute: () => root,
    path: '/accounts/$accountId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, account]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('UnvaluedAccountsNotice', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('names every account left out, as not counted rather than zero, and every one counted by typed balance', async () => {
    stubFetchRoutes([
      {
        match: '/api/accounts/valuation',
        handle: () =>
          jsonResponse({
            asOfDate: '2026-10-06',
            unvalued: [{ accountId: 'a2', name: 'Typed brokerage', reason: 'no_priced_holding' }],
            byBalance: [{ accountId: 'a1', name: 'Rollover' }],
          }),
      },
    ]);
    renderIn(<UnvaluedAccountsNotice />);
    const notice = await screen.findByTestId('unvalued-accounts-notice');
    expect(notice).toHaveTextContent('Not counted: Typed brokerage (no priced holdings)');
    expect(notice).toHaveTextContent('not counted as zero');
    expect(notice).toHaveTextContent('Counted at your typed balance: Rollover');
    expect(screen.getByRole('link', { name: 'Typed brokerage' })).toHaveAttribute(
      'href',
      '/accounts/a2',
    );
  });

  it('renders nothing when every account is valued the ordinary way', async () => {
    stubFetchRoutes([
      {
        match: '/api/accounts/valuation',
        handle: () => jsonResponse({ asOfDate: '2026-10-06', unvalued: [], byBalance: [] }),
      },
    ]);
    renderIn(<UnvaluedAccountsNotice />);
    await waitFor(() =>
      expect(screen.queryByTestId('unvalued-accounts-notice')).not.toBeInTheDocument(),
    );
  });
});

describe('ProjectionOverridesNotice', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  const stale: RunPlanProjectionResponse = {
    status: 'stale',
    run: null,
    percentiles: [],
    staleness: {
      reason: 'account_overrides_changed',
      changes: [{ accountId: 'a1', field: 'taxTreatment', from: null, to: 'ROTH' }],
    },
  };

  it('says the projection is out of date, names the change, and recomputes only when asked', async () => {
    let body: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/accounts',
        handle: () =>
          jsonResponse({
            accounts: [
              {
                id: 'a1',
                name: 'Rollover',
                connectionId: null,
                provider: 'plaid',
                officialName: null,
                type: 'investment',
                subtype: 'ira',
                classification: 'asset',
                currency: 'USD',
                mask: null,
                closedAt: null,
                includeInNetWorth: true,
                balance: null,
              },
            ],
          }),
      },
      {
        match: '/api/plan/scenarios/s1/projections',
        method: 'POST',
        handle: async ({ request }) => {
          body = await request.json();
          return jsonResponse({ status: 'computed', run: null, percentiles: [], staleness: null });
        },
      },
    ]);
    renderIn(<ProjectionOverridesNotice projection={stale} scenarioId="s1" />);
    const notice = await screen.findByTestId('projection-stale-notice');
    expect(notice).toHaveTextContent('This projection is out of date');
    await waitFor(() =>
      expect(notice).toHaveTextContent('Rollover: tax treatment was default, now Roth'),
    );
    expect(body).toBeNull(); // nothing recomputed by itself

    await userEvent.setup().click(screen.getByRole('button', { name: /Recompute/u }));
    await waitFor(() => expect(body).toEqual({ acceptAccountChanges: true }));
  });

  it('says nothing for a fresh projection or another kind of staleness', () => {
    renderIn(
      <ProjectionOverridesNotice
        projection={{ ...stale, status: 'computed', staleness: null }}
        scenarioId="s1"
      />,
    );
    expect(screen.queryByTestId('projection-stale-notice')).not.toBeInTheDocument();
  });
});
