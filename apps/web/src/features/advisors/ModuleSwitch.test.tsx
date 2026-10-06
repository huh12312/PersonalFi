// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { ModuleSwitch } from './ModuleSwitch.tsx';

function renderSwitch() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ModuleSwitch />
    </QueryClientProvider>,
  );
}

interface State {
  advisorsEnabled: boolean;
  userEnabled: boolean;
}

const body = (state: State) => ({
  operator: { advisorsEnabled: state.advisorsEnabled },
  user: { enabled: state.userEnabled },
  effective: state.advisorsEnabled && state.userEnabled,
});

function getRoute(state: State): FetchRoute {
  return {
    match: '/api/advisors/module/enabled',
    method: 'GET',
    handle: () => jsonResponse(body(state)),
  };
}

/** WP 9.6 item 2 / G5-14: level 1's two halves, read, in words, and the holder's half writable. */
describe('ModuleSwitch (level 1)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('on: says both halves allow advisors and shows the holder switch on', async () => {
    stubFetchRoutes([getRoute({ advisorsEnabled: true, userEnabled: true })]);
    renderSwitch();

    expect(await screen.findByTestId('module-state-words')).toHaveTextContent(
      'Level 1 is on: the operator allows advisors (ADVISORS_ENABLED) and you have not switched the insights module off.',
    );
    expect(screen.getByRole('switch', { name: /Insights module/ })).toBeChecked();
  });

  it('the holder half off: says it is the holder who turned it off and the switch is off', async () => {
    stubFetchRoutes([getRoute({ advisorsEnabled: true, userEnabled: false })]);
    renderSwitch();

    const words = await screen.findByTestId('module-state-words');
    expect(words).toHaveTextContent('Level 1 is off, so no advisor runs: you have switched');
    expect(words).not.toHaveTextContent('ADVISORS_ENABLED is false');
    expect(screen.getByRole('switch', { name: /Insights module/ })).not.toBeChecked();
  });

  it('the operator half off: names ADVISORS_ENABLED and a restart as the only way back', async () => {
    stubFetchRoutes([getRoute({ advisorsEnabled: false, userEnabled: true })]);
    renderSwitch();

    const words = await screen.findByTestId('module-state-words');
    expect(words).toHaveTextContent('ADVISORS_ENABLED is false');
    expect(words).toHaveTextContent('a restart');
    expect(words).not.toHaveTextContent('you have switched the insights module off');
  });

  it('both halves off: names both', async () => {
    stubFetchRoutes([getRoute({ advisorsEnabled: false, userEnabled: false })]);
    renderSwitch();

    const words = await screen.findByTestId('module-state-words');
    expect(words).toHaveTextContent('ADVISORS_ENABLED is false');
    expect(words).toHaveTextContent('you have switched the insights module off');
  });

  it('switching off sends exactly {enabled: false} and then shows the state the route returned', async () => {
    const state: State = { advisorsEnabled: true, userEnabled: true };
    let sent: unknown = null;
    stubFetchRoutes([
      getRoute(state),
      {
        match: '/api/advisors/module/enabled',
        method: 'PUT',
        handle: async ({ request }) => {
          sent = await request.json();
          state.userEnabled = false;
          return jsonResponse(body(state));
        },
      },
    ]);
    renderSwitch();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('switch', { name: /Insights module/ }));

    expect(await screen.findByText(/Level 1 is off, so no advisor runs: you have/)).toBeVisible();
    expect(sent).toEqual({ enabled: false });
    expect(screen.getByRole('switch', { name: /Insights module/ })).not.toBeChecked();
  });

  it('a failed write is shown by its code and the switch stays where the api last said', async () => {
    stubFetchRoutes([
      getRoute({ advisorsEnabled: true, userEnabled: true }),
      {
        match: '/api/advisors/module/enabled',
        method: 'PUT',
        handle: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Forbidden',
              status: 403,
              code: 'auth.forbidden',
              correlationId: 'corr_m',
            },
            403,
          ),
      },
    ]);
    renderSwitch();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('switch', { name: /Insights module/ }));

    expect(await screen.findByText(/auth\.forbidden/)).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /Insights module/ })).toBeChecked();
  });

  it('when the state cannot be read there is no switch at all (a switch nobody read would be a guess)', async () => {
    stubFetchRoutes([
      {
        match: '/api/advisors/module/enabled',
        method: 'GET',
        handle: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Internal Server Error',
              status: 500,
              code: 'internal',
              correlationId: 'corr_g',
            },
            500,
          ),
      },
    ]);
    renderSwitch();

    expect(await screen.findByTestId('module-state-error')).toHaveTextContent('(internal)');
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
