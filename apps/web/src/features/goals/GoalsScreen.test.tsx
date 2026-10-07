// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import type { Goal, GoalContribution } from '../../api/generated/types.gen.ts';
import { contributionFixture, goalFixture, riskInstrumentFixture } from './fixtures.ts';
import { GoalsScreen } from './GoalsScreen.tsx';
import { RouterForTest } from './routerTest.tsx';

interface Server {
  goals: Goal[];
  contributions: GoalContribution[];
  posted: { goal?: unknown; patch?: unknown; contribution?: unknown; deleted: string[] };
  refuse?: { status: number; code: string };
}

function routes(server: Server): FetchRoute[] {
  const refusal = () =>
    server.refuse === undefined
      ? null
      : jsonResponse(
          {
            type: 'about:blank',
            title: 'Refused',
            status: server.refuse.status,
            code: server.refuse.code,
            detail: 'server detail',
            correlationId: 'corr-1',
          },
          server.refuse.status,
        );
  return [
    {
      match: '/api/goals',
      method: 'GET',
      handle: () => jsonResponse({ goals: server.goals }),
    },
    {
      match: '/api/goals',
      method: 'POST',
      handle: async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        server.posted.goal = body;
        const refused = refusal();
        if (refused !== null) return refused;
        const created = goalFixture({
          id: '00000000-0000-4000-8000-000000000002',
          name: String(body['name']),
        });
        server.goals = [...server.goals, created];
        return jsonResponse(created, 201);
      },
    },
    {
      match: /^\/api\/goals\/[^/]+$/,
      method: 'PATCH',
      handle: async ({ request }) => {
        server.posted.patch = await request.json();
        const updated = { ...(server.goals[0] as Goal), ...(server.posted.patch as Partial<Goal>) };
        server.goals = [updated];
        return jsonResponse(updated);
      },
    },
    {
      match: /^\/api\/goals\/[^/]+$/,
      method: 'DELETE',
      handle: ({ url }) => {
        const id = url.pathname.split('/').pop() as string;
        server.posted.deleted.push(id);
        server.goals = server.goals.filter((g) => g.id !== id);
        return jsonResponse({ deleted: true });
      },
    },
    {
      match: /^\/api\/goals\/[^/]+\/contributions$/,
      method: 'GET',
      handle: () => jsonResponse({ contributions: server.contributions }),
    },
    {
      match: /^\/api\/goals\/[^/]+\/contributions$/,
      method: 'POST',
      handle: async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        server.posted.contribution = body;
        const created = contributionFixture({
          id: '00000000-0000-4000-8000-0000000000c2',
          cadence: body['cadence'] as GoalContribution['cadence'],
          amount: body['amount'] as GoalContribution['amount'],
        });
        server.contributions = [...server.contributions, created];
        return jsonResponse(created, 201);
      },
    },
    {
      match: /^\/api\/goals\/[^/]+\/contributions\/[^/]+$/,
      method: 'DELETE',
      handle: ({ url }) => {
        const id = url.pathname.split('/').pop() as string;
        server.contributions = server.contributions.filter((c) => c.id !== id);
        return jsonResponse({ deleted: true });
      },
    },
    {
      match: '/api/risk-profile',
      method: 'GET',
      handle: () => jsonResponse(riskInstrumentFixture()),
    },
  ];
}

function newServer(overrides: Partial<Server> = {}): Server {
  return { goals: [], contributions: [], posted: { deleted: [] }, ...overrides };
}

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterForTest>
        <GoalsScreen />
      </RouterForTest>
    </QueryClientProvider>,
  );
}

