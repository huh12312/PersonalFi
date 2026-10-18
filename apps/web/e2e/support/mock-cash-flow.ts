// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * `GET /reports/cash-flow` (WP 10.10), as a layerable mock: a field-for-field instance of the contract's `CashFlow`
 * for whatever timeframe and period the hub asks, computed from one deterministic figure per period so stepping,
 * the bars, the three comparisons and the breakdowns all agree with each other the way the server's do.
 *
 * "Today" is 2026-03-17 (the pace mock's day). The ledger starts in April 2025: earlier periods have no data, so a
 * holder stepping back meets withheld comparisons and "no data" bars. February 2026 has no income (the savings rate
 * is withheld for it). The expense breakdown has fourteen categories, so twelve rows show and two fold into "Other".
 * Other currencies: EUR, named and never summed.
 */

const TODAY = '2026-03-17';
const FIRST_MONTH = '2025-04';

type Timeframe = 'month' | 'quarter' | 'year';

interface Period {
  readonly key: string;
  readonly start: string;
  readonly end: string;
  /** The months it spans, `YYYY-MM`. */
  readonly months: readonly string[];
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function period(timeframe: Timeframe, year: number, index: number): Period {
  const span = timeframe === 'month' ? 1 : timeframe === 'quarter' ? 3 : 12;
  const absolute = year * (12 / span) + index;
  const y = Math.floor(absolute / (12 / span));
  const i = absolute - y * (12 / span);
  const firstMonth = i * span + 1;
  const lastMonth = firstMonth + span - 1;
  const months = Array.from(
    { length: span },
    (_unused, k) => `${pad(y, 4)}-${pad(firstMonth + k)}`,
  );
  const key =
    timeframe === 'year'
      ? pad(y, 4)
      : timeframe === 'quarter'
        ? `${pad(y, 4)}-Q${String(i + 1)}`
        : `${pad(y, 4)}-${pad(firstMonth)}`;
  return {
    key,
    start: `${pad(y, 4)}-${pad(firstMonth)}-01`,
    end: `${pad(y, 4)}-${pad(lastMonth)}-${pad(daysIn(y, lastMonth))}`,
    months,
  };
}

function parse(timeframe: Timeframe, key: string): { year: number; index: number } | null {
  if (timeframe === 'year' && /^\d{4}$/.test(key)) return { year: Number(key), index: 0 };
  if (timeframe === 'quarter' && /^\d{4}-Q[1-4]$/.test(key))
    return { year: Number(key.slice(0, 4)), index: Number(key.slice(6)) - 1 };
  if (timeframe === 'month' && /^\d{4}-(0[1-9]|1[0-2])$/.test(key))
    return { year: Number(key.slice(0, 4)), index: Number(key.slice(5)) - 1 };
  return null;
}

/** One month's figures (minor units), or null before the ledger starts / after today's month. */
function monthFigures(month: string): { income: number; expenses: number } | null {
  if (month < FIRST_MONTH || month > TODAY.slice(0, 7)) return null;
  const n = Number(month.slice(0, 4)) * 12 + Number(month.slice(5));
  const expenses = 310_000 + ((n * 7919) % 9) * 9_500;
  if (month === '2026-02') return { income: 0, expenses: 288_000 };
  if (month === TODAY.slice(0, 7)) return { income: 520_000, expenses: 151_250 };
  return { income: 520_000 + ((n * 104_729) % 5) * 12_000, expenses };
}

interface Figures {
  hasData: boolean;
  income: number;
  expenses: number;
}

function figuresOf(p: Period): Figures {
  let hasData = false;
  let income = 0;
  let expenses = 0;
  for (const month of p.months) {
    const f = monthFigures(month);
    if (f === null) continue;
    hasData = true;
    income += f.income;
    expenses += f.expenses;
  }
  return { hasData, income, expenses };
}

function wireFigures(p: Period, f: Figures) {
  return {
    from: p.start,
    to: p.end,
    hasData: f.hasData,
    incomeMinor: String(f.income),
    expensesMinor: String(f.expenses),
    netMinor: String(f.income - f.expenses),
    transactionCount: f.hasData ? 40 * p.months.length : 0,
  };
}

const EXPENSE_CATEGORIES: readonly {
  id: string | null;
  label: string;
  hue: string;
  parent: string;
}[] = [
  { id: 'cat_rent', label: 'Rent', hue: 'indigo', parent: 'cat_home' },
  { id: 'cat_groceries', label: 'Groceries', hue: 'green', parent: 'cat_groceries' },
  { id: 'cat_dining_restaurants', label: 'Restaurants', hue: 'orange', parent: 'cat_dining' },
  { id: 'cat_transport', label: 'Transport', hue: 'cyan', parent: 'cat_travel' },
  { id: 'cat_utilities', label: 'Utilities', hue: 'yellow', parent: 'cat_home' },
  { id: 'cat_dining_coffee', label: 'Coffee Shops', hue: 'brown', parent: 'cat_dining' },
  { id: 'cat_health', label: 'Health', hue: 'red', parent: 'cat_health' },
  { id: 'cat_shopping', label: 'Shopping', hue: 'purple', parent: 'cat_shopping' },
  { id: 'cat_subscriptions', label: 'Subscriptions', hue: 'purple', parent: 'cat_shopping' },
  { id: null, label: 'Uncategorised', hue: 'neutral', parent: '' },
  { id: 'cat_gifts', label: 'Gifts', hue: 'pink', parent: 'cat_shopping' },
  { id: 'cat_insurance', label: 'Insurance', hue: 'teal', parent: 'cat_home' },
  { id: 'cat_pets', label: 'Pets', hue: 'lime', parent: 'cat_pets' },
  { id: 'cat_books', label: 'Books', hue: 'mint', parent: 'cat_shopping' },
];
const EXPENSE_WEIGHTS = [38, 14, 9, 7, 6, 5, 4, 4, 3, 3, 2.5, 2, 1.5, 1];
const GROUP_LABELS: Record<string, string> = {
  cat_home: 'Home',
  cat_groceries: 'Groceries',
  cat_dining: 'Dining',
  cat_travel: 'Travel',
  cat_health: 'Health',
  cat_shopping: 'Shopping',
  cat_pets: 'Pets',
};
const MERCHANTS = [
  { id: 'merch_landlord', label: 'Parkside Lettings', hue: 'indigo', weight: 38 },
  { id: 'merch_grocer', label: 'Corner Grocery', hue: 'green', weight: 18 },
  { id: 'merch_1', label: 'Blue Bottle Coffee', hue: 'brown', weight: 9 },
  { id: 'merch_transit', label: 'City Transit', hue: 'cyan', weight: 8 },
  { id: 'merch_power', label: 'Bright Power Co', hue: 'yellow', weight: 7 },
  { id: 'merch_bistro', label: 'Bistro Nord', hue: 'orange', weight: 6 },
  { id: 'merch_market', label: 'Farmers Market', hue: 'lime', weight: 3 },
  { id: 'merch_taco', label: 'Taco Stand', hue: 'red', weight: 2 },
];

/** Split `total` by `weights`, largest remainder, so the rows always add up to the total. */
function split(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (total * w) / sum);
  const floors = raw.map(Math.floor);
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }
  return floors;
}

