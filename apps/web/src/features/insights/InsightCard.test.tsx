// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Insight } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { InsightCard } from './InsightCard.tsx';
import { InsightsScreen } from './InsightsScreen.tsx';
import { mentionHref, segmentsFor, valueLineOf, verifiedMentionOf } from './mentions.ts';

/**
 * WP 10.15 (V8): the insight card's entity mentions (backed by its own evidence or drawn as plain words), its
 * value line, its bookmark and its Helpful / Not helpful answer; and the Insights screen's Bookmarked filter.
 */

const INSIGHT_ID = '0190a000-0000-7000-8000-0000000000aa';
const CATEGORY = '0190a000-0000-7000-8000-000000000001';
const ACCOUNT = '0190a000-0000-7000-8000-000000000002';
const STRANGER = '0190a000-0000-7000-8000-00000000dead';

function buildInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: INSIGHT_ID,
    advisorId: 'builtin.spending.category_creep',
    advisorVersion: '1.0.0',
    key: 'spending.category_creep',
    period: '2026-09',
    type: 'spending.category_creep',
    severity: 'notable',
    severityClamped: false,
    title: 'Groceries ran higher than usual',
    summaryMd: 'Spending in Groceries from Everyday Checking rose.',
    confidence: 1,
    confidenceBasis: 'deterministic',
    horizon: 'this_year',
    status: 'pending_review',
    annualizedImpact: { minor: '3600', currency: 'USD' },
    oneTimeImpact: null,
    impactBasis: 'b',
    caveats: [],
    inputDigest: 'sha256:abc',
    firstProposedAt: '2026-09-02T00:00:00.000Z',
    lastProposedAt: '2026-09-02T00:00:00.000Z',
    expiresAt: null,
    evidence: [
      {
        position: 0,
        kind: 'metric',
        label: 'The category',
        value: null,
        sourceRef: 'snapshot:spending_summary.by_category[0].category_ref',
        resolvedDisplay: CATEGORY,
        href: null,
      },
      {
        position: 1,
        kind: 'metric',
        label: 'The account',
        value: null,
        sourceRef: 'snapshot:cash_summary.accounts[0].account_ref',
        resolvedDisplay: ACCOUNT,
        href: null,
      },
    ],
    actions: [],
    bookmarkedAt: null,
    feedback: null,
    feedbackReason: null,
    mentions: [
      { text: 'Groceries', entityType: 'category', entityId: CATEGORY, evidencePosition: 0 },
      { text: 'Everyday Checking', entityType: 'account', entityId: ACCOUNT, evidencePosition: 1 },
    ],
    titleSegments: [
      { text: 'Groceries', entityType: 'category', entityId: CATEGORY },
      { text: ' ran higher than usual' },
    ],
    bodySegments: [
      { text: 'Spending in ' },
      { text: 'Groceries', entityType: 'category', entityId: CATEGORY },
      { text: ' from ' },
      { text: 'Everyday Checking', entityType: 'account', entityId: ACCOUNT },
      { text: ' rose.' },
    ],
    contextLine: [
      { text: 'About ' },
      { text: 'Groceries', entityType: 'category', entityId: CATEGORY },
      { text: ', ' },
      { text: 'Everyday Checking', entityType: 'account', entityId: ACCOUNT },
    ],
    ...overrides,
  };
}

