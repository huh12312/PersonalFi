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
import { KindSwitch } from './KindSwitch.tsx';

function renderSwitch() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <KindSwitch kind="local_model" />
    </QueryClientProvider>,
  );
}

describe('KindSwitch', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** `GET /advisors/kinds/local_model/enabled`, answering from a mutable state. */
  function stateRoute(state: { enabled: boolean; configured: boolean }): FetchRoute {
    return {
      match: '/api/advisors/kinds/local_model/enabled',
      method: 'GET',
      handle: () =>
        jsonResponse({
          kind: 'local_model',
          enabled: state.enabled,
          configured: state.configured,
          effective: state.enabled && state.configured,
        }),
    };
  }

  it('says the real state in words — flag and model configuration — before any write', async () => {
    stubFetchRoutes([stateRoute({ enabled: true, configured: false })]);
    renderSwitch();

    expect(await screen.findByTestId('kind-state-words')).toHaveTextContent(
      'Level 2 is on but nothing can run: the local_model flag is on, and this deployment has no model configured',
    );
  });

  it('reports the flag off and the model configured, and both on, each in its own words', async () => {
    const state = { enabled: false, configured: true };
    stubFetchRoutes([stateRoute(state)]);
    const first = renderSwitch();
    expect(await screen.findByTestId('kind-state-words')).toHaveTextContent(
      'Level 2 is off: the local_model flag is off (its default), so no local_model advisor runs, though a model is configured.',
    );
    first.unmount();

    state.enabled = true;
    renderSwitch();
    expect(await screen.findByTestId('kind-state-words')).toHaveTextContent(
      'Level 2 is on: the local_model flag is on and a model is configured',
    );
  });

  it('when the state cannot be read it says so and still offers the writes — no guessed position', async () => {
    stubFetchRoutes([
      {
        match: '/api/advisors/kinds/local_model/enabled',
        method: 'GET',
        handle: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Internal Server Error',
              status: 500,
              code: 'internal',
              correlationId: 'corr_x',
            },
            500,
          ),
      },
    ]);
    renderSwitch();

    expect(await screen.findByTestId('kind-state-error')).toHaveTextContent('(internal)');
    expect(screen.queryByTestId('kind-state-words')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable local_model' })).toBeEnabled();
  });

  it('disabling sends exactly {enabled: false}, and the line then reads the new state from the api', async () => {
    let body: unknown = null;
    const state = { enabled: true, configured: true };
    stubFetchRoutes([
      stateRoute(state),
      {
        match: '/api/advisors/kinds/local_model/enabled',
        method: 'PUT',
        handle: async ({ request }) => {
          body = await request.json();
          state.enabled = false;
          return jsonResponse({ kind: 'local_model', enabled: false });
        },
      },
    ]);

    renderSwitch();
    const user = userEvent.setup();
    await screen.findByText(/Level 2 is on: the local_model flag is on/);
    await user.click(screen.getByRole('button', { name: 'Disable local_model' }));

    expect(await screen.findByText(/Level 2 is off: the local_model flag is off/)).toBeVisible();
    expect(body).toEqual({ enabled: false });
  });

  it('enabling sends exactly {enabled: true}, and the line then reads the new state from the api', async () => {
    let body: unknown = null;
    const state = { enabled: false, configured: true };
    stubFetchRoutes([
      stateRoute(state),
      {
        match: '/api/advisors/kinds/local_model/enabled',
        method: 'PUT',
        handle: async ({ request }) => {
          body = await request.json();
          state.enabled = true;
          return jsonResponse({ kind: 'local_model', enabled: true });
        },
      },
    ]);

    renderSwitch();
    const user = userEvent.setup();
    await screen.findByText(/Level 2 is off: the local_model flag is off/);
    await user.click(screen.getByRole('button', { name: 'Enable local_model' }));

    expect(await screen.findByText(/Level 2 is on: the local_model flag is on/)).toBeVisible();
    expect(body).toEqual({ enabled: true });
  });

  it('a 404 for a kind with no declared flag is shown, not swallowed', async () => {
    stubFetchRoutes([
      stateRoute({ enabled: false, configured: false }),
      {
        match: '/api/advisors/kinds/local_model/enabled',
        method: 'PUT',
        handle: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Kind flag not found',
              status: 404,
              code: 'insights.kind_flag_not_found',
              correlationId: 'corr_1',
            },
            404,
          ),
      },
    ]);

    renderSwitch();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Disable local_model' }));

    expect(await screen.findByText(/insights.kind_flag_not_found/)).toBeInTheDocument();
  });
});
