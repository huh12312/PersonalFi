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
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ensureApiClient,
  jsonResponse,
  stubFetchRoutes,
} from '../../test-support/api-test-utils.ts';
import { BRIEF_DISCLAIMER } from '../brief/disclaimer.ts';
import {
  COST_MISSING_MESSAGE,
  FAILED_MESSAGE,
  HOSTED_ENGINE,
  LOCAL_MODEL,
  LOOKED_AT_LINE,
  OPTIONS,
  OUT_OF_SCOPE_MESSAGE,
  QUESTION,
  awaitingPick,
  FINDING_ID,
  FINDING_TITLE,
  clarifying,
  completed,
  failed,
  fromFinding,
  overview,
  refused,
  session,
  tracked,
  unanswerable,
} from './advisor-fixtures.ts';
import {
  ADVISOR_DISCLAIMER,
  directionWords,
  isWorking,
  judgeWords,
  optionsWithCost,
  runsOnLabel,
  statusWords,
  stepWords,
  withheldWords,
  type AdvisorOverview,
  type AdvisorSession,
} from './advisor-words.ts';
import { AdvisorScreen } from './AdvisorScreen.tsx';

/**
 * WP 11.5d, the Advisor: the screen's states against a stubbed api that records every call, so "rendering only
 * reads" is a fact the tests check. No model is anywhere in these tests.
 */

interface Api {
  calls: string[];
  bodies: Array<{ call: string; body: unknown }>;
}

const advisorSearch = z.object({
  finding: z.string().optional(),
  week: z.string().optional(),
  session: z.string().optional(),
});

const SESSION_PATH = /^\/api\/advisor\/sessions\/([^/]+)(?:\/(answers|pick|cancel))?$/u;

/**
 * `GET`/`POST /advisor/sessions`, `GET /advisor/sessions/{id}` and the three writes. `reads` is what each
 * `GET /advisor/sessions/{id}` answers, in order; `writes` is what each write answers, keyed by its verb.
 */
function api(options: {
  overview: AdvisorOverview;
  start?: { status: number; body: unknown };
  reads?: AdvisorSession[];
  writes?: Partial<Record<'answers' | 'pick' | 'cancel', { status: number; body: unknown }>>;
}): Api {
  const state: Api = { calls: [], bodies: [] };
  let read = 0;
  stubFetchRoutes([
    {
      match: '/api/advisor/sessions',
      handle: async ({ url, request }) => {
        state.calls.push(`${request.method} ${url.pathname}`);
        if (request.method === 'POST') {
          state.bodies.push({ call: 'start', body: await request.json() });
          const reply = options.start ?? { status: 500, body: {} };
          return jsonResponse(reply.body, reply.status);
        }
        return jsonResponse(options.overview);
      },
    },
    {
      match: SESSION_PATH,
      handle: async ({ url, request }) => {
        state.calls.push(`${request.method} ${url.pathname}`);
        const verb = SESSION_PATH.exec(url.pathname)?.[2];
        if (request.method === 'POST' && verb !== undefined) {
          const text = await request.text();
          state.bodies.push({ call: verb, body: text === '' ? null : JSON.parse(text) });
          const reply = options.writes?.[verb as 'answers'] ?? { status: 500, body: {} };
          return jsonResponse(reply.body, reply.status);
        }
        const reads = options.reads ?? [];
        const body = reads[Math.min(read, reads.length - 1)];
        read += 1;
        return body === undefined
          ? jsonResponse({ status: 404, code: 'insights.advisor_session_not_found' }, 404)
          : jsonResponse(body);
      },
    },
  ]);
  return state;
}