function renderInRouter(node: () => ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const page = createRoute({ getParentRoute: () => root, path: '/', component: node });
  const category = createRoute({
    getParentRoute: () => root,
    path: '/categories/$categoryId',
    component: () => <p>category screen</p>,
  });
  const account = createRoute({
    getParentRoute: () => root,
    path: '/accounts/$accountId',
    component: () => <p>account screen</p>,
  });
  const transactions = createRoute({
    getParentRoute: () => root,
    path: '/transactions',
    component: () => <p>transactions screen</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, category, account, transactions]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

function card(insight: Insight) {
  return renderInRouter(() => (
    <ul>
      <InsightCard insight={insight} />
    </ul>
  ));
}

describe('mentions', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('a mention backed by the evidence is a link to its screen, and it navigates', async () => {
    const user = userEvent.setup();
    const router = card(buildInsight());
    const heading = await screen.findByRole('heading', { level: 2 });
    const link = within(heading).getByRole('link', { name: 'Groceries' });
    expect(link).toHaveAttribute('href', `/categories/${CATEGORY}`);
    expect(screen.getAllByRole('link', { name: 'Everyday Checking' })[0]).toHaveAttribute(
      'href',
      `/accounts/${ACCOUNT}`,
    );
    expect(screen.getByTestId('insight-context-line')).toHaveTextContent(
      'About Groceries, Everyday Checking',
    );
    await user.click(link);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/categories/${CATEGORY}`));
  });

  it('a mention naming an entity the evidence does not cite is plain text, not a link', async () => {
    // The segment and the mention say STRANGER; the evidence row they point at resolves to CATEGORY.
    const insight = buildInsight({
      mentions: [
        { text: 'Groceries', entityType: 'category', entityId: STRANGER, evidencePosition: 0 },
      ],
      titleSegments: [
        { text: 'Groceries', entityType: 'category', entityId: STRANGER },
        { text: ' ran higher than usual' },
      ],
      bodySegments: [],
      contextLine: null,
    });
    card(insight);
    const heading = await screen.findByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('Groceries ran higher than usual');
    expect(within(heading).queryByRole('link')).toBeNull();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('a segment whose entity is not among the mentions, or whose evidence row is gone, is plain text', () => {
    const insight = buildInsight();
    expect(
      verifiedMentionOf(insight, { text: 'x', entityType: 'category', entityId: STRANGER }),
    ).toBeNull();
    expect(
      verifiedMentionOf(
        { ...insight, evidence: insight.evidence.slice(1) },
        { text: 'Groceries', entityType: 'category', entityId: CATEGORY },
      ),
    ).toBeNull();
    expect(
      verifiedMentionOf(insight, { text: 'Groceries', entityType: 'category', entityId: CATEGORY }),
    ).toEqual({ entityType: 'category', entityId: CATEGORY });
    expect(mentionHref({ entityType: 'merchant', entityId: 'm1' })).toBe(
      '/transactions?merchantIds=%5B%22m1%22%5D',
    );
    expect(mentionHref({ entityType: 'transaction', entityId: 't1' })).toBeNull();
  });

  it('segments that do not spell the field are ignored in favour of the field itself', () => {
    expect(segmentsFor([{ text: 'Something else' }], 'The title')).toEqual([{ text: 'The title' }]);
    expect(segmentsFor(null, 'The title')).toEqual([{ text: 'The title' }]);
  });
});

describe('the value line', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('says what the insight claims it is worth, per year or one-time, and nothing when it claims nothing', async () => {
    expect(valueLineOf(buildInsight())?.suffix).toBe('/ year');
    expect(
      valueLineOf(
        buildInsight({
          annualizedImpact: null,
          oneTimeImpact: { minor: '12000', currency: 'USD' },
        }),
      )?.suffix,
    ).toBe('one-time');
    expect(valueLineOf(buildInsight({ annualizedImpact: null, oneTimeImpact: null }))).toBeNull();

    card(buildInsight());
    // The Money span also carries its spoken form for screen readers ("36.00 US dollars").
    expect(await screen.findByTestId('insight-value-line')).toHaveTextContent(
      /^Worth \$36\.00.* \/ year$/u,
    );
  });

  it('is absent, never a zero, when the insight has no dollar impact', async () => {
    card(buildInsight({ annualizedImpact: null, oneTimeImpact: null }));
    await screen.findByRole('heading', { level: 2 });
    expect(screen.queryByTestId('insight-value-line')).toBeNull();
    expect(screen.queryByText('$0.00')).toBeNull();
  });
});

describe('bookmark and feedback', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  function recording(): { routes: FetchRoute[]; bodies: { url: string; body: unknown }[] } {
    const bodies: { url: string; body: unknown }[] = [];
    const record =
      (response: unknown): FetchRoute['handle'] =>
      async ({ url, request }) => {
        bodies.push({ url: url.pathname, body: await request.json() });
        return jsonResponse(response);
      };
    return {
      bodies,
      routes: [
        {
          method: 'POST',
          match: `/api/insights/${INSIGHT_ID}/bookmark`,
          handle: record({ insightId: INSIGHT_ID, bookmarkedAt: '2026-10-18T12:00:00.000Z' }),
        },
        {
          method: 'POST',
          match: `/api/insights/${INSIGHT_ID}/feedback`,
          handle: record({ insightId: INSIGHT_ID, feedback: 'not_helpful', feedbackReason: null }),
        },
        {
          match: '/api/insights',
          handle: () => jsonResponse({ dashboard: [], list: [], overflow: [], belowFloor: [] }),
        },
      ],
    };
  }

  it('Bookmark posts the toggle and shows its state', async () => {
    const user = userEvent.setup();
    const { routes, bodies } = recording();
    stubFetchRoutes(routes);
    card(buildInsight());
    const button = await screen.findByRole('button', { name: 'Bookmark' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    await user.click(button);
    await waitFor(() =>
      expect(bodies).toContainEqual({
        url: `/api/insights/${INSIGHT_ID}/bookmark`,
        body: { bookmarked: true },
      }),
    );
  });

  it('a bookmarked insight says so, and pressing it again un-bookmarks', async () => {
    const user = userEvent.setup();
    const { routes, bodies } = recording();
    stubFetchRoutes(routes);
    card(buildInsight({ bookmarkedAt: '2026-10-18T12:00:00.000Z' }));
    const button = await screen.findByRole('button', { name: 'Bookmarked' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    await user.click(button);
    await waitFor(() => expect(bodies.at(-1)?.body).toEqual({ bookmarked: false }));
  });

  it('Helpful posts the answer; Not helpful asks why with the reason dialog, without "later" or a note', async () => {
    const user = userEvent.setup();
    const { routes, bodies } = recording();
    stubFetchRoutes(routes);
    card(buildInsight());
    await user.click(await screen.findByRole('button', { name: 'Helpful' }));
    await waitFor(() =>
      expect(bodies.at(-1)).toEqual({
        url: `/api/insights/${INSIGHT_ID}/feedback`,
        body: { feedback: 'helpful', reasonCode: null },
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Not helpful' }));
    const dialog = await screen.findByRole('dialog', { name: "Why wasn't this helpful?" });
    expect(within(dialog).queryByLabelText('Remind me later')).toBeNull();
    expect(within(dialog).queryByLabelText('Dismissal note')).toBeNull();
    await user.click(within(dialog).getByLabelText('True, but I already knew'));
    await user.click(within(dialog).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(bodies.at(-1)?.body).toEqual({ feedback: 'not_helpful', reasonCode: 'ALREADY_KNOW' }),
    );
  });

  it('a stored answer is shown pressed, and pressing it again clears it', async () => {
    const user = userEvent.setup();
    const { routes, bodies } = recording();
    stubFetchRoutes(routes);
    card(buildInsight({ feedback: 'not_helpful', feedbackReason: 'NOT_TRUE' }));
    const notHelpful = await screen.findByRole('button', { name: 'Not helpful' });
    expect(notHelpful).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Helpful' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await user.click(notHelpful);
    await waitFor(() => expect(bodies.at(-1)?.body).toEqual({ feedback: null, reasonCode: null }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the Bookmarked filter', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('narrows the feed to the bookmarked insights, and says so when there are none', async () => {
    const user = userEvent.setup();
    const kept = buildInsight({
      id: '0190a000-0000-7000-8000-0000000000b1',
      bookmarkedAt: '2026-10-18T12:00:00.000Z',
      title: 'A kept insight',
      titleSegments: [],
      bodySegments: [],
      contextLine: null,
    });
    const other = buildInsight({
      id: '0190a000-0000-7000-8000-0000000000b2',
      title: 'Another insight',
      titleSegments: [],
      bodySegments: [],
      contextLine: null,
    });
    stubFetchRoutes([
      {
        match: '/api/insights',
        handle: () =>
          jsonResponse({
            dashboard: [kept, other],
            list: [kept, other],
            overflow: [],
            belowFloor: [],
          }),
      },
      { match: '/api/advisors', handle: () => jsonResponse({ advisors: [] }) },
    ]);
    renderInRouter(InsightsScreen);
    const filter = await screen.findByRole('button', { name: 'Bookmarked (1)' });
    expect(filter).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText('Another insight')).toBeInTheDocument();
    await user.click(filter);
    expect(filter).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('A kept insight')).toBeInTheDocument();
    expect(screen.queryByText('Another insight')).toBeNull();
  });
});
