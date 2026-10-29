// SPDX-License-Identifier: MIT
import type { Page, Route } from '@playwright/test';

/**
 * WP 11.5d (the Advisor, advisor mode): `GET`/`POST /api/advisor/sessions`, `GET /api/advisor/sessions/{id}`, its
 * `answers`, `pick` and `cancel` writes, and `GET`/`PUT /api/advisor/settings` (the advisor's own hosted consent),
 * as a layerable mock in the shapes `apps/api/src/routes/advisor-sessions.ts` sends (`AdvisorOverview`,
 * `AdvisorSessionDetail`, `AdvisorSettings`) and with its words.
 *
 * A test scripts what the next `POST /sessions` becomes (`outcome`): `walk` (202 `clarifying`, then the restatement
 * with its two questions on the first read; `answers` -> `gathering` -> `options` -> `tradeoffs` ->
 * `awaiting_pick`, one step per read; `pick` -> `planning` -> `tracked`), `refused` (the same walk, ending refused at
 * the trade-offs step with `tradeoffs.cost_missing`), `unanswerable` (200 at once, no model asked), `in_flight` or
 * `unavailable` (409 problems). `hold` stops a walk at a status for ever (a pending screen to look at). Every call is
 * recorded (`calls`, `bodies`), so "rendering only reads" is checkable. No model is involved anywhere: each option
 * carries its cost and each plan step links to a screen of the app.
 *
 * The settings write needs a fresh session (403 `step_up_required` until the caller's step-up has run), as the api's
 * `requireFreshSession`; a write that gets past it is recorded in `writes`.
 */

export type AdvisorStatus =
  | 'clarifying'
  | 'gathering'
  | 'options'
  | 'tradeoffs'
  | 'awaiting_pick'
  | 'planning'
  | 'tracked'
  | 'completed'
  | 'refused'
  | 'unanswerable'
  | 'failed'
  | 'cancelled';

type Figure = { label: string; text: string };

export interface AdvisorEngineBody {
  provider: 'ollama' | 'openai' | 'openrouter' | 'anthropic';
  providerName: string;
  model: string;
  egress: 'local' | 'hosted';
}

export interface AdvisorSessionBody {
  id: string;
  question: string;
  status: AdvisorStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  engine: AdvisorEngineBody | null;
  aiAssisted: boolean;
  disclaimer: string;
  clarification: {
    restatement: string;
    questions: string[];
    assumed: Array<{ about: string; valueRef: string; value: string }>;
  } | null;
  answers: string[] | null;
  /** WP 11.5e: the finding the session was opened from; `null` for a question the holder typed. */
  origin: { insightId: string; ruleId: string; title: string; briefWeek: string | null } | null;
  /** WP 11.5e: what was gathered before the first question; `null` unless the session has an origin. */
  pregathered: { seeded: string[]; finding: string | null } | null;
  lookedAt: {
    line: string;
    items: Array<{
      function: string;
      label: string;
      status: 'ok' | 'not_available' | 'refused';
      asOf: string | null;
      figures: Figure[];
      screen: { path: string; label: string };
    }>;
  } | null;
  knowledge: { pagesRead: string[]; withheld: Array<{ key: string; code: string }> } | null;
  options: Array<{
    id: string;
    label: string;
    summary: string;
    backing: Figure[];
    benefit: Figure[];
    cost: Figure[];
    note: string;
  }> | null;
  optionsDropped: number;
  pickedOption: string | null;
  plan: Array<{ text: string; href: string; label: string }> | null;
  tracked: {
    kind: string;
    label: string;
    baseline: { text: string; asOf: string | null };
    latest: { text: string; asOf: string | null } | null;
    direction: 'down' | 'up' | 'same' | null;
    status: string;
    checkedAt: string | null;
    brief: { outcome: string; path: string };
    target: { text: string } | null;
    pickedAt: string | null;
    reached: boolean;
    wording: string;
  } | null;
  judge: {
    score: string | null;
    page: string | null;
    criteria: Array<{ criterion: string; met: boolean; reason: string }>;
    runId: string | null;
    error: string | null;
  } | null;
  fallback: boolean;
  refusal: {
    step: 'question' | 'answer' | 'clarify' | 'gather' | 'options' | 'tradeoffs' | 'plan';
    class: string;
    message: string;
  } | null;
  unanswerable: {
    reason: 'out_of_scope' | 'not_computable';
    topic: string | null;
    message: string;
    nearestScreen: { path: string; label: string };
  } | null;
  failure: { code: string; message: string } | null;
  tokens: { used: number; budget: number; hostedWindowLeft: number | null };
}

