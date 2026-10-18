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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HealthOverview } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { HealthPillarScreen } from './HealthPillarScreen.tsx';
import { HealthScreen } from './HealthScreen.tsx';
import { HealthZoneChartInner } from './HealthZoneChart.tsx';
import { metricText } from './pillars.ts';
import { ScoreGauge } from './ScoreGauge.tsx';
import { HISTORY, overviewFixture, THRESHOLDS } from './test-fixtures.ts';

function serve(body: HealthOverview | 'not-computed'): void {
  stubFetchRoutes([
    {
      match: '/api/insights/health',
      handle: () =>
        body === 'not-computed'
          ? jsonResponse(
              {
                type: 'about:blank',
                title: 'Not Found',
                status: 404,
                code: 'insights.health_not_computed',
                correlationId: 'c',
              },
              404,
            )
          : jsonResponse({ health: body }),
    },
  ]);
}

function renderAt(path: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const health = createRoute({
    getParentRoute: () => root,
    path: '/health',
    component: HealthScreen,
  });
  const pillar = createRoute({
    getParentRoute: () => root,
    path: '/health/$pillar',
    component: function Pillar() {
      const { pillar: slug } = pillar.useParams();
      return <HealthPillarScreen slug={slug} />;
    },
  });
  const budget = createRoute({
    getParentRoute: () => root,
    path: '/budget',
    component: () => <p>budget</p>,
  });
  const router = createRouter({
    routeTree: root.addChildren([health, pillar, budget]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function stubReducedMotion(reduce: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    (query: string) =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

describe('the Health screen (WP 10.12)', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the hero: the gauge, the tier in words, the next step, the as-of date and the 30-day change', async () => {
    serve(overviewFixture());
    renderAt('/health');
    const hero = await screen.findByTestId('health-hero');
    expect(
      within(hero).getByRole('img', { name: 'Financial health score 75 out of 100, Steady' }),
    ).toBeInTheDocument();
    expect(within(hero).getByTestId('health-tier')).toHaveTextContent('Steady');
    expect(within(hero).getByTestId('health-tier-line')).toHaveTextContent(
      'The one thing to do next: save 10% of your income (Savings rate).',
    );
    expect(within(hero).getByTestId('health-as-of')).toHaveTextContent('As of Oct 18, 2026');
    expect(within(hero).getByTestId('health-delta')).toHaveTextContent(
      'Up 4.5 points from 30 days ago (70.5 on Sep 15, 2026)',
    );
    // Three scored days: the history is drawn, not withheld.
    expect(within(hero).queryByText(/history starts once/u)).not.toBeInTheDocument();
  });

  it('six pillar cards; a scored one states score / 100, its figure, its weight and its inputs', async () => {
    serve(overviewFixture());
    renderAt('/health');
    const grid = await screen.findByTestId('pillars-grid');
    expect(grid.querySelectorAll('[data-pillar]')).toHaveLength(6);
    const emergency = grid.querySelector('[data-pillar="emergency_fund_months"]') as HTMLElement;
    expect(within(emergency).getByTestId('pillar-score')).toHaveTextContent('75 / 100');
    expect(within(emergency).getByTestId('pillar-value')).toHaveTextContent('4.2 months');
    expect(within(emergency).getByText('Counts for 23.5% of your score')).toBeInTheDocument();
    expect(within(emergency).getByText('Good')).toBeInTheDocument();
    expect(within(emergency).getByTestId('pillar-inputs')).toHaveTextContent('$12,600.00');
    const link = within(emergency).getByRole('link', { name: /See detail/u });
    expect(link).toHaveAttribute('href', '/health/emergency-fund');
  });

  it('a withheld pillar says why and what would unlock it — and is never drawn as a number', async () => {
    serve(overviewFixture());
    renderAt('/health');
    const grid = await screen.findByTestId('pillars-grid');
    const card = grid.querySelector('[data-pillar="diversification"]') as HTMLElement;
    expect(card.getAttribute('data-pillar-status')).toBe('withheld');
    expect(within(card).getByText('Not scored')).toBeInTheDocument();
    expect(within(card).getByTestId('pillar-withheld')).toHaveTextContent(
      'holdings.aggregate had no investable holdings',
    );
    expect(within(card).getByTestId('pillar-withheld')).toHaveTextContent(
      'To unlock: Link an investment account whose holdings have prices.',
    );
    expect(within(card).queryByTestId('pillar-score')).not.toBeInTheDocument();
    expect(within(card).queryByTestId('pillar-value')).not.toBeInTheDocument();
    expect(card.textContent ?? '').not.toMatch(/\/ 100|\b0%|Counts for/u);
  });

  it('the living cover, withheld until a category is classified, links to the Budget’s variability view', async () => {
    serve(overviewFixture());
    renderAt('/health');
    const withheld = await screen.findByTestId('living-cover-withheld');
    expect(
      within(withheld).getByRole('link', {
        name: 'Classify your categories on the Budget screen.',
      }),
    ).toHaveAttribute('href', '/budget?view=variability');
  });

  it('with one snapshot the history sparkline is withheld, with a sentence', async () => {
    serve(overviewFixture({ history: [HISTORY[2]!] }));
    renderAt('/health');
    expect(await screen.findByTestId('health-history-sparkline')).toHaveTextContent(
      'history starts once there are two days of scores',
    );
    expect(screen.getByTestId('health-delta')).toHaveTextContent('No score from 30 days ago yet.');
  });

  it('no score at all: the gauge says so, never 0', async () => {
    serve(
      overviewFixture({
        score: null,
        pillars: overviewFixture().pillars.filter((p) => p.status === 'withheld'),
        history: [],
      }),
    );
    renderAt('/health');
    const hero = await screen.findByTestId('health-hero');
    expect(
      within(hero).getByRole('img', { name: 'Financial health score: not enough data yet' }),
    ).toBeInTheDocument();
    expect(within(hero).getByTestId('health-tier')).toHaveTextContent('Not scored yet');
    expect(hero.querySelector('[data-gauge-fill]')).toBeNull();
    expect(hero.querySelector('[data-gauge-score]')).toBeNull();
  });

  it('a holder with no snapshot yet reads "not computed yet", not an error', async () => {
    serve('not-computed');
    renderAt('/health');
    expect(
      await screen.findByText('Your first health score hasn’t been computed yet'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a pillar’s detail: its figure in words, the ladder from the scoring rules, its inputs', async () => {
    serve(overviewFixture());
    renderAt('/health/emergency-fund');
    expect(
      await screen.findByRole('heading', { name: 'Emergency fund', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('pillar-detail-figure')).toHaveTextContent(
      'Your figure is 4.2 months, which is good: this pillar scores 75 / 100',
    );
    expect(screen.getByTestId('pillar-detail-figure')).toHaveTextContent(
      'To move up a band: build your cash toward 6 months of spending.',
    );
    expect(
      [...screen.getByTestId('pillar-ladder').querySelectorAll('li')].map((li) => li.textContent),
    ).toEqual([
      'Poor: under 1 month',
      'Fair: 1 month to under 3 months',
      'Good: 3 months to under 6 months',
      'Excellent: 6 months or more',
    ]);
  });

  it('a lower-is-better ladder reads worst first too; an unknown pillar says so', async () => {
    serve(overviewFixture());
    renderAt('/health/fees');
    await screen.findByRole('heading', { name: 'Fee drag', level: 2 });
    expect(
      [...screen.getByTestId('pillar-ladder').querySelectorAll('li')].map((li) => li.textContent),
    ).toEqual([
      'Poor: $150 a year or more',
      'Fair: $50 a year to under $150 a year',
      'Good: $25 a year to under $50 a year',
      'Excellent: under $25 a year',
    ]);
  });

  it('an unknown pillar slug is a message, not a crash', async () => {
    serve(overviewFixture());
    renderAt('/health/happiness');
    expect(await screen.findByTestId('pillar-not-found')).toHaveTextContent(
      'There is no pillar called “happiness”',
    );
  });
});

describe('the zone chart (WP 10.12)', () => {
  it('draws the four zones from the scoring rules’ edges, the metric line and the marked current point', () => {
    const threshold = THRESHOLDS[0]!;
    const { container } = render(
      <HealthZoneChartInner
        width={640}
        label="Emergency fund"
        threshold={threshold}
        history={[
          { date: '2026-09-15', value: 3.6 },
          { date: '2026-10-17', value: 4 },
        ]}
        current={{ date: '2026-10-18', value: 4.2 }}
        formatValue={(value) => metricText('months', value)}
        windowStart="2026-07-21"
      />,
    );
    expect(
      [...container.querySelectorAll('[data-zone]')].map((z) => z.getAttribute('data-zone')),
    ).toEqual(['poor', 'fair', 'good', 'excellent']);
    expect([...container.querySelectorAll('[data-axis="y"]')].map((t) => t.textContent)).toEqual([
      '1 month',
      '3 months',
      '6 months',
    ]);
    expect(container.querySelector('[data-series="metric"]')).not.toBeNull();
    expect(screen.getByTestId('zone-now')).toHaveTextContent('Now: 4.2 months');
    expect(screen.getByTestId('zone-chart').getAttribute('aria-label')).toContain(
      'Now 4.2 months, in the Good zone.',
    );
  });
});

describe('the gauge sweep (WP 10.12)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubAnimate() {
    const animate = vi.fn(() => ({}) as Animation);
    Object.defineProperty(Element.prototype, 'animate', {
      value: animate,
      configurable: true,
      writable: true,
    });
    return animate;
  }

  it('sweeps once on first mount, and not when the score changes later', () => {
    stubReducedMotion(false);
    const animate = stubAnimate();
    const { rerender, container } = render(<ScoreGauge score={60} />);
    const fillCalls = () =>
      animate.mock.contexts.filter((el) => (el as Element).hasAttribute('data-gauge-fill')).length;
    expect(fillCalls()).toBe(1);
    expect(container.querySelector('[data-gauge-swept]')?.getAttribute('data-gauge-swept')).toBe(
      'true',
    );
    rerender(<ScoreGauge score={82} />);
    expect(fillCalls()).toBe(1);
    expect(screen.getByRole('img')).toHaveAccessibleName(
      'Financial health score 82 out of 100, Strong',
    );
  });

  it('never sweeps under reduced motion', () => {
    stubReducedMotion(true);
    const animate = stubAnimate();
    const { container } = render(<ScoreGauge score={60} />);
    expect(animate).not.toHaveBeenCalled();
    expect(container.querySelector('[data-gauge-swept]')?.getAttribute('data-gauge-swept')).toBe(
      'false',
    );
    // Drawn where it lands: the fill is at the score from the first frame.
    const fill = container.querySelector('[data-gauge-fill]') as SVGPathElement;
    const [length] = (fill.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number);
    expect(Number(fill.getAttribute('stroke-dashoffset'))).toBeCloseTo((length ?? 0) * 0.4);
  });
});
