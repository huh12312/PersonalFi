// SPDX-License-Identifier: MIT
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Insight, InsightExplanationState } from '../../api/generated/types.gen.ts';
import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { HealthPillarScreen } from '../health/HealthPillarScreen.tsx';
import { HealthScreen } from '../health/HealthScreen.tsx';
import { overviewFixture } from '../health/test-fixtures.ts';
import {
  EXPLANATION_REFUSED_FALLBACK,
  ExplainButton,
  ExplanationResult,
  explainedByLabel,
  explanationModelText,
} from './ExplainThis.tsx';
import { InsightCard } from './InsightCard.tsx';
import { EXPLAIN_TAKING_LONG, useExplanation, type ExplainEntity } from './useExplanation.ts';

/**
 * WP 11.3 ("Explain this"): the button, its states and its outcomes, on an insight card and on a health pillar,
 * against a stubbed api that records every call — so "rendering only reads" is a fact the tests check.
 */

const INSIGHT_ID = '0190a000-0000-7000-8000-0000000000bb';
const DIGEST = '3f'.repeat(32);
const LOCAL_MODEL = `qwen2.5:7b-instruct-q4_K_M@sha256:${DIGEST}`;
const TEXT =
  'Groceries cost $420.00 last month, against a usual $350.00. That gap, kept up for a year, is the $840.00 above.';
const REFUSED = "The explanation didn't pass the checks; the evidence below is the arithmetic.";

function stateOf(
  state: InsightExplanationState['state'],
  overrides: Partial<InsightExplanationState> = {},
): InsightExplanationState {
  return {
    state,
    entityKind: 'insight',
    entityId: INSIGHT_ID,
    explanation: null,
    refusal: null,
    reason: null,
    message: null,
    ...overrides,
  };
}

const SHOWN = stateOf('shown', {
  explanation: {
    text: TEXT,
    provider: 'ollama',
    providerName: 'Local model',
    model: LOCAL_MODEL,
    createdAt: '2026-10-27T09:00:00.000Z',
    runId: '0190a000-0000-7000-8000-0000000000cc',
  },
});
const REFUSED_STATE = stateOf('refused', {
  refusal: 'figure_not_in_evidence',
  message: REFUSED,
});

function buildInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: INSIGHT_ID,
    advisorId: 'builtin.spending.category_creep',
    advisorVersion: '1.0.0',
    key: 'spending.category_creep',
    period: '2026-09',
    type: 'spending.category_creep',
    severity: 'notable',
    severityClamped: false,
    title: 'Groceries ran higher than usual',
    summaryMd: 'Spending in Groceries rose.',
    confidence: 1,
    confidenceBasis: 'deterministic',
    horizon: 'this_year',
    status: 'pending_review',
    annualizedImpact: { minor: '84000', currency: 'USD' },
    oneTimeImpact: null,
    impactBasis: 'b',
    caveats: [],
    inputDigest: 'sha256:abc',
    firstProposedAt: '2026-09-02T00:00:00.000Z',
    lastProposedAt: '2026-09-02T00:00:00.000Z',
    expiresAt: null,
    evidence: [
      {
        position: 0,
        kind: 'metric',
        label: 'A recent month',
        value: '$420.00',
        sourceRef: 'snapshot:spending_summary.by_category_month[3].amount.minor',
        resolvedDisplay: '$420.00',
        href: null,
      },
    ],
    actions: [],
    bookmarkedAt: null,
    feedback: null,
    feedbackReason: null,
    mentions: [],
    titleSegments: [{ text: 'Groceries ran higher than usual' }],
    bodySegments: [{ text: 'Spending in Groceries rose.' }],
    contextLine: null,
    talkThrough: false,
    ...overrides,
  };
}

interface Api {
  calls: string[];
  /** What `GET` answers, in order; the last one repeats. */
  gets: InsightExplanationState[];
  /** What `POST` answers (status, body), in order; the last one repeats. */
  posts: Array<{ status: number; body: InsightExplanationState }>;
}

