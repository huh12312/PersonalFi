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
import type { AdvisoryBrief, BriefItem } from '../../api/generated/types.gen.ts';
import { BriefScreen } from './BriefScreen.tsx';

function renderScreen() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <BriefScreen />
    </QueryClientProvider>,
  );
}

const COMPUTED_EFFECT = {
  kind: 'computed' as const,
  engineVersion: 'personalfi.deterministic/1',
  assumptionsVersion: 'sha256:abc',
  plannedRetirementAge: 65,
  baseline: { kind: 'earliest' as const, age: 65, engineRuns: 3 },
  withAction: { kind: 'earliest' as const, age: 63, engineRuns: 3 },
  yearsEarlier: 2,
  monthsOfSpending: {
    months: '9',
    atAge: 65,
    wealthDifference: { minor: '3222688', currency: 'USD' },
    firstYearSpending: { minor: '4000000', currency: 'USD' },
    derivation: 'two engine runs at the planned retirement age',
  },
  assumption: 'if the saving is invested in your plan',
};

const NO_WHOLE_YEAR_EFFECT = {
  ...COMPUTED_EFFECT,
  yearsEarlier: 0,
};

const NOT_COMPUTABLE_EFFECT = {
  kind: 'not_computable' as const,
  reason: 'no baseline plan to project against',
};

function buildItem(overrides: Partial<BriefItem> & Pick<BriefItem, 'id'>): BriefItem {
  return {
    section: 'ranked',
    position: 0,
    insightId: `insight_${overrides.id}`,
    advisorId: 'builtin.spending.fee_hunter',
    insightKey: `spending.fee_hunter.${overrides.id}`,
    insightType: 'spending.fee_hunter',
    severity: 'warning',
    title: 'Avoidable fees this year',
    summaryMd: 'You paid $720 in avoidable fees over the last twelve months.',
    confidence: 0.9,
    horizon: 'this_year',
    carried: false,
    annualizedImpact: { minor: '72000', currency: 'USD' },
    oneTimeImpact: null,
    evidence: [
      {
        position: 0,
        kind: 'metric',
        label: 'Avoidable fees, twelve months',
        value: '$720.00',
        sourceRef: 'snapshot:fees_summary.by_type[0].total',
        resolvedDisplay: '$720.00',
        href: null,
      },
    ],
    score: 50400,
    retirementEffect: COMPUTED_EFFECT,
    ...overrides,
  };
}

function buildBrief(overrides: Partial<AdvisoryBrief> = {}): AdvisoryBrief {
  return {
    id: 'brief_1',
    isoWeek: '2026-W40',
    currency: 'USD',
    nothingMaterial: false,
    coldStart: false,
    coldStartNote: null,
    inputDigest: 'sha256:digest',
    publishedAt: '2026-10-04T06:00:00.000Z',
    items: [buildItem({ id: '1' })],
    ...overrides,
  };
}

function briefRoute(brief: AdvisoryBrief): FetchRoute {
  return { match: '/api/insights/brief/current', handle: () => jsonResponse({ brief }) };
}

function healthScoreNotComputedRoute(): FetchRoute {
  return {
    match: '/api/insights/health-score',
    handle: () =>
      jsonResponse(
        {
          type: 'about:blank',
          title: 'Not Found',
          status: 404,
          code: 'insights.health_score_not_computed',
          correlationId: 'corr_1',
        },
        404,
      ),
  };
}

