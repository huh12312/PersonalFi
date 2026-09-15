// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../routeTree.gen.ts';
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
 *
 * Since `/_app`'s `beforeLoad` (gate-remediation-web.md M-3/M-8) now checks
 * `/auth/session` before rendering anything under it, every test in this
 * file needs a mocked `fetch` — the describe blocks below split "already
 * signed in" (the pre-existing shell tests) from "the guard itself" (new).
 */

interface SessionState {
  userId: string;
  displayName: string;
  displayTimezone: string;
  authMethod: 'webauthn' | 'totp' | 'recovery_code' | 'bootstrap';
  trustedDevice: boolean;
  fresh: boolean;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  credentialCount: number;
  totpEnrolled: boolean;
  recoveryCodesRemaining: number;
}

const AUTHENTICATED_SESSION: SessionState = {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Handler = () => Response | Promise<Response>;

/** Routes a stubbed `fetch` by pathname to a per-test map of canned responses. */
function stubFetch(handlers: Record<string, Handler>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, 'http://localhost/').pathname;
      const handler = handlers[path];
      if (handler === undefined) {
        throw new Error(`router.test.tsx: no fetch handler stubbed for ${path}`);
      }
      return handler();
    }),
  );
}

describe('router', () => {
  beforeEach(() => {
    queryClient.clear();
    stubFetch({ '/api/auth/session': () => jsonResponse(AUTHENTICATED_SESSION) });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

/**
 * Each test below builds its own router + `QueryClient` (memory history,
 * fresh cache) instead of sharing the app's singleton — the guard redirects
 * the router itself, and asserting on that redirect is much less fragile
 * against a router instance no other test has already navigated around.
 */
function createTestRouter(initialPath: string) {
  const testQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const testRouter = createRouter({
    routeTree,
    context: { queryClient: testQueryClient },
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  return { testQueryClient, testRouter };
}

describe('/_app auth guard (gate-remediation-web.md M-3/M-8)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redirects an unauthenticated visitor to /login, preserving the intended path', async () => {
    stubFetch({ '/api/auth/session': () => jsonResponse({ code: 'unauthenticated' }, 401) });
    const { testQueryClient, testRouter } = createTestRouter('/accounts');

    render(
      <QueryClientProvider client={testQueryClient}>
        <RouterProvider router={testRouter} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(testRouter.state.location.pathname).toBe('/login'));
    expect(testRouter.state.location.search).toEqual({ redirect: '/accounts' });
    expect(
      await screen.findByRole('heading', { name: 'Sign in to PersonalFi' }),
    ).toBeInTheDocument();
  });

  it('sends a visitor who is already signed in straight through, without a redirect', async () => {
    stubFetch({ '/api/auth/session': () => jsonResponse(AUTHENTICATED_SESSION) });
    const { testQueryClient, testRouter } = createTestRouter('/accounts');

    render(
      <QueryClientProvider client={testQueryClient}>
        <RouterProvider router={testRouter} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(testRouter.state.location.pathname).toBe('/accounts'));
    expect(await screen.findByRole('heading', { name: 'Accounts', level: 1 })).toBeInTheDocument();
  });

  it('returns to the originally intended path after a successful sign-in', async () => {
    let authenticated = false;
    stubFetch({
      '/api/auth/session': () =>
        authenticated
          ? jsonResponse(AUTHENTICATED_SESSION)
          : jsonResponse({ code: 'unauthenticated' }, 401),
      '/api/auth/totp/verify': () => {
        authenticated = true;
        return jsonResponse({ ok: true });
      },
    });
    const { testQueryClient, testRouter } = createTestRouter('/accounts');

    render(
      <QueryClientProvider client={testQueryClient}>
        <RouterProvider router={testRouter} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(testRouter.state.location.pathname).toBe('/login'));

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Use an authenticator code instead' }));
    await user.type(screen.getByLabelText('6-digit authenticator code'), '123456');
    await user.click(screen.getByRole('button', { name: 'Verify code' }));

    await waitFor(() => expect(testRouter.state.location.pathname).toBe('/accounts'));
    expect(await screen.findByRole('heading', { name: 'Accounts', level: 1 })).toBeInTheDocument();
  });
});
