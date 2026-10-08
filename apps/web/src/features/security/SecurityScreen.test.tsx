// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { SecurityScreen } from './SecurityScreen.tsx';

const startAuthentication = vi.fn(async (): Promise<unknown> => ({}));
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthentication(...(args as [])),
}));

const SESSION = {
  userId: 'user_1',
  displayName: 'Chris',
  displayTimezone: 'UTC',
  authMethod: 'webauthn',
  trustedDevice: true,
  fresh: false,
  idleExpiresAt: '2030-01-01T00:00:00.000Z',
  absoluteExpiresAt: '2030-01-01T00:00:00.000Z',
  credentialCount: 1,
  totpEnrolled: true,
  recoveryCodesRemaining: 10,
};

const CURRENT = '01920000-0000-7000-8000-000000000001';
const PHONE = '01920000-0000-7000-8000-000000000002';
const OLD = '01920000-0000-7000-8000-000000000003';

const LIST = {
  sessions: [
    {
      familyId: CURRENT,
      authMethod: 'webauthn',
      trustedDevice: true,
      lastSeenAt: '2026-10-07T12:00:00.000Z',
      familyExpiresAt: '2026-10-21T12:00:00.000Z',
      current: true,
    },
    {
      familyId: PHONE,
      authMethod: 'totp',
      trustedDevice: false,
      lastSeenAt: '2026-10-06T08:30:00.000Z',
      familyExpiresAt: '2026-10-13T08:30:00.000Z',
      current: false,
    },
    {
      familyId: OLD,
      authMethod: 'recovery_code',
      trustedDevice: false,
      lastSeenAt: '2026-10-01T08:30:00.000Z',
      familyExpiresAt: '2026-10-08T08:30:00.000Z',
      current: false,
    },
  ],
};

const STEP_UP_REQUIRED = {
  type: 'https://personalfi.local/problems/step_up_required',
  title: 'Forbidden',
  status: 403,
  code: 'step_up_required',
};

interface Calls {
  list: number;
  stepUps: number;
  revoked: string[];
  revokedOthers: number;
  totpRemoved: number;
  codesGenerated: number;
}

