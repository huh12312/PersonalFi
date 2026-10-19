// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../../routeTree.gen.ts';
import {
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import {
  blockDocumentOf,
  budgetVsActualBlocks,
  categoryMonthBlocks,
} from '../../test-support/block-fixtures.ts';

const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'webauthn',
  trustedDevice: true,
  fresh: true,
  idleExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  absoluteExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

function usd(minor: string) {
  return { minor, currency: 'USD' };
}

const DRILL_THROUGH = { categoryIds: ['cat_dining_coffee'], from: '2026-08-01', to: '2026-09-01' };

const SPENDING_CELLS = [
  {
    month: '2026-08',
    categoryId: 'cat_dining_coffee',
    amount: usd('-4200'),
    transactionCount: 3,
    transferExcludedCount: 0,
    refundNettedCount: 0,
    drillThrough: DRILL_THROUGH,
  },
];

const BVA_LINES = [
  {
    id: 'line_1',
    categoryId: 'cat_dining_coffee',
    name: 'Coffee Shops',
    assigned: usd('5000'),
    activity: usd('-4200'),
    available: usd('800'),
    cashOverspend: usd('0'),
    creditOverspend: usd('0'),
    drillThrough: DRILL_THROUGH,
  },
];

const lookup = (categoryId: string | null) =>
  categoryId === null
    ? { label: 'Uncategorised', hue: 'neutral' as const }
    : { label: 'Coffee Shops', hue: 'brown' as const };

function renderReports() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/reports'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

function commonRoutes() {
  return [
    categoriesRoute(),
    { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
    {
      match: '/api/budgets/current',
      handle: () =>
        jsonResponse({
          budgetId: 'budget_1',
          currency: 'USD',
          today: '2026-09-15',
          period: {
            id: 'period_1',
            budgetId: 'budget_1',
            kind: 'CALENDAR_MONTH',
            startDate: '2026-09-01',
            endDate: '2026-10-01',
            sequence: 1,
            status: 'open',
            readyToAssign: usd('0'),
            income: usd('0'),
            dirty: false,
            toStayOnTrack: usd('0'),
            totalCategoryAvailable: usd('0'),
            totalCreditCardPaymentAvailable: usd('0'),
            budgetedExpenses: usd('0'),
            plannedSavings: usd('0'),
            rolledOver: usd('0'),
            lines: [],
          },
        }),
    },
    {
      match: '/api/reports/spending',
      handle: () =>
        jsonResponse({
          cells: [
            {
              month: '2026-08',
              categoryId: 'cat_dining_coffee',
              amount: usd('-4200'),
              transactionCount: 3,
              transferExcludedCount: 0,
              refundNettedCount: 0,
              drillThrough: DRILL_THROUGH,
            },
          ],
        }),
    },
    { match: '/api/reports/income', handle: () => jsonResponse({ cells: [] }) },
    // WP 10.15: the three sections as blocks, built from the same figures the way the API builds them.
    {
      match: '/api/reports/blocks/spending',
      handle: () =>
        jsonResponse(
          blockDocumentOf(
            categoryMonthBlocks(SPENDING_CELLS, lookup, 'Spending by category and month'),
          ),
        ),
    },
    {
      match: '/api/reports/blocks/income',
      handle: () =>
        jsonResponse(
          blockDocumentOf(categoryMonthBlocks([], lookup, 'Income by category and month')),
        ),
    },
    {
      match: '/api/reports/blocks/budget-vs-actual',
      handle: () => jsonResponse(blockDocumentOf(budgetVsActualBlocks(BVA_LINES))),
    },
    {
      match: '/api/reports/sankey',
      handle: () =>
        jsonResponse({
          currency: 'USD',
          nodes: [
            { id: 'income', kind: 'income', refId: null },
            { id: 'coffee', kind: 'category', refId: 'cat_dining_coffee' },
          ],
          links: [
            {
              source: 'income',
              target: 'coffee',
              amount: usd('-4200'),
              drillThrough: DRILL_THROUGH,
            },
          ],
        }),
    },
    {
      match: '/api/reports/budget-vs-actual',
      handle: () =>
        jsonResponse({
          lines: [
            {
              id: 'line_1',
              categoryId: 'cat_dining_coffee',
              name: 'Coffee Shops',
              assigned: usd('5000'),
              activity: usd('-4200'),
              available: usd('800'),
              cashOverspend: usd('0'),
              creditOverspend: usd('0'),
              drillThrough: DRILL_THROUGH,
            },
          ],
        }),
    },
  ];
}

describe('ReportsScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the spending tab by default, with a working link back to the budget screen', async () => {
    stubFetchRoutes(commonRoutes());
    renderReports();

    expect(await screen.findByRole('heading', { name: 'Reports', level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Back to budget/ }).getAttribute('href')).toBe(
      '/budget',
    );
    expect(
      await screen.findByRole('group', { name: 'Spending by category and month' }),
    ).toBeInTheDocument();
    // WP 10.15: drawn through the block renderer — a stacked-bars block, its segment a drill-through link.
    const blocks = screen.getByTestId('report-blocks-spending');
    expect(blocks.querySelector('[data-block-kind="stacked-bars"]')).not.toBeNull();
    const segment = blocks.querySelector('[data-segment="cat_dining_coffee"]');
    expect(segment?.getAttribute('role')).toBe('link');
    expect(segment?.getAttribute('aria-label')).toBe(
      'Coffee Shops, 2026-08, $42.00, view transactions',
    );
  });

  it('the income tab says there was no activity, as a block', async () => {
    stubFetchRoutes(commonRoutes());
    renderReports();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Reports', level: 1 });
    await user.click(screen.getByRole('tab', { name: 'Income' }));
    expect(await screen.findByText('No activity in this window.')).toBeInTheDocument();
  });

  it('shows the budget-vs-actual table with a category link and a drill-through link per row', async () => {
    stubFetchRoutes(commonRoutes());
    renderReports();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'Reports', level: 1 });
    await user.click(screen.getByRole('tab', { name: 'Budget vs. actual' }));

    // WP 10.14: the name opens the category's screen; the row's transactions are the link beside it.
    const rowLink = await screen.findByRole('link', { name: 'Coffee Shops' });
    expect(rowLink.getAttribute('href')).toContain('/categories/');
    const drill = screen.getByRole('link', { name: 'transactions in Coffee Shops' });
    expect(drill.getAttribute('href')).toContain('/transactions');
  });

  it('renders the Sankey diagram, every flow a drill-through link in its table', async () => {
    stubFetchRoutes(commonRoutes());
    renderReports();
    const user = userEvent.setup();

    await screen.findByRole('heading', { name: 'Reports', level: 1 });
    await user.click(screen.getByRole('tab', { name: 'Cash flow' }));

    // WP 10.10: the bands are pointer targets (they overlap, so a focused one could never be unobscured); the
    // keyboard's drill-through is the chart's table, one link per flow, named by the flow's destination.
    await user.click(await screen.findByRole('button', { name: /View as table.*Cash flow/ }));
    const link = await screen.findByRole('link', { name: /, view transactions$/ });
    expect(link.getAttribute('href')).toContain('/transactions');
    expect(document.querySelectorAll('[data-flow]').length).toBeGreaterThan(0);
  });
});
