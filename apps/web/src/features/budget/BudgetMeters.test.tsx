// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../../routeTree.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import type { BudgetLine, BudgetPeriod, Category } from '../../api/generated/types.gen.ts';

/**
 * WP 10.11 on the Budget screen: the Left-to-budget card is the server's, the group and row meters with the pace
 * tick, the honesty rules (zero budget, period over), and the By-variability view with its classify control and a
 * suggestion that is never applied by itself.
 */

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

const usd = (minor: number) => ({ minor: String(minor), currency: 'USD' });

function category(
  id: string,
  label: string,
  kind: Category['kind'],
  variability: Category['variability'],
): Category {
  return {
    id,
    key: id,
    parentId: null,
    label,
    description: '',
    kind,
    icon: 'circle',
    hue: 'teal',
    variability,
    sort: 0,
    isSystem: false,
    archivedAt: null,
    assignable: true,
  };
}

const CATEGORIES: Category[] = [
  category('cat_rent', 'Rent', 'expense', 'fixed'),
  category('cat_groceries', 'Groceries', 'expense', 'flexible'),
  category('cat_gifts', 'Gifts', 'expense', 'non_monthly'),
  category('cat_coffee', 'Coffee', 'expense', null),
  category('cat_books', 'Books', 'expense', null),
  category('cat_salary', 'Salary', 'income', null),
];

function line(
  id: string,
  categoryId: string,
  carryover: number,
  assigned: number,
  spent: number,
): BudgetLine {
  const available = carryover + assigned - spent;
  return {
    id,
    kind: 'category',
    categoryId,
    creditAccountId: null,
    name: null,
    carryover: usd(carryover),
    assigned: usd(assigned),
    activity: usd(-spent),
    available: usd(available),
    cashOverspend: usd(Math.max(0, -available)),
    creditOverspend: usd(0),
    rolloverPolicy: 'ROLLOVER',
    goalType: 'NONE',
    neededThisPeriod: usd(0),
    underfunded: usd(0),
    priority: 0,
    class: null,
    transferExcludedCount: 0,
    refundNettedCount: 0,
  };
}

const LINES: BudgetLine[] = [
  line('l_rent', 'cat_rent', 0, 150_000, 150_000),
  line('l_groceries', 'cat_groceries', 5_000, 60_000, 30_000),
  line('l_gifts', 'cat_gifts', 0, 0, 0),
  line('l_coffee', 'cat_coffee', 0, 10_000, 2_000),
  line('l_books', 'cat_books', 0, 5_000, 6_000),
  line('l_salary', 'cat_salary', 0, 0, -500_000),
];

function period(overrides: Partial<BudgetPeriod> = {}): BudgetPeriod {
  return {
    id: 'period_1',
    budgetId: 'budget_1',
    kind: 'CALENDAR_MONTH',
    startDate: '2026-09-01',
    endDate: '2026-10-01',
    sequence: 1,
    status: 'open',
    // Deliberately NOT income − budgetedExpenses − plannedSavings (500 000 − 225 000 − 20 000 = 255 000), nor
    // anything the lines add to: the screen must print what the server says.
    readyToAssign: usd(-1_234),
    income: usd(500_000),
    dirty: false,
    toStayOnTrack: usd(0),
    totalCategoryAvailable: usd(0),
    totalCreditCardPaymentAvailable: usd(0),
    budgetedExpenses: usd(225_000),
    plannedSavings: usd(20_000),
    rolledOver: usd(5_000),
    lines: LINES,
    ...overrides,
  };
}

interface Served {
  readonly patches: { url: string; body: unknown }[];
}