export interface AdvisorOverviewBody {
  availability: {
    state: 'ready' | 'unavailable';
    reason: string | null;
    step: 'clarify' | 'gather' | 'options' | 'tradeoffs' | 'plan' | 'judge' | null;
    message: string | null;
  };
  engine: (AdvisorEngineBody & { hostedConsented: boolean; hostedFallback: string | null }) | null;
  disclaimer: string;
  maxQuestionLength: number;
  maxAnswerLength: number;
  tokenBudget: number;
  examples: string[];
  sessions: AdvisorSessionBody[];
}

export interface AdvisorSettingsBody {
  consent: { version: string; sha256: string; text: string };
  hostedConsented: boolean;
  hostedConsentedAt: string | null;
  hostedProvider: 'openai' | 'openrouter' | 'anthropic' | null;
}

export type AdvisorOutcome = 'walk' | 'refused' | 'unanswerable' | 'in_flight' | 'unavailable';

export const ADVISOR_LOCAL_MODEL = `qwen2.5:7b-instruct-q4_K@sha256:${'3f'.repeat(32)}`;
export const ADVISOR_LOCAL_BADGE =
  'Runs on Local model qwen2.5:7b-instruct-q4_K@sha256:3f3f3f3f3f3f…';
export const ADVISOR_DISCLAIMER =
  'Educational information generated from your own data. Not investment, tax, or legal advice. ' +
  'Figures are estimates based on assumptions you can review and change. Consider consulting a ' +
  'qualified professional.';

export const ADVISOR_QUESTION = 'How could I build up my emergency fund faster?';
export const ADVISOR_RESTATEMENT = 'You want to know how your emergency fund could grow faster.';
export const ADVISOR_QUESTIONS = [
  'How many months of essentials would you like set aside?',
  'Is there a date in mind?',
];
export const ADVISOR_LOOKED_AT_LINE = 'I looked at: emergency fund runway, as of 2026-10-28.';
export const ADVISOR_COST_MISSING_WORDS =
  'An option came back without its cost, so no options are shown. Nothing was offered.';
export const ADVISOR_OUT_OF_SCOPE_QUESTION = 'Which stock should I pick for my IRA?';
export const ADVISOR_OUT_OF_SCOPE_WORDS =
  'Choosing investments is outside what the advisor covers. It sets out options for your own figures.';
export const ADVISOR_UNAVAILABLE_WORDS =
  'The advisor cannot run yet: the payload for advisor.clarify has not been approved.';
export const ADVISOR_IN_FLIGHT_DETAIL = 'Another session has a step running.';
export const ADVISOR_CONSENT_TEXT =
  'I allow the advisor to send its approved payloads to the hosted provider I choose, for advisor sessions only. Without this tick it runs on the local model.';
export const ADVISOR_CONSENT_SHA = `${'a1'.repeat(32)}`;

/** WP 11.5e: the finding the mock knows (a Brief item's `talkThrough.insightId`) and the words built from it. */
export const ADVISOR_FINDING_ID = '0190c000-0000-7000-8000-0000000000f1';
export const ADVISOR_FINDING_TITLE = 'Your cash covers 2.4 months of spending';
export const ADVISOR_FINDING_QUESTION = `What could be done about “${ADVISOR_FINDING_TITLE}”?`;
export const ADVISOR_FINDING_RULE = 'C4';
export const ADVISOR_FINDING_PREGATHERED =
  "Gathered first: Emergency-fund cover (target 3 months) and the finding's own figures.";
export const ADVISOR_FINDING_LOOKED_AT_LINE =
  'I looked at: your cash cover and emergency-fund cover (target 3 months), as of 2026-10-28.';