function api(gets: InsightExplanationState[], posts: Api['posts'] = []): Api {
  const state: Api = { calls: [], gets, posts };
  let getIndex = 0;
  let postIndex = 0;
  stubFetchRoutes([
    {
      match: /^\/api\/insights\/(health\/[^/]+|[^/]+)\/explain$/,
      handle: ({ url, request }) => {
        state.calls.push(`${request.method} ${url.pathname}`);
        if (request.method === 'POST') {
          const reply = state.posts[Math.min(postIndex, state.posts.length - 1)]!;
          postIndex += 1;
          return jsonResponse(reply.body, reply.status);
        }
        const body = state.gets[Math.min(getIndex, state.gets.length - 1)]!;
        getIndex += 1;
        return jsonResponse(body, body.state === 'computing' ? 202 : 200);
      },
    },
    {
      match: '/api/insights/health',
      handle: () => jsonResponse({ health: overviewFixture() }),
    },
  ]);
  return state;
}

function renderInRouter(node: () => ReactNode, path = '/') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const page = createRoute({ getParentRoute: () => root, path: '/', component: node });
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
  const router = createRouter({
    routeTree: root.addChildren([page, health, pillar]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function card(insight = buildInsight()) {
  renderInRouter(() => (
    <ul>
      <InsightCard insight={insight} />
    </ul>
  ));
}

/** The hook with short clocks, for the polling and give-up tests. */
function Harness({ entity, giveUpMs }: { entity: ExplainEntity; giveUpMs?: number }) {
  const explanation = useExplanation(entity, { pollMs: 50, giveUpMs: giveUpMs ?? 180_000 });
  return (
    <div>
      <ExplainButton explanation={explanation} subject="Groceries" />
      <ExplanationResult explanation={explanation} />
    </div>
  );
}

describe('WP 11.3 Explain this: words', () => {
  it('the badge names the provider and model; a local digest is shortened, a hosted prefix dropped', () => {
    expect(explanationModelText('ollama', LOCAL_MODEL)).toBe(
      'qwen2.5:7b-instruct-q4_K_M@sha256:3f3f3f3f3f3f…',
    );
    expect(explainedByLabel(SHOWN.explanation!)).toBe(
      'Explained by the local model qwen2.5:7b-instruct-q4_K_M@sha256:3f3f3f3f3f3f…',
    );
    expect(
      explainedByLabel({
        provider: 'anthropic',
        providerName: 'Anthropic',
        model: 'anthropic:claude-sonnet-5-5',
      }),
    ).toBe('Explained by Anthropic claude-sonnet-5-5');
    expect(EXPLANATION_REFUSED_FALLBACK).toBe(REFUSED);
  });
});

describe('WP 11.3 Explain this on an insight card', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('rendering sends GET only, never POST; idle offers the button beside the evidence toggle', async () => {
    const calls = api([stateOf('idle')]).calls;
    card();
    const button = await screen.findByRole('button', {
      name: 'Explain this — Groceries ran higher than usual',
    });
    expect(button).not.toHaveAttribute('aria-disabled');
    expect(screen.getByRole('button', { name: 'View evidence panel' })).toBeInTheDocument();
    await waitFor(() => expect(calls).toEqual([`GET /api/insights/${INSIGHT_ID}/explain`]));
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
    expect(screen.queryByTestId('explanation')).not.toBeInTheDocument();
  });

  it('a tap POSTs; 202 computing is busy with "Explaining…" in a polite live region; polling stops once shown', async () => {
    const state = api(
      [stateOf('idle'), stateOf('computing'), SHOWN],
      [{ status: 202, body: stateOf('computing') }],
    );
    const user = userEvent.setup();
    card();
    const button = await screen.findByRole('button', { name: /^Explain this/ });
    await user.click(button);

    const live = screen.getByTestId('explain-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(live).toHaveTextContent('Explaining…'));
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAttribute('aria-busy', 'true');
    // The spinner turns only under motion-safe.
    expect(button.querySelector('svg')?.getAttribute('class')).toContain(
      'motion-safe:animate-spin',
    );

    const text = await screen.findByTestId('explanation-text', {}, { timeout: 6_000 });
    expect(text).toHaveTextContent(TEXT);
    expect(screen.getByTestId('explanation-badge')).toHaveTextContent(
      'Explained by the local model qwen2.5:7b-instruct-q4_K_M@sha256:3f3f3f3f3f3f…',
    );
    expect(screen.getByTestId('explanation-ai-label')).toHaveTextContent('AI-assisted wording');
    // The outcome takes focus: the button it replaced is gone.
    expect(screen.queryByRole('button', { name: /^Explain this/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('explanation')).toHaveFocus();
    // The evidence it was worded from is beneath it, and stays.
    expect(screen.getByTestId('insight-evidence')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View evidence panel' })).not.toBeInTheDocument();

    expect(state.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
    const reads = state.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(state.calls).toHaveLength(reads);
  }, 15_000);

  it('an explanation already there (asked earlier, or prefetched with the Brief) shows without a tap, as plain text', async () => {
    const markdown = stateOf('shown', {
      explanation: {
        ...SHOWN.explanation!,
        text: 'Groceries cost **$420.00** last month.',
        provider: 'openai',
        providerName: 'OpenAI',
        model: 'openai:gpt-5-mini',
      },
    });
    const { calls } = api([markdown]);
    card();
    const text = await screen.findByTestId('explanation-text');
    // Plain text: the asterisks are characters, never bold.
    expect(text.textContent).toBe('Groceries cost **$420.00** last month.');
    expect(text.querySelector('strong, em, b')).toBeNull();
    expect(screen.getByTestId('explanation-badge')).toHaveTextContent(
      'Explained by OpenAI gpt-5-mini',
    );
    expect(screen.getByText('AI-assisted wording')).toBeVisible();
    expect(screen.getByTestId('insight-evidence')).toBeInTheDocument();
    expect(screen.getByTestId('explanation')).not.toHaveFocus();
    expect(calls).toEqual([`GET /api/insights/${INSIGHT_ID}/explain`]);
  });

  it('refused: the api’s sentence, visible, never template wording; the evidence stays beneath it', async () => {
    api([REFUSED_STATE]);
    card();
    const refused = await screen.findByTestId('explanation-refused');
    expect(refused).toHaveTextContent(REFUSED);
    expect(refused).toBeVisible();
    expect(screen.queryByTestId('explanation-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('explanation-badge')).not.toBeInTheDocument();
    expect(screen.getByTestId('insight-evidence')).toBeInTheDocument();
    expect(within(screen.getByTestId('insight-evidence')).getByText('$420.00')).toBeVisible();
  });

  it('unavailable (the narrator Off): the message and the way to Advisor management and Settings › Language model, no retry', async () => {
    const off = stateOf('unavailable', {
      reason: 'off',
      message: 'No language model is turned on, so nothing can explain this.',
    });
    const state = api([stateOf('idle')], [{ status: 200, body: off }]);
    const user = userEvent.setup();
    card();
    await user.click(await screen.findByRole('button', { name: /^Explain this/ }));
    const box = await screen.findByTestId('explanation');
    expect(box).toHaveAttribute('data-explanation-state', 'unavailable');
    expect(within(box).getByText(off.message!)).toBeVisible();
    expect(within(box).getByRole('link', { name: 'Advisor management' })).toHaveAttribute(
      'href',
      '/settings/advisors',
    );
    expect(within(box).getByRole('link', { name: 'Settings › Language model' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(within(box).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Explain this/ })).not.toBeInTheDocument();
    expect(state.calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('unavailable for want of an approval: Advisor management only', async () => {
    api([
      stateOf('unavailable', {
        reason: 'payload_not_approved',
        message: 'The explanation payload has not been approved in Advisor management.',
      }),
    ]);
    card();
    const box = await screen.findByTestId('explanation');
    expect(within(box).getByRole('link', { name: 'Advisor management' })).toBeInTheDocument();
    expect(
      within(box).queryByRole('link', { name: 'Settings › Language model' }),
    ).not.toBeInTheDocument();
  });

  it('failed: the message and Try again, which POSTs', async () => {
    const failed = stateOf('failed', {
      message: 'The last explanation run failed. The evidence is unchanged.',
    });
    const state = api([failed], [{ status: 200, body: SHOWN }]);
    const user = userEvent.setup();
    card();
    expect(await screen.findByTestId('explanation-failed')).toHaveTextContent(failed.message!);
    expect(state.calls.filter((c) => c.startsWith('POST'))).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('explanation-text')).toHaveTextContent(TEXT);
    expect(state.calls.filter((c) => c.startsWith('POST'))).toEqual([
      `POST /api/insights/${INSIGHT_ID}/explain`,
    ]);
  });

  it('a POST that fails outright reads as failed, with Try again', async () => {
    stubFetchRoutes([
      {
        match: /\/explain$/,
        handle: ({ request }) =>
          request.method === 'POST'
            ? jsonResponse({ type: 'about:blank', title: 'Unavailable', status: 503 }, 503)
            : jsonResponse(stateOf('idle')),
      },
    ]);
    const user = userEvent.setup();
    card();
    await user.click(await screen.findByRole('button', { name: /^Explain this/ }));
    expect(await screen.findByTestId('explanation-failed')).toHaveTextContent(
      'The explanation could not be asked for right now.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});

describe('WP 11.3 Explain this: polling', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('computing on mount resumes polling; past the give-up time it stops and offers a retry', async () => {
    const state = api([stateOf('computing')], [{ status: 202, body: stateOf('computing') }]);
    renderInRouter(() => (
      <Harness entity={{ kind: 'insight', insightId: INSIGHT_ID }} giveUpMs={400} />
    ));
    expect(await screen.findByText('Explaining…')).toBeInTheDocument();
    await waitFor(() => expect(state.calls.length).toBeGreaterThan(2));
    expect(state.calls.every((c) => c.startsWith('GET'))).toBe(true);
    expect(await screen.findByTestId('explanation-failed')).toHaveTextContent(EXPLAIN_TAKING_LONG);
    const reads = state.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(state.calls).toHaveLength(reads);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(state.calls).toContain(`POST /api/insights/${INSIGHT_ID}/explain`));
  });
});

describe('WP 11.3 Explain this on Financial health', () => {
  beforeEach(() => ensureApiClient());
  afterEach(() => vi.unstubAllGlobals());

  it('every scored pillar card offers Explain this; the withheld one does not', async () => {
    const { calls } = api([stateOf('idle', { entityKind: 'health_pillar' })]);
    renderInRouter(() => null, '/health');
    const grid = await screen.findByTestId('pillars-grid');
    const scored = grid.querySelectorAll('[data-pillar-status="scored"]');
    expect(scored.length).toBe(5);
    for (const pillar of scored) {
      expect(within(pillar as HTMLElement).getByTestId('explain-this')).toBeInTheDocument();
    }
    const withheld = grid.querySelector('[data-pillar="diversification"]') as HTMLElement;
    expect(within(withheld).queryByTestId('explain-this')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Explain this — Savings rate' })).toBeInTheDocument();
    await waitFor(() => expect(calls).toHaveLength(5));
    expect(calls).toContain('GET /api/insights/health/savings_rate/explain');
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });

  it('the pillar detail explains that pillar; the inputs stay beneath the explanation', async () => {
    const pillarShown = {
      ...SHOWN,
      entityKind: 'health_pillar' as const,
      entityId: 'savings_rate',
    };
    const state = api(
      [stateOf('idle', { entityKind: 'health_pillar' })],
      [{ status: 200, body: pillarShown }],
    );
    const user = userEvent.setup();
    renderInRouter(() => null, '/health/savings-rate');
    await user.click(await screen.findByRole('button', { name: 'Explain this — Savings rate' }));
    const explanation = await screen.findByTestId('explanation');
    expect(within(explanation).getByTestId('explanation-badge')).toBeInTheDocument();
    expect(state.calls).toContain('POST /api/insights/health/savings_rate/explain');
    const builtFrom = screen.getByRole('heading', { name: 'What it is built from' });
    // Document order: the explanation, then the inputs it was worded from.
    expect(
      explanation.compareDocumentPosition(builtFrom) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
