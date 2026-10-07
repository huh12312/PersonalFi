// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../../test-support/api-test-utils.ts';
import { baselineScenario, projectionResponse } from '../fixtures.ts';
import { GoalSliders } from './GoalSliders.tsx';
import type { ProjectionRun } from '../../../api/generated/types.gen.ts';

const money = (minor: string) => ({ minor, currency: 'USD' });

function seriesRoute(points: unknown[] | 'failure'): FetchRoute {
  return {
    match: '/api/net-worth/series',
    handle: () =>
      points === 'failure'
        ? jsonResponse({ type: 'about:blank', title: 'Error', status: 500, code: 'internal' }, 500)
        : jsonResponse({
            from: '2026-08-01',
            to: '2026-10-04',
            baseCurrency: 'USD',
            points,
            lastSnapshotFailure: null,
          }),
  };
}

const sealedPoint = {
  asOfDate: '2026-10-02',
  netWorth: money('90000000'),
  assets: money('95000000'),
  liabilities: money('5000000'),
  liquid: money('1000000'),
  investable: money('61234500'),
  onBudget: money('1000000'),
  sealed: true,
  sealedAt: '2026-10-02T07:00:00.000Z',
  revision: 1,
  source: 'snapshot',
  stalePrice: false,
  dirty: false,
  accountsCounted: 3,
  accountsUnvalued: 0,
  correctionReason: null,
};

function projectionRoute(method: ProjectionRun['method'] = 'monte_carlo'): FetchRoute {
  const base = projectionResponse();
  return {
    match: /^\/api\/plan\/scenarios\/[^/]+\/projections$/,
    method: 'POST',
    handle: () =>
      jsonResponse({
        ...base,
        run: {
          ...(base.run as ProjectionRun),
          method,
          paths: method === 'monte_carlo' ? 10_000 : 1,
          successProbability: method === 'monte_carlo' ? '0.82' : '1',
        },
      }),
  };
}

function renderSliders() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <GoalSliders scenario={baselineScenario()} />
    </QueryClientProvider>,
  );
}

describe('GoalSliders (WP 9.7, G4-11, G4-13)', () => {
  beforeEach(() => {
    ensureApiClient();
    // happy-dom has no Worker: the panel runs in its server-fallback mode, which is what these tests need.
    vi.stubGlobal('Worker', undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('starts from the newest sealed net-worth day and says so', async () => {
    stubFetchRoutes([seriesRoute([sealedPoint]), projectionRoute()]);
    renderSliders();

    const source = await screen.findByText(/investable balance on 2026-10-02/);
    expect(source).toHaveAttribute('data-start-source', 'sealed');
    expect(screen.getByRole('spinbutton', { name: 'Starting balance' })).toHaveValue(612345);
    expect(screen.queryByTestId('slider-placeholder-note')).not.toBeInTheDocument();
  });

  it('labels the starting balance a placeholder when there is no sealed day', async () => {
    stubFetchRoutes([seriesRoute([{ ...sealedPoint, sealed: false }]), projectionRoute()]);
    renderSliders();

    const source = await screen.findByTestId('slider-start-source');
    await waitFor(() => expect(source).toHaveAttribute('data-start-source', 'placeholder'));
    expect(source).toHaveTextContent(/placeholder, not your data/);
    expect(screen.getByRole('spinbutton', { name: 'Starting balance' })).toHaveValue(250000);
    expect(await screen.findByTestId('slider-placeholder-note')).toHaveTextContent(
      /illustration only/i,
    );
  });

  it('labels it a placeholder when the series cannot be read', async () => {
    stubFetchRoutes([seriesRoute('failure'), projectionRoute()]);
    renderSliders();
    expect(await screen.findByText(/net-worth series could not be read/)).toHaveAttribute(
      'data-start-source',
      'placeholder',
    );
  });

  it('names spending and savings the saved plan does not state as placeholders too', async () => {
    stubFetchRoutes([seriesRoute([sealedPoint]), projectionRoute()]);
    renderSliders();
    expect(await screen.findByTestId('slider-lever-placeholders')).toHaveTextContent(
      /annual spending and monthly savings are also a placeholder/i,
    );
  });

  it('never quotes a deterministic saved plan as a share of paths when the worker is unavailable', async () => {
    stubFetchRoutes([seriesRoute([]), projectionRoute('deterministic')]);
    renderSliders();
    const fallback = await screen.findByTestId('slider-worker-fallback');
    expect(fallback).toHaveTextContent('single deterministic path');
    expect(fallback.textContent).not.toMatch(/%|paths|probab/i);
  });

  it('still quotes a Monte Carlo saved plan as a share of simulated paths', async () => {
    stubFetchRoutes([seriesRoute([]), projectionRoute('monte_carlo')]);
    renderSliders();
    expect(await screen.findByTestId('slider-worker-fallback')).toHaveTextContent(
      '82% of simulated paths succeed',
    );
  });
});