export const ADVISOR_TRACKED_WORDING =
  'Emergency fund runway was 2.0 months when you picked this plan on 2026-10-28. It has not been checked since.';
export const ADVISOR_COMPLETED_WORDING =
  'Emergency fund runway was 2.0 months when you picked this plan on 2026-10-28. It is 6.1 months now: up since then, and past the 6.0 months target.';

const NOW = '2026-10-28T14:22:00.000Z';
const DONE = '2026-10-28T14:22:09.000Z';

const LOCAL_ENGINE: AdvisorEngineBody = {
  provider: 'ollama',
  providerName: 'Local model',
  model: ADVISOR_LOCAL_MODEL,
  egress: 'local',
};

const LOOKED_AT: NonNullable<AdvisorSessionBody['lookedAt']> = {
  line: ADVISOR_LOOKED_AT_LINE,
  items: [
    {
      function: 'emergency_runway',
      label: 'Emergency fund runway',
      status: 'ok',
      asOf: '2026-10-28',
      figures: [
        { label: 'Cash set aside', text: '$6,200.00' },
        { label: 'Monthly essentials', text: '$3,100.00' },
        { label: 'Runway', text: '2.0 months' },
      ],
      screen: { path: '/health', label: 'Financial health' },
    },
  ],
};

const CASH_LOOKED_AT: NonNullable<AdvisorSessionBody['lookedAt']> = {
  line: ADVISOR_FINDING_LOOKED_AT_LINE,
  items: [
    {
      function: 'finding',
      label: ADVISOR_FINDING_TITLE,
      status: 'ok',
      asOf: '2026-10-28',
      figures: [
        { label: 'Cash set aside', text: '$6,200.00' },
        { label: 'Cover', text: '2.4 months' },
      ],
      screen: { path: '/health', label: 'Financial health' },
    },
    {
      function: 'cash.emergency_fund',
      label: 'Emergency-fund cover (target 3 months)',
      status: 'ok',
      asOf: '2026-10-28',
      figures: [
        { label: 'Target', text: '3 months' },
        { label: 'Shortfall', text: '0.6 months' },
      ],
      screen: { path: '/health', label: 'Financial health' },
    },
  ],
};

const CLARIFICATION: NonNullable<AdvisorSessionBody['clarification']> = {
  restatement: ADVISOR_RESTATEMENT,
  questions: ADVISOR_QUESTIONS,
  assumed: [
    { about: 'Monthly essentials', valueRef: 'essentials', value: '$3,100.00' },
    { about: 'Cash set aside', valueRef: 'cash', value: '$6,200.00' },
  ],
};

export const ADVISOR_OPTIONS: NonNullable<AdvisorSessionBody['options']> = [
  {
    id: 'o1',
    label: 'Raise the monthly transfer to savings',
    summary: 'Set aside more each month until the fund reaches the target.',
    backing: [{ label: 'Monthly surplus', text: '$450.00' }],
    benefit: [{ label: 'Fund reaches target in', text: '9 months' }],
    cost: [{ label: 'Less left each month', text: '$250.00' }],
    note: 'Based on the last three months of income.',
  },
  {
    id: 'o2',
    label: 'Trim dining and subscriptions',
    summary: 'Redirect part of flexible spending to the fund.',
    backing: [],
    benefit: [{ label: 'Extra per month', text: '$180.00' }],
    cost: [{ label: 'Flexible spending lower by', text: '22%' }],
    note: 'Dining and subscriptions are the two most flexible categories.',
  },
];

export const ADVISOR_PLAN: NonNullable<AdvisorSessionBody['plan']> = [
  { text: 'Review the emergency fund goal.', href: '/goals', label: 'Goals' },
  { text: 'Check which account holds the cash.', href: '/accounts', label: 'Accounts' },
  { text: 'See what the plan assumes.', href: '/plan', label: 'Plan' },
];