function rows(
  entries: readonly {
    key: string | null;
    label: string;
    hue: string;
    sum: number;
    drill: object | null;
  }[],
  total: number,
) {
  return entries
    .map((entry) => ({
      key: entry.key,
      label: entry.label,
      hue: entry.hue,
      sumMinor: String(entry.sum),
      share: total > 0 ? entry.sum / total : null,
      count: Math.max(1, Math.round(entry.sum / 4_000)),
      drillThrough: entry.drill,
    }))
    .sort((a, b) => Number(b.sumMinor) - Number(a.sumMinor) || a.label.localeCompare(b.label));
}

function breakdowns(p: Period, f: Figures) {
  const span = { from: p.start, to: p.end };
  const amounts = split(f.expenses, EXPENSE_WEIGHTS);
  const category = rows(
    EXPENSE_CATEGORIES.map((c, i) => ({
      key: c.id,
      label: c.label,
      hue: c.hue,
      sum: amounts[i] ?? 0,
      drill: c.id === null ? { ...span, uncategorized: true } : { categoryIds: [c.id], ...span },
    })),
    f.expenses,
  );
  const groupSums = new Map<string | null, number>();
  EXPENSE_CATEGORIES.forEach((c, i) => {
    const key = c.id === null ? null : c.parent;
    groupSums.set(key, (groupSums.get(key) ?? 0) + (amounts[i] ?? 0));
  });
  const group = rows(
    [...groupSums].map(([key, sum]) => ({
      key,
      label: key === null ? 'Uncategorised' : (GROUP_LABELS[key] ?? key),
      hue: key === null ? 'neutral' : 'sky',
      sum,
      drill: key === null ? { ...span, uncategorized: true } : { categoryIds: [key], ...span },
    })),
    f.expenses,
  );
  const merchantAmounts = split(f.expenses, [...MERCHANTS.map((m) => m.weight), 20]);
  const merchant = rows(
    [
      ...MERCHANTS.map((m, i) => ({
        key: m.id,
        label: m.label,
        hue: m.hue,
        sum: merchantAmounts[i] ?? 0,
        drill: { merchantIds: [m.id], ...span },
      })),
      {
        key: null,
        label: 'No merchant',
        hue: 'neutral',
        sum: merchantAmounts[MERCHANTS.length] ?? 0,
        drill: null,
      },
    ],
    f.expenses,
  );
  const incomeRow = (key: string | null, label: string, hue: string, drill: object | null) =>
    f.income > 0 ? rows([{ key, label, hue, sum: f.income, drill }], f.income) : [];
  return {
    income: {
      category: incomeRow('cat_salary', 'Paycheck', 'teal', {
        categoryIds: ['cat_salary'],
        ...span,
      }),
      group: incomeRow('cat_income', 'Income', 'teal', {
        categoryIds: ['cat_income', 'cat_salary'],
        ...span,
      }),
      merchant: incomeRow('merch_acme', 'ACME Payroll', 'jade', {
        merchantIds: ['merch_acme'],
        ...span,
      }),
    },
    expenses: { category, group, merchant },
  };
}

