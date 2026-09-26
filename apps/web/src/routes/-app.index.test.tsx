// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureApiClient, jsonResponse, stubFetchRoutes } from '../test-support/api-test-utils.ts';
import { NetWorthHero } from './_app.index.tsx';

/**
 * Phase 3 gate finding G3-2 (docs/evidence/phase-3/gate-security-review.md).
 *
 * The dashboard hero used to render two scaffold literals — `$88,904.00` and
 * "+$4,210.00 2.1% this month" — on every install, whatever the database
 * held, directly above a chart drawn from `GET /net-worth/series`. These tests
 * pin that the hero shows the series' own latest valued day and, with no
 * valued day, shows no number at all.
 */
function point(asOfDate: string, minor: string | null, sealed: boolean) {
  return {
    asOfDate,
    netWorth: minor === null ? null : { minor, currency: 'USD' },
    assets: null,
    liabilities: null,
    liquid: null,
    investable: null,
    onBudget: null,
    sealed,
    sealedAt: null,
    revision: minor === null ? 0 : 1,
    source: minor === null ? null : 'observed',
    stalePrice: false,
    dirty: false,
    accountsCounted: minor === null ? null : 3,
    accountsUnvalued: minor === null ? null : 0,
    correctionReason: null,
  };
}

function renderHero(points: ReturnType<typeof point>[]) {
  stubFetchRoutes([
    {
      match: '/api/net-worth/series',
      method: 'GET',
      handle: () =>
        jsonResponse({ from: '2026-06-28', to: '2026-09-26', baseCurrency: 'USD', points }),
    },
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NetWorthHero />
    </QueryClientProvider>,
  );
}

describe('dashboard net-worth hero (gate G3-2)', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the latest valued day from GET /net-worth/series, never a literal', async () => {
    const { container } = renderHero([
      point('2026-09-24', '17000000', true),
      point('2026-09-25', null, false),
      point('2026-09-26', '17649961', false),
    ]);
    expect(await screen.findByText(/As of 2026-09-26/)).toBeInTheDocument();
    expect(container.textContent).toContain('176,499.61');
    expect(container.textContent).not.toContain('88,904');
    expect(container.textContent).not.toContain('4,210');
  });

  it('shows no number at all when no day has a value yet', async () => {
    const { container } = renderHero([
      point('2026-09-25', null, false),
      point('2026-09-26', null, false),
    ]);
    expect(await screen.findByText('No net worth recorded yet')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\$\s?\d/);
  });
});