function base(
  id: string,
  question: string,
  status: AdvisorStatus,
  createdAt = NOW,
): AdvisorSessionBody {
  const ended = ['tracked', 'completed', 'refused', 'unanswerable', 'failed', 'cancelled'].includes(
    status,
  );
  return {
    id,
    question,
    status,
    createdAt,
    updatedAt: createdAt,
    finishedAt: ended ? DONE : null,
    engine: status === 'unanswerable' ? null : LOCAL_ENGINE,
    aiAssisted: true,
    disclaimer: ADVISOR_DISCLAIMER,
    clarification: null,
    answers: null,
    origin: null,
    pregathered: null,
    lookedAt: null,
    knowledge: null,
    options: null,
    optionsDropped: 0,
    pickedOption: null,
    plan: null,
    tracked: null,
    judge: null,
    fallback: false,
    refusal: null,
    unanswerable: null,
    failure: null,
    tokens: { used: 0, budget: 8000, hostedWindowLeft: null },
  };
}

const ANSWERS = ['Six months', 'By spring'];

export function clarifyingSession(
  id: string,
  question = ADVISOR_QUESTION,
  createdAt = NOW,
): AdvisorSessionBody {
  return {
    ...base(id, question, 'clarifying', createdAt),
    clarification: CLARIFICATION,
    tokens: { used: 640, budget: 8000, hostedWindowLeft: null },
  };
}

export function awaitingPickSession(
  id: string,
  question = ADVISOR_QUESTION,
  createdAt = NOW,
): AdvisorSessionBody {
  return {
    ...base(id, question, 'awaiting_pick', createdAt),
    clarification: CLARIFICATION,
    answers: ANSWERS,
    lookedAt: LOOKED_AT,
    knowledge: {
      pagesRead: ['emergency-fund'],
      withheld: [{ key: 'debt-paydown', code: 'unreviewed' }],
    },
    options: ADVISOR_OPTIONS,
    tokens: { used: 3900, budget: 8000, hostedWindowLeft: null },
  };
}

export function trackedSession(
  id: string,
  question = ADVISOR_QUESTION,
  createdAt = NOW,
): AdvisorSessionBody {
  return {
    ...base(id, question, 'tracked', createdAt),
    clarification: CLARIFICATION,
    answers: ANSWERS,
    lookedAt: LOOKED_AT,
    knowledge: { pagesRead: ['emergency-fund'], withheld: [] },
    options: ADVISOR_OPTIONS,
    pickedOption: 'o1',
    plan: ADVISOR_PLAN,
    tracked: {
      kind: 'emergency_runway',
      label: 'Emergency fund runway',
      baseline: { text: '2.0 months', asOf: '2026-10-28' },
      latest: null,
      direction: null,
      status: 'following',
      checkedAt: null,
      brief: { outcome: 'adv-out-1', path: '/brief' },
      target: { text: '6.0 months' },
      pickedAt: '2026-10-28',
      reached: false,
      wording: ADVISOR_TRACKED_WORDING,
    },
    judge: {
      score: '0.667',
      page: 'emergency-fund',
      criteria: [
        { criterion: 'Each step links to a screen of the app', met: true, reason: 'All three do.' },
        { criterion: 'No step moves money', met: true, reason: 'None does.' },
        { criterion: 'The cost is repeated beside the plan', met: false, reason: 'It is not.' },
      ],
      runId: null,
      error: null,
    },
    tokens: { used: 5400, budget: 8000, hostedWindowLeft: null },
  };
}

/** WP 11.5e: the plan's watched figure reached its target; the watcher stopped. */
export function completedSession(
  id: string,
  question = ADVISOR_QUESTION,
  createdAt = NOW,
): AdvisorSessionBody {
  const followed = trackedSession(id, question, createdAt);
  return {
    ...followed,
    status: 'completed',
    finishedAt: '2026-12-02T08:00:00.000Z',
    tracked: {
      ...followed.tracked!,
      latest: { text: '6.1 months', asOf: '2026-12-01' },
      direction: 'up',
      status: 'reached',
      checkedAt: '2026-12-02T08:00:00.000Z',
      reached: true,
      wording: ADVISOR_COMPLETED_WORDING,
    },
  };
}

/**
 * WP 11.5e: a session opened from a finding, already gathered from (the finding's own figures and the cash cover
 * joined the context before the first question), waiting on the holder's answers.
 */
