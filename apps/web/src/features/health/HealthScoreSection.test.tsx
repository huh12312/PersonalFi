// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { HealthScoreSection } from './HealthScoreSection.tsx';
import type { HealthScoreResult } from './types.ts';

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <HealthScoreSection />
    </QueryClientProvider>,
  );
}

function buildResult(overrides: Partial<HealthScoreResult> = {}): HealthScoreResult {
  return {
    isoWeek: '2026-W40',
    computedAt: '2026-10-04T06:00:00.000Z',
    overall: 72.5,
    components: [
      {
        component: 'emergency_fund_months',
        value: '4.50',
        band: 'good',
        weight: '0.230000',
        score: 75,
        direction: 'improved',
      },
      {
        component: 'savings_rate',
        value: '0.120000',
        band: 'fair',
        weight: '0.230000',
        score: 50,
        direction: 'worsened',
      },
      {
        component: 'debt_to_income',
        value: '0.180000',
        band: 'excellent',
        weight: '0.230000',
        score: 100,
        direction: 'unchanged',
      },
      {
        component: 'subscription_load',
        value: '0.070000',
        band: 'good',
        weight: '0.150000',
        score: 75,
        direction: 'no_previous_data',
      },
      {
        component: 'diversification',
        value: '0.080000',
        band: 'good',
        weight: '0.080000',
        score: 75,
        direction: 'improved',
      },
      {
        component: 'fee_drag',
        value: { minor: '12000', currency: 'USD' },
        band: 'poor',
        weight: '0.090000',
        score: 25,
        direction: 'worsened',
      },
    ],
    excluded: [],
    ...overrides,
  };
}

function healthScoreRoute(result: HealthScoreResult): FetchRoute {
  return {
    match: '/api/insights/health-score',
    handle: () => jsonResponse({ healthScore: result }),
  };
}

function notComputedRoute(): FetchRoute {
  return {
    match: '/api/insights/health-score',
    handle: () =>
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          code: 'insights.health_score_not_computed',
          correlationId: 'corr_1',
        },
        404,
      ),
  };
}

describe('HealthScoreSection', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a 404 health_score_not_computed renders as "not computed yet", not as an error', async () => {
    stubFetchRoutes([notComputedRoute()]);

    renderSection();

    expect(await screen.findByTestId('health-score-not-computed')).toHaveTextContent(
      'Not computed yet',
    );
    expect(screen.queryByTestId('health-score-error')).not.toBeInTheDocument();
  });

  it('every health component shows value, weight and direction in words', async () => {
    stubFetchRoutes([healthScoreRoute(buildResult())]);

    renderSection();

    const rows = await screen.findAllByTestId('health-component-row');
    expect(rows).toHaveLength(6);

    const emergencyFund = rows.find((row) => row.textContent?.includes('Emergency fund'));
    expect(emergencyFund).toBeDefined();
    expect(within(emergencyFund!).getByText('4.50 months')).toBeInTheDocument();
    expect(within(emergencyFund!).getByText('Weight: 23.0%')).toBeInTheDocument();
    // The direction word, in words — "Improved" — not merely a glyph or a colour.
    expect(within(emergencyFund!).getByText('Improved')).toBeInTheDocument();
    expect(within(emergencyFund!).getByText('Good')).toBeInTheDocument();

    const savingsRate = rows.find((row) => row.textContent?.includes('Savings rate'));
    expect(within(savingsRate!).getByText('12.0%')).toBeInTheDocument();
    expect(within(savingsRate!).getByText('Worsened')).toBeInTheDocument();

    const feeDrag = rows.find((row) => row.textContent?.includes('Fee drag'));
    // `fee_drag`'s value is MoneyJson — rendered through the real `<Money>`
    // component, never a parsed-to-number ratio.
    expect(within(feeDrag!).getByText('+$120.00')).toBeInTheDocument();
    expect(within(feeDrag!).getByText('Poor')).toBeInTheDocument();

    const subscriptionLoad = rows.find((row) => row.textContent?.includes('Subscription load'));
    expect(within(subscriptionLoad!).getByText('No previous week to compare')).toBeInTheDocument();

    // The overall figure never appears without its six-row breakdown — this
    // same render always shows both.
    expect(screen.getByTestId('health-score-overall')).toHaveTextContent('72.5 / 100');
  });

  it('an excluded component is named, with its reason, never scored as zero', async () => {
    const result = buildResult({
      overall: null,
      components: buildResult().components.slice(0, 5),
      excluded: [{ component: 'fee_drag', reason: 'fees.summary was not granted' }],
    });
    stubFetchRoutes([healthScoreRoute(result)]);

    renderSection();

    const excluded = await screen.findByTestId('health-excluded');
    expect(excluded).toHaveTextContent('Fee drag');
    expect(excluded).toHaveTextContent('fees.summary was not granted');
    // Not present among the six scored rows.
    expect(screen.getAllByTestId('health-component-row')).toHaveLength(5);
    expect(screen.getByTestId('health-score-overall')).toHaveTextContent('not enough data');
  });

  it('a direction word is present beside its glyph — the test the "glyph without its word" sabotage is run against', async () => {
    stubFetchRoutes([healthScoreRoute(buildResult())]);

    renderSection();

    const rows = await screen.findAllByTestId('health-component-row');
    const debtToIncome = rows.find((row) => row.textContent?.includes('Debt-to-income'));
    // The glyph alone ('→') is `aria-hidden` and never the only signal; the
    // word "Unchanged" must also be literally present in the DOM text.
    expect(within(debtToIncome!).getByText('Unchanged')).toBeInTheDocument();
  });
});
