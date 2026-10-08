// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { PasskeyRegisterFlow } from './PasskeyRegisterFlow.tsx';

vi.mock('@simplewebauthn/browser', () => ({
  startRegistration: vi.fn(async () => ({})),
  startAuthentication: vi.fn(async () => ({})),
}));

const CREDENTIAL = {
  id: 'cred-1',
  credentialId: 'abc',
  friendlyName: 'Laptop',
  transports: [],
  aaguid: null,
  backedUp: false,
  deviceType: 'singleDevice',
  createdAt: '2026-10-07T00:00:00.000Z',
  lastUsedAt: null,
};

function renderFlow(registrationToken?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    component: () => <PasskeyRegisterFlow registrationToken={registrationToken} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([index]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

let generated = 0;

function stubApi(enrolSecond: boolean) {
  generated = 0;
  stubFetchRoutes([
    {
      match: '/api/auth/register/options',
      method: 'POST',
      handle: () => jsonResponse({ userId: 'u1', options: {} }),
    },
    {
      match: '/api/auth/register/verify',
      method: 'POST',
      handle: () =>
        jsonResponse({
          credential: CREDENTIAL,
          credentialCount: 1,
          signedIn: true,
          enrolSecondAuthenticator: enrolSecond,
        }),
    },
    {
      match: '/api/auth/recovery-codes',
      method: 'POST',
      handle: () => {
        generated += 1;
        return jsonResponse({
          codes: Array.from({ length: 10 }, (_, i) => `rc${String(generated)}-${String(i)}`),
        });
      },
    },
  ]);
}

describe('PasskeyRegisterFlow: recovery codes at the end of first-run enrolment (F-13-5)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('shows the ten codes once after the backup passkey step, and continues only once they are saved', async () => {
    stubApi(true);
    renderFlow('enrolment-token');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Create passkey' }));
    expect(
      await screen.findByRole('heading', { name: 'Add a backup passkey' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Skip for now' }));

    expect(
      await screen.findByRole('heading', { name: 'Save your recovery codes' }),
    ).toBeInTheDocument();
    expect(generated).toBe(0);
    await user.click(screen.getByRole('button', { name: 'Create my recovery codes' }));
    const list = await screen.findByRole('list', { name: 'Your recovery codes' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(10);
    expect(generated).toBe(1);

    const next = screen.getByRole('button', { name: 'Continue' });
    expect(next).toBeDisabled();
    await user.click(screen.getByRole('checkbox'));
    await user.click(next);
    expect(await screen.findByRole('heading', { name: 'You’re all set' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('rc1-0');
  });

  it('adding a second authenticator later (no enrolment token) does not touch recovery codes', async () => {
    stubApi(false);
    renderFlow(undefined);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create passkey' }));
    expect(await screen.findByRole('heading', { name: 'You’re all set' })).toBeInTheDocument();
    expect(generated).toBe(0);
  });

  it('can be skipped, and says where the codes can be made later', async () => {
    stubApi(false);
    renderFlow('enrolment-token');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create passkey' }));
    await screen.findByRole('heading', { name: 'Save your recovery codes' });
    await user.click(screen.getByRole('button', { name: /Skip for now — create them later/ }));
    expect(await screen.findByRole('heading', { name: 'You’re all set' })).toBeInTheDocument();
    expect(generated).toBe(0);
  });
});
