// SPDX-License-Identifier: MIT
import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  TEST_CATEGORIES,
} from '../../../test-support/api-test-utils.ts';
import { renderWidget } from '../test-utils.tsx';
import { closestToBudget } from './budget-meters.ts';
import { BudgetsWidget } from './BudgetsWidget.tsx';
import { budgetLine, budgetPeriod, envelope, usd } from './fixtures.ts';

function serve(period: ReturnType<typeof budgetPeriod> | null) {
  stubFetchRoutes([
    {
      match: '/api/budgets/current',
      method: 'GET',
      handle: () =>
        period === null
          ? jsonResponse({ code: 'budgeting.balance_unreported' }, 409)
          : jsonResponse({ budgetId: 'budget_1', currency: 'USD', period }),
    },
    {
      match: '/api/categories',
      method: 'GET',
      handle: () => jsonResponse({ categories: TEST_CATEGORIES }),
    },
  ]);
}

describe('closestToBudget (WP 10.9)', () => {
  const none = () => false;

  it('over first (by how far over), then by share spent; three at most', () => {
    const meters = closestToBudget(
      [
        envelope('a', 'Groceries', 40_000, 20_000), // 50 %
        envelope('b', 'Dining', 10_000, 12_500), // over by 25.00
        envelope('c', 'Fuel', 8_000, 7_600), // 95 %: near
        envelope('d', 'Gifts', 5_000, 9_000), // over by 40.00
        envelope('e', 'Books', 5_000, 1_000), // 20 %
      ],
      none,
    );
    expect(meters.map((meter) => meter.lineId)).toEqual(['d', 'b', 'c']);
    expect(meters.map((meter) => meter.state)).toEqual(['over', 'over', 'near']);
  });

  it('uses the server figures: funded = carryover + assigned, spent = −activity, over = available < 0', () => {
    const [meter] = closestToBudget(
      [
        budgetLine({
          id: 'x',
          carryover: usd(5_000),
          assigned: usd(10_000),
          activity: usd(-12_000),
          available: usd(3_000),
        }),
      ],
      none,
    );
    expect(meter?.funded.minor).toBe(15_000n);
    expect(meter?.spent.minor).toBe(12_000n);
    expect(meter?.state).toBe('under');
    expect(meter?.ratio).toBeCloseTo(0.8);
  });

  it('skips a line with nothing funded and nothing spent, income categories, and card-payment lines', () => {
    const meters = closestToBudget(
      [
        budgetLine({ id: 'idle' }),
        envelope('salary', 'Salary', 0, 5_000),
        budgetLine({ id: 'ccp', kind: 'credit_card_payment', assigned: usd(1), activity: usd(-1) }),
      ],
      (id) => id === 'cat_salary',
    );
    expect(meters).toEqual([]);
  });

  it('spent with nothing funded is over, with no ratio to draw a share from', () => {
    const [meter] = closestToBudget(
      [budgetLine({ id: 'u', activity: usd(-3_000), available: usd(-3_000) })],
      none,
    );
    expect(meter?.state).toBe('over');
    expect(meter?.ratio).toBeNull();
  });
});

describe('BudgetsWidget (WP 10.9)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('populated: Left to budget is the period’s Ready to Assign, and three meters in words', async () => {
    serve(
      budgetPeriod([
        envelope('a', 'Groceries', 40_000, 20_000),
        envelope('b', 'Dining', 10_000, 12_500),
        envelope('c', 'Fuel', 8_000, 7_600),
        envelope('e', 'Books', 5_000, 1_000),
      ]),
    );
    renderWidget(<BudgetsWidget />);
    expect(await screen.findByText('Left to budget')).toBeInTheDocument();
    expect(screen.getByText('Left to budget').closest('div')?.parentElement?.textContent).toContain(
      '$250.00',
    );
    const list = screen.getByRole('list', { name: 'Closest to their budget' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('Dining');
    expect(items[0]!.textContent).toContain('Over budget');
    expect(items[0]!.textContent).toMatch(/\$25\.00.* over/u);
    expect(items[1]!.textContent).toContain('Nearly spent');
    expect(within(items[0]!).getByRole('meter')).toHaveAttribute('aria-valuenow', '100');
  });

  it('empty: no category lines is "no budget yet" with the link that sets one — never $0 meters', async () => {
    serve(budgetPeriod([], 0));
    const { container } = renderWidget(<BudgetsWidget />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent('No budget yet');
    expect(screen.getByRole('link', { name: 'Set one' })).toHaveAttribute('href', '/budget');
    expect(container.textContent).not.toContain('$0.00');
  });

  it('nothing spent yet says so instead of drawing empty meters', async () => {
    serve(budgetPeriod([budgetLine({ id: 'a', name: 'Groceries' })]));
    renderWidget(<BudgetsWidget />);
    expect(
      await screen.findByText(/Nothing has been spent from a budgeted category/u),
    ).toBeInTheDocument();
  });

  it('an error (the budget cannot be read) says so', async () => {
    serve(null);
    renderWidget(<BudgetsWidget />);
    expect(await screen.findByTestId('widget-error')).toHaveTextContent(
      "Your budget isn't available",
    );
  });
});
