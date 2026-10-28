// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 11.5c (Ask PersonalFi, reporting mode): `GET`/`POST /api/ask` and `GET /api/ask/{sessionId}`, as a layerable
 * mock in the shapes `apps/api/src/routes/ask.ts` sends (`AskOverview`, `AskSession`) and with its words.
 *
 * A test scripts what the next `POST` becomes (`outcome`): `shown` (202, then `compiling` -> `running` ->
 * `narrating` -> the answer, one step per read), `refused` (the same walk, ending refused at the narrate step with
 * the arithmetic as the fallback), `unanswerable` (200 at once, no model asked), `in_flight` or `unavailable` (409
 * problems). `hold` stops a walk at a status for ever (a pending screen to look at). Every call is recorded
 * (`calls`, `bodies`), so "rendering only reads" is checkable. No model is involved anywhere: each answer quotes
 * only figures its own `lookedAt` carries.
 */

export type AskStatus =
  | 'compiling'
  | 'running'
  | 'narrating'
  | 'shown'
  | 'refused'
  | 'unanswerable'
  | 'failed'
  | 'cancelled';

export interface AskSessionBody {
  id: string;
  question: string;
  status: AskStatus;
  createdAt: string;
  finishedAt: string | null;
  answer: {
    text: string;
    provider: 'ollama' | 'openai' | 'openrouter' | 'anthropic';
    providerName: string;
    model: string;
    aiAssisted: true;
  } | null;
  lookedAt: {
    line: string;
    items: Array<{
      function: string;
      label: string;
      status: 'ok' | 'not_available' | 'refused';
      asOf: string | null;
      figures: Array<{ label: string; text: string }>;
      note: string | null;
      screen: { path: string; label: string };
    }>;
  } | null;
  fallback: boolean;
  refusal: { step: 'question' | 'compile' | 'narrate'; class: string; message: string } | null;
  unanswerable: {
    reason: 'out_of_scope' | 'not_computable';
    topic: string | null;
    message: string;
    nearestScreen: { path: string; label: string };
  } | null;
  failure: { code: string; message: string } | null;
}

export interface AskOverviewBody {
  availability: {
    state: 'ready' | 'unavailable';
    reason: string | null;
    step: 'compile' | 'narrate' | null;
    message: string | null;
  };
  maxQuestionLength: number;
  maxAnswerLength: number;
  examples: string[];
  sessions: AskSessionBody[];
}

export type AskOutcome = 'shown' | 'refused' | 'unanswerable' | 'in_flight' | 'unavailable';

export const ASK_LOCAL_MODEL = `qwen2.5:7b-instruct-q4_K@sha256:${'3f'.repeat(32)}`;
export const ASK_LOCAL_BADGE =
  'Answered by the local model qwen2.5:7b-instruct-q4_K@sha256:3f3f3f3f3f3f…';

export const ASK_QUESTION = 'How much IRA contribution room is left this year?';
export const ASK_ANSWER =
  'You have $2,500.00 of IRA contribution room left for 2026: the limit is $7,000.00 and $4,500.00 is already in.';
export const ASK_LOOKED_AT_LINE = 'I looked at: contribution room (2026, IRA), as of 2026-10-28.';
export const ASK_REFUSED_WORDS =
  "The draft didn't pass the checks; here is the arithmetic without the prose.";
export const ASK_OUT_OF_SCOPE_QUESTION = 'Which stock should I pick for my IRA?';
export const ASK_OUT_OF_SCOPE_WORDS =
  'Choosing investments is outside what Ask PersonalFi answers; it reports on your own figures.';
export const ASK_UNAVAILABLE_WORDS =
  'Ask PersonalFi cannot run yet: the payload for ask.compile has not been approved.';
export const ASK_IN_FLIGHT_DETAIL = 'A question is already being worked on.';

const LOOKED_AT: NonNullable<AskSessionBody['lookedAt']> = {
  line: ASK_LOOKED_AT_LINE,
  items: [
    {
      function: 'contribution_room',
      label: 'Contribution room (2026, IRA)',
      status: 'ok',
      asOf: '2026-10-28',
      figures: [
        { label: 'Annual limit', text: '$7,000.00' },
        { label: 'Contributed so far', text: '$4,500.00' },
        { label: 'Room left', text: '$2,500.00' },
      ],
      note: 'Counts contributions dated in calendar year 2026.',
      screen: { path: '/accounts', label: 'Accounts' },
    },
  ],
};

