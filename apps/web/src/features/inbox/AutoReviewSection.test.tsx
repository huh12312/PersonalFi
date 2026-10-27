// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Transaction } from '../../api/generated/types.gen.ts';
import {
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import {
  buildAssignedExplanation,
  buildAutoTransaction,
  LEARNED_LINE,
} from '../../test-support/provenance-fixtures.ts';
import { AutoReviewSection } from './AutoReviewSection.tsx';

interface World {
  rows: Transaction[];
  nextCursor: string | null;
  showAutoReview: boolean;
  listCalls: URLSearchParams[];
  patches: { id: string; body: unknown }[];
  puts: unknown[];
}

function world(rows: Transaction[], over: Partial<World> = {}): World {
  return {
    rows,
    nextCursor: null,
    showAutoReview: true,
    listCalls: [],
    patches: [],
    puts: [],
    ...over,
  };
}

function routes(w: World): FetchRoute[] {
  return [
    categoriesRoute(),
    {
      match: '/api/inbox/preferences',
      handle: async ({ request }) => {
        if (request.method === 'PUT') {
          const body = (await request.json()) as { showAutoReview: boolean };
          w.puts.push(body);
          w.showAutoReview = body.showAutoReview;
        }
        return jsonResponse({ showAutoReview: w.showAutoReview });
      },
    },
    {
      match: '/api/transactions/explanations',
      method: 'GET',
      handle: ({ url }) => {
        const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => id !== '');
        return jsonResponse({
          items: ids.map((id) => buildAssignedExplanation(id, 'merchant_default')),
        });
      },
    },
    {
      match: /^\/api\/transactions\/[^/]+$/u,
      method: 'PATCH',
      handle: async ({ url, request }) => {
        const id = url.pathname.split('/').pop() ?? '';
        const body = (await request.json()) as { categoryId: string };
        w.patches.push({ id, body });
        // A pick is the holder's: the row leaves the server's review list.
        w.rows = w.rows.filter((row) => row.id !== id);
        return jsonResponse({ ...(w.rows[0] ?? buildAutoTransaction(id, 'provider', 0.8)), id });
      },
    },
    {
      match: '/api/transactions',
      method: 'GET',
      handle: ({ url }) => {
        w.listCalls.push(url.searchParams);
        return jsonResponse({
          items: url.searchParams.get('autoReview') === 'true' ? w.rows : [],
          nextCursor: w.nextCursor,
          summary: null,
        });
      },
    },
  ];
}

function renderSection() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AutoReviewSection />
    </QueryClientProvider>,
  );
}

const rowsOf = () => screen.queryAllByTestId('auto-review-row');

describe('AutoReviewSection (WP 11.2b)', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const A = () =>
    buildAutoTransaction('txn_a', 'merchant_default', 0.75, {
      name: 'Blue Bottle',
      merchantName: 'Blue Bottle',
    });
  const B = () =>
    buildAutoTransaction('txn_b', 'classifier', 0.92, {
      name: 'Philz',
      merchantName: 'Philz',
      date: '2026-05-30',
    });

  it('asks for the review rows (a page of 50) and lists each with its provenance chip', async () => {
    const w = world([A(), B()]);
    stubFetchRoutes(routes(w));
    renderSection();

    expect(await screen.findAllByTestId('auto-review-row')).toHaveLength(2);
    expect(screen.getByTestId('auto-review-count')).toHaveTextContent('2');
    const chips = screen.getAllByTestId('provenance-chip');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Learned', 'Classifier 92 %']);
    const call = w.listCalls.find((params) => params.get('autoReview') === 'true');
    expect(call?.get('limit')).toBe('50');
  });

  it('says it is a page when the server has more', async () => {
    stubFetchRoutes(routes(world([A()], { nextCursor: 'next' })));
    renderSection();
    expect(await screen.findByTestId('auto-review-count')).toHaveTextContent('1+');
    expect(screen.getByText(/Showing the first 50/u)).toBeInTheDocument();
  });

  it('Looks right is the normal pick with the category already there; the row leaves and focus moves on', async () => {
    const w = world([A(), B()]);
    stubFetchRoutes(routes(w));
    renderSection();
    const user = userEvent.setup();
    const first = (await screen.findAllByTestId('auto-review-row'))[0] as HTMLElement;

    await user.click(within(first).getByRole('button', { name: /^Looks right/u }));

    await waitFor(() =>
      expect(w.patches).toEqual([{ id: 'txn_a', body: { categoryId: 'cat_dining_coffee' } }]),
    );
    await waitFor(() => expect(rowsOf()).toHaveLength(1));
    expect(screen.queryByText('Blue Bottle')).toBeNull();
    const remaining = rowsOf()[0] as HTMLElement;
    expect(remaining).toHaveTextContent('Philz');
    expect(within(remaining).getByRole('button', { name: /^Looks right/u })).toHaveFocus();
  });

  it('the last row gone: focus returns to the section heading and the section says nothing is waiting', async () => {
    const w = world([A()]);
    stubFetchRoutes(routes(w));
    renderSection();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Looks right/u }));
    expect(await screen.findByTestId('auto-review-empty')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Auto-categorised, unreviewed/u })).toHaveFocus();
  });

  it('Change opens the normal picker, and picking another category is the pick', async () => {
    const w = world([A()]);
    stubFetchRoutes(routes(w));
    renderSection();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Change the category/u }));
    const combobox = await screen.findByRole('combobox', { name: 'Category' });
    await user.click(combobox);
    await user.click(await screen.findByRole('option', { name: 'Restaurants' }));
    await waitFor(() =>
      expect(w.patches).toEqual([{ id: 'txn_a', body: { categoryId: 'cat_dining_restaurants' } }]),
    );
    await waitFor(() => expect(rowsOf()).toHaveLength(0));
  });

  it('the setting: off saves the preference, hides the rows and stops asking for them', async () => {
    const w = world([A()]);
    stubFetchRoutes(routes(w));
    renderSection();
    const user = userEvent.setup();
    expect(await screen.findAllByTestId('auto-review-row')).toHaveLength(1);
    const before = w.listCalls.length;

    await user.click(screen.getByRole('switch', { name: 'Review automatic placements' }));

    await waitFor(() => expect(w.puts).toEqual([{ showAutoReview: false }]));
    expect(await screen.findByTestId('auto-review-off')).toBeInTheDocument();
    expect(rowsOf()).toHaveLength(0);
    expect(w.listCalls.length).toBe(before);

    // And back on: the rows come back.
    await user.click(screen.getByRole('switch', { name: 'Review automatic placements' }));
    await waitFor(() =>
      expect(w.puts).toEqual([{ showAutoReview: false }, { showAutoReview: true }]),
    );
    expect(await screen.findAllByTestId('auto-review-row')).toHaveLength(1);
  });

  it('a holder who turned it off never triggers the request for the rows', async () => {
    const w = world([A()], { showAutoReview: false });
    stubFetchRoutes(routes(w));
    renderSection();
    expect(await screen.findByTestId('auto-review-off')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Review automatic placements' })).not.toBeChecked();
    expect(w.listCalls.filter((params) => params.get('autoReview') === 'true')).toHaveLength(0);
  });

  it('shows the stored line in the chip’s reveal', async () => {
    stubFetchRoutes(routes(world([A()])));
    renderSection();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('provenance-chip'));
    expect(await screen.findByTestId('provenance-line')).toHaveTextContent(LEARNED_LINE);
  });
});
