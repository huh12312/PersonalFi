// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 10.14 (V7): the category detail screen's mocks.
 *
 *  - `installCategoryHistoryMocks` answers `GET /reports/category-history` for any category: thirteen months ending
 *    with March 2026 (the sweep's "today" is 17 March 2026), two of them zero, the average over the twelve complete
 *    months. The sweep installs it, so `/categories/$categoryId` is walked like every other screen.
 *  - `installCategoryMocks` is the functional spec's chart of categories over the whole app's mocks: the Cash Flow
 *    hub's categories (so a breakdown row opens its screen), a stateful `PATCH /categories/{id}` (label, emoji, hue,
 *    variability — the last body is kept), and a `GET /transactions` that filters a small ledger by category and
 *    month, so "the transactions follow the selected month" is observable. Install it after `installSweepMocks`.
 */

function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

const MONTHS = [
  '2025-03',
  '2025-04',
  '2025-05',
  '2025-06',
  '2025-07',
  '2025-08',
  '2025-09',
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
] as const;

/** Spend per month for Groceries (minor units): two zero months; the last is March 2026 so far. */
export const GROCERIES_AMOUNTS = [
  41000, 38000, 0, 45000, 40000, 39000, 52000, 44000, 0, 47000, 43000, 39000, 21000,
] as const;
/** Σ of the twelve complete months = 428 000; ÷ 12 = 35 666.67 → 35 667 (half-even). */
export const GROCERIES_AVERAGE = 35667;

