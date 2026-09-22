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
import type { Insight } from '../../api/generated/types.gen.ts';
import { InsightsScreen } from './InsightsScreen.tsx';

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <InsightsScreen />
    </QueryClientProvider>,
  );
}

function buildInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'insight_1',
    advisorId: 'builtin.subscriptions.price_increase',
    advisorVersion: '1.0.0',
    key: 'subscription.price_increase.merch_1.2026-06-01',
    period: '2026-06',
    type: 'subscription.price_increase',
    severity: 'notable',
    severityClamped: false,
    title: 'A subscription went up in price',
    summaryMd: 'One of your subscriptions increased from $15.99 to $18.99 a month.',
    confidence: 0.9,
    confidenceBasis: 'deterministic',
    horizon: 'this_year',
    status: 'pending_review',
    annualizedImpact: { minor: '3600', currency: 'USD' },
    oneTimeImpact: null,
    impactBasis: 'The difference between the old and new monthly price, annualized.',
    caveats: [],
    inputDigest: 'sha256:abc',
    firstProposedAt: '2026-06-02T00:00:00.000Z',
    lastProposedAt: '2026-06-02T00:00:00.000Z',
    expiresAt: null,
    evidence: [
      {
        position: 0,
        kind: 'metric',
        label: 'New monthly price',
        value: '$18.99',
        sourceRef: 'snapshot:recurring_list.streams[0].typical_amount',
        resolvedDisplay: '$18.99',
        href: '/transactions?q=CafeSprocket',
      },
    ],
    actions: [],
    ...overrides,
  };
}

function feedRoute(insights: readonly Insight[]): FetchRoute {
  return {
    match: '/api/insights',
    handle: () =>
      jsonResponse({ dashboard: insights, list: insights, overflow: [], belowFloor: [] }),
  };
}

function advisorsRoute(): FetchRoute {
  return {
    match: '/api/advisors',
    handle: () =>
      jsonResponse({
        advisors: [
          {
            advisorId: 'builtin.subscriptions.price_increase',
            displayName: 'Subscription price increases',
            kind: 'builtin',
            version: '1',
            enabled: true,
            quarantinedAt: null,
            quarantineReason: null,
            consecutiveFailures: 0,
            lastRunAt: null,
            grantedScopes: ['recurring.list'],
            lastRunStatus: null,
            lastRunRejected: null,
          },
        ],
      }),
  };
}

describe('InsightsScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the all-caught-up empty state when the feed is empty', async () => {
    stubFetchRoutes([feedRoute([]), advisorsRoute()]);

    renderScreen();

    expect(await screen.findByText("You're all caught up")).toBeInTheDocument();
  });

  it('lists an insight with its severity, impact and confidence', async () => {
    stubFetchRoutes([feedRoute([buildInsight()]), advisorsRoute()]);

    renderScreen();

    expect(await screen.findByText('A subscription went up in price')).toBeInTheDocument();
    expect(screen.getByText('Notable')).toBeInTheDocument();
    expect(screen.getByText('90% confidence')).toBeInTheDocument();
    expect(screen.getByText('+$36.00')).toBeInTheDocument();
  });

  it("opening the evidence panel shows a number that equals the insight's own evidence value, with its source named", async () => {
    stubFetchRoutes([feedRoute([buildInsight()]), advisorsRoute()]);
    renderScreen();
    const user = userEvent.setup();

    await screen.findByText('A subscription went up in price');
    await user.click(screen.getByRole('button', { name: 'View evidence panel' }));

    const panel = await screen.findByTestId('evidence-panel');
    expect(panel).toHaveTextContent('New monthly price');
    expect(panel).toHaveTextContent('$18.99');
    expect(panel).toHaveTextContent('snapshot:recurring_list.streams[0].typical_amount');
    expect(panel).toHaveTextContent('builtin.subscriptions.price_increase');

    const link = screen.getByRole('link', { name: 'View transaction' });
    expect(link).toHaveAttribute('href', '/transactions?q=CafeSprocket');
  });

  it('accepting an insight calls the review route with action "accept"', async () => {
    let reviewedBody: unknown = null;
    stubFetchRoutes([
      feedRoute([buildInsight()]),
      advisorsRoute(),
      {
        match: '/api/insights/insight_1/review',
        method: 'POST',
        handle: async ({ request }) => {
          reviewedBody = await request.json();
          return jsonResponse({
            insightId: 'insight_1',
            status: 'accepted',
            dismissCount: 0,
            permanent: false,
            suppressedUntil: null,
          });
        },
      },
    ]);
    renderScreen();
    const user = userEvent.setup();

    await screen.findByText('A subscription went up in price');
    await user.click(screen.getByRole('button', { name: 'Accept' }));

    await waitFor(() => expect(reviewedBody).toEqual({ action: 'accept' }));
  });

  it('dismissing an insight captures a reason and shows the cooldown notice', async () => {
    let reviewedBody: unknown = null;
    stubFetchRoutes([
      feedRoute([buildInsight()]),
      advisorsRoute(),
      {
        match: '/api/insights/insight_1/review',
        method: 'POST',
        handle: async ({ request }) => {
          reviewedBody = await request.json();
          return jsonResponse({
            insightId: 'insight_1',
            status: 'dismissed',
            dismissCount: 1,
            permanent: false,
            suppressedUntil: '2026-07-02T00:00:00.000Z',
          });
        },
      },
    ]);
    renderScreen();
    const user = userEvent.setup();

    await screen.findByText('A subscription went up in price');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('radio', { name: 'Not useful' }));
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(reviewedBody).toEqual({ action: 'dismiss', reason: 'Not useful' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Dismissed until');
  });

  it('no proposed action ever renders as something that performs a transfer', async () => {
    const insight = buildInsight({
      actions: [
        {
          position: 0,
          kind: 'suggest_only',
          label: 'Consider cancelling',
          rationaleMd: '',
          url: null,
        },
        {
          position: 1,
          kind: 'open_url',
          label: 'Compare plans',
          rationaleMd: '',
          url: 'https://example.com',
        },
        {
          position: 2,
          kind: 'create_rule_draft',
          label: 'Draft a rule',
          rationaleMd: '',
          url: null,
        },
        {
          position: 3,
          kind: 'create_goal_draft',
          label: 'Draft a goal',
          rationaleMd: '',
          url: null,
        },
      ],
    });
    stubFetchRoutes([feedRoute([insight]), advisorsRoute()]);
    renderScreen();
    const user = userEvent.setup();

    await screen.findByText('A subscription went up in price');
    await user.click(screen.getByRole('button', { name: 'View evidence panel' }));

    // Every rendered action is inert text, except `open_url`, which is a
    // plain external link — never a button that calls a mutation, and never
    // labelled or wired to anything transfer-shaped.
    expect(screen.queryByRole('button', { name: /transfer/i })).not.toBeInTheDocument();
    const externalLink = screen.getByRole('link', { name: 'Compare plans' });
    expect(externalLink).toHaveAttribute('href', 'https://example.com');
    expect(externalLink).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Draft a rule')).toBeInTheDocument();
    expect(screen.getByText('Draft a goal')).toBeInTheDocument();
  });
});
