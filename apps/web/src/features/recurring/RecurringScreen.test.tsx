// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { RecurringScreen } from './RecurringScreen.tsx';

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RecurringScreen />
    </QueryClientProvider>,
  );
}

const CANDIDATE = {
  candidateId: 'cand_1',
  seriesId: null,
  merchantId: 'merch_netflix',
  streamKey: 'merch_netflix:OUTFLOW:USD:0:2026-01-01',
  cadence: 'MONTHLY',
  type: 'SUBSCRIPTION',
  confidence: 0.7,
  amount: { minor: '1899', currency: 'USD' },
  proposedAt: '2026-06-01T00:00:00.000Z',
};

const SERIES = {
  id: 'series_1',
  streamKey: 'merch_spotify:OUTFLOW:USD:0:2026-01-01',
  merchantId: 'merch_spotify',
  state: 'ACTIVE',
  status: 'ACTIVE',
  userConfirmed: true,
  cadence: 'MONTHLY',
  type: 'SUBSCRIPTION',
  sign: 'OUTFLOW',
  confidence: 0.95,
  typicalAmount: { minor: '999', currency: 'USD' },
  observedMin: { minor: '999', currency: 'USD' },
  observedMax: { minor: '999', currency: 'USD' },
  nextDueDate: '2026-07-01',
  firstSeen: '2026-01-01',
  lastSeen: '2026-06-01',
  duplicateNode: null,
  priceChangeEvents: [],
};

function upcomingRoute(): FetchRoute {
  return {
    match: '/api/recurring/upcoming',
    handle: () =>
      jsonResponse({
        from: '2026-06-01',
        to: '2026-06-30',
        currency: 'USD',
        chargeCount: 0,
        days: [],
      }),
  };
}

function forecastRoute(): FetchRoute {
  return {
    match: '/api/recurring/forecast',
    handle: () =>
      jsonResponse({
        from: '2026-06-01',
        to: '2026-06-30',
        currency: 'USD',
        outflow: { minor: '-999', currency: 'USD' },
        inflow: { minor: '0', currency: 'USD' },
        net: { minor: '-999', currency: 'USD' },
        netLow: { minor: '-1200', currency: 'USD' },
        netHigh: { minor: '-800', currency: 'USD' },
        chargeCount: 1,
        charges: [],
      }),
  };
}

function safeToSpendRoute(): FetchRoute {
  return {
    match: '/api/recurring/safe-to-spend',
    handle: () =>
      jsonResponse({
        from: '2026-06-01',
        to: '2026-06-30',
        currency: 'USD',
        availableCash: { minor: '250000', currency: 'USD' },
        committed: { minor: '-999', currency: 'USD' },
        committedWorstCase: { minor: '-1200', currency: 'USD' },
        expectedIncome: { minor: '0', currency: 'USD' },
        safe: { minor: '248800', currency: 'USD' },
        committedCount: 1,
      }),
  };
}