export function originSession(
  id: string,
  briefWeek: string | null,
  createdAt = NOW,
): AdvisorSessionBody {
  return {
    ...clarifyingSession(id, ADVISOR_FINDING_QUESTION, createdAt),
    origin: {
      insightId: ADVISOR_FINDING_ID,
      ruleId: ADVISOR_FINDING_RULE,
      title: ADVISOR_FINDING_TITLE,
      briefWeek,
    },
    pregathered: { seeded: ['cash.emergency_fund'], finding: 'joined' },
    lookedAt: CASH_LOOKED_AT,
  };
}

export function refusedSession(
  id: string,
  question = ADVISOR_QUESTION,
  createdAt = NOW,
): AdvisorSessionBody {
  return {
    ...base(id, question, 'refused', createdAt),
    clarification: CLARIFICATION,
    answers: ANSWERS,
    lookedAt: LOOKED_AT,
    refusal: {
      step: 'tradeoffs',
      class: 'tradeoffs.cost_missing',
      message: ADVISOR_COST_MISSING_WORDS,
    },
    tokens: { used: 4700, budget: 8000, hostedWindowLeft: null },
  };
}

export function unanswerableSession(
  id: string,
  question = ADVISOR_OUT_OF_SCOPE_QUESTION,
  createdAt = NOW,
): AdvisorSessionBody {
  return {
    ...base(id, question, 'unanswerable', createdAt),
    unanswerable: {
      reason: 'out_of_scope',
      topic: 'investment_selection',
      message: ADVISOR_OUT_OF_SCOPE_WORDS,
      nearestScreen: { path: '/investments', label: 'Investments' },
    },
  };
}

/** The holder's earlier sessions, newest first: one awaiting a pick, one awaiting answers, one followed, one refused, one out of scope. */
export function seededAdvisorHistory(): AdvisorSessionBody[] {
  return [
    awaitingPickSession(
      '0190d000-0000-7000-8000-0000000000b5',
      ADVISOR_QUESTION,
      '2026-10-28T09:00:00.000Z',
    ),
    clarifyingSession(
      '0190d000-0000-7000-8000-0000000000b4',
      'How do I plan for a car in two years?',
      '2026-10-27T18:00:00.000Z',
    ),
    trackedSession(
      '0190d000-0000-7000-8000-0000000000b3',
      ADVISOR_QUESTION,
      '2026-10-26T09:00:00.000Z',
    ),
    refusedSession(
      '0190d000-0000-7000-8000-0000000000b2',
      'How could I pay down debt sooner?',
      '2026-10-25T18:30:00.000Z',
    ),
    unanswerableSession(
      '0190d000-0000-7000-8000-0000000000b1',
      ADVISOR_OUT_OF_SCOPE_QUESTION,
      '2026-10-24T12:05:00.000Z',
    ),
  ];
}

export interface AdvisorMockOptions {
  readonly availability?: AdvisorOverviewBody['availability'];
  readonly engine?: AdvisorOverviewBody['engine'];
  readonly sessions?: AdvisorSessionBody[];
  readonly examples?: string[];
  /** What the next `POST /sessions` becomes. Default `walk`. */
  readonly outcome?: AdvisorOutcome;
  /** Stop a walk at this status for ever (a pending screen to look at). */
  readonly hold?: 'clarifying' | 'gathering' | 'options' | 'tradeoffs' | 'planning';
  /** How many reads stay at each step before the next. Default 1. */
  readonly readsPerStep?: number;
  readonly settings?: Partial<AdvisorSettingsBody>;
  /** WP 11.5e: a `POST` with an `origin` is answered with this problem code (404/409/400) instead of a session. */
  readonly originProblem?: 'not_found' | 'not_supported' | 'not_granted' | 'brief_unknown';
}

type Stage = 'start' | 'answered' | 'picked' | 'cancelled' | 'seed';

interface Walk {
  id: string;
  question: string;
  createdAt: string;
  stage: Stage;
  /** Reads answered since the stage began. */
  reads: number;
  seed: AdvisorSessionBody | null;
  /** WP 11.5e: carried onto every body of a session opened from a finding. */
  origin?: { briefWeek: string | null };
  ending: 'options' | 'refused';
  answers: string[];
  picked: string | null;
}

