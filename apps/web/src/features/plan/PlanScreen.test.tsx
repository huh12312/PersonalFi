// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type * as VisxResponsive from '@visx/responsive';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import { RouterForTest } from '../goals/routerTest.tsx';
import { PlanScreen } from './PlanScreen.tsx';
import {
  assumptionsResponse,
  baselineScenario,
  compareResponse,
  forkScenario,
  lifeEventFixture,
  projectionResponse,
  scenariosResponse,
} from './fixtures.ts';
import type { PlanSearch } from './search.ts';

/**
 * happy-dom has no layout engine, so `@visx/responsive`'s `ParentSize`
 * (`FanChart.tsx`) never receives a real size via `ResizeObserver`
 * (`vitest.setup.ts`'s own doc comment on its no-op polyfill: "renders
 * nothing rather than throwing"). `FanChart.test.tsx` sidesteps this by unit
 * testing the exported `ChartInner` directly with an explicit width; this
 * file renders the whole screen, so it needs the same fixed size supplied at
 * the `ParentSize` seam instead — the one legitimate place to mock in this
 * suite, since the alternative is a chart that can never be interacted with
 * in any test that mounts the real route.
 */
vi.mock('@visx/responsive', async () => {
  const actual = await vi.importActual<typeof VisxResponsive>('@visx/responsive');
  return {
    ...actual,
    ParentSize: ({
      children,
    }: {
      children: (size: { width: number; height: number }) => ReactNode;
    }) => children({ width: 640, height: 320 }),
  };
});

interface RouteOverrides {
  readonly scenarios?: unknown;
  readonly projection?: unknown;
  /** Answers the projection POST itself — a refusal, or a counter. Wins over `projection`. */
  readonly onProjection?: () => Response;
  readonly requiredSavings?: (body: unknown) => Response;
  readonly onCreateScenario?: (body: unknown) => Response;
  readonly onPatchLifeEvent?: (body: unknown) => Response;
  readonly onOverride?: (body: unknown) => Response;
}

function routesFor(overrides: RouteOverrides = {}): FetchRoute[] {
  return [
    {
      match: '/api/plan/scenarios',
      method: 'GET',
      handle: () => jsonResponse(overrides.scenarios ?? scenariosResponse()),
    },
    {
      match: '/api/plan/scenarios',
      method: 'POST',
      handle: async ({ request }) =>
        overrides.onCreateScenario === undefined
          ? jsonResponse(baselineScenario(), 201)
          : overrides.onCreateScenario(await request.json()),
    },
    {
      match: /^\/api\/plan\/scenarios\/[^/]+\/projections$/,
      method: 'POST',
      handle: () =>
        overrides.onProjection === undefined
          ? jsonResponse(overrides.projection ?? projectionResponse())
          : overrides.onProjection(),
    },
    {
      match: '/api/risk-profile',
      method: 'GET',
      handle: () => jsonResponse({ instrument: 'risk-v1', items: [], current: null }),
    },
    { match: '/api/assumptions', method: 'GET', handle: () => jsonResponse(assumptionsResponse()) },
    {
      match: '/api/assumptions/overrides',
      method: 'PUT',
      handle: async ({ request }) =>
        overrides.onOverride === undefined
          ? jsonResponse({ ok: true })
          : overrides.onOverride(await request.json()),
    },
    {
      match: '/api/plan/life-events',
      method: 'GET',
      handle: () => jsonResponse({ lifeEvents: [lifeEventFixture()] }),
    },
    {
      match: '/api/plan/life-events',
      method: 'POST',
      handle: () => jsonResponse(lifeEventFixture({ id: 'life-event-new' }), 201),
    },
    {
      match: /^\/api\/plan\/life-events\/[^/]+$/,
      method: 'PATCH',
      handle: async ({ request }) =>
        overrides.onPatchLifeEvent === undefined
          ? jsonResponse(lifeEventFixture())
          : overrides.onPatchLifeEvent(await request.json()),
    },
    {
      match: /^\/api\/plan\/life-events\/[^/]+$/,
      method: 'DELETE',
      handle: () => new Response(null, { status: 204 }),
    },
    { match: '/api/plan/compare', method: 'GET', handle: () => jsonResponse(compareResponse()) },
    {
      match: '/api/plan/required-savings',
      method: 'POST',
      handle: async ({ request }) =>
        overrides.requiredSavings === undefined
          ? jsonResponse({
              kind: 'required',
              monthly: { minor: '50000', currency: 'USD' },
              iterations: 4,
              verified: true,
            })
          : overrides.requiredSavings(await request.json()),
    },
  ];
}

