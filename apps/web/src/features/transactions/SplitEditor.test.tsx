// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTransactionDetail,
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { SplitEditor } from './SplitEditor.tsx';

function renderEditor(overrides: Parameters<typeof buildTransactionDetail>[0] = { id: 'txn_1' }) {
  const transaction = buildTransactionDetail({
    amount: { minor: '-1000', currency: 'USD' },
    ...overrides,
  });
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SplitEditor transaction={transaction} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange, transaction };
}

describe('SplitEditor', () => {
  beforeEach(() => {
    ensureApiClient();
    stubFetchRoutes([categoriesRoute()]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('seeds two even lines from the total and shows Balanced', async () => {
    renderEditor();

    expect(await screen.findByText('Balanced')).toBeInTheDocument();
    const amountInputs = screen
      .getAllByLabelText(/amount$/i)
      .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
    expect(amountInputs.map((input) => input.value)).toEqual(['5.00', '5.00']);
  });

  it('disables Save and shows the unallocated amount while the lines do not sum to the total', async () => {
    renderEditor();
    const user = userEvent.setup();

    const amountInputs = screen
      .getAllByLabelText(/amount$/i)
      .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
    await user.clear(amountInputs[0]!);
    await user.type(amountInputs[0]!, '3');

    expect(await screen.findByText(/unallocated/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save splits/i })).toBeDisabled();
  });

  it('"Split evenly" over three lines restores balance with largest-remainder shares', async () => {
    renderEditor({ id: 'txn_1', amount: { minor: '-1000', currency: 'USD' } });
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Add line' }));
    await user.click(screen.getByRole('button', { name: 'Split evenly' }));

    await waitFor(() => expect(screen.getByText('Balanced')).toBeInTheDocument());
    const amountInputs = screen
      .getAllByLabelText(/amount$/i)
      .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
    expect(amountInputs.map((input) => input.value).sort()).toEqual(['3.33', '3.33', '3.34']);
  });

  it('saves a balanced split via POST /transactions/{id}/splits', async () => {
    let savedBody: unknown = null;
    stubFetchRoutes([
      categoriesRoute(),
      {
        match: '/api/transactions/txn_1/splits',
        method: 'POST',
        handle: async ({ request }) => {
          savedBody = await request.json();
          return jsonResponse({
            splits: [
              {
                id: 's1',
                position: 0,
                amount: { minor: '-500', currency: 'USD' },
                userCategoryId: null,
                note: null,
              },
              {
                id: 's2',
                position: 1,
                amount: { minor: '-500', currency: 'USD' },
                userCategoryId: null,
                note: null,
              },
            ],
          });
        },
      },
    ]);
    const { onOpenChange } = renderEditor();
    const user = userEvent.setup();

    await screen.findByText('Balanced');
    await user.click(screen.getByRole('button', { name: /save splits/i }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(savedBody).toEqual({
      splits: [
        { amount: { minor: '-500', currency: 'USD' }, userCategoryId: null, note: null },
        { amount: { minor: '-500', currency: 'USD' }, userCategoryId: null, note: null },
      ],
    });
  });
});