function epochDay(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

export function cashFlowBody(timeframe: Timeframe, key: string | null) {
  const today = { year: Number(TODAY.slice(0, 4)), month: Number(TODAY.slice(5, 7)) };
  const span = timeframe === 'month' ? 1 : timeframe === 'quarter' ? 3 : 12;
  const current = period(timeframe, today.year, Math.floor((today.month - 1) / span));
  const parsed = key === null ? null : parse(timeframe, key);
  const selected = parsed === null ? current : period(timeframe, parsed.year, parsed.index);
  const shift = (p: Period, n: number) => {
    const at = parse(timeframe, p.key);
    if (at === null) throw new Error(p.key);
    return period(timeframe, at.year, at.index + n);
  };
  const isCurrent = selected.key === current.key;
  const isFuture = selected.start > TODAY;
  const offset = isCurrent ? epochDay(TODAY) - epochDay(selected.start) : null;
  const summary = figuresOf(selected);

  // Counterparts of the current period are read "at this point": the mock scales them by the elapsed fraction.
  const atPoint = (p: Period): Figures => {
    const f = figuresOf(p);
    if (offset === null || !f.hasData) return f;
    const fraction = Math.min(1, (offset + 1) / (epochDay(p.end) - epochDay(p.start) + 1));
    return {
      hasData: true,
      income: Math.round(f.income * fraction),
      expenses: Math.round(f.expenses * fraction),
    };
  };
  const single = (kind: 'previous' | 'year_ago', p: Period) => {
    const f = atPoint(p);
    return f.hasData
      ? {
          kind,
          periods: [p.key],
          available: true,
          withheld: null,
          periodsAveraged: 1,
          throughOffsetDays: offset,
          incomeMinor: String(f.income),
          expensesMinor: String(f.expenses),
          netMinor: String(f.income - f.expenses),
        }
      : {
          kind,
          periods: [p.key],
          available: false,
          withheld: 'no_data',
          periodsAveraged: 0,
          throughOffsetDays: offset,
          incomeMinor: null,
          expensesMinor: null,
          netMinor: null,
        };
  };
  const trailing = Array.from({ length: 12 }, (_unused, i) => shift(selected, i - 12))
    .map((p) => ({ p, f: atPoint(p) }))
    .filter((entry) => entry.f.hasData);
  const avg = (pick: (f: Figures) => number) =>
    Math.round(
      trailing.reduce((sum, entry) => sum + pick(entry.f), 0) / Math.max(trailing.length, 1),
    );
  const average =
    trailing.length === 0
      ? {
          kind: 'average',
          periods: [],
          available: false,
          withheld: 'no_history',
          periodsAveraged: 0,
          throughOffsetDays: offset,
          incomeMinor: null,
          expensesMinor: null,
          netMinor: null,
        }
      : {
          kind: 'average',
          periods: trailing.map((entry) => entry.p.key),
          available: true,
          withheld: null,
          periodsAveraged: trailing.length,
          throughOffsetDays: offset,
          incomeMinor: String(avg((f) => f.income)),
          expensesMinor: String(avg((f) => f.expenses)),
          netMinor: String(avg((f) => f.income) - avg((f) => f.expenses)),
        };

  const savings = isFuture
    ? { savingsRate: null, savingsRateWithheld: 'not_started' }
    : !summary.hasData
      ? { savingsRate: null, savingsRateWithheld: 'no_data' }
      : isCurrent
        ? { savingsRate: null, savingsRateWithheld: 'incomplete' }
        : summary.income <= 0
          ? { savingsRate: null, savingsRateWithheld: 'no_income' }
          : {
              savingsRate: (summary.income - summary.expenses) / summary.income,
              savingsRateWithheld: null,
            };

  return {
    timeframe,
    period: selected.key,
    start: selected.start,
    end: selected.end,
    currentPeriod: current.key,
    isCurrent,
    isFuture,
    through: isCurrent ? TODAY : null,
    currency: 'USD',
    otherCurrencies: ['EUR'],
    summary: { ...wireFigures(selected, summary), ...savings },
    comparisons: [
      single('previous', shift(selected, -1)),
      average,
      single('year_ago', shift(selected, -(12 / span))),
    ],
    bars: Array.from({ length: 12 }, (_unused, i) => {
      const p = shift(selected, i - 11);
      return { ...wireFigures(p, figuresOf(p)), period: p.key, complete: p.end < TODAY };
    }),
    breakdowns: breakdowns(selected, summary),
    asOf: `${TODAY}T15:00:00.000Z`,
    lastSyncedAt: `${TODAY}T14:00:00.000Z`,
  };
}

/**
 * The hub asks `GET /reports/sankey` for a period's exact window (`to` = a month's last day); Reports asks for
 * `to` = the first of a month. Only the hub's window is answered here — a spending flow over five categories and
 * their top merchants — so Reports keeps the budget layer's own fixture.
 */
function sankeyBody(from: string, to: string) {
  const usd = (minor: number) => ({ minor: String(minor), currency: 'USD' });
  const drill = (extra: object) => ({ ...extra, from, to });
  const categories = [
    { id: 'cat_rent', minor: 57_475, merchants: [['merch_landlord', 57_475]] },
    {
      id: 'cat_groceries',
      minor: 21_175,
      merchants: [
        ['merch_grocer', 16_000],
        ['merch_market', 5_175],
      ],
    },
    {
      id: 'cat_dining_restaurants',
      minor: 13_613,
      merchants: [
        ['merch_bistro', 9_000],
        ['merch_taco', 4_613],
      ],
    },
    { id: 'cat_transport', minor: 10_588, merchants: [['merch_transit', 10_588]] },
    { id: 'cat_dining_coffee', minor: 7_563, merchants: [['merch_1', 7_563]] },
  ] as const;
  const nodes: object[] = [{ id: 'income', kind: 'income', refId: null }];
  const links: object[] = [];
  for (const category of categories) {
    const node = `category:${category.id}`;
    nodes.push({ id: node, kind: 'category', refId: category.id });
    links.push({
      source: 'income',
      target: node,
      amount: usd(category.minor),
      drillThrough: drill({ categoryIds: [category.id] }),
    });
    for (const [merchant, minor] of category.merchants) {
      const target = `merchant:${merchant}`;
      nodes.push({ id: target, kind: 'merchant', refId: merchant });
      links.push({
        source: node,
        target,
        amount: usd(minor),
        drillThrough: drill({ categoryIds: [category.id], merchantIds: [merchant] }),
      });
    }
  }
  return { currency: 'USD', nodes, links };
}

/** `GET /reports/spending|income` for the hub's categories window: every month in it, the five largest categories. */
function categoryCells(side: 'spending' | 'income', from: string, to: string) {
  const cells: object[] = [];
  for (let month = from.slice(0, 7); month <= to.slice(0, 7);) {
    const f = monthFigures(month);
    if (f !== null) {
      const total = side === 'spending' ? f.expenses : f.income;
      const picks = side === 'spending' ? EXPENSE_CATEGORIES.slice(0, 5) : [{ id: 'cat_salary' }];
      const amounts = split(total, side === 'spending' ? [38, 14, 9, 7, 6] : [1]);
      picks.forEach((category, i) => {
        if ((amounts[i] ?? 0) === 0) return;
        const minor = side === 'spending' ? -(amounts[i] ?? 0) : (amounts[i] ?? 0);
        cells.push({
          month,
          categoryId: category.id,
          amount: { minor: String(minor), currency: 'USD' },
          transactionCount: 3,
          transferExcludedCount: 0,
          refundNettedCount: 0,
          drillThrough: {
            ...(category.id === null ? {} : { categoryIds: [category.id] }),
            from: `${month}-01`,
            to: `${month}-${pad(daysIn(Number(month.slice(0, 4)), Number(month.slice(5))))}`,
          },
        });
      });
    }
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5));
    month = m === 12 ? `${pad(y + 1, 4)}-01` : `${pad(y, 4)}-${pad(m + 1)}`;
  }
  return { cells };
}

