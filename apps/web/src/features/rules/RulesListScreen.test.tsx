// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { RulesListScreen } from './RulesListScreen.tsx';

const RULE = {
  id: 'rule_1',
  name: 'Blue Bottle Coffee → Coffee Shops',
  priority: 100,
  enabled: true,
  conditions: { all: [{ type: 'payee', match: 'contains', value: 'Blue Bottle' }], any: [] },
  actions: [{ type: 'set_category', categoryKey: 'dining.coffee' }],
  runOnSync: true,
  stopProcessing: false,
  createdFromTransactionId: 'txn_1',
  lastAppliedAt: null,
  lastAppliedCount: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
};

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RulesListScreen />
    </QueryClientProvider>,
  );
}

describe('RulesListScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows an empty state pointing at "Always categorize like this" when there are no rules', async () => {
    stubFetchRoutes([
      { match: '/api/rules', method: 'GET', handle: () => jsonResponse({ rules: [] }) },
    ]);
    renderScreen();

    expect(await screen.findByText('No rules yet')).toBeInTheDocument();
  });

  it('lists a rule with its conditions and actions summarised', async () => {
    stubFetchRoutes([
      { match: '/api/rules', method: 'GET', handle: () => jsonResponse({ rules: [RULE] }) },
    ]);
    renderScreen();

    expect(await screen.findByText(RULE.name)).toBeInTheDocument();
    expect(screen.getByText(/payee contains "Blue Bottle"/)).toBeInTheDocument();
    expect(screen.getByText(/set category to dining.coffee/)).toBeInTheDocument();
  });

  it('toggles a rule enabled/disabled via PATCH /rules/{id}', async () => {
    let patchedBody: unknown = null;
    stubFetchRoutes([
      { match: '/api/rules', method: 'GET', handle: () => jsonResponse({ rules: [RULE] }) },
      {
        match: '/api/rules/rule_1',
        method: 'PATCH',
        handle: async ({ request }) => {
          patchedBody = await request.json();
          return jsonResponse({ rule: { ...RULE, enabled: false } });
        },
      },
    ]);
    renderScreen();
    const user = userEvent.setup();

    const toggle = await screen.findByRole('switch', { name: /disable/i });
    await user.click(toggle);

    await waitFor(() => expect(patchedBody).toEqual({ enabled: false }));
  });

  it('deletes a rule via DELETE /rules/{id}', async () => {
    let deleted = false;
    stubFetchRoutes([
      { match: '/api/rules', method: 'GET', handle: () => jsonResponse({ rules: [RULE] }) },
      {
        match: '/api/rules/rule_1',
        method: 'DELETE',
        handle: () => {
          deleted = true;
          return jsonResponse({ deleted: true });
        },
      },
    ]);
    renderScreen();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: /delete/i }));

    await waitFor(() => expect(deleted).toBe(true));
  });
});
