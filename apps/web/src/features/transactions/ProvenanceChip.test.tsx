// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTransaction,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import {
  buildAssignedExplanation,
  buildAutoTransaction,
  CLASSIFIER_LINE,
  LEARNED_LINE,
  PLAID_LINE,
} from '../../test-support/provenance-fixtures.ts';
import { TransactionProvenanceChip } from './ProvenanceChip.tsx';

function renderChip(element: React.ReactElement, onRowClick: () => void = () => undefined): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      {/* The row the chip sits in opens the transaction on a click or Enter. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div onClick={onRowClick}>{element}</div>
    </QueryClientProvider>,
  );
}

function explanationsFor(
  calls: string[],
  explanation: ReturnType<typeof buildAssignedExplanation>,
) {
  stubFetchRoutes([
    {
      match: '/api/transactions/explanations',
      method: 'GET',
      handle: ({ url }) => {
        calls.push(url.searchParams.getAll('ids').join(','));
        return jsonResponse({ items: [explanation] });
      },
    },
  ]);
}

describe('ProvenanceChip (WP 11.2b)', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is always present on an automatic placement, and absent on a pick or a rule', () => {
    stubFetchRoutes([]);
    const { rerender } = (() => {
      const queryClient = new QueryClient();
      const view = render(
        <QueryClientProvider client={queryClient}>
          <TransactionProvenanceChip transaction={buildAutoTransaction('a', 'provider', 0.85)} />
        </QueryClientProvider>,
      );
      return {
        rerender: (node: React.ReactElement) =>
          view.rerender(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>),
      };
    })();
    expect(screen.getByTestId('provenance-chip')).toHaveTextContent('Plaid');
    rerender(
      <TransactionProvenanceChip
        transaction={buildTransaction({ id: 'u', categoryId: 'cat_dining_coffee' })}
      />,
    );
    expect(screen.queryByTestId('provenance-chip')).toBeNull();
    rerender(
      <TransactionProvenanceChip
        transaction={buildTransaction({
          id: 'r',
          categoryId: 'cat_dining_coffee',
          categorySource: 'rule',
        })}
      />,
    );
    expect(screen.queryByTestId('provenance-chip')).toBeNull();
  });

  it.each([
    ['provider', 0.85, 'Plaid', PLAID_LINE, 'From Plaid’s category for this transaction'],
    ['merchant_default', 0.75, 'Learned', LEARNED_LINE, 'Learned from 4 confirmations'],
    ['classifier', 0.9234, 'Classifier 92 %', CLASSIFIER_LINE, 'Classifier, 92 % confident'],
  ] as const)(
    '%s: press reveals the stored explanation',
    async (tier, confidence, label, line, headline) => {
      const calls: string[] = [];
      explanationsFor(calls, buildAssignedExplanation('txn_a', tier));
      renderChip(
        <TransactionProvenanceChip transaction={buildAutoTransaction('txn_a', tier, confidence)} />,
      );

      const chip = screen.getByTestId('provenance-chip');
      expect(chip).toHaveTextContent(label);
      // Nothing is fetched until the chip is asked.
      expect(calls).toEqual([]);

      await userEvent.click(chip);
      expect(await screen.findByTestId('provenance-line')).toHaveTextContent(line);
      expect(screen.getByTestId('provenance-reveal')).toHaveTextContent(headline);
      expect(calls).toEqual(['txn_a']);
    },
  );

  it('is reachable by keyboard: Tab to it, Enter reveals, Escape closes — and the row never hears the keys', async () => {
    explanationsFor([], buildAssignedExplanation('txn_a', 'merchant_default'));
    const onRow = vi.fn();
    renderChip(
      <TransactionProvenanceChip
        transaction={buildAutoTransaction('txn_a', 'merchant_default', 0.75)}
      />,
      onRow,
    );
    await userEvent.tab();
    expect(screen.getByTestId('provenance-chip')).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('provenance-line')).toHaveTextContent(LEARNED_LINE);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('provenance-reveal')).toBeNull());
    expect(screen.getByTestId('provenance-chip')).toHaveFocus();
    expect(onRow).not.toHaveBeenCalled();
  });

  it('reveals on hover too', async () => {
    explanationsFor([], buildAssignedExplanation('txn_a', 'provider'));
    renderChip(
      <TransactionProvenanceChip transaction={buildAutoTransaction('txn_a', 'provider', 0.85)} />,
    );
    await userEvent.hover(screen.getByTestId('provenance-chip'));
    await waitFor(
      () => expect(screen.getByTestId('provenance-line')).toHaveTextContent(PLAID_LINE),
      {
        timeout: 2000,
      },
    );
  });

  it('uses an explanation it was handed instead of asking again', async () => {
    const calls: string[] = [];
    explanationsFor(calls, buildAssignedExplanation('txn_a', 'provider'));
    renderChip(
      <TransactionProvenanceChip
        transaction={buildAutoTransaction('txn_a', 'provider', 0.85)}
        explanation={buildAssignedExplanation('txn_a', 'provider', {
          line: 'Stored, handed over.',
        })}
      />,
    );
    await userEvent.click(screen.getByTestId('provenance-chip'));
    expect(await screen.findByTestId('provenance-line')).toHaveTextContent('Stored, handed over.');
    expect(calls).toEqual([]);
  });

  it('says so when the stored explanation cannot be loaded, and invents none', async () => {
    stubFetchRoutes([
      {
        match: '/api/transactions/explanations',
        method: 'GET',
        handle: () => jsonResponse({}, 500),
      },
    ]);
    renderChip(
      <TransactionProvenanceChip transaction={buildAutoTransaction('txn_a', 'classifier', 0.92)} />,
    );
    await userEvent.click(screen.getByTestId('provenance-chip'));
    expect(
      await screen.findByText('The stored explanation could not be loaded.'),
    ).toBeInTheDocument();
  });
});