function install(options: { fresh?: boolean; totpEnrolled?: boolean } = {}): Calls {
  const calls: Calls = {
    list: 0,
    stepUps: 0,
    revoked: [],
    revokedOthers: 0,
    totpRemoved: 0,
    codesGenerated: 0,
  };
  let fresh = options.fresh ?? false;
  let totpEnrolled = options.totpEnrolled ?? true;
  const routes: FetchRoute[] = [
    {
      match: '/api/auth/session',
      method: 'GET',
      handle: () => jsonResponse({ ...SESSION, totpEnrolled }),
    },
    {
      match: '/api/auth/step-up/options',
      method: 'POST',
      handle: () => jsonResponse({ options: {} }),
    },
    {
      match: '/api/auth/step-up/verify',
      method: 'POST',
      handle: () => {
        calls.stepUps += 1;
        fresh = true;
        return jsonResponse({ freshUntil: '2030-01-01T00:00:00.000Z' });
      },
    },
    {
      match: '/api/auth/sessions',
      method: 'GET',
      handle: () => {
        calls.list += 1;
        return fresh ? jsonResponse(LIST) : jsonResponse(STEP_UP_REQUIRED, 403);
      },
    },
    {
      match: '/api/auth/sessions',
      method: 'DELETE',
      handle: () => {
        if (!fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        calls.revokedOthers += 1;
        return jsonResponse({ revoked: 2 });
      },
    },
    {
      match: /\/api\/auth\/sessions\/[0-9a-f-]+$/,
      method: 'DELETE',
      handle: ({ url }) => {
        if (!fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        calls.revoked.push(url.pathname.split('/').at(-1) ?? '');
        return jsonResponse({ ok: true });
      },
    },
    {
      match: '/api/auth/recovery-codes',
      method: 'POST',
      handle: () => {
        if (!fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        calls.codesGenerated += 1;
        return jsonResponse({
          codes: Array.from(
            { length: 10 },
            (_, index) =>
              `gen${String(calls.codesGenerated)}-code-${String(index + 1).padStart(2, '0')}`,
          ),
        });
      },
    },
    {
      match: '/api/auth/totp',
      method: 'DELETE',
      handle: () => {
        if (!fresh) return jsonResponse(STEP_UP_REQUIRED, 403);
        calls.totpRemoved += 1;
        totpEnrolled = false;
        return jsonResponse({ ok: true });
      },
    },
  ];
  stubFetchRoutes(routes);
  return calls;
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const index = createRoute({ getParentRoute: () => root, path: '/', component: SecurityScreen });
  const login = createRoute({
    getParentRoute: () => root,
    path: '/login',
    component: () => <p>login screen</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, login]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe('SecurityScreen', () => {
  beforeEach(() => {
    ensureApiClient();
    startAuthentication.mockReset();
    startAuthentication.mockResolvedValue({});
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks nothing of the sessions route until the holder asks, then steps up once and lists them', async () => {
    const calls = install();
    renderScreen();
    const user = userEvent.setup();

    expect(await screen.findByRole('button', { name: 'Show my sessions' })).toBeInTheDocument();
    expect(calls.list).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Show my sessions' }));

    const list = await screen.findByRole('list', { name: 'Signed-in sessions' });
    expect(calls.stepUps).toBe(1);
    // The stale call, then the retry after the passkey check.
    expect(calls.list).toBe(2);
    expect(startAuthentication).toHaveBeenCalledTimes(1);
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('This session')).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText('Trusted device')).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText('Authenticator code')).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText('Recovery code')).toBeInTheDocument();
  });

  it('does not step up again while the assertion is still fresh', async () => {
    const calls = install({ fresh: true });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show my sessions' }));
    await screen.findByRole('list', { name: 'Signed-in sessions' });
    expect(calls.stepUps).toBe(0);
    expect(calls.list).toBe(1);
  });

  it('a cancelled passkey check lists nothing and says so', async () => {
    const calls = install();
    startAuthentication.mockRejectedValue(
      Object.assign(new Error('cancelled'), { name: 'NotAllowedError' }),
    );
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show my sessions' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Signed-in sessions' })).not.toBeInTheDocument();
    expect(calls.stepUps).toBe(0);
  });

  it('signs another session out by its own id and removes only that row', async () => {
    const calls = install({ fresh: true });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show my sessions' }));
    const list = await screen.findByRole('list', { name: 'Signed-in sessions' });

    await user.click(
      within(list).getByRole('button', { name: /Sign out the authenticator code session/ }),
    );

    await waitFor(() => expect(calls.revoked).toEqual([PHONE]));
    expect(await screen.findByText('That session was signed out.')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).queryByText('Authenticator code')).not.toBeInTheDocument();
  });

  it('signing out every other session keeps this one and reports the count', async () => {
    const calls = install({ fresh: true });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show my sessions' }));
    const list = await screen.findByRole('list', { name: 'Signed-in sessions' });

    await user.click(screen.getByRole('button', { name: 'Sign out every other session' }));

    await waitFor(() => expect(calls.revokedOthers).toBe(1));
    expect(await screen.findByText('2 other sessions were signed out.')).toBeInTheDocument();
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Sign out every other session' })).toBeDisabled();
  });

  it('signing out this session ends it: the cache is cleared and the holder is sent to /login', async () => {
    const calls = install({ fresh: true });
    const { queryClient } = renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show my sessions' }));
    const list = await screen.findByRole('list', { name: 'Signed-in sessions' });

    await user.click(within(list).getByRole('button', { name: /Sign out this session/ }));

    await waitFor(() => expect(calls.revoked).toEqual([CURRENT]));
    expect(await screen.findByText('login screen')).toBeInTheDocument();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });

  it('a session list that outlives its assertion steps up again for the sign-out, once', async () => {
    const calls = install({ fresh: true });
    renderScreen();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Show my sessions' }));
    const list = await screen.findByRole('list', { name: 'Signed-in sessions' });
    expect(calls.stepUps).toBe(0);

    // The five minutes pass: the server now answers 403 step_up_required until a new assertion.
    stubFetchRoutes([
      {
        match: '/api/auth/step-up/options',
        method: 'POST',
        handle: () => jsonResponse({ options: {} }),
      },
      {
        match: '/api/auth/step-up/verify',
        method: 'POST',
        handle: () => {
          calls.stepUps += 1;
          return jsonResponse({ freshUntil: '2030-01-01T00:00:00.000Z' });
        },
      },
      {
        match: /\/api\/auth\/sessions\/[0-9a-f-]+$/,
        method: 'DELETE',
        handle: ({ url }) => {
          if (calls.stepUps === 0) return jsonResponse(STEP_UP_REQUIRED, 403);
          calls.revoked.push(url.pathname.split('/').at(-1) ?? '');
          return jsonResponse({ ok: true });
        },
      },
    ]);
    await user.click(within(list).getAllByRole('button', { name: /^Sign out/ })[2] as HTMLElement);

    await waitFor(() => expect(calls.revoked).toEqual([OLD]));
    expect(calls.stepUps).toBe(1);
  });

  it('removes the authenticator code only after a confirmation, through a step-up', async () => {
    const calls = install();
    renderScreen();
    const user = userEvent.setup();

    const remove = await screen.findByRole('button', { name: 'Remove authenticator code' });
    await waitFor(() => expect(remove).toBeEnabled());
    expect(screen.getByText('Set up')).toBeInTheDocument();

    await user.click(remove);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Remove the authenticator code?')).toBeInTheDocument();

    // Cancel first: nothing is called.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.totpRemoved).toBe(0);
    expect(calls.stepUps).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Remove authenticator code' }));
    await user.click(await screen.findByRole('button', { name: 'Remove it' }));

    await waitFor(() => expect(calls.totpRemoved).toBe(1));
    expect(calls.stepUps).toBe(1);
    expect(
      await screen.findByText('The authenticator code was removed. It can no longer sign in.'),
    ).toBeInTheDocument();
    // The session view is refetched: the badge and the button follow the server.
    expect(await screen.findByText('Not set up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove authenticator code' })).toBeDisabled();
  });

  it('offers no removal when no authenticator code is set up', async () => {
    install({ totpEnrolled: false });
    renderScreen();
    expect(await screen.findByText('Not set up')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove authenticator code' })).toBeDisabled();
  });

  it('creates recovery codes behind a step-up, shows the ten once, and drops them when saved', async () => {
    const calls = install();
    renderScreen();
    const user = userEvent.setup();

    expect(await screen.findByText(/You have 10 unused\./)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Replace my recovery codes' }));
    expect(calls.codesGenerated).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Create new recovery codes' }));

    const list = await screen.findByRole('list', { name: 'Your recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(within(list).getByText('gen1-code-01')).toBeInTheDocument();
    expect(calls.stepUps).toBe(1);
    expect(calls.codesGenerated).toBe(1);

    // Cannot leave until the holder says they are saved.
    const done = screen.getByRole('button', { name: 'Done' });
    expect(done).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', { name: 'I have saved these codes somewhere safe' }),
    );
    expect(done).toBeEnabled();
    await user.click(done);

    expect(screen.queryByRole('list', { name: 'Your recovery codes' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('gen1-code-01');
    expect(
      await screen.findByText('Your new recovery codes are active. The old ones no longer work.'),
    ).toBeInTheDocument();
  });

  it('never creates codes on its own: opening the section calls nothing', async () => {
    const calls = install();
    renderScreen();
    const user = userEvent.setup();
    await screen.findByText(/You have 10 unused\./);
    await user.click(screen.getByRole('button', { name: 'Replace my recovery codes' }));
    expect(calls.codesGenerated).toBe(0);
    expect(calls.stepUps).toBe(0);
  });
});