function serve(options: { today?: string; overrides?: Partial<BudgetPeriod> } = {}): Served {
  const served: Served = { patches: [] };
  stubFetchRoutes([
    { match: '/api/auth/session', handle: () => jsonResponse(SESSION) },
    {
      match: '/api/categories/variability-suggestions',
      method: 'GET',
      handle: () =>
        jsonResponse({
          suggestions: [
            {
              categoryId: 'cat_coffee',
              variability: 'fixed',
              seriesIds: ['00000000-0000-4000-8000-000000000001'],
            },
          ],
        }),
    },
    {
      match: /^\/api\/categories\/[^/]+$/,
      method: 'PATCH',
      handle: async ({ url, request }) => {
        const body = (await request.json()) as { variability: Category['variability'] };
        served.patches.push({ url: url.pathname, body });
        const id = url.pathname.split('/').at(-1) ?? '';
        const found = CATEGORIES.find((c) => c.id === id);
        return jsonResponse({ category: { ...found, variability: body.variability } });
      },
    },
    { match: '/api/categories', handle: () => jsonResponse({ categories: CATEGORIES }) },
    {
      match: '/api/budgets/current',
      handle: () =>
        jsonResponse({
          budgetId: 'budget_1',
          currency: 'USD',
          today: options.today ?? '2026-09-15',
          period: period(options.overrides),
        }),
    },
    { match: '/api/budgets/periods', handle: () => jsonResponse({ periods: [] }) },
  ]);
  return served;
}

function renderAt(path: string) {
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
  return router;
}

/** The visible text of a `Money` (its `aria-hidden` half). */
function visible(element: HTMLElement): string {
  return element.querySelector('[aria-hidden="true"]')?.textContent ?? '';
}

