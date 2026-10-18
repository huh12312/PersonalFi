// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../../routeTree.gen.ts';
import {
  buildTransaction,
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { historyWire, withOneCompleteMonth } from './fixtures.ts';
import type { HistoryWire } from './history.ts';

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

const CATEGORY_ID = 'cat_dining_coffee';

function setup(history: HistoryWire = historyWire(), path = `/categories/${CATEGORY_ID}`) {
  const transactionQueries: URLSearchParams[] = [];
  stubFetchRoutes([
    categoriesRoute(),
    { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
    { match: '/api/accounts', handle: () => jsonResponse({ accounts: [] }) },
    {
      match: '/api/reports/category-history',
      handle: ({ url }) => {
        expect(url.searchParams.get('categoryId')).toBe(CATEGORY_ID);
        return jsonResponse({
          ...history,
          categoryId: CATEGORY_ID,
          includesChildren: false,
          historyStart: '2025-10',
          drillThrough: { categoryIds: [CATEGORY_ID] },
        });
      },
    },
    {
      match: '/api/transactions',
      handle: ({ url }) => {
        transactionQueries.push(url.searchParams);
        return jsonResponse({
          items: [
            buildTransaction({
              id: `txn_${url.searchParams.get('from') ?? 'all'}`,
              categoryId: CATEGORY_ID,
              date: url.searchParams.get('from') ?? '2026-10-02',
            }),
          ],
          nextCursor: null,
          summary: { count: 1, totals: [] },
        });
      },
    },
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, transactionQueries };
}

beforeEach(() => {
  ensureApiClient();
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the category detail screen (WP 10.14)', () => {
  it('heads the screen with the icon, name, group and kind, and an Edit button', async () => {
    setup();
    expect(
      await screen.findByRole('heading', { name: 'Coffee Shops', level: 2 }),
    ).toBeInTheDocument();
    const header = screen.getByTestId('category-header');
    expect(header).toHaveTextContent('In Dining · Expense');
    expect(header.querySelector('[data-category-icon]')?.textContent).toBe('☕');
    expect(screen.getByRole('button', { name: 'Edit Coffee Shops' })).toBeInTheDocument();
  });

  it('says this month against the average, and lists this month’s transactions', async () => {
    const { transactionQueries } = setup();
    expect(await screen.findByTestId('category-comparison')).toHaveTextContent(
      'So far this month, $146.67 less than your average month of $356.67.',
    );
    await waitFor(() => expect(transactionQueries.length).toBeGreaterThan(0));
    const last = transactionQueries.at(-1)!;
    expect(last.getAll('categoryIds')).toEqual([CATEGORY_ID]);
    expect(last.get('from')).toBe('2026-10-01');
    expect(last.get('to')).toBe('2026-10-31');
  });

  it('selecting a month with the keyboard filters the transactions beneath to it', async () => {
    const { router, transactionQueries } = setup();
    const slider = await screen.findByRole('slider', {
      name: 'Coffee Shops by month: choose a month',
    });
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    await waitFor(() => expect(router.state.location.search).toEqual({ month: '2026-09' }));
    await waitFor(() => expect(transactionQueries.at(-1)?.get('from')).toBe('2026-09-01'));
    expect(transactionQueries.at(-1)?.get('to')).toBe('2026-09-30');
    expect(screen.getByTestId('category-transactions-heading')).toHaveTextContent(
      'Transactions in September 2026',
    );
    expect(screen.getByTestId('category-readout')).toHaveTextContent(
      'September 2026: $390.00 spent; $33.33 more than your average month of $356.67.',
    );
    expect(screen.getByTestId('category-see-transactions').getAttribute('href')).toContain(
      'from=2026-09-01',
    );
  });

  it('withholds the sentence, with the reason, when the ledger has one complete month', async () => {
    setup(withOneCompleteMonth());
    const sentence = await screen.findByTestId('category-comparison');
    expect(sentence).toHaveAttribute('data-withheld', 'true');
    expect(sentence).toHaveTextContent('Not enough history for an average yet');
  });

  it('says so when the category does not exist', async () => {
    setup(historyWire(), '/categories/not_a_category');
    expect(await screen.findByText('Category not found')).toBeInTheDocument();
  });
});