describe('GoalsScreen', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows an empty state with a way to add the first goal', async () => {
    stubFetchRoutes(routes(newServer()));
    renderScreen();
    expect(await screen.findByText('No goals yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add goal' })).toBeInTheDocument();
  });

  it('creates a goal from the dialog: dollars become minor units once, and the list shows it', async () => {
    const server = newServer();
    stubFetchRoutes(routes(server));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: 'Add goal' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Car');
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'purchase');
    await user.type(within(dialog).getByLabelText('Target amount'), '18000.50');
    await user.type(within(dialog).getByLabelText('Target date'), '2029-06-01');
    await user.click(within(dialog).getByRole('button', { name: 'Add goal' }));

    await waitFor(() => expect(server.posted.goal).toBeDefined());
    expect(server.posted.goal).toEqual({
      kind: 'purchase',
      name: 'Car',
      target: { minor: '1800050', currency: 'USD' },
      targetDate: '2029-06-01',
      priority: 3,
    });
    expect(await screen.findByRole('heading', { name: 'Car' })).toBeInTheDocument();
  });

  it('refuses an empty form in words before asking the server anything', async () => {
    const server = newServer();
    stubFetchRoutes(routes(server));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Add goal' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Add goal' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Give the goal a name');
    expect(server.posted.goal).toBeUndefined();
  });

  it("words the server's refusal of a goal, with the server detail beneath", async () => {
    const server = newServer({
      refuse: { status: 422, code: 'planning.goal_target_date_in_past' },
    });
    stubFetchRoutes(routes(server));
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole('button', { name: 'Add goal' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), 'Past');
    await user.type(within(dialog).getByLabelText('Target amount'), '100');
    await user.type(within(dialog).getByLabelText('Target date'), '2020-01-01');
    await user.click(within(dialog).getByRole('button', { name: 'Add goal' }));
    const alert = await within(dialog).findByTestId('plan-problem');
    expect(alert).toHaveAttribute('data-problem-words', 'table');
    expect(alert).toHaveTextContent("A goal's date must be in the future");
    expect(alert).toHaveTextContent('server detail');
  });

  it('edits a goal in place', async () => {
    const server = newServer({ goals: [goalFixture()] });
    stubFetchRoutes(routes(server));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /^Edit/ }));
    const dialog = await screen.findByRole('dialog');
    const name = within(dialog).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Rainy day fund');
    await user.selectOptions(within(dialog).getByLabelText('Status'), 'paused');
    await user.click(within(dialog).getByRole('button', { name: 'Save goal' }));

    await waitFor(() => expect(server.posted.patch).toBeDefined());
    expect(server.posted.patch).toMatchObject({ name: 'Rainy day fund', status: 'paused' });
    expect(await screen.findByRole('heading', { name: 'Rainy day fund' })).toBeInTheDocument();
  });

  it('funds a goal: lists its contributions, adds one, and removes one after asking', async () => {
    const server = newServer({
      goals: [goalFixture()],
      contributions: [
        contributionFixture({ source: 'DERIVED', derivedAsOf: '2026-09-30', id: 'derived-1' }),
      ],
    });
    stubFetchRoutes(routes(server));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /^Contributions/ }));
    const panel = await screen.findByRole('region', { name: 'Contributions to Emergency fund' });
    expect(await within(panel).findByTestId('contribution')).toHaveTextContent(
      'worked out from your history as of 2026-09-30',
    );

    await user.selectOptions(within(panel).getByLabelText('How often'), 'weekly');
    await user.type(within(panel).getByLabelText('Amount each time'), '125');
    await user.click(within(panel).getByRole('button', { name: 'Add contribution' }));
    await waitFor(() => expect(server.posted.contribution).toBeDefined());
    expect(server.posted.contribution).toMatchObject({
      cadence: 'weekly',
      amount: { minor: '12500', currency: 'USD' },
      source: 'USER',
    });
    await waitFor(() => expect(within(panel).getAllByTestId('contribution')).toHaveLength(2));

    await user.click(within(panel).getAllByRole('button', { name: /^Remove/ })[0] as HTMLElement);
    const confirm = await screen.findByRole('dialog');
    expect(confirm).toHaveTextContent('Remove this contribution?');
    await user.click(within(confirm).getByRole('button', { name: 'Remove contribution' }));
    await waitFor(() => expect(within(panel).getAllByTestId('contribution')).toHaveLength(1));
  });

  it('deletes a goal only after the confirmation', async () => {
    const server = newServer({ goals: [goalFixture()] });
    stubFetchRoutes(routes(server));
    const user = userEvent.setup();
    renderScreen();

    await user.click(await screen.findByRole('button', { name: /^Delete/ }));
    const confirm = await screen.findByRole('dialog');
    expect(server.posted.deleted).toEqual([]);
    await user.click(within(confirm).getByRole('button', { name: 'Delete goal' }));
    await waitFor(() => expect(server.posted.deleted).toHaveLength(1));
    expect(await screen.findByText('No goals yet')).toBeInTheDocument();
  });

  it('words a failed list instead of showing an empty one', async () => {
    stubFetchRoutes([
      {
        match: '/api/goals',
        method: 'GET',
        handle: () =>
          jsonResponse(
            { type: 'about:blank', title: 'Unavailable', status: 503, code: 'unavailable' },
            503,
          ),
      },
      {
        match: '/api/risk-profile',
        method: 'GET',
        handle: () => jsonResponse(riskInstrumentFixture()),
      },
    ]);
    renderScreen();
    expect(await screen.findAllByRole('alert')).not.toHaveLength(0);
    expect(screen.queryByText('No goals yet')).not.toBeInTheDocument();
  });
});
