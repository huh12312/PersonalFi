// SPDX-License-Identifier: MIT
import { screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import type { HealthScore as HealthScoreResult } from '../../api/generated/types.gen.ts';
import { renderWidget } from '../dashboard/test-utils.tsx';
import { HealthScoreSection } from './HealthScoreSection.tsx';

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
        weight: '1.000000',
        score: 75,
        direction: 'improved',
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

/** WP 10.12: the Brief's health section is a link to `/health`, with the week's stored score beside it. */
describe('HealthScoreSection (a link to /health since WP 10.12)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("names the week's stored score and links to the Financial health screen", async () => {
    stubFetchRoutes([healthScoreRoute(buildResult())]);
    renderWidget(<HealthScoreSection />);
    expect(await screen.findByTestId('health-score-overall')).toHaveTextContent(
      'This week’s score: 72.5 / 100.',
    );
    expect(screen.getByRole('link', { name: /Open Financial health/u })).toHaveAttribute(
      'href',
      '/health',
    );
    // The six rows moved to /health: nothing component-by-component is drawn here any more.
    expect(screen.queryByTestId('health-component-row')).not.toBeInTheDocument();
  });

  it('a 404 health_score_not_computed reads as "not computed yet", not as an error, and still links', async () => {
    stubFetchRoutes([notComputedRoute()]);
    renderWidget(<HealthScoreSection />);
    expect(await screen.findByTestId('health-score-overall')).toHaveTextContent('not computed yet');
    expect(screen.getByRole('link', { name: /Open Financial health/u })).toBeInTheDocument();
  });

  it('a week with every component excluded says so — never "0 / 100"', async () => {
    stubFetchRoutes([healthScoreRoute(buildResult({ overall: null, components: [] }))]);
    renderWidget(<HealthScoreSection />);
    const line = await screen.findByTestId('health-score-overall');
    expect(line).toHaveTextContent('not enough data');
    expect(line).not.toHaveTextContent('0 / 100');
  });
});
