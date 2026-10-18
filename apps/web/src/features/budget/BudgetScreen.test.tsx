// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../../routeTree.gen.ts';
import {
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import type { BudgetLine, BudgetPeriod } from '../../api/generated/types.gen.ts';

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

function buildLine(overrides: Partial<BudgetLine> & Pick<BudgetLine, 'id'>): BudgetLine {
  return {
    kind: 'category',
    categoryId: 'cat_groceries',
    creditAccountId: null,
    name: null,
    carryover: usd('0'),
    assigned: usd('0'),
    activity: usd('0'),
    available: usd('0'),
    cashOverspend: usd('0'),
    creditOverspend: usd('0'),
    rolloverPolicy: 'ROLLOVER',
    goalType: 'NONE',
    neededThisPeriod: usd('0'),
    underfunded: usd('0'),
    priority: 0,
    class: null,
    transferExcludedCount: 0,
    refundNettedCount: 0,
    ...overrides,
  };
}

function buildPeriod(overrides: Partial<BudgetPeriod> = {}): BudgetPeriod {
  return {
    id: 'period_1',
    budgetId: 'budget_1',
    kind: 'CALENDAR_MONTH',
    startDate: '2026-09-01',
    endDate: '2026-10-01',
    sequence: 1,
    status: 'open',
    readyToAssign: usd('100000'),
    income: usd('0'),
    dirty: false,
    toStayOnTrack: usd('0'),
    totalCategoryAvailable: usd('0'),
    totalCreditCardPaymentAvailable: usd('0'),
    budgetedExpenses: usd('0'),
    plannedSavings: usd('0'),
    rolledOver: usd('0'),
    lines: [],
    ...overrides,
  };
}

function renderBudget() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ['/budget'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe('BudgetScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the no-budget empty state and offers to seed from last month', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      {
        match: '/api/budgets/current',
        handle: () =>
          jsonResponse({
            budgetId: 'budget_1',
            currency: 'USD',
            today: '2026-09-15',
            period: buildPeriod(),
          }),
      },
      { match: '/api/budgets/periods', handle: () => jsonResponse({ periods: [] }) },
    ]);

    renderBudget();

    expect(await screen.findByText('No budget yet')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: "Start from last month's spending" }),
    ).toBeInTheDocument();
  });

  it('assigning an amount PATCHes the line and the row reflects the new value after refetch', async () => {
    let assignedMinor = '0';
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      {
        match: '/api/budgets/current',
        handle: () =>
          jsonResponse({
            budgetId: 'budget_1',
            currency: 'USD',
            today: '2026-09-15',
            period: buildPeriod({
              readyToAssign: usd((100000 - Number(assignedMinor)).toString()),
              lines: [
                buildLine({
                  id: 'line_groceries',
                  assigned: usd(assignedMinor),
                  available: usd(assignedMinor),
                }),
              ],
            }),
          }),
      },
      { match: '/api/budgets/periods', handle: () => jsonResponse({ periods: [] }) },
      {
        match: '/api/budgets/lines/line_groceries',
        method: 'PATCH',
        handle: async ({ request }) => {
          const body = (await request.json()) as { assigned: { minor: string; currency: string } };
          assignedMinor = body.assigned.minor;
          return jsonResponse({
            line: buildLine({
              id: 'line_groceries',
              assigned: usd(assignedMinor),
              available: usd(assignedMinor),
            }),
          });
        },
      },
    ]);

    renderBudget();
    const user = userEvent.setup();

    const button = await screen.findByRole('button', { name: /Assign amount for Category/ });
    await user.click(button);
    const input = screen.getByRole('textbox', { name: /Assign amount for Category/ });
    await user.clear(input);
    await user.type(input, '25.00{Enter}');

    await waitFor(() => expect(assignedMinor).toBe('2500'));
    expect(await screen.findByTestId('ready-to-assign-amount')).toHaveTextContent('$975.00');
  });

  it('renders a credit-card-payment line as read-only, with a credit overspend badge', async () => {
    stubFetchRoutes([
      categoriesRoute(),
      { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
      {
        match: '/api/budgets/current',
        handle: () =>
          jsonResponse({
            budgetId: 'budget_1',
            currency: 'USD',
            today: '2026-09-15',
            period: buildPeriod({
              lines: [
                buildLine({
                  id: 'line_ccp',
                  kind: 'credit_card_payment',
                  categoryId: null,
                  creditAccountId: 'acct_card',
                  name: 'Card payment',
                  creditOverspend: usd('1500'),
                }),
              ],
            }),
          }),
      },
      { match: '/api/budgets/periods', handle: () => jsonResponse({ periods: [] }) },
    ]);

    renderBudget();

    expect(await screen.findByText('Card payment')).toBeInTheDocument();
    expect(screen.getByText('Card payment — funded automatically')).toBeInTheDocument();
    expect(screen.getByText('Credit overspend')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Assign amount for Card payment/ }),
    ).not.toBeInTheDocument();
  });
});
