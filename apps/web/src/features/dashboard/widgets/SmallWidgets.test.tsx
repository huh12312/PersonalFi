// SPDX-License-Identifier: MIT
import { fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTransaction,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../../test-support/api-test-utils.ts';
import { renderWidget } from '../test-utils.tsx';
import { netWorthDelta } from './net-worth-delta.ts';
import { NetWorthWidget } from './NetWorthWidget.tsx';
import { ToReviewWidget } from './ToReviewWidget.tsx';
import { TopInsightsDashboardWidget } from './TopInsightsDashboardWidget.tsx';

function point(asOfDate: string, minor: string | null, currency = 'USD') {
  return {
    asOfDate,
    netWorth: minor === null ? null : { minor, currency },
    assets: null,
    liabilities: null,
    liquid: null,
    investable: null,
    onBudget: null,
    sealed: true,
    sealedAt: null,
    revision: 1,
    source: minor === null ? null : 'observed',
    stalePrice: false,
    dirty: false,
    accountsCounted: 1,
    accountsUnvalued: 0,
    correctionReason: null,
  };
}

beforeEach(() => ensureApiClient());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('netWorthDelta (WP 10.9)', () => {
  it('latest valued day against the first valued day in the same currency', () => {
    const delta = netWorthDelta([
      point('2026-03-01', null),
      point('2026-03-02', '1000000'),
      point('2026-03-17', '1050000'),
    ]);
    expect(delta?.change.minor).toBe(50_000n);
    expect(delta?.ratio).toBeCloseTo(0.05);
    expect(delta?.from).toBe('2026-03-02');
  });

  it('fewer than two valued days is no delta, never +$0', () => {
    expect(netWorthDelta([point('2026-03-17', '1050000'), point('2026-03-16', null)])).toBeNull();
    expect(netWorthDelta([])).toBeNull();
  });

  it('never compares across currencies', () => {
    const delta = netWorthDelta([
      point('2026-03-01', '900', 'EUR'),
      point('2026-03-17', '1000', 'USD'),
    ]);
    expect(delta).toBeNull();
  });
});

describe('NetWorthWidget (WP 10.9)', () => {
  it('period chips ask for their own window; the delta names the period', async () => {
    const asked: string[] = [];
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: ({ url }) => {
          asked.push(`${url.searchParams.get('from') ?? ''}..${url.searchParams.get('to') ?? ''}`);
          return jsonResponse({
            from: url.searchParams.get('from'),
            to: url.searchParams.get('to'),
            baseCurrency: 'USD',
            lastSnapshotFailure: null,
            points: [point('2026-01-01', '1000000'), point('2026-03-17', '1100000')],
          });
        },
      },
    ]);
    renderWidget(<NetWorthWidget />);
    expect(await screen.findByTestId('net-worth-delta')).toHaveTextContent(
      /\+\$1,000\.00.*\(\+10%\).*over the last 3 months/u,
    );
    expect(screen.getByRole('button', { name: /^3M.*the last 3 months$/u })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: /^6M.*the last 6 months$/u }));
    expect(await screen.findByText(/over the last 6 months/u)).toBeInTheDocument();
    const spans = asked.map((range) => {
      const [from, to] = range.split('..');
      return (Date.parse(`${to!}T00:00:00Z`) - Date.parse(`${from!}T00:00:00Z`)) / 86_400_000 + 1;
    });
    expect(new Set(spans)).toEqual(new Set([90, 182]));
  });

  it('a failed read is the error state, asked once — not a loop of remounting refetches', async () => {
    let asked = 0;
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () => {
          asked += 1;
          return jsonResponse({ code: 'internal' }, 503);
        },
      },
    ]);
    renderWidget(<NetWorthWidget />);
    expect(await screen.findByTestId('widget-error')).toHaveTextContent(
      "Net worth history isn't available right now.",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(asked).toBe(1);
  });

  it('no net worth yet: "—" and no delta, never a literal', async () => {
    stubFetchRoutes([
      {
        match: '/api/net-worth/series',
        method: 'GET',
        handle: () =>
          jsonResponse({
            from: 'x',
            to: 'y',
            baseCurrency: 'USD',
            lastSnapshotFailure: null,
            points: [point('2026-03-17', null)],
          }),
      },
    ]);
    renderWidget(<NetWorthWidget />);
    expect(await screen.findByLabelText('No net worth recorded yet')).toBeInTheDocument();
    expect(screen.queryByTestId('net-worth-delta')).toBeNull();
  });
});

function serveInbox(uncategorized: number, nextCursor: string | null = null) {
  stubFetchRoutes([
    {
      match: '/api/transactions',
      method: 'GET',
      handle: ({ url }) =>
        url.searchParams.get('uncategorized') === 'true'
          ? jsonResponse({
              items: Array.from({ length: uncategorized }, (_unused, index) =>
                buildTransaction({ id: `t${String(index)}`, merchantId: `m${String(index)}` }),
              ),
              nextCursor,
              summary: null,
            })
          : jsonResponse({ items: [], nextCursor: null, summary: null }),
    },
  ]);
}

describe('ToReviewWidget (WP 10.9)', () => {
  it('counts the inbox’s own queue and links to it', async () => {
    serveInbox(3);
    renderWidget(<ToReviewWidget />);
    const count = await screen.findByTestId('to-review-count');
    expect(count.textContent).toBe('3 items to review');
    expect(screen.getByRole('link', { name: '3' })).toHaveAttribute('href', '/inbox');
  });

  it('a count at the page limit is "at least"', async () => {
    serveInbox(2, 'cursor');
    renderWidget(<ToReviewWidget />);
    expect((await screen.findByTestId('to-review-count')).textContent).toBe('2+ items to review');
  });

  it('nothing to review is said in words', async () => {
    serveInbox(0);
    renderWidget(<ToReviewWidget />);
    expect((await screen.findByTestId('to-review-count')).textContent).toContain(
      "You're all caught up",
    );
  });
});

describe('TopInsightsDashboardWidget (WP 10.9)', () => {
  it('no insight waiting is an empty state with the link, not an empty card', async () => {
    stubFetchRoutes([
      {
        match: '/api/insights',
        method: 'GET',
        handle: () => jsonResponse({ dashboard: [], list: [], overflow: [], belowFloor: [] }),
      },
    ]);
    renderWidget(<TopInsightsDashboardWidget />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent('No insights are waiting');
    expect(screen.getByRole('link', { name: 'Open insights' })).toHaveAttribute(
      'href',
      '/insights',
    );
  });
});