export interface AdvisorMockState {
  /** `METHOD /path` of every advisor call, in order. */
  readonly calls: string[];
  /** `{ call, body }` of every write (not the settings write). */
  readonly bodies: Array<{ call: string; body: unknown }>;
  options: AdvisorMockOptions;
  readonly walks: Map<string, Walk>;
  /** Sessions created by `POST`, newest first. */
  readonly created: string[];
  sequence: number;
  settings: AdvisorSettingsBody;
  /** Every settings `PUT` body that got past the step-up. */
  readonly writes: Array<Record<string, unknown>>;
  stepUpsAsked: number;
}

export function createAdvisorState(options: AdvisorMockOptions = {}): AdvisorMockState {
  const state: AdvisorMockState = {
    calls: [],
    bodies: [],
    options,
    walks: new Map(),
    created: [],
    sequence: 0,
    settings: {
      consent: { version: '2026-10-v1', sha256: ADVISOR_CONSENT_SHA, text: ADVISOR_CONSENT_TEXT },
      hostedConsented: false,
      hostedConsentedAt: null,
      hostedProvider: null,
      ...options.settings,
    },
    writes: [],
    stepUpsAsked: 0,
  };
  for (const seed of options.sessions ?? seededAdvisorHistory()) {
    state.walks.set(seed.id, {
      id: seed.id,
      question: seed.question,
      createdAt: seed.createdAt,
      stage: 'seed',
      reads: 0,
      seed,
      ending: 'options',
      answers: seed.answers ?? [],
      picked: seed.pickedOption,
    });
  }
  return state;
}

const ANSWER_STEPS = ['gathering', 'options', 'tradeoffs'] as const;

/** The session as it stands now (a read advances the stage's clock, the caller does that). */
function current(state: AdvisorMockState, walk: Walk): AdvisorSessionBody {
  const body = currentBody(state, walk);
  if (walk.origin === undefined || walk.stage === 'seed') return body;
  // WP 11.5e: a session opened from a finding carries it, and what was gathered first, at every step.
  const { origin } = originSession(walk.id, walk.origin.briefWeek);
  return {
    ...body,
    origin,
    pregathered: { seeded: ['cash.emergency_fund'], finding: 'joined' },
    lookedAt: body.lookedAt ?? CASH_LOOKED_AT,
  };
}