export interface CashFlowMockState {
  /** Every `timeframe|period` asked, in order. */
  readonly requests: string[];
}

export async function installCashFlowMocks(page: Page): Promise<CashFlowMockState> {
  const state: CashFlowMockState = { requests: [] };
  await page.route('**/api/reports/cash-flow**', async (route: Route) => {
    const request = route.request();
    if (request.method() !== 'GET') return route.fallback();
    const url = new URL(request.url());
    if (url.pathname !== '/api/reports/cash-flow') return route.fallback();
    const timeframe = (url.searchParams.get('timeframe') ?? 'month') as Timeframe;
    const key = url.searchParams.get('period');
    state.requests.push(`${timeframe}|${key ?? ''}`);
    if (
      !['month', 'quarter', 'year'].includes(timeframe) ||
      (key !== null && parse(timeframe, key) === null)
    ) {
      return route.fulfill({
        status: 400,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'about:blank',
          title: 'Bad Request',
          status: 400,
          code: 'validation',
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(cashFlowBody(timeframe, key)),
    });
  });
  for (const side of ['spending', 'income'] as const) {
    await page.route(`**/api/reports/${side}**`, async (route: Route) => {
      const request = route.request();
      const url = new URL(request.url());
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      if (
        request.method() !== 'GET' ||
        url.pathname !== `/api/reports/${side}` ||
        to.endsWith('-01')
      )
        return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(categoryCells(side, from, to)),
      });
    });
  }
  await page.route('**/api/reports/sankey**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    if (request.method() !== 'GET' || url.pathname !== '/api/reports/sankey' || to.endsWith('-01'))
      return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(sankeyBody(from, to)),
    });
  });
  return state;
}
