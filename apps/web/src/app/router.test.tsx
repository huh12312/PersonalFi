// SPDX-License-Identifier: MIT
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { queryClient } from './query-client.ts';
import { router } from './router.tsx';

/**
 * A router-level smoke test, distinct from the Playwright e2e smoke test:
 * this one proves the route tree resolves and the app shell renders content
 * for both the default route and a navigated-to route, entirely in
 * happy-dom — no dev server, no network. `NetWorthAreaChart` renders 0×0
 * under happy-dom (no layout engine, ResizeObserver stubbed in
 * vitest.setup.ts) and is asserted elsewhere; this test only needs the shell
 * and route content, not pixels.
 */
describe('router', () => {
  it('renders the app shell and the dashboard at the root route', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText('PersonalFi')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByText('Net worth')).toBeInTheDocument();
  });

  it('navigates to a placeholder route through the real route tree', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await screen.findByRole('heading', { name: 'Dashboard' });

    await router.navigate({ to: '/settings' });

    expect(await screen.findByRole('heading', { name: 'Settings', level: 1 })).toBeInTheDocument();
    expect(
      await screen.findByText(/Profile, security & passkeys, connections/),
    ).toBeInTheDocument();
  });
});
