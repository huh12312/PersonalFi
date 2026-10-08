// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { routeTree } from '../../routeTree.gen.ts';
import {
  categoriesRoute,
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({})),
  browserSupportsWebAuthnAutofill: vi.fn(async () => false),
}));

/**
 * G-09 (WP 9.10, ASVS V3.7.2), the route half: `/login?redirect=` is attacker-controllable, and the page
 * must land on `/` for anything that is not an in-app path, through the REAL route tree and the real
 * sign-in mutation. (`lib/safe-redirect.test.ts` has the guard's own table.)
 */
const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'totp',
  trustedDevice: false,
  fresh: false,
  idleExpiresAt: '2030-01-01T00:00:00.000Z',
  absoluteExpiresAt: '2030-01-01T00:00:00.000Z',
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

async function signInWith(redirect: string): Promise<string> {
  let signedIn = false;
  stubFetchRoutes([
    {
      match: '/api/auth/unlock-state',
      handle: () => jsonResponse({ state: 'unlocked', bootstrapped: true }),
    },
    {
      match: '/api/auth/session',
      handle: () =>
        signedIn
          ? jsonResponse(SESSION)
          : jsonResponse({ code: 'unauthenticated', title: 'Unauthenticated', status: 401 }, 401),
    },
    {
      match: '/api/auth/totp/verify',
      method: 'POST',
      handle: () => {
        signedIn = true;
        return jsonResponse({ ok: true });
      },
    },
    categoriesRoute(),
  ]);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient },
    history: createMemoryHistory({
      initialEntries: [`/login?redirect=${encodeURIComponent(redirect)}`],
    }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Use an authenticator code instead' }),
  );
  await user.type(screen.getByLabelText('6-digit authenticator code'), '123456');
  await user.click(screen.getByRole('button', { name: 'Verify code' }));
  await waitFor(() => expect(router.state.location.pathname).not.toBe('/login'));
  return router.state.location.pathname;
}

describe('the post-login redirect, through the real route', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('returns the holder to the in-app page the guard bounced them from', async () => {
    expect(await signInWith('/budget')).toBe('/budget');
  });

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/x', '/\t/evil.example'])(
    'lands on / for the hostile value %j',
    async (hostile) => {
      expect(await signInWith(hostile)).toBe('/');
    },
  );
});
