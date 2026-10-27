// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Transaction } from '../../api/generated/types.gen.ts';
import {
  buildTransaction,
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import {
  buildExplanation,
  SUGGESTED_ID,
  SUGGESTED_LABEL,
  SUGGESTED_REASON,
} from '../../test-support/suggestion-fixtures.ts';
import { TransactionsList } from '../transactions/TransactionsList.tsx';

/**
 * WP 11.2: the transaction list asks about its uncategorised rows in one explanations batch and shows the model's
 * suggestion as a compact chip in the row; Confirm is the normal pick (`PATCH` with the suggested category), Not this
 * posts the rejection; neither opens the row's detail.
 */
interface Recorded {
  patches: Array<{ id: string; body: unknown }>;
  rejects: string[];
  batches: string[];
}

function setup(rows: Transaction[]) {
  const recorded: Recorded = { patches: [], rejects: [], batches: [] };
  const state = new Map(rows.map((row) => [row.id, { ...row }]));
  stubFetchRoutes([
    categoriesRoute(),
    {
      match: '/api/transactions/explanations',
      method: 'GET',
      handle: ({ url }) => {
        const ids = url.searchParams.getAll('ids').join(',').split(',');
        recorded.batches.push(ids.join(','));
        return jsonResponse({
          items: ids.map((id) =>
            buildExplanation(id, recorded.rejects.length > 0 ? { suggestion: null } : {}),
          ),
        });
      },
    },
    {
      match: /^\/api\/transactions\/[^/]+\/suggestion\/reject$/,
      method: 'POST',
      handle: ({ url }) => {
        recorded.rejects.push(url.pathname.split('/')[3] ?? '');
        return jsonResponse({ outcome: 'rejected' });
      },
    },
    {
      match: /^\/api\/transactions\/[^/]+$/,
      method: 'PATCH',
      handle: async ({ request, url }) => {
        const id = url.pathname.split('/')[3] ?? '';
        const body = (await request.json()) as { categoryId: string };
        recorded.patches.push({ id, body });
        const row = state.get(id);
        if (row !== undefined) row.categoryId = body.categoryId;
        return jsonResponse(row);
      },
    },
    {
      match: '/api/transactions',
      method: 'GET',
      handle: () =>
        jsonResponse({
          items: [...state.values()],
          nextCursor: null,
          summary: { count: state.size, totals: [] },
        }),
    },
  ]);
  const onOpen = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TransactionsList
        search={{}}
        accountName={() => 'Everyday Checking'}
        selected={new Set()}
        onToggleSelect={() => undefined}
        onOpen={onOpen}
        onClearFilters={() => undefined}
      />
    </QueryClientProvider>,
  );
  return { recorded, onOpen };
}

describe('TransactionsList › the model’s suggestion (WP 11.2)', () => {
  beforeEach(() => {
    ensureApiClient();
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const rows = () => [
    buildTransaction({ id: 'txn_u', name: 'Corner Roastery', merchantName: null }),
    buildTransaction({
      id: 'txn_c',
      name: 'Bistro Nine',
      merchantName: null,
      categoryId: 'cat_dining_restaurants',
    }),
  ];

  it('asks about the uncategorised rows only, in one batch, and shows the chip on that row', async () => {
    const { recorded } = setup(rows());

    const chip = await screen.findByTestId('suggestion-chip');
    expect(within(chip).getByTestId('suggestion-chip-text').textContent).toBe(
      `Suggested by the model: ${SUGGESTED_LABEL} — ${SUGGESTED_REASON}`,
    );
    const row = chip.closest('[role="row"]');
    expect(row).toHaveAttribute('data-transaction-id', 'txn_u');
    expect(within(row as HTMLElement).getByText(/^Uncategorized · /)).toBeInTheDocument();
    expect(screen.getAllByTestId('suggestion-chip')).toHaveLength(1);
    expect(recorded.batches).toEqual(['txn_u']);
    expect(recorded.patches).toEqual([]);
  });

  it('Confirm sends the suggested category through the normal PATCH and does not open the row', async () => {
    const { recorded, onOpen } = setup(rows());
    const user = userEvent.setup();

    const chip = await screen.findByTestId('suggestion-chip');
    await user.click(within(chip).getByRole('button', { name: `Confirm ${SUGGESTED_LABEL}` }));

    await waitFor(() =>
      expect(recorded.patches).toEqual([{ id: 'txn_u', body: { categoryId: SUGGESTED_ID } }]),
    );
    await waitFor(() => expect(screen.queryByTestId('suggestion-chip')).not.toBeInTheDocument());
    const row = document.querySelector('[data-transaction-id="txn_u"]') as HTMLElement;
    expect(within(row).getByText(/^Coffee Shops · /)).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    expect(recorded.rejects).toEqual([]);
  });

  it('Not this posts the rejection, the chip goes, the row stays uncategorised, and the detail stays closed', async () => {
    const { recorded, onOpen } = setup(rows());
    const user = userEvent.setup();

    const chip = await screen.findByTestId('suggestion-chip');
    await user.click(within(chip).getByRole('button', { name: 'Not this' }));

    await waitFor(() => expect(recorded.rejects).toEqual(['txn_u']));
    await waitFor(() => expect(screen.queryByTestId('suggestion-chip')).not.toBeInTheDocument());
    const row = document.querySelector('[data-transaction-id="txn_u"]') as HTMLElement;
    expect(within(row).getByText(/^Uncategorized · /)).toBeInTheDocument();
    expect(document.activeElement).toBe(row);
    expect(recorded.patches).toEqual([]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('Enter on Confirm activates it without opening the row', async () => {
    const { recorded, onOpen } = setup(rows());
    const user = userEvent.setup();

    const chip = await screen.findByTestId('suggestion-chip');
    within(chip)
      .getByRole('button', { name: `Confirm ${SUGGESTED_LABEL}` })
      .focus();
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(recorded.patches).toEqual([{ id: 'txn_u', body: { categoryId: SUGGESTED_ID } }]),
    );
    expect(onOpen).not.toHaveBeenCalled();
  });
});
