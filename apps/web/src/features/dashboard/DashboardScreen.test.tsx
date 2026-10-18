// SPDX-License-Identifier: MIT
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { DashboardScreen } from './DashboardScreen.tsx';
import { WIDGET_IDS, type LayoutEntry } from './layout.ts';
import { paceFixture, renderWidget } from './test-utils.tsx';

interface Server {
  layout: LayoutEntry[] | null;
  readonly requests: string[];
  readonly puts: LayoutEntry[][];
  deletes: number;
}

function serve(initial: LayoutEntry[] | null): Server {
  const server: Server = { layout: initial, requests: [], puts: [], deletes: 0 };
  const body = () => ({
    widgets: server.layout ?? WIDGET_IDS.map((id) => ({ id, visible: true })),
    customised: server.layout !== null,
  });
  stubFetchRoutes([
    { match: '/api/dashboard/layout', method: 'GET', handle: () => jsonResponse(body()) },
    {
      match: '/api/dashboard/layout',
      method: 'PUT',
      handle: async ({ request }) => {
        const sent = (await request.json()) as { widgets: LayoutEntry[] };
        server.puts.push(sent.widgets);
        server.layout = sent.widgets;
        return jsonResponse(body());
      },
    },
    {
      match: '/api/dashboard/layout',
      method: 'DELETE',
      handle: () => {
        server.deletes += 1;
        server.layout = null;
        return jsonResponse(body());
      },
    },
    {
      match: '/api/reports/spending-pace',
      method: 'GET',
      handle: () => jsonResponse(paceFixture()),
    },
    {
      // Every other widget's source: recorded, and answered as unavailable (each widget's own tests cover its data).
      match: /^\/api\//u,
      handle: ({ url }) => {
        server.requests.push(url.pathname);
        return jsonResponse({ code: 'test.unmocked' }, 503);
      },
    },
  ]);
  return server;
}

/** The grid's widgets in order; `[]` while the grid is not there yet (no throw, so `waitFor` retries cheaply). */
function gridOrder(): string[] {
  const grid = document.querySelector('[data-testid="dashboard-grid"]');
  if (grid === null) return [];
  return [...grid.querySelectorAll('[data-grid-widget]')].map(
    (node) => node.getAttribute('data-grid-widget') ?? '',
  );
}

describe('DashboardScreen (WP 10.9)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }, 20_000);

  it('draws the saved order; net worth spans two columns', async () => {
    serve([
      { id: 'spending-pace', visible: true },
      { id: 'net-worth', visible: true },
    ]);
    renderWidget(<DashboardScreen />);
    await waitFor(() => expect(gridOrder().slice(0, 2)).toEqual(['spending-pace', 'net-worth']));
    expect(gridOrder()).toHaveLength(WIDGET_IDS.length);
    const netWorth = screen
      .getByTestId('dashboard-grid')
      .querySelector('[data-grid-widget="net-worth"]');
    expect(netWorth?.className).toContain('@2xl:col-span-2');
  }, 20_000);

  it('a hidden widget is not rendered at all, and asks its source for nothing', async () => {
    const server = serve(
      WIDGET_IDS.map((id) => ({ id, visible: id !== 'investments' && id !== 'goals' })),
    );
    renderWidget(<DashboardScreen />);
    await waitFor(() => expect(gridOrder()).toHaveLength(WIDGET_IDS.length - 2), {
      timeout: 10_000,
    });
    expect(gridOrder()).not.toContain('goals');
    expect(document.querySelector('[data-widget="investments"]')).toBeNull();
    // Give every mounted widget's request time to go out.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(
      server.requests.filter((path) => path === '/api/holdings' || path === '/api/goals'),
    ).toEqual([]);
    expect(server.requests).toContain('/api/budgets/current');
  }, 20_000);

  it('every widget hidden says how to bring them back', async () => {
    serve(WIDGET_IDS.map((id) => ({ id, visible: false })));
    renderWidget(<DashboardScreen />);
    expect(await screen.findByText(/Every widget is hidden/u)).toBeInTheDocument();
  }, 20_000);

  it('Customize: a switch hides a widget, the arrows move one, each change is saved; reset restores the default', async () => {
    const server = serve(null);
    renderWidget(<DashboardScreen />);
    await waitFor(() => expect(gridOrder()).toHaveLength(WIDGET_IDS.length));

    fireEvent.click(screen.getByRole('button', { name: 'Customize' }));
    const dialog = await screen.findByRole('dialog', { name: 'Customize the dashboard' });

    fireEvent.click(within(dialog).getByRole('switch', { name: 'Show Goals' }));
    await waitFor(() => expect(server.puts).toHaveLength(1));
    expect(server.puts[0]?.find((entry) => entry.id === 'goals')).toEqual({
      id: 'goals',
      visible: false,
    });
    await waitFor(() => expect(gridOrder()).not.toContain('goals'));

    const up = within(dialog).getByRole('button', { name: 'Move Spending pace up' });
    up.focus();
    fireEvent.click(up);
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]?.slice(0, 2).map((entry) => entry.id)).toEqual([
      'spending-pace',
      'net-worth',
    ]);
    await waitFor(() => expect(gridOrder()[0]).toBe('spending-pace'));
    // At the top now, "up" is disabled: focus moved to its sibling, not lost to the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(dialog).getByRole('button', { name: 'Move Spending pace down' }),
      ),
    );
    expect(within(dialog).getByRole('button', { name: 'Move Spending pace up' })).toBeDisabled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(server.deletes).toBe(1));
    await waitFor(() => expect(gridOrder()).toEqual([...WIDGET_IDS]));
  }, 20_000);
});