const NOW = '2026-10-28T14:22:00.000Z';
const DONE = '2026-10-28T14:22:09.000Z';

function base(id: string, question: string, status: AskStatus, createdAt = NOW): AskSessionBody {
  const going = status === 'compiling' || status === 'running' || status === 'narrating';
  return {
    id,
    question,
    status,
    createdAt,
    finishedAt: going ? null : DONE,
    answer: null,
    lookedAt: null,
    fallback: false,
    refusal: null,
    unanswerable: null,
    failure: null,
  };
}

export function shownSession(id: string, question = ASK_QUESTION, createdAt = NOW): AskSessionBody {
  return {
    ...base(id, question, 'shown', createdAt),
    answer: {
      text: ASK_ANSWER,
      provider: 'ollama',
      providerName: 'Local model',
      model: ASK_LOCAL_MODEL,
      aiAssisted: true,
    },
    lookedAt: LOOKED_AT,
  };
}

export function refusedSession(
  id: string,
  question = ASK_QUESTION,
  createdAt = NOW,
): AskSessionBody {
  return {
    ...base(id, question, 'refused', createdAt),
    lookedAt: LOOKED_AT,
    fallback: true,
    refusal: { step: 'narrate', class: 'narrate.numeral', message: ASK_REFUSED_WORDS },
  };
}

export function unanswerableSession(
  id: string,
  question = ASK_OUT_OF_SCOPE_QUESTION,
  createdAt = NOW,
): AskSessionBody {
  return {
    ...base(id, question, 'unanswerable', createdAt),
    unanswerable: {
      reason: 'out_of_scope',
      topic: 'investment_selection',
      message: ASK_OUT_OF_SCOPE_WORDS,
      nearestScreen: { path: '/investments', label: 'Investments' },
    },
  };
}

/** The holder's earlier questions, newest first: one answered, one refused, one out of scope. */
export function seededHistory(): AskSessionBody[] {
  return [
    shownSession('0190c000-0000-7000-8000-0000000000a3', ASK_QUESTION, '2026-10-27T09:00:00.000Z'),
    refusedSession(
      '0190c000-0000-7000-8000-0000000000a2',
      'How much room do I have in my IRA?',
      '2026-10-26T18:30:00.000Z',
    ),
    unanswerableSession(
      '0190c000-0000-7000-8000-0000000000a1',
      ASK_OUT_OF_SCOPE_QUESTION,
      '2026-10-25T12:05:00.000Z',
    ),
  ];
}

export interface AskMockOptions {
  readonly availability?: AskOverviewBody['availability'];
  readonly sessions?: AskSessionBody[];
  readonly examples?: string[];
  /** What the next `POST` becomes. Default `shown`. */
  readonly outcome?: AskOutcome;
  /** Stop a walk at this status for ever (a pending screen to look at). */
  readonly hold?: 'compiling' | 'running' | 'narrating';
  /** How many reads stay at each step before the next. Default 1. */
  readonly readsPerStep?: number;
}

interface Walk {
  final: AskSessionBody;
  /** Reads answered so far. */
  reads: number;
}

export interface AskMockState {
  /** `METHOD /path` of every ask call, in order. */
  readonly calls: string[];
  /** Every `POST` body. */
  readonly bodies: unknown[];
  options: AskMockOptions;
  /** Sessions created by `POST`, newest first. */
  readonly walks: Map<string, Walk>;
  readonly created: string[];
  sequence: number;
}

export function createAskState(options: AskMockOptions = {}): AskMockState {
  return { calls: [], bodies: [], options, walks: new Map(), created: [], sequence: 0 };
}

const STEPS = ['compiling', 'running', 'narrating'] as const;

