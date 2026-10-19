// SPDX-License-Identifier: MIT
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
  type FetchRoute,
} from '../../test-support/api-test-utils.ts';
import type { AdvisoryBrief, BriefItem } from '../../api/generated/types.gen.ts';
import { renderWidget } from '../dashboard/test-utils.tsx';
import { BriefScreen } from './BriefScreen.tsx';
import {
  blockDocumentOf,
  briefItemBlocks,
  briefOverviewBlocks,
} from '../../test-support/block-fixtures.ts';

/** Inside a router since WP 10.12: the health section is a `<Link>` to `/health`. */
function renderScreen() {
  renderWidget(<BriefScreen />);
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
  const base: Omit<BriefItem, 'blocks'> = {
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
    primaryAction: null,
    narration: {
      status: 'none',
      aiAssisted: false,
      textShown: false,
      summaryMd: null,
      narratedBy: null,
    },
    ...overrides,
  };
  // WP 10.15: the card's blocks, built from the item's own fields the way the API builds them.
  return { ...base, blocks: blockDocumentOf(briefItemBlocks(base)) };
}

/** An item whose fields a test changed after building it: its blocks rebuilt from the changed fields. */
function withItemBlocks(item: BriefItem): BriefItem {
  return { ...item, blocks: blockDocumentOf(briefItemBlocks(item)) };
}

