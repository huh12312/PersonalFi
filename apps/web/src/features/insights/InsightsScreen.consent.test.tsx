// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdvisorHealth } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { consentCounts, InsightsScreen } from './InsightsScreen.tsx';

/**
 * WP 9.6 item 6 (G4-18's feed half): an empty feed says when consent is why.
 * The component is the shipped screen, mounted in a real router (its link is a
 * router link); only the network is stubbed.
 */

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: InsightsScreen,
  });
  const settings = createRoute({
    getParentRoute: () => root,
    path: '/settings/advisors',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, settings]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function advisor(overrides: Partial<AdvisorHealth> = {}): AdvisorHealth {
  return {
    advisorId: 'builtin.subscriptions.price_increase',
    displayName: 'Subscription price increases',
    kind: 'builtin',
    version: '1',
    enabled: true,
    quarantinedAt: null,
    quarantineReason: null,
    consecutiveFailures: 0,
    lastRunAt: null,
    grantedScopes: [],
    lastRunStatus: null,
    lastRunRejected: null,
    ...overrides,
  };
}

const EMPTY_FEED: FetchRoute = {
  match: '/api/insights',
  handle: () => jsonResponse({ dashboard: [], list: [], overflow: [], belowFloor: [] }),
};

function advisorsRoute(advisors: readonly AdvisorHealth[]): FetchRoute {
  return { match: '/api/advisors', handle: () => jsonResponse({ advisors }) };
}

describe('the empty feed and consent (G4-18)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('says no advisor has access, and links to where to grant it, when nothing is granted', async () => {
    stubFetchRoutes([
      EMPTY_FEED,
      advisorsRoute([advisor(), advisor({ advisorId: 'builtin.cash.low_balance' })]),
    ]);
    renderScreen();

    expect(
      await screen.findByText('No advisor has been given access to your data'),
    ).toBeInTheDocument();
    expect(screen.queryByText("You're all caught up")).not.toBeInTheDocument();
    expect(screen.getByTestId('insights-consent-link')).toHaveAttribute(
      'href',
      '/settings/advisors',
    );
  });

  it('is all caught up, with no consent claim, when every active advisor holds a grant', async () => {
    stubFetchRoutes([EMPTY_FEED, advisorsRoute([advisor({ grantedScopes: ['recurring.list'] })])]);
    renderScreen();

    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByTestId('insights-consent-partial')).not.toBeInTheDocument();
    expect(screen.queryByTestId('insights-consent-link')).not.toBeInTheDocument();
  });

  it('is all caught up and counts the advisors without access when only some hold a grant', async () => {
    stubFetchRoutes([
      EMPTY_FEED,
      advisorsRoute([
        advisor({ grantedScopes: ['recurring.list'] }),
        advisor({ advisorId: 'builtin.cash.low_balance' }),
        advisor({ advisorId: 'builtin.budget.over', grantedScopes: ['budgets.status'] }),
      ]),
    ]);
    renderScreen();

    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    expect(await screen.findByTestId('insights-consent-partial')).toHaveTextContent(
      '1 of 3 advisors have not been given access to any of your data',
    );
  });

  it('does not blame consent for an advisor the holder switched off or the app quarantined', () => {
    expect(
      consentCounts([
        advisor({ enabled: false }),
        advisor({ quarantinedAt: '2026-10-01T00:00:00.000Z', quarantineReason: 'rejections' }),
        advisor({ grantedScopes: ['recurring.list'] }),
      ]),
    ).toEqual({ active: 1, withoutAccess: 0 });
  });

  it('does not guess when the advisor list cannot be read: the ordinary empty state', async () => {
    stubFetchRoutes([
      EMPTY_FEED,
      {
        match: '/api/advisors',
        handle: () =>
          jsonResponse({ code: 'internal', title: 'Internal Server Error', status: 500 }, 500),
      },
    ]);
    renderScreen();

    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByTestId('insights-consent-link')).not.toBeInTheDocument();
  });

  it('with no advisor active at all, it is not a consent state either', async () => {
    stubFetchRoutes([EMPTY_FEED, advisorsRoute([advisor({ enabled: false })])]);
    renderScreen();

    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
    expect(screen.queryByTestId('insights-consent-link')).not.toBeInTheDocument();
  });
});