function currentBody(state: AdvisorMockState, walk: Walk): AdvisorSessionBody {
  const per = state.options.readsPerStep ?? 1;
  const hold = state.options.hold;
  const at = (steps: readonly string[], endsHold: boolean) => {
    const stepIndex = Math.floor(walk.reads / per);
    const holdIndex = hold === undefined ? Infinity : steps.indexOf(hold);
    return { stepIndex, held: endsHold && holdIndex >= 0 && stepIndex >= holdIndex, holdIndex };
  };
  if (walk.stage === 'seed') return walk.seed!;
  if (walk.stage === 'cancelled') {
    return { ...base(walk.id, walk.question, 'cancelled', walk.createdAt) };
  }
  if (walk.stage === 'start') {
    const held = hold === 'clarifying';
    return walk.reads === 0 || held
      ? base(walk.id, walk.question, 'clarifying', walk.createdAt)
      : clarifyingSession(walk.id, walk.question, walk.createdAt);
  }
  if (walk.stage === 'answered') {
    const { stepIndex, held, holdIndex } = at(ANSWER_STEPS, true);
    if (held) {
      return {
        ...base(walk.id, walk.question, ANSWER_STEPS[holdIndex]!, walk.createdAt),
        clarification: CLARIFICATION,
        answers: walk.answers,
      };
    }
    if (stepIndex < ANSWER_STEPS.length) {
      return {
        ...base(walk.id, walk.question, ANSWER_STEPS[stepIndex]!, walk.createdAt),
        clarification: CLARIFICATION,
        answers: walk.answers,
        ...(stepIndex >= 1 ? { lookedAt: LOOKED_AT } : {}),
      };
    }
    const final =
      walk.ending === 'refused'
        ? refusedSession(walk.id, walk.question, walk.createdAt)
        : awaitingPickSession(walk.id, walk.question, walk.createdAt);
    return { ...final, answers: walk.answers };
  }
  // picked
  const held = hold === 'planning';
  if (walk.reads < per || held) {
    return {
      ...awaitingPickSession(walk.id, walk.question, walk.createdAt),
      status: 'planning',
      pickedOption: walk.picked,
      answers: walk.answers,
    };
  }
  return { ...trackedSession(walk.id, walk.question, walk.createdAt), pickedOption: walk.picked };
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

function detail(session: AdvisorSessionBody) {
  return { ...session, inspector: { contextDigest: null, steps: [] } };
}

const STEP_UP = {
  type: 'about:blank',
  title: 'Forbidden',
  status: 403,
  code: 'step_up_required',
};

/** Answers an advisor path; `false` for any other path (the caller falls back). */
export async function handleAdvisor(
  route: Route,
  path: string,
  method: string,
  state: AdvisorMockState,
  isFresh: () => boolean,
): Promise<boolean> {
  const options = state.options;

  if (path === '/api/advisor/settings') {
    if (method === 'GET') {
      state.calls.push(`${method} ${path}`);
      await json(route, 200, state.settings);
      return true;
    }
    if (method === 'PUT') {
      state.calls.push(`${method} ${path}`);
      if (!isFresh()) {
        state.stepUpsAsked += 1;
        await json(route, 403, STEP_UP);
        return true;
      }
      const body = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      state.writes.push(body);
      if (typeof body['hostedConsent'] === 'boolean') {
        state.settings = {
          ...state.settings,
          hostedConsented: body['hostedConsent'],
          hostedConsentedAt: body['hostedConsent'] ? NOW : null,
        };
      }
      if ('hostedProvider' in body) {
        state.settings = {
          ...state.settings,
          hostedProvider: body['hostedProvider'] as AdvisorSettingsBody['hostedProvider'],
        };
      }
      await json(route, 200, state.settings);
      return true;
    }
    return false;
  }

  const one = /^\/api\/advisor\/sessions\/([^/]+)(?:\/(answers|pick|cancel))?$/u.exec(path);
  if (path !== '/api/advisor/sessions' && one === null) return false;
  if (method !== 'GET' && method !== 'POST') return false;
  state.calls.push(`${method} ${path}`);

  if (one !== null) {
    const id = one[1]!;
    const verb = one[2];
    const walk = state.walks.get(id);
    if (walk === undefined) {
      const p = problem(404, 'insights.advisor_session_not_found', 'Not Found');
      await json(route, p.status, p.body);
      return true;
    }
    if (verb === undefined && method === 'GET') {
      const body = current(state, walk);
      walk.reads += 1;
      await json(route, 200, detail(body));
      return true;
    }
    if (verb === undefined || method !== 'POST') return false;
    const raw = route.request().postData();
    const sent = raw === null || raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
    state.bodies.push({ call: verb, body: raw === null || raw === '' ? null : sent });
    const now = current(state, walk);
    if (verb === 'cancel') {
      walk.stage = 'cancelled';
      await json(route, 200, detail(current(state, walk)));
      return true;
    }
    if (verb === 'answers') {
      if (now.status !== 'clarifying' || now.clarification === null) {
        const p = problem(
          409,
          'insights.advisor_not_awaiting_answers',
          'Conflict',
          `session is ${now.status}`,
        );
        await json(route, p.status, p.body);
        return true;
      }
      walk.stage = 'answered';
      walk.reads = 0;
      walk.answers = (sent['answers'] as string[] | undefined) ?? [];
      await json(route, 202, detail(current(state, walk)));
      return true;
    }
    // pick
    if (now.status !== 'awaiting_pick') {
      const p = problem(
        409,
        'insights.advisor_not_awaiting_pick',
        'Conflict',
        `session is ${now.status}`,
      );
      await json(route, p.status, p.body);
      return true;
    }
    walk.stage = 'picked';
    walk.reads = 0;
    walk.picked = String(sent['optionId']);
    walk.answers = now.answers ?? walk.answers;
    await json(route, 202, detail(current(state, walk)));
    return true;
  }

  if (method === 'GET') {
    const created = state.created.map((id) => current(state, state.walks.get(id)!));
    const seeded = (options.sessions ?? seededAdvisorHistory()).map((s) =>
      current(state, state.walks.get(s.id)!),
    );
    const body: AdvisorOverviewBody = {
      availability: options.availability ?? {
        state: 'ready',
        reason: null,
        step: null,
        message: null,
      },
      engine:
        options.engine === undefined
          ? { ...LOCAL_ENGINE, hostedConsented: false, hostedFallback: null }
          : options.engine,
      disclaimer: ADVISOR_DISCLAIMER,
      maxQuestionLength: 500,
      maxAnswerLength: 300,
      tokenBudget: 8000,
      examples: options.examples ?? [
        'How could I build up my emergency fund faster?',
        'How should I weigh paying down debt against saving?',
        'What would it take to cover six months of expenses?',
      ],
      sessions: [...created, ...seeded],
    };
    await json(route, 200, body);
    return true;
  }

  // POST /api/advisor/sessions
  const sent = JSON.parse(route.request().postData() ?? '{}') as {
    question?: string;
    origin?: { insightId: string; briefWeek?: string };
  };
  state.bodies.push({ call: 'start', body: sent });
  const holdsQuestion = typeof sent.question === 'string' && sent.question !== '';
  if (holdsQuestion === (sent.origin !== undefined)) {
    const p = problem(400, 'insights.advisor_question_or_origin', 'Bad Request');
    await json(route, p.status, p.body);
    return true;
  }
  const outcome = options.outcome ?? 'walk';
  if (sent.origin !== undefined) {
    const code = {
      not_found: [404, 'insights.advisor_finding_not_found'],
      not_supported: [409, 'insights.advisor_finding_not_supported'],
      not_granted: [409, 'insights.advisor_finding_not_granted'],
      brief_unknown: [400, 'insights.advisor_brief_unknown'],
    } as const;
    const scripted = options.originProblem === undefined ? null : code[options.originProblem];
    const unknown = sent.origin.insightId !== ADVISOR_FINDING_ID;
    const [status, problemCode] = scripted ?? (unknown ? code.not_found : [0, '']);
    if (status !== 0) {
      const p = problem(status, problemCode, 'Problem');
      await json(route, p.status, p.body);
      return true;
    }
  }
  const question = sent.origin === undefined ? (sent.question ?? '') : ADVISOR_FINDING_QUESTION;
  if (outcome === 'unavailable') {
    const p = problem(409, 'insights.advisor_unavailable', 'Conflict', ADVISOR_UNAVAILABLE_WORDS);
    await json(route, p.status, p.body);
    return true;
  }
  if (outcome === 'in_flight') {
    const p = problem(409, 'insights.advisor_in_flight', 'Conflict', ADVISOR_IN_FLIGHT_DETAIL);
    await json(route, p.status, p.body);
    return true;
  }
  state.sequence += 1;
  const id = `0190d000-0000-7000-8000-${String(state.sequence).padStart(12, '0')}`;
  state.created.unshift(id);
  if (outcome === 'unanswerable') {
    const session = unanswerableSession(id, question);
    state.walks.set(id, {
      id,
      question,
      createdAt: NOW,
      stage: 'seed',
      reads: 0,
      seed: session,
      ending: 'options',
      answers: [],
      picked: null,
    });
    await json(route, 200, detail(session));
    return true;
  }
  state.walks.set(id, {
    id,
    question,
    createdAt: NOW,
    stage: 'start',
    reads: 0,
    seed: null,
    ...(sent.origin === undefined ? {} : { origin: { briefWeek: sent.origin.briefWeek ?? null } }),
    ending: outcome === 'refused' ? 'refused' : 'options',
    answers: [],
    picked: null,
  });
  await json(route, 202, detail(current(state, state.walks.get(id)!)));
  return true;
}

/** The layer on its own (`installAdvisorMocks` and `installSweepMocks` install it for every screen). */
export async function installAdvisorSessionMocks(
  page: Page,
  isFresh: () => boolean,
  state: AdvisorMockState = createAdvisorState(),
): Promise<AdvisorMockState> {
  await page.route('**/api/advisor/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (await handleAdvisor(route, path, request.method(), state, isFresh)) return;
    return route.fallback();
  });
  return state;
}