function renderScreen(pollMs = 20, entry = '/advisor', strict = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRoute();
  const routes = [
    '/advisor',
    '/goals',
    '/accounts',
    '/plan',
    '/brief',
    '/investments',
    '/health',
    '/settings',
    '/settings/advisors',
  ].map((path) =>
    createRoute({
      getParentRoute: () => root,
      path,
      ...(path === '/advisor' ? { validateSearch: advisorSearch } : {}),
      component: path === '/advisor' ? () => <AdvisorScreen pollMs={pollMs} /> : () => null,
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren(routes),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  const tree = (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  // StrictMode runs every effect twice on mount: what a start-once guard has to survive.
  render(strict ? <StrictMode>{tree}</StrictMode> : tree);
  return router;
}

const gathering = (id = 'sess-new') => session(id, 'gathering');

describe('WP 11.5d Advisor: words', () => {
  it('the badge always names the provider and the model; a local digest is shortened, a hosted prefix dropped', () => {
    expect(
      runsOnLabel({ provider: 'ollama', providerName: 'Local model', model: LOCAL_MODEL }),
    ).toBe('Runs on Local model qwen2.5:7b-instruct-q4_K@sha256:3f3f3f3f3f3f…');
    expect(runsOnLabel(HOSTED_ENGINE)).toBe('Runs on Anthropic claude-sonnet-5-5');
  });

  it('knows which statuses are going, says each step, and names each state in the history', () => {
    expect(stepWords(session('a', 'gathering'))).toBe('Gathering your figures…');
    expect(stepWords(session('a', 'options'))).toBe('Setting out the options…');
    expect(stepWords(session('a', 'tradeoffs'))).toBe('Working out what each option costs…');
    expect(stepWords(session('a', 'planning'))).toBe('Writing the steps…');
    expect(stepWords(session('a', 'clarifying'))).toBe('Restating your question…');
    expect(isWorking(session('a', 'clarifying'))).toBe(true);
    expect(isWorking(clarifying())).toBe(false);
    expect(isWorking(awaitingPick())).toBe(false);
    expect(isWorking(tracked())).toBe(false);
    expect(statusWords(clarifying())).toBe('Waiting for your answers');
    expect(statusWords(refused())).toBe('Refused');
  });

  it('counts the rubric criteria met, and the pages withheld, in plain words', () => {
    expect(
      judgeWords({
        score: '0.667',
        page: null,
        runId: null,
        error: null,
        criteria: [
          { criterion: 'a', met: true, reason: '' },
          { criterion: 'b', met: true, reason: '' },
          { criterion: 'c', met: false, reason: '' },
        ],
      }),
    ).toBe('Rubric check: 2 of 3 criteria met');
    expect(withheldWords(3)).toBe('Playbook pages not yet reviewed were not used: 3');
    expect(directionWords('down')).toBe('Lower than when you picked it');
  });

  it('keeps only the options that carry a cost', () => {
    const [first] = OPTIONS;
    expect(first).toBeDefined();
    const kept = optionsWithCost({ options: [{ ...first!, id: 'o3', cost: [] }, ...OPTIONS] });
    expect(kept.map((option) => option.id)).toEqual(['o1', 'o2']);
  });
});

describe('WP 11.5d Advisor screen', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens on the overview, reads nothing else, and shows the disclaimer, the engine badge and the examples', async () => {
    const state = api({ overview: overview() });
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Advisor', level: 2 })).toBeInTheDocument();
    expect(await screen.findByTestId('advisor-engine-badge')).toHaveTextContent(
      'Runs on Local model qwen2.5:7b-instruct-q4_K@sha256:3f3f3f3f3f3f…',
    );
    expect(screen.getByTestId('advisor-engine-egress')).toHaveTextContent(
      'This is the local model',
    );
    expect(screen.getByTestId('advisor-disclaimer')).toHaveTextContent(BRIEF_DISCLAIMER);
    expect(ADVISOR_DISCLAIMER).toBe(BRIEF_DISCLAIMER);
    expect(within(screen.getByTestId('advisor-examples')).getAllByRole('button')).toHaveLength(2);
    expect(screen.getByTestId('advisor-count')).toHaveTextContent('0 / 500 characters');
    expect(state.calls).toEqual(['GET /api/advisor/sessions']);
  });

  it('says whether the engine is the hosted provider under the advisor’s own consent', async () => {
    api({
      overview: overview([], {
        engine: { ...HOSTED_ENGINE, hostedConsented: true, hostedFallback: null },
      }),
    });
    renderScreen();
    expect(await screen.findByTestId('advisor-engine-badge')).toHaveTextContent(
      'Runs on Anthropic claude-sonnet-5-5',
    );
    expect(screen.getByTestId('advisor-engine')).toHaveAttribute('data-egress', 'hosted');
    expect(screen.getByTestId('advisor-engine-egress')).toHaveTextContent(
      "advisor's own hosted consent",
    );
  });

  it('an example fills the box and sends nothing', async () => {
    const user = userEvent.setup();
    const state = api({ overview: overview() });
    renderScreen();
    await user.click(
      await screen.findByRole('button', { name: 'How could I build up my emergency fund faster?' }),
    );
    expect(screen.getByLabelText('Your question')).toHaveValue(QUESTION);
    expect(state.bodies).toEqual([]);
  });

  it('starting a session posts the trimmed question, then follows it through the working steps', async () => {
    const user = userEvent.setup();
    const state = api({
      overview: overview(),
      start: { status: 202, body: session('sess-new', 'clarifying') },
      reads: [session('sess-new', 'clarifying'), clarifying('sess-new')],
    });
    renderScreen();
    const box = await screen.findByLabelText('Your question');
    await user.type(box, `  ${QUESTION}  `);
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('advisor-live')).toHaveTextContent('Restating your question…');
    await waitFor(() => expect(screen.getByTestId('advisor-clarify')).toBeInTheDocument());
    expect(state.bodies).toEqual([{ call: 'start', body: { question: QUESTION } }]);
    expect(screen.getByLabelText('Your question')).toHaveValue('');
    expect(screen.getByTestId('advisor-disclaimer')).toBeInTheDocument();
  });

  it('a working state has a polite live region and a Close this session button that posts cancel', async () => {
    const user = userEvent.setup();
    const state = api({
      overview: overview([gathering('sess-go')]),
      reads: [gathering('sess-go')],
      writes: {
        cancel: { status: 200, body: session('sess-go', 'cancelled', { failure: null }) },
      },
    });
    renderScreen();
    const live = await screen.findByTestId('advisor-live');
    expect(live).toHaveAttribute('role', 'status');
    expect(live).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => expect(live).toHaveTextContent('Gathering your figures…'));
    await user.click(screen.getByRole('button', { name: 'Close this session' }));
    await waitFor(() =>
      expect(screen.getByTestId('advisor-session')).toHaveAttribute('data-state', 'cancelled'),
    );
    expect(state.bodies).toEqual([{ call: 'cancel', body: null }]);
    expect(screen.getByTestId('advisor-message')).toHaveTextContent('This session was closed.');
    expect(screen.queryByRole('button', { name: 'Close this session' })).not.toBeInTheDocument();
  });

  it('a going session is polled until it settles', async () => {
    const state = api({
      overview: overview([gathering('sess-go')]),
      reads: [gathering('sess-go'), session('sess-go', 'options'), awaitingPick('sess-go')],
    });
    renderScreen();
    await waitFor(() =>
      expect(screen.getByTestId('advisor-session')).toHaveAttribute('data-state', 'awaiting_pick'),
    );
    expect(
      state.calls.filter((c) => c === 'GET /api/advisor/sessions/sess-go').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('the clarify form shows the restatement, the assumptions and one labelled box per question, and posts the answers in order', async () => {
    const user = userEvent.setup();
    const state = api({
      overview: overview([clarifying('sess-c')]),
      reads: [clarifying('sess-c')],
      writes: { answers: { status: 202, body: session('sess-c', 'gathering') } },
    });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    expect(await screen.findByTestId('advisor-restatement')).toHaveTextContent(
      'You want to know how your emergency fund could grow faster.',
    );
    expect(screen.getByTestId('advisor-assumed')).toHaveTextContent(
      'Assumed: Monthly essentials — $3,100.00',
    );
    const first = screen.getByLabelText('How many months of essentials would you like set aside?');
    const second = screen.getByLabelText('Is there a date in mind?');
    expect(first).toHaveAttribute('maxlength', '300');
    await user.type(first, 'Six months');
    await user.type(second, 'By spring');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() =>
      expect(state.bodies).toEqual([
        { call: 'answers', body: { answers: ['Six months', 'By spring'] } },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByTestId('advisor-session')).toHaveAttribute('data-state', 'gathering'),
    );
  });

  it('with no questions Continue posts an empty list', async () => {
    const user = userEvent.setup();
    const none = clarifying('sess-none', {
      clarification: { restatement: 'Nothing more is needed.', questions: [], assumed: [] },
    });
    const state = api({
      overview: overview([none]),
      reads: [none],
      writes: { answers: { status: 202, body: session('sess-none', 'gathering') } },
    });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    expect(screen.queryByTestId('advisor-answer')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(state.bodies).toEqual([{ call: 'answers', body: { answers: [] } }]));
  });

  it('options render as cards with their gains and costs, and the pick posts the option id', async () => {
    const user = userEvent.setup();
    const picked = session('sess-pick', 'planning', { options: OPTIONS, pickedOption: 'o2' });
    const state = api({
      overview: overview([awaitingPick()]),
      reads: [awaitingPick()],
      writes: { pick: { status: 202, body: picked } },
    });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    const cards = await screen.findAllByTestId('advisor-option');
    expect(cards).toHaveLength(2);
    const first = within(cards[0]!);
    expect(
      first.getByRole('heading', { name: 'Raise the monthly transfer to savings' }),
    ).toBeInTheDocument();
    expect(first.getByTestId('advisor-option-gains')).toHaveTextContent('Gains');
    expect(first.getByTestId('advisor-option-gains')).toHaveTextContent('Fund reaches target in');
    expect(first.getByTestId('advisor-option-gains')).toHaveTextContent('9 months');
    expect(first.getByTestId('advisor-option-costs')).toHaveTextContent('Costs');
    expect(first.getByTestId('advisor-option-costs')).toHaveTextContent('Less left each month');
    expect(first.getByTestId('advisor-option-costs')).toHaveTextContent('$250.00');
    expect(first.getByTestId('advisor-option-note')).toHaveTextContent(
      'Based on the last three months',
    );
    expect(screen.getByTestId('advisor-looked-at-line')).toHaveTextContent(LOOKED_AT_LINE);

    await user.click(within(cards[1]!).getByRole('button', { name: /Pick this option/u }));
    await waitFor(() => expect(state.bodies).toEqual([{ call: 'pick', body: { optionId: 'o2' } }]));
    await waitFor(() =>
      expect(screen.getByTestId('advisor-session')).toHaveAttribute('data-state', 'planning'),
    );
  });

  it('a card is never rendered without a cost: an option with an empty cost list is skipped, and none left says so', async () => {
    const user = userEvent.setup();
    const [first, second] = OPTIONS;
    const mixed = awaitingPick('sess-mixed', {
      options: [{ ...first!, cost: [] }, second!],
      optionsDropped: 1,
    });
    const none = awaitingPick('sess-none', { options: [{ ...first!, cost: [] }] });
    api({ overview: overview([mixed, none]), reads: [mixed] });
    renderScreen();
    const rows = await screen.findAllByTestId('advisor-history-item');
    await user.click(rows[0]!);
    expect(await screen.findAllByTestId('advisor-option')).toHaveLength(1);
    expect(screen.getByTestId('advisor-option')).toHaveAttribute('data-option-id', 'o2');
    for (const costs of screen.getAllByTestId('advisor-option-costs')) {
      expect(within(costs).getAllByRole('term').length).toBeGreaterThan(0);
    }
    expect(screen.getByTestId('advisor-options-dropped')).toHaveTextContent(
      '2 options were left out because they did not pass the checks.',
    );

    await user.click(rows[1]!);
    await waitFor(() => expect(screen.queryByTestId('advisor-option')).not.toBeInTheDocument());
    expect(screen.getByTestId('advisor-no-options')).toHaveTextContent(
      'No option came with its cost',
    );
    expect(screen.queryByRole('button', { name: /Pick this option/u })).not.toBeInTheDocument();
  });

  it('plan steps are an ordered list with an in-app link each; the tracked state links to the Brief', async () => {
    const user = userEvent.setup();
    const done = tracked('sess-t', {
      judge: {
        score: '0.667',
        page: null,
        runId: null,
        error: null,
        criteria: [
          { criterion: 'Each step links to a screen', met: true, reason: 'All three do.' },
          { criterion: 'No step moves money', met: true, reason: 'None does.' },
          { criterion: 'Costs are repeated', met: false, reason: 'One is missing.' },
        ],
      },
      knowledge: { pagesRead: ['emergency-fund'], withheld: [{ key: 'debt', code: 'unreviewed' }] },
      tokens: { used: 5400, budget: 8000, hostedWindowLeft: 7 },
    });
    api({ overview: overview([done]), reads: [done] });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    const plan = await screen.findByTestId('advisor-plan');
    expect(plan.querySelector('ol')).not.toBeNull();
    const steps = within(plan).getAllByTestId('advisor-plan-step');
    expect(steps).toHaveLength(3);
    expect(within(steps[0]!).getByRole('link', { name: 'Goals' })).toHaveAttribute(
      'href',
      '/goals',
    );
    expect(within(steps[1]!).getByRole('link', { name: 'Accounts' })).toHaveAttribute(
      'href',
      '/accounts',
    );
    expect(within(steps[2]!).getByRole('link', { name: 'Plan' })).toHaveAttribute('href', '/plan');

    const trackedBox = screen.getByTestId('advisor-tracked');
    expect(within(trackedBox).getByTestId('advisor-tracked-label')).toHaveTextContent(
      'Emergency fund runway',
    );
    expect(within(trackedBox).getByTestId('advisor-tracked-baseline')).toHaveTextContent(
      'When you picked it: 2.0 months',
    );
    expect(within(trackedBox).getByTestId('advisor-tracked-latest')).toHaveTextContent(
      'Not checked yet',
    );
    expect(within(trackedBox).getByRole('link', { name: 'See it in the Brief' })).toHaveAttribute(
      'href',
      '/brief',
    );

    expect(screen.getByTestId('advisor-judge-line')).toHaveTextContent(
      'Rubric check: 2 of 3 criteria met',
    );
    expect(screen.getByTestId('advisor-withheld')).toHaveTextContent(
      'Playbook pages not yet reviewed were not used: 1',
    );
    expect(screen.getByTestId('advisor-tokens')).toHaveTextContent('Tokens used: 5,400 of 8,000');
    expect(screen.getByTestId('advisor-hosted-left')).toHaveTextContent(
      'Hosted calls left this hour: 7',
    );
    expect(screen.getByTestId('advisor-picked')).toHaveTextContent(
      'Picked option: Raise the monthly transfer to savings',
    );
  });

  it('a tracked figure that has been checked shows the latest and its direction in words', async () => {
    const user = userEvent.setup();
    const base = tracked('sess-t');
    const checked = tracked('sess-t', {
      tracked: {
        ...base.tracked!,
        latest: { text: '2.6 months', asOf: '2026-11-04' },
        direction: 'up',
        checkedAt: '2026-11-04T09:00:00.000Z',
      },
    });
    api({ overview: overview([checked]), reads: [checked] });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    expect(await screen.findByTestId('advisor-tracked-latest')).toHaveTextContent(
      'Latest: 2.6 months',
    );
    expect(screen.getByTestId('advisor-tracked-direction')).toHaveTextContent(
      'Higher than when you picked it',
    );
  });

  it('refused shows the message and the step and class, small', async () => {
    const user = userEvent.setup();
    api({ overview: overview([refused()]), reads: [refused()] });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    expect(await screen.findByTestId('advisor-message')).toHaveTextContent(COST_MISSING_MESSAGE);
    expect(screen.getByTestId('advisor-refusal-class')).toHaveTextContent(
      'Stopped at the trade-offs step: tradeoffs.cost_missing',
    );
    expect(screen.queryByTestId('advisor-option')).not.toBeInTheDocument();
  });

  it('unanswerable shows the message and a real link to the nearest screen', async () => {
    const user = userEvent.setup();
    api({ overview: overview([unanswerable()]), reads: [unanswerable()] });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    expect(await screen.findByTestId('advisor-message')).toHaveTextContent(OUT_OF_SCOPE_MESSAGE);
    expect(screen.queryByTestId('advisor-session-badge')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Investments' })).toHaveAttribute(
      'href',
      '/investments',
    );
  });

  it('failed shows the failure message', async () => {
    const user = userEvent.setup();
    api({ overview: overview([failed()]), reads: [failed()] });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    expect(await screen.findByTestId('advisor-message')).toHaveTextContent(FAILED_MESSAGE);
  });

  it('a refusal that kept its arithmetic shows the figures without prose, open', async () => {
    const user = userEvent.setup();
    const arithmetic = refused('sess-a', {
      fallback: true,
      lookedAt: awaitingPick().lookedAt,
    });
    api({ overview: overview([arithmetic]), reads: [arithmetic] });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    expect(await screen.findByTestId('advisor-arithmetic-heading')).toHaveTextContent(
      'The arithmetic, without the prose',
    );
    expect(screen.getByTestId('advisor-figures')).toHaveTextContent('$6,200.00');
  });

  it('unavailable says why in the api’s words, disables the box and links to Advisor management', async () => {
    const message =
      'The advisor cannot run yet: the payload for advisor.clarify has not been approved.';
    api({
      overview: overview([], {
        availability: {
          state: 'unavailable',
          reason: 'payload_not_approved',
          step: 'clarify',
          message,
        },
        engine: null,
      }),
    });
    renderScreen();
    expect(await screen.findByTestId('advisor-unavailable-message')).toHaveTextContent(message);
    expect(screen.getByLabelText('Your question')).toBeDisabled();
    expect(screen.getByTestId('advisor-submit')).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Advisor management' })).toHaveAttribute(
      'href',
      '/settings/advisors',
    );
    expect(
      screen.queryByRole('link', { name: 'Settings › Language model' }),
    ).not.toBeInTheDocument();
  });

  it('unavailable because no model is set up also points to Settings', async () => {
    api({
      overview: overview([], {
        availability: { state: 'unavailable', reason: 'off', step: null, message: null },
        engine: null,
      }),
    });
    renderScreen();
    expect(await screen.findByRole('link', { name: 'Settings › Language model' })).toHaveAttribute(
      'href',
      '/settings',
    );
    expect(screen.getByTestId('advisor-unavailable-message')).toHaveTextContent(
      'The advisor cannot start a session right now.',
    );
  });

  it('a 409 because another session is going says so and keeps the text', async () => {
    const user = userEvent.setup();
    api({
      overview: overview(),
      start: {
        status: 409,
        body: { status: 409, code: 'insights.advisor_in_flight', title: 'Conflict' },
      },
    });
    renderScreen();
    const box = await screen.findByLabelText('Your question');
    await user.type(box, 'Another question?');
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('advisor-error')).toHaveTextContent(
      'Another session is still being worked on',
    );
    expect(box).toHaveValue('Another question?');
  });

  it('a question over the cap holds the button and says by how much', async () => {
    const user = userEvent.setup();
    const state = api({ overview: overview([], { maxQuestionLength: 20 }) });
    renderScreen();
    const box = await screen.findByLabelText('Your question');
    await user.click(box);
    await user.paste('x'.repeat(26));
    expect(screen.getByTestId('advisor-count')).toHaveTextContent('26 / 20 characters — over by 6');
    expect(screen.getByTestId('advisor-submit')).toHaveAttribute('aria-disabled', 'true');
    await user.keyboard('{Enter}');
    expect(state.bodies).toEqual([]);
  });

  it('history lists the sessions with a word for where each stands and opens one on a click', async () => {
    const user = userEvent.setup();
    api({
      overview: overview([tracked('s1'), refused('s2'), unanswerable('s3')]),
      reads: [tracked('s1')],
    });
    renderScreen();
    const rows = await screen.findAllByTestId('advisor-history-item');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Followed in the Brief');
    expect(rows[1]).toHaveTextContent('Refused');
    expect(rows[2]).toHaveTextContent('Out of scope');
    await user.click(rows[0]!);
    expect(await screen.findByTestId('advisor-session')).toHaveAttribute('data-state', 'tracked');
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
  });

  it('the session badge names the provider and the model it ran on, with the AI-assisted label', async () => {
    const user = userEvent.setup();
    const hosted = awaitingPick('s-h', { engine: HOSTED_ENGINE });
    api({ overview: overview([hosted]), reads: [hosted] });
    renderScreen();
    await user.click(await screen.findByTestId('advisor-history-item'));
    expect(await screen.findByTestId('advisor-session-badge')).toHaveTextContent(
      'Runs on Anthropic claude-sonnet-5-5',
    );
    expect(screen.getByTestId('advisor-ai-label')).toHaveTextContent('AI-assisted wording');
  });

  it('the disclaimer is on every state', async () => {
    const user = userEvent.setup();
    const all = [
      gathering('s-1'),
      clarifying('s-2'),
      awaitingPick('s-3'),
      tracked('s-4'),
      refused('s-5'),
      unanswerable('s-6'),
      failed('s-7'),
    ];
    api({ overview: overview(all), reads: all });
    renderScreen();
    const rows = await screen.findAllByTestId('advisor-history-item');
    expect(screen.getByTestId('advisor-disclaimer')).toHaveTextContent(BRIEF_DISCLAIMER);
    for (const row of rows) {
      await user.click(row);
      await screen.findByTestId('advisor-session');
      expect(screen.getByTestId('advisor-disclaimer')).toHaveTextContent(
        'Not investment, tax, or legal advice.',
      );
    }
  });

  it('shows the disclaimer while the overview is still loading', () => {
    stubFetchRoutes([
      { match: '/api/advisor/sessions', handle: () => new Promise(() => undefined) },
    ]);
    renderScreen();
    return screen
      .findByTestId('advisor-disclaimer')
      .then((node) => expect(node).toHaveTextContent('Not investment, tax, or legal advice.'));
  });
});

