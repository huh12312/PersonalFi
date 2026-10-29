// SPDX-License-Identifier: MIT
/**
 * Test-only (WP 10.9): renders a dashboard widget inside a fresh QueryClient and a memory router that knows every
 * screen a widget links to, so `<Link>` resolves. The same shape as `features/goals/routerTest.tsx`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';

import type { SpendingPace } from '../../api/generated/types.gen.ts';

const TARGETS = [
  '/accounts',
  '/accounts/connections',
  '/advisor',
  '/budget',
  '/goals',
  '/health',
  '/inbox',
  '/insights',
  '/investments',
  '/recurring',
  '/reports',
  '/transactions',
] as const;

export function renderWidget(ui: ReactNode): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const index = createRoute({ getParentRoute: () => root, path: '/', component: () => <>{ui}</> });
  const others = TARGETS.map((path) =>
    createRoute({ getParentRoute: () => root, path, component: () => <p>{`screen ${path}`}</p> }),
  );
  const router = createRouter({
    routeTree: root.addChildren([index, ...others]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  };
}

/** A cumulative series from daily amounts (minor units): `[0, 2500, 0]` → days 1–3 at 0, 2500, 2500. */
export function cumulative(daily: readonly number[]): { day: number; cumulativeMinor: string }[] {
  let running = 0;
  return daily.map((amount, index) => {
    running += amount;
    return { day: index + 1, cumulativeMinor: String(running) };
  });
}

export function paceFixture(overrides: Partial<SpendingPace> = {}): SpendingPace {
  return {
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
    lastSyncedAt: '2026-03-17T14:00:00.000Z',
    ...overrides,
  };
}