function transactionsRoute(name = 'Netflix', merchantId = 'merch_netflix'): FetchRoute {
  return {
    match: '/api/transactions',
    handle: () =>
      jsonResponse({
        items: [
          {
            id: 'txn_1',
            accountId: 'acct_1',
            factId: 'fact_1',
            date: '2026-06-01',
            amount: { minor: '-1899', currency: 'USD' },
            name,
            merchantId,
            merchantName: name,
            pending: false,
            excluded: false,
            categoryId: null,
            note: null,
            isTransfer: false,
            transferLinkId: null,
            refundOfId: null,
            refundConfidence: null,
            supersededById: null,
            supersededReason: null,
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        ],
        nextCursor: null,
        summary: { count: 1, totals: [] },
      }),
  };
}

describe('RecurringScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows empty states when there are no candidates and no series', async () => {
    stubFetchRoutes([
      { match: '/api/recurring/candidates', handle: () => jsonResponse({ candidates: [] }) },
      { match: '/api/recurring/series', handle: () => jsonResponse({ series: [] }) },
      upcomingRoute(),
      forecastRoute(),
      safeToSpendRoute(),
      transactionsRoute(),
    ]);

    renderScreen();

    expect(await screen.findByText('No subscriptions detected yet')).toBeInTheDocument();
    expect(screen.queryByText('Needs your confirmation')).not.toBeInTheDocument();
  });

  it('confirming a candidate calls the confirm route and refreshes the queue', async () => {
    let candidates = [CANDIDATE];
    let confirmedBody: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/recurring/candidates',
        handle: () => jsonResponse({ candidates }),
      },
      { match: '/api/recurring/series', handle: () => jsonResponse({ series: [] }) },
      {
        match: '/api/recurring/candidates/cand_1/confirm',
        method: 'POST',
        handle: async ({ request }) => {
          confirmedBody = await request.json();
          candidates = [];
          return jsonResponse({ seriesId: 'series_new' });
        },
      },
      upcomingRoute(),
      forecastRoute(),
      safeToSpendRoute(),
      transactionsRoute(),
    ]);

    renderScreen();
    const user = userEvent.setup();

    expect(await screen.findByText('Needs your confirmation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(confirmedBody).toEqual({}));
    await waitFor(() =>
      expect(screen.queryByText('Needs your confirmation')).not.toBeInTheDocument(),
    );
  });

  it('rejecting a candidate shows the permanent-override warning and posts the chosen scope + reason', async () => {
    let candidates = [CANDIDATE];
    let rejectedBody: unknown = null;
    stubFetchRoutes([
      { match: '/api/recurring/candidates', handle: () => jsonResponse({ candidates }) },
      { match: '/api/recurring/series', handle: () => jsonResponse({ series: [] }) },
      {
        match: '/api/recurring/candidates/cand_1/reject',
        method: 'POST',
        handle: async ({ request }) => {
          rejectedBody = await request.json();
          candidates = [];
          return jsonResponse({
            candidateId: 'cand_1',
            merchantId: 'merch_netflix',
            scope: 'MERCHANT',
            archivedSeriesId: null,
          });
        },
      },
      upcomingRoute(),
      forecastRoute(),
      safeToSpendRoute(),
      transactionsRoute(),
    ]);

    renderScreen();
    const user = userEvent.setup();

    expect(await screen.findByText('Needs your confirmation')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reject' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/This is permanent/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Why? (optional)'), 'not mine');
    await user.click(within(dialog).getByRole('button', { name: 'Reject permanently' }));

    await waitFor(() => expect(rejectedBody).toEqual({ scope: 'MERCHANT', reason: 'not mine' }));
  });

  it('renders the confirmed series list with cadence, next-due and a dormancy badge', async () => {
    stubFetchRoutes([
      { match: '/api/recurring/candidates', handle: () => jsonResponse({ candidates: [] }) },
      {
        match: '/api/recurring/series',
        handle: () => jsonResponse({ series: [{ ...SERIES, status: 'AT_RISK' }] }),
      },
      upcomingRoute(),
      forecastRoute(),
      safeToSpendRoute(),
      transactionsRoute('Spotify', 'merch_spotify'),
    ]);

    renderScreen();

    expect(await screen.findByText('Spotify')).toBeInTheDocument();
    expect(screen.getByText(/Monthly/)).toBeInTheDocument();
    expect(screen.getByText('Next due Jul 1')).toBeInTheDocument();
    expect(screen.getByText("Might be slowing down — we're watching")).toBeInTheDocument();
  });

  it('shows the latest price change alongside a series that has one (wp3.14-carryovers.md item 4)', async () => {
    const withPriceChange = {
      ...SERIES,
      priceChangeEvents: [
        {
          id: 'pce_1',
          direction: 'INCREASE' as const,
          effectiveDate: '2026-05-15',
          fromAmount: { minor: '899', currency: 'USD' },
          toAmount: { minor: '999', currency: 'USD' },
          deltaAmount: { minor: '100', currency: 'USD' },
          annualImpact: { minor: '1200', currency: 'USD' },
          confirmed: true,
        },
      ],
    };
    stubFetchRoutes([
      { match: '/api/recurring/candidates', handle: () => jsonResponse({ candidates: [] }) },
      {
        match: '/api/recurring/series',
        handle: () => jsonResponse({ series: [withPriceChange] }),
      },
      upcomingRoute(),
      forecastRoute(),
      safeToSpendRoute(),
      transactionsRoute('Spotify', 'merch_spotify'),
    ]);

    renderScreen();

    expect(await screen.findByText('Spotify')).toBeInTheDocument();
    expect(screen.getByText(/Price increased to/)).toBeInTheDocument();
    expect(screen.getByText(/2026-05-15/)).toBeInTheDocument();
  });

  it('renders the safe-to-spend figure and forecast headline from the real routes', async () => {
    stubFetchRoutes([
      { match: '/api/recurring/candidates', handle: () => jsonResponse({ candidates: [] }) },
      { match: '/api/recurring/series', handle: () => jsonResponse({ series: [SERIES] }) },
      upcomingRoute(),
      forecastRoute(),
      safeToSpendRoute(),
      transactionsRoute('Spotify', 'merch_spotify'),
    ]);

    renderScreen();

    expect(await screen.findByText('Safe to spend')).toBeInTheDocument();
    expect(await screen.findByText('+$2,488.00')).toBeInTheDocument();
  });
});