describe('BriefScreen', () => {
  beforeEach(() => {
    ensureApiClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('the Brief shows at most five actions, each with a dollar figure and a retirement effect or a stated reason it has none', async () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      buildItem({
        id: String(index),
        position: index,
        title: `Ranked action ${String(index)}`,
        annualizedImpact: { minor: String(100_00 - index), currency: 'USD' },
        retirementEffect: index === 6 ? NOT_COMPUTABLE_EFFECT : COMPUTED_EFFECT,
      }),
    );
    stubFetchRoutes([briefRoute(buildBrief({ items })), healthScoreNotComputedRoute()]);

    renderScreen();

    const cards = await screen.findAllByTestId('brief-item-card');
    expect(cards).toHaveLength(5);

    for (const card of cards.slice(0, 5)) {
      // Every rendered card's dollar figure is present (headlineImpactOf
      // always resolves here — every fixture item carries an impact), and
      // its retirement-effect line is always present too, either a figure
      // or a stated reason it has none.
      expect(within(card).getByTestId('brief-item-impact')).toHaveTextContent(/\$\d/);
      const effect = within(card).getByTestId('retirement-effect');
      expect(effect.textContent).toMatch(/Retire \d+ years? earlier|Not computable:/);
    }
  });

  it("the view's own five-card cap holds even when the backend serves more than five", async () => {
    // This fixture deliberately serves *eight* ranked items with no
    // client-side filtering elsewhere that would coincidentally cap them —
    // so this assertion genuinely depends on `BriefScreen.tsx`'s own
    // `MAX_RANKED_CARDS` slice, and is the test the evidence's "five-card
    // cap removed" sabotage is run against (docs/evidence/phase-5/wp5.11-brief-ui.md).
    const items = Array.from({ length: 8 }, (_, index) =>
      buildItem({ id: String(index), position: index }),
    );
    stubFetchRoutes([briefRoute(buildBrief({ items })), healthScoreNotComputedRoute()]);

    renderScreen();

    const cards = await screen.findAllByTestId('brief-item-card');
    expect(cards.length).toBeLessThanOrEqual(5);
  });

  it('a week with no whole-year change shows the months-of-spending wording, never an interpolated month', async () => {
    stubFetchRoutes([
      briefRoute(
        buildBrief({ items: [buildItem({ id: '1', retirementEffect: NO_WHOLE_YEAR_EFFECT })] }),
      ),
      healthScoreNotComputedRoute(),
    ]);

    renderScreen();

    const effect = await screen.findByTestId('retirement-effect');
    expect(effect).toHaveTextContent('No change at yearly resolution');
    expect(effect).toHaveTextContent('funds about 9 months of retirement spending');
  });

  it('a not-computable retirement effect states its reason and shows no figure', async () => {
    stubFetchRoutes([
      briefRoute(
        buildBrief({ items: [buildItem({ id: '1', retirementEffect: NOT_COMPUTABLE_EFFECT })] }),
      ),
      healthScoreNotComputedRoute(),
    ]);

    renderScreen();

    const effect = await screen.findByTestId('retirement-effect');
    expect(effect).toHaveTextContent('Not computable: no baseline plan to project against');
  });

  it('a narrated item shows the AI-assisted badge and the template text is one click away', async () => {
    const narrated = {
      ...buildItem({ id: '1' }),
      narration: { narratedSummaryMd: 'Fee hunter found $720 you could get back this year.' },
    };
    stubFetchRoutes([briefRoute(buildBrief({ items: [narrated] })), healthScoreNotComputedRoute()]);

    renderScreen();
    const user = userEvent.setup();

    expect(
      await screen.findByText('Fee hunter found $720 you could get back this year.'),
    ).toBeInTheDocument();
    expect(screen.getByText('AI-assisted wording')).toBeInTheDocument();
    // The template (deterministic builtin) wording is not shown until the
    // toggle is clicked — "one click away", not immediately visible.
    expect(screen.queryByTestId('narration-template-text')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'See the template wording' }));
    expect(await screen.findByTestId('narration-template-text')).toHaveTextContent(
      'You paid $720 in avoidable fees over the last twelve months.',
    );
  });

  it('an item with no narration shows only the template wording and no badge', async () => {
    stubFetchRoutes([
      briefRoute(buildBrief({ items: [buildItem({ id: '1' })] })),
      healthScoreNotComputedRoute(),
    ]);

    renderScreen();

    await screen.findByText('You paid $720 in avoidable fees over the last twelve months.');
    expect(screen.queryByText('AI-assisted wording')).not.toBeInTheDocument();
  });

  it('a week with nothing material says so plainly', async () => {
    stubFetchRoutes([
      briefRoute(buildBrief({ items: [], nothingMaterial: true })),
      healthScoreNotComputedRoute(),
    ]);

    renderScreen();

    expect(await screen.findByText('Nothing material this week')).toBeInTheDocument();
    expect(screen.queryByTestId('brief-item-card')).not.toBeInTheDocument();
  });

  it('a cold-start week shows its note, and the disclaimer is always present', async () => {
    stubFetchRoutes([
      briefRoute(
        buildBrief({
          coldStart: true,
          coldStartNote:
            'Under 30 days of advisor history, trend-based findings are not yet assessable.',
        }),
      ),
      healthScoreNotComputedRoute(),
    ]);

    renderScreen();

    expect(await screen.findByText(/Under 30 days of advisor history/)).toBeInTheDocument();
    expect(screen.getByTestId('brief-disclaimer')).toHaveTextContent(
      'Educational information generated from your own data.',
    );
  });

  it('an urgent, no-dollar-figure finding renders in the attention strip, never among the ranked cards', async () => {
    const attentionItem = buildItem({
      id: 'attn',
      section: 'attention',
      severity: 'urgent',
      title: 'A payment looks like it will be missed',
      annualizedImpact: null,
      oneTimeImpact: null,
      score: null,
      retirementEffect: NOT_COMPUTABLE_EFFECT,
    });
    stubFetchRoutes([
      briefRoute(buildBrief({ items: [attentionItem, buildItem({ id: '1' })] })),
      healthScoreNotComputedRoute(),
    ]);

    renderScreen();

    const strip = await screen.findByTestId('attention-strip');
    expect(within(strip).getByText('A payment looks like it will be missed')).toBeInTheDocument();
    const cards = screen.getAllByTestId('brief-item-card');
    expect(cards).toHaveLength(1);
  });

  it('dismissing asks for one of seven reasons and the code reaches the API', async () => {
    let reviewedBody: unknown = null;
    stubFetchRoutes([
      briefRoute(buildBrief({ items: [buildItem({ id: '1' })] })),
      healthScoreNotComputedRoute(),
      {
        match: '/api/insights/insight_1/review',
        method: 'POST',
        handle: async ({ request }) => {
          reviewedBody = await request.json();
          return jsonResponse({
            insightId: 'insight_1',
            status: 'dismissed',
            dismissCount: 1,
            permanent: false,
            suppressedUntil: '2026-11-04T00:00:00.000Z',
          });
        },
      },
    ]);
    renderScreen();
    const user = userEvent.setup();

    await screen.findByTestId('brief-item-card');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    const dialog = await screen.findByRole('dialog');
    const radios = within(dialog).getAllByRole('radio');
    expect(radios).toHaveLength(7);
    await user.click(within(dialog).getByRole('radio', { name: "True, but I can't act on it" }));
    await user.click(within(dialog).getByRole('button', { name: 'Dismiss' }));

    await waitFor(() =>
      expect(reviewedBody).toEqual({
        action: 'dismiss',
        reasonCode: 'NOT_ACTIONABLE',
        reason: null,
      }),
    );
  });

  it('a large dollar figure renders exactly, from the bigint minor units — the test the "money formatted from a number" sabotage is run against', async () => {
    // 2^53 + 1 minor units — the smallest integer a JS `number` cannot
    // represent exactly. The real `<Money>` component formats from the
    // bigint `minor` string and gets this exactly right; a naive
    // `Number(minor) / 100` (the forbidden pattern docs/CONVENTIONS.md's
    // "Money" section bans — "may never flow back into a *_minor column
    // without an explicit, rounded conversion", the display-side mirror of
    // that rule) silently loses precision.
    const item = buildItem({
      id: '1',
      annualizedImpact: { minor: '9007199254740993', currency: 'USD' },
    });
    stubFetchRoutes([briefRoute(buildBrief({ items: [item] })), healthScoreNotComputedRoute()]);

    renderScreen();

    const card = await screen.findByTestId('brief-item-card');
    // The exact, correctly-rounded dollar figure a bigint-based formatter
    // produces for this minor-unit value.
    expect(within(card).getByText('+$90,071,992,547,409.93')).toBeInTheDocument();
  });
});
