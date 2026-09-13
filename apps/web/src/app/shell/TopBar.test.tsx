// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRoute,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '../../components/ui/tooltip.tsx';
import { TopBar } from './TopBar.tsx';

/**
 * gate-remediation-web.md M-4: there was no sign-out control at all, and
 * nothing cleared TanStack Query's cache on logout. This mounts `TopBar` on
 * a minimal one-route router (not the full app tree — the guard on `/_app`
 * is exercised separately in `src/app/router.test.tsx`) so the "Sign out"
 * button can be driven end to end: the mutation fires, the cache empties,
 * and the app leaves for `/login`.
 */
function renderTopBar(queryClient: QueryClient) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <TopBar title="Dashboard" onOpenSearch={() => {}} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <RouterProvider router={router} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return router;
}

describe('TopBar sign-out', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('clears the query cache and navigates to /login', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(['auth', 'session'], { userId: 'user_1' });
    expect(queryClient.getQueryData(['auth', 'session'])).toBeDefined();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );

    const router = renderTopBar(queryClient);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(queryClient.getQueryData(['auth', 'session'])).toBeUndefined();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
