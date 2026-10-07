// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { forkScenario } from './fixtures.ts';
import { ScenarioForkForm } from './ScenarioForkForm.tsx';

function mount(onCreated = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ScenarioForkForm onCreated={onCreated} />
    </QueryClientProvider>,
  );
  return onCreated;
}

describe('ScenarioForkForm', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('sends only the levers filled in, and hands the stored fork to the caller', async () => {
    let body: unknown = null;
    stubFetchRoutes([
      {
        match: '/api/plan/scenarios',
        method: 'POST',
        handle: async ({ request }) => {
          body = await request.json();
          return jsonResponse(forkScenario({ id: 'fork-new', name: 'Retire at 60' }), 201);
        },
      },
    ]);
    const user = userEvent.setup();
    const onCreated = mount();
    await user.type(screen.getByLabelText('Fork name'), 'Retire at 60');
    await user.type(screen.getByLabelText('Retirement age'), '60');
    await user.type(screen.getByLabelText('Annual spending'), '55000');
    await user.click(screen.getByRole('button', { name: 'Fork and compare' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledOnce());
    expect(body).toEqual({
      kind: 'fork',
      name: 'Retire at 60',
      levers: { retireAge: 60, annualSpending: { minor: '5500000', currency: 'USD' } },
    });
    expect(onCreated.mock.calls[0]?.[0]).toMatchObject({ id: 'fork-new' });
  });

  it('words the server refusing a fork that changes nothing', async () => {
    stubFetchRoutes([
      {
        match: '/api/plan/scenarios',
        method: 'POST',
        handle: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Unprocessable Content',
              status: 422,
              code: 'planning.scenario_levers_empty',
              detail: 'a fork must change at least one lever',
              correlationId: 'corr-2',
            },
            422,
          ),
      },
    ]);
    const user = userEvent.setup();
    const onCreated = mount();
    await user.type(screen.getByLabelText('Fork name'), 'Same');
    await user.click(screen.getByRole('button', { name: 'Fork and compare' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-problem-words', 'table');
    expect(alert).toHaveTextContent('A fork needs at least one change');
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('refuses a missing name or a malformed lever in words, without asking the server', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole('button', { name: 'Fork and compare' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Give the fork a name');
    await user.type(screen.getByLabelText('Fork name'), 'X');
    await user.type(screen.getByLabelText('Expected return shift'), 'one point');
    await user.click(screen.getByRole('button', { name: 'Fork and compare' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('plain decimal');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