function buildBrief(overrides: Partial<AdvisoryBrief> = {}): AdvisoryBrief {
  const base: Omit<AdvisoryBrief, 'blocks'> = {
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
  return {
    ...base,
    blocks: blockDocumentOf(briefOverviewBlocks(base, { kind: 'not_computed' }, [])),
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
    // The real response shape (WP 9.6 item 3): status, badge, textShown, text.
    const narrated = withItemBlocks({
      ...buildItem({ id: '1' }),
      narration: {
        status: 'narrated' as const,
        aiAssisted: true,
        textShown: true,
        summaryMd: 'Fee hunter found $720 you could get back this year.',
        narratedBy: null,
      },
    });
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

  it('R-2: a narrated item whose text the deployment withholds shows the built-in wording and says so', async () => {
    const withheld = withItemBlocks({
      ...buildItem({ id: '1' }),
      narration: {
        status: 'narrated' as const,
        aiAssisted: true,
        textShown: false,
        summaryMd: null,
        narratedBy: null,
      },
    });
    stubFetchRoutes([briefRoute(buildBrief({ items: [withheld] })), healthScoreNotComputedRoute()]);

    renderScreen();

    // The built-in's own wording is the text; the narration is not on screen.
    expect(
      await screen.findByText('You paid $720 in avoidable fees over the last twelve months.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('narration-withheld')).toHaveTextContent(
      'An AI-assisted wording of this item exists and is not shown yet.',
    );
    expect(screen.queryByRole('button', { name: 'See the template wording' })).toBeNull();
  });

  it('WP 10.6: the badge names the provider and model that wrote the wording, shown and withheld alike', async () => {
    const shown = withItemBlocks({
      ...buildItem({ id: '1', title: 'Shown wording' }),
      narration: {
        status: 'narrated' as const,
        aiAssisted: true,
        textShown: true,
        summaryMd: 'Fee hunter found $720 you could get back this year.',
        narratedBy: { provider: 'anthropic' as const, model: 'claude-sonnet-5-5' },
      },
    });
    const withheld = withItemBlocks({
      ...buildItem({ id: '2', position: 1, title: 'Withheld wording' }),
      narration: {
        status: 'narrated' as const,
        aiAssisted: true,
        textShown: false,
        summaryMd: null,
        narratedBy: { provider: 'ollama' as const, model: 'qwen2.5:7b-instruct-q4_K_M' },
      },
    });
    stubFetchRoutes([
      briefRoute(buildBrief({ items: [shown, withheld] })),
      healthScoreNotComputedRoute(),
    ]);

    renderScreen();

    expect(await screen.findByText('Narrated by Anthropic claude-sonnet-5-5')).toBeInTheDocument();
    expect(screen.getByTestId('narration-withheld')).toHaveTextContent(
      'Narrated by the local model qwen2.5:7b-instruct-q4_K_M',
    );
    expect(screen.getByTestId('narration-withheld')).toHaveTextContent(
      'An AI-assisted wording of this item exists and is not shown yet.',
    );
    // A named narrator replaces the generic words; nothing else on the card changes.
    expect(screen.queryByText('AI-assisted wording')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See the template wording' })).toBeInTheDocument();
  });

  it('a narration that is expected but has not arrived says it may follow', async () => {
    const pending = withItemBlocks({
      ...buildItem({ id: '1' }),
      narration: {
        status: 'pending' as const,
        aiAssisted: false,
        textShown: true,
        summaryMd: null,
        narratedBy: null,
      },
    });
    stubFetchRoutes([briefRoute(buildBrief({ items: [pending] })), healthScoreNotComputedRoute()]);

    renderScreen();

    expect(await screen.findByTestId('narration-pending')).toBeInTheDocument();
    expect(screen.queryByText('AI-assisted wording')).not.toBeInTheDocument();
  });

  it("CF-24: the item shows the action the Brief recorded, and 'No action recorded' for an older Brief", async () => {
    const recorded = withItemBlocks({
      ...buildItem({ id: '1' }),
      primaryAction: {
        kind: 'open_url' as const,
        label: 'Open the fee-free account page',
        rationaleMd: 'Moves the fees away.',
        url: 'https://example.com/accounts',
      },
    });
    const older = { ...buildItem({ id: '2' }), position: 1, primaryAction: null };
    stubFetchRoutes([
      briefRoute(buildBrief({ items: [recorded, older] })),
      healthScoreNotComputedRoute(),
    ]);

    renderScreen();

    const cards = await screen.findAllByTestId('brief-item-action');
    expect(cards[0]).toHaveTextContent('Suggested next step: Open the fee-free account page');
    expect(
      within(cards[0]!).getByRole('link', { name: 'Open the fee-free account page' }),
    ).toHaveAttribute('href', 'https://example.com/accounts');
    expect(cards[1]).toHaveTextContent('No action recorded');
  });

  // C5-7 (G5-19), the web half. The port side pins a funded plan at
  // `yearsEarlier` 3 and 374 months (`brief-retirement-port.test.ts`); this
  // side pins that the number a holder reads is the number the API sent —
  // nothing between the response and the screen adds, rounds or re-derives a
  // year or a month. Phase 5's gate found `Math.abs(yearsEarlier) + 1` in
  // `retirement-effect.ts` passing every unit test and the e2e regex.
  describe("C5-7: the rendered retirement figures equal the API's", () => {
    function effectOf(yearsEarlier: number | null, months: string) {
      return {
        ...COMPUTED_EFFECT,
        yearsEarlier,
        monthsOfSpending: { ...COMPUTED_EFFECT.monthsOfSpending, months },
      };
    }

    it('the funded plan the port test pins: 3 years earlier, 374 months', async () => {
      stubFetchRoutes([
        briefRoute(
          buildBrief({
            items: [
              buildItem({ id: '1', retirementEffect: effectOf(3, '374') }),
              buildItem({ id: '2', position: 1, retirementEffect: effectOf(0, '374') }),
            ],
          }),
        ),
        healthScoreNotComputedRoute(),
      ]);
      renderScreen();
      const effects = await screen.findAllByTestId('retirement-effect');
      // Years, exactly as sent.
      expect(effects[0]).toHaveTextContent(/^Retire 3 years earlier/);
      // Months, exactly as sent, when the year did not move.
      expect(effects[1]).toHaveTextContent('funds about 374 months of retirement spending');
    });

    it.each([1, 2, 3, 7, 12, 40])('%i years earlier is rendered as %i', async (years) => {
      stubFetchRoutes([
        briefRoute(
          buildBrief({ items: [buildItem({ id: '1', retirementEffect: effectOf(years, '9') })] }),
        ),
        healthScoreNotComputedRoute(),
      ]);
      renderScreen();
      const effect = await screen.findByTestId('retirement-effect');
      const expected =
        years === 1 ? 'Retire 1 year earlier' : `Retire ${String(years)} years earlier`;
      expect(effect.textContent?.startsWith(expected)).toBe(true);
      // Not the neighbouring figures a +1 / -1 slip would print.
      expect(effect.textContent).not.toMatch(new RegExp(`Retire ${String(years + 1)} year`));
    });

    it.each(['0', '1', '9', '374', '1200'])(
      '%s months of spending is rendered as sent',
      async (months) => {
        stubFetchRoutes([
          briefRoute(
            buildBrief({ items: [buildItem({ id: '1', retirementEffect: effectOf(0, months) })] }),
          ),
          healthScoreNotComputedRoute(),
        ]);
        renderScreen();
        const effect = await screen.findByTestId('retirement-effect');
        expect(effect).toHaveTextContent(`funds about ${months} months of retirement spending`);
      },
    );

    it("a later retirement is rendered with the API's magnitude", async () => {
      stubFetchRoutes([
        briefRoute(
          buildBrief({ items: [buildItem({ id: '1', retirementEffect: effectOf(-4, '9') })] }),
        ),
        healthScoreNotComputedRoute(),
      ]);
      renderScreen();
      expect(await screen.findByTestId('retirement-effect')).toHaveTextContent(
        /^Retire 4 years later/,
      );
    });
  });

  it("WP 10.15: the overview is drawn from the Brief's blocks — the week, the ranked bars, the health card", async () => {
    const items = [
      buildItem({ id: '1', title: 'Avoidable fees this year' }),
      buildItem({
        id: '2',
        position: 1,
        title: 'A one-off refund is due',
        annualizedImpact: null,
        oneTimeImpact: { minor: '15000', currency: 'USD' },
      }),
      buildItem({ id: '3', position: 2, title: 'No figure here', annualizedImpact: null }),
    ];
    stubFetchRoutes([briefRoute(buildBrief({ items })), healthScoreNotComputedRoute()]);
    renderScreen();

    const overview = await screen.findByTestId('brief-overview-blocks');
    expect(
      within(overview).getByRole('heading', { name: 'The week', level: 3 }),
    ).toBeInTheDocument();
    expect(within(overview).getByText('2026-W40')).toBeInTheDocument();
    const perYear = within(overview).getByRole('group', { name: 'Ranked actions, per year' });
    expect(within(perYear).getByText('$720.00')).toBeInTheDocument();
    const oneTime = within(overview).getByRole('group', { name: 'Ranked actions, one-time' });
    expect(within(oneTime).getByText('$150.00')).toBeInTheDocument();
    // An item with no figure is named, not drawn as a zero-length bar.
    expect(within(overview).getByText('No dollar figure: No figure here.')).toBeInTheDocument();
    expect(within(overview).getByTestId('block-withheld')).toHaveTextContent('Not computed yet');
    expect(within(overview).getByRole('link', { name: 'Open Financial health' })).toHaveAttribute(
      'href',
      '/health',
    );
    // The card without a figure says why, in its own right column.
    const cards = screen.getAllByTestId('brief-item-card');
    expect(within(cards[2]!).getByTestId('brief-item-impact')).toHaveTextContent(
      'No dollar figure: this finding claims none.',
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
    expect(within(card).getByText('$90,071,992,547,409.93')).toBeInTheDocument();
  });
});
