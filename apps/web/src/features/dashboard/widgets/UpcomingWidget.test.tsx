// SPDX-License-Identifier: MIT
import { screen, within } from '@testing-library/react';
import { Money } from '@core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../../test-support/api-test-utils.ts';
import { renderWidget } from '../test-utils.tsx';
import { calendar, charge, usd } from './fixtures.ts';
import { chargesWithin, lowestBalance } from './upcoming.ts';
import { UpcomingWidget } from './UpcomingWidget.tsx';

function safe(availableMinor: number, safeMinor: number) {
  return {
    from: '2026-03-17',
    to: '2026-04-16',
    currency: 'USD',
    availableCash: usd(availableMinor),
    committed: usd(0),
    committedWorstCase: usd(0),
    expectedIncome: usd(0),
    safe: usd(safeMinor),
    committedCount: 0,
  };
}

function serve(cal: ReturnType<typeof calendar>, safeBody: ReturnType<typeof safe>) {
  stubFetchRoutes([
    { match: '/api/recurring/upcoming', method: 'GET', handle: () => jsonResponse(cal) },
    { match: '/api/recurring/safe-to-spend', method: 'GET', handle: () => jsonResponse(safeBody) },
    {
      match: '/api/transactions',
      method: 'GET',
      handle: () => jsonResponse({ items: [], nextCursor: null, summary: null }),
    },
  ]);
}

describe('lowestBalance (WP 10.9)', () => {
  it('walks today’s cash through each day’s expected flows and keeps the lowest point and its date', () => {
    const cal = calendar('2026-03-17', 10, [
      charge('2026-03-18', -30_000),
      charge('2026-03-20', 250_000),
      charge('2026-03-19', -40_000),
    ]);
    const lowest = lowestBalance(Money.of(50_000n, 'USD'), cal);
    expect(lowest).toEqual({ balance: Money.of(-20_000n, 'USD'), date: '2026-03-19' });
  });

  it('never converts: another currency is no projection', () => {
    expect(lowestBalance(Money.of(1n, 'EUR'), calendar('2026-03-17', 3, []))).toBeNull();
  });

  it('lists the first seven days only', () => {
    const cal = calendar('2026-03-17', 30, [
      charge('2026-03-23', -100),
      charge('2026-03-24', -200),
    ]);
    expect(chargesWithin(cal, 7).map((entry) => entry.date)).toEqual(['2026-03-23']);
  });
});

describe('UpcomingWidget (WP 10.9)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('populated: Safe to spend and the next seven days; no warning when the balance stays above zero', async () => {
    serve(
      calendar('2026-03-17', 30, [charge('2026-03-18', -1_599), charge('2026-03-30', -9_000)]),
      safe(200_000, 189_401),
    );
    renderWidget(<UpcomingWidget />);
    expect(await screen.findByText('Safe to spend')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Expected in the next 7 days' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(list.textContent).toContain('−$15.99');
    expect(screen.queryByTestId('overdraft-warning')).toBeNull();
  });

  it('an overdraft is a warning in words: how low, and when', async () => {
    serve(
      calendar('2026-03-17', 30, [charge('2026-03-18', -30_000), charge('2026-03-19', -40_000)]),
      safe(50_000, -20_000),
    );
    renderWidget(<UpcomingWidget />);
    const warning = await screen.findByTestId('overdraft-warning');
    expect(warning).toHaveAttribute('role', 'status');
    expect(warning.textContent).toMatch(
      /Your cash could run short: the projected balance falls to −\$200\.00.* on Thu, Mar 19/u,
    );
  });

  it('empty: no recurring charge at all names the screen that finds them', async () => {
    serve(calendar('2026-03-17', 30, []), safe(50_000, 50_000));
    renderWidget(<UpcomingWidget />);
    expect(await screen.findByTestId('widget-empty')).toHaveTextContent(
      'No recurring charges are expected',
    );
    expect(screen.getByRole('link', { name: 'Review recurring' })).toHaveAttribute(
      'href',
      '/recurring',
    );
  });

  it('nothing in seven days (but later) says so', async () => {
    serve(calendar('2026-03-17', 30, [charge('2026-04-01', -500)]), safe(50_000, 49_500));
    renderWidget(<UpcomingWidget />);
    expect(await screen.findByText('Nothing is expected in the next 7 days.')).toBeInTheDocument();
  });
});