function renderScreen(search: PlanSearch = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSearchChange = vi.fn((next: PlanSearch) => {
    search = next;
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterForTest>
        <PlanScreen search={search} onSearchChange={onSearchChange} />
      </RouterForTest>
    </QueryClientProvider>,
  );
  return { onSearchChange, view };
}

/**
 * `_app.plan.tsx` (the real route) is what actually round-trips
 * `onSearchChange` back into `search` — TanStack Router re-renders
 * `PlanScreen` with the new search on every navigation. `renderScreen`
 * above, matching `InvestmentsScreen.test.tsx`'s own house pattern, only
 * spies on `onSearchChange` and is right for asserting *what* a control
 * would ask the router to do. The tests below need the actual round trip
 * (setting a goal, then reading the gap solver's answer; choosing both
 * compare scenarios, then reading the delta), so this wrapper reproduces
 * the router's own re-render with a plain `useState`, the smallest thing
 * that plays the router's part correctly.
 */
function ControlledPlanScreen({ initialSearch = {} }: { initialSearch?: PlanSearch }) {
  const [search, setSearch] = useState(initialSearch);
  return <PlanScreen search={search} onSearchChange={setSearch} />;
}

function renderControlledScreen(initialSearch: PlanSearch = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterForTest>
        <ControlledPlanScreen initialSearch={initialSearch} />
      </RouterForTest>
    </QueryClientProvider>,
  );
}