function lastDay(month: string): string {
  const [year, number] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(year, number, 0)).getUTCDate()).padStart(2, '0')}`;
}

export function categoryHistoryBody(categoryId: string) {
  const months = MONTHS.map((month, index) => {
    const amount = GROCERIES_AMOUNTS[index] ?? 0;
    return {
      month,
      start: `${month}-01`,
      end: lastDay(month),
      amountMinor: String(amount),
      transactionCount: amount === 0 ? 0 : Math.max(1, Math.round(amount / 9000)),
      hasActivity: amount !== 0,
      complete: index < 12,
      isCurrent: index === 12,
      inHistory: true,
    };
  });
  return {
    categoryId,
    side: 'spending',
    includesChildren: false,
    currency: 'USD',
    otherCurrencies: [],
    currentMonth: '2026-03',
    through: '2026-03-17',
    historyStart: '2025-03',
    months,
    average: {
      available: true,
      withheld: null,
      amountMinor: String(GROCERIES_AVERAGE),
      monthsAveraged: 12,
      months: MONTHS.slice(0, 12),
    },
    comparison: {
      available: true,
      withheld: null,
      thisMonthMinor: '21000',
      averageMinor: String(GROCERIES_AVERAGE),
      differenceMinor: String(21000 - GROCERIES_AVERAGE),
      direction: 'less',
    },
    drillThrough: { categoryIds: [categoryId] },
  };
}

export async function installCategoryHistoryMocks(page: Page): Promise<void> {
  await page.route('**/api/reports/category-history**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname !== '/api/reports/category-history') return route.fallback();
    const categoryId = url.searchParams.get('categoryId') ?? '';
    return route.fulfill(json(categoryHistoryBody(categoryId)));
  });
}

function category(
  id: string,
  key: string,
  label: string,
  hue: string,
  parentId: string | null,
  extra: Partial<{ assignable: boolean; kind: string; variability: string | null }> = {},
) {
  return {
    id,
    key,
    parentId,
    label,
    description: '',
    kind: extra.kind ?? 'expense',
    icon: 'circle',
    hue,
    variability: extra.variability ?? null,
    emoji: null as string | null,
    sort: 0,
    isSystem: true,
    archivedAt: null,
    assignable: extra.assignable ?? true,
  };
}

/** The Cash Flow hub's expense categories (`mock-cash-flow.ts`), under their groups. */
function categoriesFixture() {
  return [
    category('cat_home', 'housing', 'Home', 'indigo', null, { assignable: false }),
    category('cat_rent', 'housing.rent', 'Rent', 'indigo', 'cat_home', { variability: 'fixed' }),
    category('cat_utilities', 'utilities', 'Utilities', 'yellow', 'cat_home'),
    category('cat_insurance', 'insurance', 'Insurance', 'teal', 'cat_home'),
    category('cat_groceries', 'groceries', 'Groceries', 'green', null, {
      variability: 'flexible',
    }),
    category('cat_dining', 'dining', 'Dining', 'orange', null, { assignable: false }),
    category('cat_dining_restaurants', 'dining.restaurants', 'Restaurants', 'orange', 'cat_dining'),
    category('cat_dining_coffee', 'dining.coffee', 'Coffee Shops', 'brown', 'cat_dining'),
    category('cat_travel', 'travel', 'Travel', 'cyan', null, { assignable: false }),
    category('cat_transport', 'transport', 'Transport', 'cyan', 'cat_travel'),
    category('cat_health', 'health', 'Health', 'red', null),
    category('cat_shopping', 'shopping', 'Shopping', 'purple', null),
    category('cat_subscriptions', 'subscriptions', 'Subscriptions', 'purple', 'cat_shopping'),
    category('cat_gifts', 'shopping.gifts', 'Gifts', 'pink', 'cat_shopping'),
    category('cat_books', 'shopping.books_and_media', 'Books', 'mint', 'cat_shopping'),
    category('cat_pets', 'family.pets', 'Pets', 'lime', null),
    category('cat_salary', 'income.salary', 'Paycheck', 'teal', null, { kind: 'income' }),
  ];
}

function transaction(id: string, date: string, minor: number, name: string, categoryId: string) {
  return {
    id,
    accountId: 'acct_checking',
    factId: `fact_${id}`,
    date,
    amount: { minor: String(-minor), currency: 'USD' },
    name,
    merchantId: null,
    merchantName: name,
    pending: false,
    excluded: false,
    categoryId,
    note: null,
    isTransfer: false,
    transferLinkId: null,
    refundOfId: null,
    refundConfidence: null,
    supersededById: null,
    supersededReason: null,
    createdAt: `${date}T12:00:00.000Z`,
    updatedAt: `${date}T12:00:00.000Z`,
  };
}

const LEDGER = [
  transaction('txn_g_mar_1', '2026-03-03', 12000, 'Corner Grocery', 'cat_groceries'),
  transaction('txn_g_mar_2', '2026-03-12', 9000, 'Farmers Market', 'cat_groceries'),
  transaction('txn_g_feb_1', '2026-02-06', 21000, 'Corner Grocery', 'cat_groceries'),
  transaction('txn_g_feb_2', '2026-02-20', 18000, 'Bulk Barn', 'cat_groceries'),
  transaction('txn_g_jan_1', '2026-01-15', 43000, 'Corner Grocery', 'cat_groceries'),
  transaction('txn_r_mar_1', '2026-03-01', 180000, 'Landlord', 'cat_rent'),
];

export interface CategoryMocks {
  /** Every `PATCH /categories/{id}` body, in order. */
  readonly patches: Record<string, unknown>[];
}

export async function installCategoryMocks(page: Page): Promise<CategoryMocks> {
  const categories = categoriesFixture();
  const patches: Record<string, unknown>[] = [];
  await installCategoryHistoryMocks(page);
  await page.route('**/api/categories**', async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (path === '/api/categories' && method === 'GET') {
      return route.fulfill(json({ categories }));
    }
    if (path === '/api/categories/variability-suggestions' && method === 'GET') {
      return route.fulfill(json({ suggestions: [] }));
    }
    const match = /^\/api\/categories\/([^/]+)$/.exec(path);
    if (match !== null && method === 'PATCH') {
      const target = categories.find((c) => c.id === match[1]);
      if (target === undefined) return route.fulfill(json({ code: 'not_found' }, 404));
      const body = request.postDataJSON() as Record<string, unknown>;
      patches.push(body);
      if (typeof body['label'] === 'string') target.label = body['label'];
      if (body['emoji'] !== undefined) target.emoji = body['emoji'] as string | null;
      if (typeof body['hue'] === 'string') target.hue = body['hue'];
      if (body['variability'] !== undefined)
        target.variability = body['variability'] as string | null;
      return route.fulfill(json({ category: target }));
    }
    return route.fallback();
  });
  await page.route(
    (url) => url.pathname === '/api/transactions',
    async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const q = new URL(route.request().url()).searchParams;
      let items = [...LEDGER];
      const ids = q.getAll('categoryIds');
      if (ids.length > 0) items = items.filter((t) => ids.includes(t.categoryId));
      const from = q.get('from');
      const to = q.get('to');
      if (from !== null) items = items.filter((t) => t.date >= from);
      if (to !== null) items = items.filter((t) => t.date <= to);
      items.sort((a, b) => b.date.localeCompare(a.date));
      return route.fulfill(
        json({ items, nextCursor: null, summary: { count: items.length, totals: [] } }),
      );
    },
  );
  return { patches };
}
