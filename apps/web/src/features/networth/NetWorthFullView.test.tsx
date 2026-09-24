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
import { NetWorthFullView } from './NetWorthFullView.tsx';

function seriesResponse(
  points: Array<{
    asOfDate: string;
    currency?: string;
    minor?: string;
    sealed?: boolean;
    source?: string | null;
    correctionReason?: string | null;
  }>,
) {
  return {
    from: points[0]?.asOfDate ?? '2026-07-03',
    to: points.at(-1)?.asOfDate ?? '2026-09-30',
    baseCurrency: 'USD',
    points: points.map((p) => ({
      asOfDate: p.asOfDate,
      netWorth: p.minor === undefined ? null : { minor: p.minor, currency: p.currency ?? 'USD' },
      assets: null,
      liabilities: null,
      liquid: null,
      investable: null,
      onBudget: null,
      sealed: p.sealed ?? true,
      sealedAt: null,
      revision: 1,
      source: p.source ?? 'observed',
      stalePrice: false,
      dirty: false,
      accountsCounted: 1,
      accountsUnvalued: 0,
      correctionReason: p.correctionReason ?? null,
    })),
  };
}

function renderFullView(onRangeChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <NetWorthFullView range="p90d" onRangeChange={onRangeChange} />
    </QueryClientProvider>,
  );
  return { onRangeChange };
}

describe('NetWorthFullView', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders one series label per currency and never a blended total', async () => {
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () =>
          jsonResponse(
            seriesResponse([
              { asOfDate: '2026-09-01', currency: 'USD', minor: '100000' },
              { asOfDate: '2026-09-02', currency: 'CAD', minor: '8000' },
            ]),
          ),
      },
    ]);

    renderFullView();

    expect(await screen.findByText('USD')).toBeInTheDocument();
    expect(screen.getByText('CAD')).toBeInTheDocument();
    expect(screen.getByText(/never summed into one total, because no FX rate/)).toBeInTheDocument();
  });

  it('does not show the multi-currency notice for a single-currency window', async () => {
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () =>
          jsonResponse(
            seriesResponse([{ asOfDate: '2026-09-01', currency: 'USD', minor: '100000' }]),
          ),
      },
    ]);

    renderFullView();

    await screen.findByText('Every day in this window has an observed or corrected value.');
    expect(screen.queryByText(/never summed into one total/)).not.toBeInTheDocument();
  });

  it('labels an interpolated day and reports the count', async () => {
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () =>
          jsonResponse(
            seriesResponse([
              { asOfDate: '2026-09-01', currency: 'USD', minor: '100000', source: 'observed' },
              { asOfDate: '2026-09-02', currency: 'USD', minor: '100200', source: 'interpolated' },
            ]),
          ),
      },
    ]);

    renderFullView();

    expect(
      await screen.findByText(
        '1 day has no observation in this window and is interpolated from neighbouring days.',
      ),
    ).toBeInTheDocument();
  });

  it("distinguishes a sealed day from today's live (unsealed) row in the recent-day table", async () => {
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () =>
          jsonResponse(
            seriesResponse([
              { asOfDate: '2026-09-01', currency: 'USD', minor: '100000', sealed: true },
              { asOfDate: '2026-09-02', currency: 'USD', minor: '100500', sealed: false },
            ]),
          ),
      },
    ]);

    renderFullView();

    expect(await screen.findByText('Sealed')).toBeInTheDocument();
    expect(screen.getByText('Live (unsealed)')).toBeInTheDocument();
  });

  it('shows a correction reason when a day carries one', async () => {
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () =>
          jsonResponse(
            seriesResponse([
              {
                asOfDate: '2026-09-01',
                currency: 'USD',
                minor: '100000',
                source: 'corrected',
                correctionReason: 'Late-arriving statement balance',
              },
            ]),
          ),
      },
    ]);

    renderFullView();

    expect(await screen.findByText('Late-arriving statement balance')).toBeInTheDocument();
  });

  it('calls onRangeChange when a different range button is clicked', async () => {
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () => jsonResponse(seriesResponse([])),
      },
    ]);

    const { onRangeChange } = renderFullView();
    const user = userEvent.setup();

    await screen.findByRole('group', { name: 'Date range' });
    await user.click(screen.getByRole('button', { name: '1 year' }));

    expect(onRangeChange).toHaveBeenCalledWith('p1y');
  });

  it('refetches the series when Refresh is clicked, proving it is a real network round trip', async () => {
    let calls = 0;
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () => {
          calls += 1;
          return jsonResponse(
            seriesResponse([
              { asOfDate: '2026-09-01', currency: 'USD', minor: String(100000 + calls) },
            ]),
          );
        },
      },
    ]);

    renderFullView();
    const user = userEvent.setup();

    await screen.findByText('Every day in this window has an observed or corrected value.');
    expect(calls).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(calls).toBe(2));
  });
});