describe('PlanScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the "Start your plan" empty state when there is no baseline scenario yet, and submitting it POSTs /plan/scenarios', async () => {
    let posted: unknown = null;
    stubFetchRoutes(
      routesFor({
        scenarios: { scenarios: [] },
        onCreateScenario: (body) => {
          posted = body;
          return jsonResponse(baselineScenario(), 201);
        },
      }),
    );
    const user = userEvent.setup();
    renderScreen();

    expect(await screen.findByRole('heading', { name: 'Start your plan' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Birth date'), '1985-04-12');
    await user.click(screen.getByRole('button', { name: 'Start your plan' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect((posted as { kind: string }).kind).toBe('baseline');
  });

  it("renders the headline sentence from the run's own success probability and terminal median — never a client computation", async () => {
    stubFetchRoutes(routesFor());
    renderScreen();

    // `screen.findByTestId('plan-headline')` alone would resolve on the
    // first paint (the "Projecting your plan…" placeholder carries the same
    // `data-testid`) — waiting on the probability span itself is what
    // actually waits for the projection query to resolve.
    const probability = await screen.findByTestId('plan-headline-probability');
    const headline = screen.getByTestId('plan-headline');
    // `projectionResponse()`'s run.successProbability is '0.82', last percentile p50 is 180000000 minor.
    expect(probability).toHaveTextContent('82%');
    expect(within(headline).getByText(/at age 65/)).toBeInTheDocument();
  });

  it('clicking the dotted gap line calls POST /plan/required-savings and renders the required monthly amount', async () => {
    stubFetchRoutes(routesFor());
    const user = userEvent.setup();
    renderControlledScreen();

    await screen.findByTestId('plan-headline');
    await user.type(screen.getByLabelText('Target amount'), '2000000');
    await user.type(screen.getByLabelText('By date'), '2046-01-01');
    await user.type(screen.getByLabelText('Max extra monthly saving to consider'), '2000');
    await user.click(screen.getByRole('button', { name: 'Set goal' }));

    const gap = await screen.findByTestId('fan-chart-gap-line');
    await user.click(gap);

    const result = await screen.findByTestId('required-savings-result');
    expect(result).toHaveTextContent('Save an additional');
    expect(result).not.toHaveTextContent('unreachable');
  });

  it('an unreachable gap names its binding constraint and renders the literal word "unreachable" — never a number implying a solution', async () => {
    stubFetchRoutes(
      routesFor({
        requiredSavings: () =>
          jsonResponse({
            kind: 'unreachable',
            constraint: {
              name: 'monthly_ceiling',
              detail: 'Even saving the full $2,000/mo ceiling falls short by $410,000.',
              ceiling: { minor: '200000', currency: 'USD' },
              gapAtCeiling: { minor: '41000000', currency: 'USD' },
            },
          }),
      }),
    );
    const user = userEvent.setup();
    renderControlledScreen();

    await screen.findByTestId('plan-headline');
    await user.type(screen.getByLabelText('Target amount'), '5000000');
    await user.type(screen.getByLabelText('By date'), '2030-01-01');
    await user.type(screen.getByLabelText('Max extra monthly saving to consider'), '2000');
    await user.click(screen.getByRole('button', { name: 'Set goal' }));

    const gap = await screen.findByTestId('fan-chart-gap-line');
    await user.click(gap);

    const result = await screen.findByTestId('required-savings-unreachable');
    expect(result).toHaveTextContent('unreachable');
    expect(result).toHaveTextContent('Even saving the full $2,000/mo ceiling falls short');
    // No field of the response that implies a solved monthly figure appears —
    // checked two ways: the literal phrasing this component uses for the
    // "required" branch, and (sabotage-resistant to a rewording) no `Money`
    // component renders inside the unreachable block at all. `Money.tsx`
    // marks every real render with `.money-sensitive`; the constraint's own
    // `detail` string (server-authored prose, which may legitimately quote
    // the ceiling in words, as it does here) is not run through `Money`, so
    // this check is specific to a *client-rendered* answer, not to any digit
    // appearing anywhere in the block.
    expect(screen.queryByText(/Save an additional/)).not.toBeInTheDocument();
    expect(result.querySelector('.money-sensitive')).toBeNull();
  });

  it("shows every assumption's source and as-of date without a click, on the same screen as the chart", async () => {
    stubFetchRoutes(routesFor());
    renderScreen();

    await screen.findByTestId('plan-headline');
    expect(await screen.findByText(/Source: 07 Appendix A §5\.5/)).toBeVisible();
  });

  it('renders two scenarios side by side with the success-probability delta once both are chosen', async () => {
    stubFetchRoutes(routesFor());
    const user = userEvent.setup();
    renderControlledScreen();

    await screen.findByTestId('plan-headline');
    await user.selectOptions(screen.getByLabelText('Scenario A'), 'scenario-baseline');
    await user.selectOptions(screen.getByLabelText('Scenario B'), 'scenario-fork-retire-early');

    const delta = await screen.findByTestId('compare-delta');
    expect(delta).toHaveTextContent('Δ success probability');
  });

  it('moving a life event via PATCH updates through the whole screen, not just the isolated component', async () => {
    let patched: unknown = null;
    stubFetchRoutes(
      routesFor({
        onPatchLifeEvent: (body) => {
          patched = body;
          return jsonResponse(lifeEventFixture());
        },
      }),
    );
    const user = userEvent.setup();
    renderScreen();

    const slider = await screen.findByRole('slider', { name: 'Signing bonus date' });
    slider.focus();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    slider.blur();

    await waitFor(() => expect(patched).not.toBeNull());
    expect((patched as { occursOn: string }).occursOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('words a refused projection instead of saying "Projecting your plan…" forever (G4-10)', async () => {
    stubFetchRoutes(
      routesFor({
        onProjection: () =>
          jsonResponse(
            {
              type: 'about:blank',
              title: 'Conflict',
              status: 409,
              code: 'planning.projection_no_balances',
              detail: 'no sealed net-worth day exists yet',
              correlationId: 'corr-1',
            },
            409,
          ),
      }),
    );
    renderScreen();

    const problem = await screen.findByTestId('plan-problem');
    expect(problem).toHaveAttribute('data-problem-words', 'table');
    expect(problem).toHaveTextContent('no sealed net-worth day');
    const headline = screen.getByTestId('plan-headline');
    expect(headline).not.toHaveTextContent('Projecting your plan');
    expect(headline).toHaveTextContent('could not be projected');
  });

  it('names the engine on the section and never phrases a deterministic run as a probability (G4-13)', async () => {
    const base = projectionResponse();
    stubFetchRoutes(
      routesFor({
        projection: {
          ...base,
          run: {
            ...(base.run as NonNullable<typeof base.run>),
            method: 'deterministic',
            paths: 1,
            successProbability: '1',
          },
        },
      }),
    );
    renderScreen();

    const section = await screen.findByTestId('plan-projection');
    await screen.findByTestId('plan-headline-outcome');
    expect(section).toHaveAttribute('data-engine', 'deterministic');
    expect(
      within(section).getByRole('heading', { name: 'Deterministic projection' }),
    ).toBeVisible();
    for (const text of [section.textContent, screen.getByTestId('plan-headline').textContent]) {
      expect(text).not.toMatch(/%|percent|probab|chance|likel|of (simulated )?(plans|paths)/i);
    }
  });

  it('says a stored run is out of date and names its version (G4-16)', async () => {
    const base = projectionResponse();
    stubFetchRoutes(
      routesFor({
        projection: {
          ...base,
          status: 'stale',
          staleness: {
            reason: 'assumptions_version_retired',
            assumptionsVersion: 'assumptions-0',
            known: ['assumptions-1'],
          },
        },
      }),
    );
    renderScreen();
    const notice = await screen.findByTestId('plan-run-stale');
    expect(notice).toHaveTextContent('assumptions-0');
    expect(screen.getByTestId('plan-headline').textContent).toMatch(/^Out of date/);
  });

  it('asks for the projection again after an assumption override is saved (G4-16)', async () => {
    let projectionCalls = 0;
    stubFetchRoutes(
      routesFor({
        onProjection: () => {
          projectionCalls += 1;
          return jsonResponse(projectionResponse());
        },
      }),
    );
    const user = userEvent.setup();
    renderScreen();

    await screen.findByTestId('plan-headline-probability');
    const before = projectionCalls;
    await user.click(await screen.findByRole('button', { name: /^Edit/ }));
    const input = screen.getByLabelText(/^Override /);
    await user.clear(input);
    await user.type(input, '0.05');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(projectionCalls).toBeGreaterThan(before));
  });

  it('puts a freshly forked scenario straight into the compare against the baseline (C-10)', async () => {
    let posted: unknown = null;
    stubFetchRoutes(
      routesFor({
        onCreateScenario: (body) => {
          posted = body;
          return jsonResponse(forkScenario(), 201);
        },
      }),
    );
    const user = userEvent.setup();
    renderControlledScreen();

    await screen.findByTestId('plan-headline-probability');
    const form = screen.getByRole('form', { name: 'Fork the baseline' });
    await user.type(within(form).getByLabelText('Fork name'), 'Retire at 62');
    await user.type(within(form).getByLabelText('Retirement age'), '62');
    await user.click(within(form).getByRole('button', { name: 'Fork and compare' }));

    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({ kind: 'fork', levers: { retireAge: 62 } });
    await waitFor(() =>
      expect(screen.getByLabelText('Scenario A')).toHaveValue('scenario-baseline'),
    );
    expect(screen.getByLabelText('Scenario B')).toHaveValue('scenario-fork-retire-early');
    expect(await screen.findByTestId('compare-delta')).toHaveTextContent('Δ success probability');
  });
});