describe('Budget meters (WP 10.11)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('Left to budget is the server’s readyToAssign, verbatim — never income − expenses − savings', async () => {
    serve();
    renderAt('/budget');
    const hero = await screen.findByTestId('ready-to-assign-amount');
    expect(visible(hero)).toBe('−$12.34');
    expect(visible(hero)).not.toContain('2,550.00');
    expect(screen.getByText('Assigned more than you have — fix this first')).toBeInTheDocument();
    expect(visible(screen.getByTestId('ltb-income'))).toBe('$5,000.00');
    expect(visible(screen.getByTestId('ltb-budgeted-expenses'))).toBe('$2,250.00');
    expect(visible(screen.getByTestId('ltb-planned-savings'))).toBe('$200.00');
    expect(screen.getByTestId('ltb-rollover')).toHaveTextContent(/\+\$50\.00.*rolled over/u);
  });

  it('a positive Left to budget carries the meaning line; nothing rolled over says so', async () => {
    serve({ overrides: { readyToAssign: usd(25_000), rolledOver: usd(0) } });
    renderAt('/budget');
    expect(visible(await screen.findByTestId('ready-to-assign-amount'))).toBe('+$250.00');
    expect(screen.getByText('Income not yet given to a category')).toBeInTheDocument();
    expect(screen.getByTestId('ltb-rollover')).toHaveTextContent(
      'Nothing rolled over from last period',
    );
  });

  it('By group: the Spending header meter with the tick at day 15 of 30, row meters, zero budget withheld', async () => {
    serve();
    renderAt('/budget');
    const spending = await screen.findByRole('region', { name: 'Spending' });
    const meters = within(spending).getAllByRole('meter');
    const header = meters.find((m) => m.getAttribute('data-meter-size') === 'md');
    if (header === undefined) throw new Error('no group meter');
    // budgeted 2,300.00 (incl. 50.00 rolled over), spent 1,880.00: 82 % at a 50 % pace.
    expect(header).toHaveAttribute('data-meter-state', 'ahead');
    expect(header).toHaveAttribute('aria-valuenow', '82');
    expect(header.querySelector('[data-meter-tick]')).toHaveAttribute('data-meter-tick', '0.5000');
    expect(spending.textContent).toContain('Ahead of pace');
    const caption = header.closest('div.mb-2')?.querySelector('p.text-right');
    const shown = [...(caption?.querySelectorAll('[aria-hidden="true"]') ?? [])].map(
      (n) => n.textContent,
    );
    expect(shown).toEqual(['$1,880.00', '$2,300.00', '$420.00']);
    expect(caption?.textContent).toMatch(/ left$/u);

    // Rows: Books over, Rent ahead (100 % mid-month), Gifts withheld with words and no bar.
    const books = screen.getByRole('meter', { name: 'Books: spent of budget' });
    expect(books).toHaveAttribute('data-meter-state', 'over');
    expect(books.closest('li')?.textContent).toMatch(/\$10\.00.* over/u);
    const gifts = screen.getByText('Gifts').closest('li');
    if (gifts === null) throw new Error('no gifts row');
    expect(within(gifts).queryByRole('meter')).toBeNull();
    expect(gifts.textContent).toContain('no amount set');
    // Income is not spent from: no meter on its header or its rows.
    const income = screen.getByRole('region', { name: 'Income' });
    expect(within(income).queryByRole('meter')).toBeNull();
  });

  it('a period that has ended hides the tick and says "period over"; one not started says so', async () => {
    serve({ today: '2026-10-01' });
    renderAt('/budget');
    expect(await screen.findByTestId('budget-pace')).toHaveTextContent('This period is over');
    expect(document.querySelector('[data-meter-tick]')).toBeNull();
    const header = screen
      .getAllByRole('meter')
      .find((m) => m.getAttribute('data-meter-size') === 'md');
    expect(header).toHaveAttribute('data-meter-state', 'within');
    expect(header).toHaveAttribute('aria-valuetext', expect.stringContaining('period over'));
  });

  it('a period not started yet has no tick either', async () => {
    serve({ today: '2026-08-31' });
    renderAt('/budget');
    expect(await screen.findByTestId('budget-pace')).toHaveTextContent('has not started');
    expect(document.querySelector('[data-meter-tick]')).toBeNull();
  });

  it('the table view names the pace for each group', async () => {
    serve();
    renderAt('/budget');
    await screen.findByRole('region', { name: 'Spending' });
    const table = screen.getByRole('table', { name: /Budget meters/u });
    expect(within(table).getByRole('columnheader', { name: 'Pace' })).toBeInTheDocument();
    const row = within(table).getByRole('row', { name: /Spending/u });
    expect(row.textContent).toContain('50% (day 15 of 30)');
    expect(row.textContent).toContain('Ahead of pace');
  });

  it('By variability: sections with totals, Unclassified with a suggestion that is not applied until pressed', async () => {
    const user = userEvent.setup();
    const served = serve();
    const router = renderAt('/budget');
    await screen.findByRole('region', { name: 'Spending' });

    await user.click(screen.getByRole('button', { name: 'By variability' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ view: 'variability' }));

    expect(visible(await screen.findByTestId('variability-total-fixed'))).toBe('$1,500.00');
    expect(screen.getByTestId('variability-total-fixed')).toHaveTextContent(
      'Budgeted fixed expenses',
    );
    expect(visible(screen.getByTestId('variability-total-flexible'))).toBe('$650.00');
    expect(visible(screen.getByTestId('variability-total-non_monthly'))).toBe('$0.00');

    const unclassified = screen.getByRole('region', { name: 'Unclassified' });
    const chips = await within(unclassified).findAllByTestId('variability-suggested');
    expect(chips).toHaveLength(1);
    const coffeeGroup = within(unclassified).getByRole('group', { name: 'Classify Coffee' });
    expect(coffeeGroup.closest('li')).toContainElement(chips[0]!);
    for (const button of within(coffeeGroup).getAllByRole('button')) {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    }
    expect(served.patches, 'a suggestion writes nothing by itself').toEqual([]);

    await user.click(within(coffeeGroup).getByRole('button', { name: 'Fixed' }));
    await waitFor(() =>
      expect(served.patches).toEqual([
        { url: '/api/categories/cat_coffee', body: { variability: 'fixed' } },
      ]),
    );

    // Income is not spending to classify; it stays editable below.
    expect(screen.getByRole('region', { name: 'Income and card payments' })).toHaveTextContent(
      'Salary',
    );
  });

  it('the classify control is keyboard operable: Tab to a choice, Space presses it', async () => {
    const user = userEvent.setup();
    const served = serve();
    renderAt('/budget?view=variability');
    const books = await screen.findByRole('group', { name: 'Classify Books' });
    within(books).getByRole('button', { name: 'Flexible' }).focus();
    await user.keyboard(' ');
    await waitFor(() =>
      expect(served.patches).toEqual([
        { url: '/api/categories/cat_books', body: { variability: 'flexible' } },
      ]),
    );
  });

  it('a bad ?view= falls back to By group', async () => {
    serve();
    renderAt('/budget?view=sideways');
    expect(await screen.findByRole('button', { name: 'By group' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