/** The session as it stands after `walk.reads` reads. */
function current(state: AskMockState, walk: Walk): AskSessionBody {
  const per = state.options.readsPerStep ?? 1;
  const hold = state.options.hold;
  const stepIndex = Math.floor(walk.reads / per);
  const holdIndex = hold === undefined ? Infinity : STEPS.indexOf(hold);
  if (stepIndex >= STEPS.length && holdIndex === Infinity) return walk.final;
  const index = Math.min(stepIndex, holdIndex, STEPS.length - 1);
  return base(walk.final.id, walk.final.question, STEPS[index]!, walk.final.createdAt);
}

function problem(status: number, code: string, title: string, detail?: string) {
  return {
    status,
    body: { type: 'about:blank', title, status, code, ...(detail === undefined ? {} : { detail }) },
  };
}

function json(route: Route, status: number, body: unknown): Promise<void> {
  return route.fulfill({
    status,
    contentType: status >= 400 ? 'application/problem+json' : 'application/json',
    body: JSON.stringify(body),
  });
}

/** Answers an ask path; `false` for any other path (the caller falls back). */
export async function handleAsk(
  route: Route,
  path: string,
  method: string,
  state: AskMockState,
): Promise<boolean> {
  const one = /^\/api\/ask\/([^/]+)$/.exec(path);
  if (path !== '/api/ask' && one === null) return false;
  if (method !== 'GET' && method !== 'POST') return false;
  state.calls.push(`${method} ${path}`);
  const options = state.options;

  if (one !== null && method === 'GET') {
    const id = one[1]!;
    const walk = state.walks.get(id);
    if (walk !== undefined) {
      const body = current(state, walk);
      walk.reads += 1;
      await json(route, 200, body);
      return true;
    }
    const seeded = (options.sessions ?? seededHistory()).find((s) => s.id === id);
    if (seeded !== undefined) await json(route, 200, seeded);
    else {
      const p = problem(404, 'insights.ask_not_found', 'Not Found');
      await json(route, p.status, p.body);
    }
    return true;
  }

  if (path === '/api/ask' && method === 'GET') {
    const created = state.created.map((id) => {
      const walk = state.walks.get(id)!;
      return walk.reads === 0
        ? base(id, walk.final.question, 'compiling', walk.final.createdAt)
        : current(state, walk);
    });
    const body: AskOverviewBody = {
      availability: options.availability ?? {
        state: 'ready',
        reason: null,
        step: null,
        message: null,
      },
      maxQuestionLength: 500,
      maxAnswerLength: 900,
      examples: options.examples ?? [
        'How much IRA contribution room is left this year?',
        'What did I spend on dining last month?',
        'How long would my emergency fund last?',
      ],
      sessions: [...created, ...(options.sessions ?? seededHistory())],
    };
    await json(route, 200, body);
    return true;
  }

  // POST /api/ask
  const sent = JSON.parse(route.request().postData() ?? '{}') as { question?: string };
  state.bodies.push(sent);
  const question = sent.question ?? '';
  const outcome = options.outcome ?? 'shown';
  if (outcome === 'unavailable') {
    const p = problem(409, 'insights.ask_unavailable', 'Conflict', ASK_UNAVAILABLE_WORDS);
    await json(route, p.status, p.body);
    return true;
  }
  if (outcome === 'in_flight') {
    const p = problem(409, 'insights.ask_in_flight', 'Conflict', ASK_IN_FLIGHT_DETAIL);
    await json(route, p.status, p.body);
    return true;
  }
  state.sequence += 1;
  const id = `0190c000-0000-7000-8000-${String(state.sequence).padStart(12, '0')}`;
  if (outcome === 'unanswerable') {
    const session = unanswerableSession(id, question);
    state.walks.set(id, { final: session, reads: 99 });
    state.created.unshift(id);
    await json(route, 200, session);
    return true;
  }
  const final = outcome === 'refused' ? refusedSession(id, question) : shownSession(id, question);
  state.walks.set(id, { final, reads: 0 });
  state.created.unshift(id);
  await json(route, 202, base(id, question, 'compiling'));
  return true;
}

/** The layer on its own (`installSweepMocks` installs it for every screen). */
export async function installAskMocks(
  page: Page,
  options: AskMockOptions = {},
): Promise<AskMockState> {
  const state = createAskState(options);
  await page.route('**/api/ask**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (await handleAsk(route, path, request.method(), state)) return;
    return route.fallback();
  });
  return state;
}
