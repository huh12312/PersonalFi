// SPDX-License-Identifier: MIT
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HealthOverview } from '../../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../../test-support/api-test-utils.ts';
import { overviewFixture } from '../../health/test-fixtures.ts';
import { renderWidget } from '../test-utils.tsx';
import { FinancialHealthWidget } from './FinancialHealthWidget.tsx';

function serve(body: HealthOverview | number): string[] {
  const requests: string[] = [];
  stubFetchRoutes([
    {
      match: '/api/insights/health',
      handle: ({ url }) => {
        requests.push(url.pathname);
        return typeof body === 'number'
          ? jsonResponse(
              {
                type: 'about:blank',
                title: 'x',
                status: body,
                code: body === 404 ? 'insights.health_not_computed' : 'x',
                correlationId: 'c',
              },
              body,
            )
          : jsonResponse({ health: body });
      },
    },
  ]);
  return requests;
}

describe('the Financial health widget (WP 10.12)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the gauge at sm, the tier in words and the 30-day change; See all opens /health', async () => {
    const requests = serve(overviewFixture());
    renderWidget(<FinancialHealthWidget />);
    const card = await screen.findByRole('region', { name: 'Financial health' });
    expect(await within(card).findByTestId('widget-health-tier')).toHaveTextContent('Steady');
    expect(within(card).getByTestId('widget-health-delta')).toHaveTextContent(
      'Up 4.5 points from 30 days ago',
    );
    expect(card.querySelector('[data-score-gauge="sm"]')).not.toBeNull();
    expect(within(card).getByRole('img', { name: /75 out of 100, Steady/u })).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: /See all/u })).toHaveAttribute('href', '/health');
    expect(requests).toEqual(['/api/insights/health']);
    // Today's snapshot: no "as of" line.
    expect(within(card).queryByTestId('widget-as-of')).not.toBeInTheDocument();
  });

  it('an older snapshot says its date', async () => {
    serve(overviewFixture({ today: '2026-10-19' }));
    renderWidget(<FinancialHealthWidget />);
    expect(await screen.findByTestId('widget-as-of')).toHaveTextContent('As of Oct 18, 2026');
  });

  it('no score yet, or nothing computed: words and a link, never a zero gauge', async () => {
    serve(overviewFixture({ score: null }));
    renderWidget(<FinancialHealthWidget />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent(
      'There isn’t enough data to score yet.',
    );
    expect(document.querySelector('[data-score-gauge]')).toBeNull();
  });

  it('a 404 reads as "not computed yet"', async () => {
    serve(404);
    renderWidget(<FinancialHealthWidget />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent(
      'Your first health score hasn’t been computed yet.',
    );
  });
});