describe('WP 11.5e Advisor from a finding', () => {
  beforeEach(() => {
    ensureApiClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('with ?finding= and ?week= it posts once, with the origin and no question, then replaces the URL with ?session=', async () => {
    const started = fromFinding('sess-f');
    const state = api({
      overview: overview(),
      start: { status: 202, body: started },
      reads: [started],
    });
    const router = renderScreen(20, `/advisor?finding=${FINDING_ID}&week=2026-W43`, true);
    await waitFor(() => expect(router.state.location.search).toEqual({ session: 'sess-f' }));
    expect(state.bodies).toEqual([
      { call: 'start', body: { origin: { insightId: FINDING_ID, briefWeek: '2026-W43' } } },
    ]);
    expect(await screen.findByTestId('advisor-origin-line')).toHaveTextContent(
      `About: ${FINDING_TITLE}, from the Brief of week 43 of 2026`,
    );
    // Let any stray second effect land: still one post.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(state.bodies.filter((entry) => entry.call === 'start')).toHaveLength(1);
  });

  it('from an insight card (no week) the origin carries only the finding', async () => {
    const started = fromFinding('sess-f', {
      origin: { ...fromFinding().origin!, briefWeek: null },
    });
    const state = api({
      overview: overview(),
      start: { status: 202, body: started },
      reads: [started],
    });
    renderScreen(20, `/advisor?finding=${FINDING_ID}`);
    expect(await screen.findByTestId('advisor-origin-line')).toHaveTextContent(
      `About: ${FINDING_TITLE}`,
    );
    expect(screen.getByTestId('advisor-origin-line').textContent).not.toContain('Brief of');
    expect(state.bodies).toEqual([{ call: 'start', body: { origin: { insightId: FINDING_ID } } }]);
  });

  it('a week that is not an ISO week is not sent', async () => {
    const state = api({
      overview: overview(),
      start: { status: 202, body: fromFinding('sess-f') },
      reads: [fromFinding('sess-f')],
    });
    renderScreen(20, `/advisor?finding=${FINDING_ID}&week=lastweek`);
    await screen.findByTestId('advisor-origin-line');
    expect(state.bodies).toEqual([{ call: 'start', body: { origin: { insightId: FINDING_ID } } }]);
  });

  it('with ?session= it opens that session and posts nothing', async () => {
    const done = fromFinding('sess-open');
    const state = api({ overview: overview([done]), reads: [done] });
    renderScreen(20, '/advisor?session=sess-open');
    expect(await screen.findByTestId('advisor-session')).toHaveAttribute(
      'data-state',
      'clarifying',
    );
    expect(state.bodies).toEqual([]);
  });

  it('shows the origin header and a line saying what was gathered first, as plain text', async () => {
    const started = fromFinding('sess-f');
    api({ overview: overview([started]), reads: [started] });
    renderScreen(20, '/advisor?session=sess-f');
    const header = await screen.findByTestId('advisor-origin');
    expect(within(header).getByTestId('advisor-origin-line')).toHaveTextContent(
      'About: Your cash covers 2.4 months of spending, from the Brief of week 43 of 2026',
    );
    expect(within(header).getByTestId('advisor-pregathered')).toHaveTextContent(
      "Gathered first: Cash emergency fund and the finding's own figures.",
    );
    expect(within(header).queryByRole('link')).toBeNull();
  });

  it('a session with no origin has no origin header', async () => {
    const plain = clarifying('sess-plain');
    api({ overview: overview([plain]), reads: [plain] });
    renderScreen(20, '/advisor?session=sess-plain');
    await screen.findByTestId('advisor-session');
    expect(screen.queryByTestId('advisor-origin')).toBeNull();
  });

  it.each([
    ['insights.advisor_finding_not_found', 404, 'That finding could not be found'],
    ['insights.advisor_finding_not_supported', 409, 'does not take up this kind of finding'],
    ['insights.advisor_finding_not_granted', 409, 'not been approved for the advisor'],
    ['insights.advisor_brief_unknown', 400, 'That Brief could not be found'],
  ])(
    '%s is said in words, and the URL sheds the finding so a refresh does not retry',
    async (code, status, words) => {
      const state = api({
        overview: overview(),
        start: { status, body: { type: 'about:blank', title: 'x', status, code } },
      });
      const router = renderScreen(20, `/advisor?finding=${FINDING_ID}&week=2026-W43`);
      expect(await screen.findByRole('alert')).toHaveTextContent(words);
      await waitFor(() => expect(router.state.location.search).toEqual({}));
      expect(state.bodies).toHaveLength(1);
    },
  );

  it('a session refused at once by the pre-check (200) is shown as refused', async () => {
    const refusedAtOnce = refused('sess-r', {
      origin: fromFinding().origin!,
      refusal: { step: 'question', class: 'question.instruction', message: 'Refused at once.' },
    });
    api({
      overview: overview(),
      start: { status: 200, body: refusedAtOnce },
      reads: [refusedAtOnce],
    });
    renderScreen(20, `/advisor?finding=${FINDING_ID}`);
    expect(await screen.findByTestId('advisor-message')).toHaveTextContent('Refused at once.');
    expect(screen.getByTestId('advisor-session')).toHaveAttribute('data-state', 'refused');
  });

  it('a completed session reads as reached: the wording, the day it was picked, the target, and the plan no longer followed', async () => {
    const done = completed('sess-done');
    api({ overview: overview([done]), reads: [done] });
    renderScreen(20, '/advisor?session=sess-done');
    const box = await screen.findByTestId('advisor-tracked');
    expect(screen.getByTestId('advisor-session')).toHaveAttribute('data-state', 'completed');
    expect(box).toHaveAttribute('data-completed', 'true');
    expect(within(box).getByTestId('advisor-tracked-wording').textContent).toBe(
      done.tracked!.wording,
    );
    expect(within(box).getByTestId('advisor-tracked-picked')).toHaveTextContent(
      'Picked on 2026-10-28',
    );
    expect(within(box).getByTestId('advisor-tracked-target')).toHaveTextContent(
      'Target: 6.0 months',
    );
    expect(within(box).getByTestId('advisor-tracked-reached')).toHaveTextContent(
      "Reached: the plan's target is met; this plan is no longer followed.",
    );
    expect(within(box).queryByTestId('advisor-tracked-link')).toBeNull();
    expect(screen.getByTestId('advisor-plan')).toBeInTheDocument();
    // Finished: no working note, and nothing to close.
    expect(screen.queryByTestId('advisor-working')).toBeNull();
    expect(screen.queryByTestId('advisor-close')).toBeNull();
    expect(screen.getByTestId('advisor-history')).toHaveTextContent('Target reached');
  });

  it('a followed (tracked) session shows the wording and the day picked, and still links to the Brief', async () => {
    const followed = tracked('sess-t');
    api({ overview: overview([followed]), reads: [followed] });
    renderScreen(20, '/advisor?session=sess-t');
    const box = await screen.findByTestId('advisor-tracked');
    expect(within(box).getByTestId('advisor-tracked-wording')).toHaveTextContent(
      'when you picked this plan on 2026-10-28',
    );
    expect(within(box).getByTestId('advisor-tracked-picked')).toHaveTextContent('Picked on');
    expect(within(box).queryByTestId('advisor-tracked-reached')).toBeNull();
    expect(within(box).getByTestId('advisor-tracked-link')).toBeInTheDocument();
  });
});
