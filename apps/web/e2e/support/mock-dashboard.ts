// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * The dashboard's own routes (WP 10.9), as a layerable mock: `GET|PUT|DELETE /dashboard/layout` against an
 * in-memory layout (it lives in the test's closure, so it survives a page reload — which is what lets
 * `dashboard.spec.ts` prove an order persists) and `GET /reports/spending-pace` with a fixed month. Every other
 * widget's source is the existing per-feature mocks' (budget, recurring, goals, investments, insights, the base
 * transactions), layered by `installSweepMocks`.
 *
 * The pace body is a field-for-field instance of the contract's `SpendingPace`: March 2026, today the 17th, $43.00
 * spent against $90.00 by the same day of February, a three-month average.
 */

export const WIDGET_IDS = [
  'net-worth',
  'spending-pace',
  'budgets',
  'upcoming',
  'to-review',
  'goals',
  'investments',
  'top-insights',
] as const;

export interface LayoutEntry {
  id: string;
  visible: boolean;
}

export interface DashboardMockState {
  layout: LayoutEntry[] | null;
  readonly puts: LayoutEntry[][];
}

function cumulative(daily: readonly number[]): { day: number; cumulativeMinor: string }[] {
  let running = 0;
  return daily.map((amount, index) => {
    running += amount;
    return { day: index + 1, cumulativeMinor: String(running) };
  });
}

export const PACE = {
  month: '2026-03',
  currency: 'USD',
  otherCurrencies: [],
  daysInMonth: 31,
  today: 17,
  days: cumulative([0, 2500, 0, 0, 0, 0, 0, 0, 1500, 0, 0, -500, 0, 0, 800, 0, 0]),
  lastMonthKey: '2026-02',
  lastMonth: cumulative([0, 0, 9000, ...new Array<number>(24).fill(0), 1000]),
  trailingMonths: ['2025-12', '2026-01', '2026-02'],
  trailingAverage: cumulative([
    0,
    0,
    3000,
    0,
    1000,
    0,
    0,
    0,
    0,
    2000,
    ...new Array<number>(21).fill(0),
  ]),
  includePending: false,
  pendingExcludedCount: 1,
  asOf: '2026-03-17T15:00:00.000Z',
  lastSyncedAt: null,
};

export async function installDashboardMocks(page: Page): Promise<DashboardMockState> {
  const state: DashboardMockState = { layout: null, puts: [] };
  const body = () => ({
    widgets: state.layout ?? WIDGET_IDS.map((id) => ({ id, visible: true })),
    customised: state.layout !== null,
  });
  const json = (route: Route, value: unknown) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });

  await page.route('**/api/dashboard/layout', async (route) => {
    const method = route.request().method();
    if (method === 'GET') return json(route, body());
    if (method === 'PUT') {
      const sent = route.request().postDataJSON() as { widgets: LayoutEntry[] };
      state.puts.push(sent.widgets);
      state.layout = sent.widgets;
      return json(route, body());
    }
    if (method === 'DELETE') {
      state.layout = null;
      return json(route, body());
    }
    return route.fallback();
  });
  await page.route('**/api/reports/spending-pace*', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return json(route, PACE);
  });
  return state;
}
