// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildTransactionDetail,
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { createdRuleResponse, previewRoute } from '../../test-support/insight-fixtures.ts';
import { RuleFromTransactionDialog } from './RuleFromTransactionDialog.tsx';

function renderDialog() {
  const transaction = buildTransactionDetail({ id: 'txn_1', categoryId: 'cat_dining_coffee' });
  const onOpenChange = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RuleFromTransactionDialog transaction={transaction} open onOpenChange={onOpenChange} />
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

describe('RuleFromTransactionDialog', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates the rule, then shows the preview count before offering to apply', async () => {
    ensureApiClient();
    let createBody: unknown = null;
    let previewBody: unknown = null;
    stubFetchRoutes([
      categoriesRoute(),
      {
        match: '/api/transactions/txn_1/rule',
        method: 'POST',
        handle: async ({ request }) => {
          createBody = await request.json();
          return jsonResponse(
            {
              rule: {
                id: 'rule_1',
                name: 'Blue Bottle Coffee → Coffee Shops',
                priority: 100,
                enabled: true,
                conditions: { all: [], any: [] },
                actions: [{ type: 'set_category', categoryKey: 'dining.coffee' }],
                runOnSync: true,
                stopProcessing: false,
                createdFromTransactionId: 'txn_1',
                lastAppliedAt: null,
                lastAppliedCount: 0,
                createdAt: '2026-06-01T00:00:00.000Z',
                updatedAt: '2026-06-01T00:00:00.000Z',
              },
            },
            201,
          );
        },
      },
      {
        match: '/api/rules/preview',
        method: 'POST',
        handle: async ({ request }) => {
          previewBody = await request.json();
          return jsonResponse({
            ruleId: 'rule_1',
            runId: 'run_1',
            preview: true,
            matchedCount: 5,
            changedCount: 4,
            sample: [],
            actionsRecorded: [],
          });
        },
      },
    ]);

    renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Preview' }));

    await waitFor(() =>
      expect(createBody).toEqual({ categoryKey: 'dining.coffee', name: expect.any(String) }),
    );
    expect(previewBody).toEqual({ ruleId: 'rule_1', retroactive: true });

    expect(await screen.findByText(/recategorize/)).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: /apply to 4 transactions/i })).toBeInTheDocument();
  });

  it('applying calls POST /rules/{id}/apply with the same retroactive flag and closes the dialog', async () => {
    ensureApiClient();
    let applyBody: unknown = null;
    stubFetchRoutes([
      categoriesRoute(),
      {
        match: '/api/transactions/txn_1/rule',
        method: 'POST',
        handle: () =>
          jsonResponse(
            {
              rule: {
                id: 'rule_1',
                name: 'rule',
                priority: 100,
                enabled: true,
                conditions: { all: [], any: [] },
                actions: [{ type: 'set_category', categoryKey: 'dining.coffee' }],
                runOnSync: true,
                stopProcessing: false,
                createdFromTransactionId: 'txn_1',
                lastAppliedAt: null,
                lastAppliedCount: 0,
                createdAt: '2026-06-01T00:00:00.000Z',
                updatedAt: '2026-06-01T00:00:00.000Z',
              },
            },
            201,
          ),
      },
      {
        match: '/api/rules/preview',
        method: 'POST',
        handle: () =>
          jsonResponse({
            ruleId: 'rule_1',
            runId: 'run_1',
            preview: true,
            matchedCount: 2,
            changedCount: 2,
            sample: [],
            actionsRecorded: [],
          }),
      },
      {
        match: '/api/rules/rule_1/apply',
        method: 'POST',
        handle: async ({ request }) => {
          applyBody = await request.json();
          return jsonResponse({
            ruleId: 'rule_1',
            runId: 'run_2',
            preview: false,
            matchedCount: 2,
            changedCount: 2,
            sample: [],
            actionsRecorded: [],
          });
        },
      },
    ]);

    const { onOpenChange } = renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await user.click(await screen.findByRole('button', { name: /apply to 2 transactions/i }));

    await waitFor(() => expect(applyBody).toEqual({ retroactive: true }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('WP 11.1: starts on initialCategoryId and reports the created rule before any apply', async () => {
    ensureApiClient();
    let createBody: unknown = null;
    stubFetchRoutes([
      categoriesRoute(),
      {
        match: '/api/transactions/txn_1/rule',
        method: 'POST',
        handle: async ({ request }) => {
          createBody = await request.json();
          return createdRuleResponse('txn_1', 'dining.restaurants');
        },
      },
      previewRoute(),
    ]);
    const transaction = buildTransactionDetail({ id: 'txn_1', categoryId: 'cat_dining_coffee' });
    const onRuleCreated = vi.fn();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <RuleFromTransactionDialog
          transaction={transaction}
          open
          onOpenChange={vi.fn()}
          initialCategoryId="cat_dining_restaurants"
          onRuleCreated={onRuleCreated}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Category' })).toHaveValue('Restaurants'),
    );
    expect(onRuleCreated).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() =>
      expect(createBody).toEqual({ categoryKey: 'dining.restaurants', name: expect.any(String) }),
    );
    await waitFor(() => expect(onRuleCreated).toHaveBeenCalledWith('rule_1'));
    expect(onRuleCreated).toHaveBeenCalledTimes(1);
  });
});
