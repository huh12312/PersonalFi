// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { KindSwitch } from './KindSwitch.tsx';

function renderSwitch() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
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

  it('names itself as write-only: no claim about the current value is made before any write', () => {
    renderSwitch();

    expect(
      screen.getByText(/no route in this build reports this flag's current value/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('disabling sends exactly {enabled: false} and reports exactly what the route returned', async () => {
    let body: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/advisors/kinds/local_model/enabled',
        method: 'PUT',
        handle: async ({ request }) => {
          body = await request.json();
          return jsonResponse({ kind: 'local_model', enabled: false });
        },
      },
    ]);

    renderSwitch();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Disable local_model' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('local_model is now disabled');
    expect(body).toEqual({ enabled: false });
  });

  it('enabling sends exactly {enabled: true}', async () => {
    let body: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/advisors/kinds/local_model/enabled',
        method: 'PUT',
        handle: async ({ request }) => {
          body = await request.json();
          return jsonResponse({ kind: 'local_model', enabled: true });
        },
      },
    ]);

    renderSwitch();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Enable local_model' }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('local_model is now enabled');
    expect(body).toEqual({ enabled: true });
  });

  it('a 404 for a kind with no declared flag is shown, not swallowed', async () => {
    stubFetchRoutes([
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
