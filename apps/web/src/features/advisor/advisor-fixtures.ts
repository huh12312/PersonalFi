// SPDX-License-Identifier: MIT
/**
 * Advisor fixtures for the unit tests (WP 11.5d): sessions in the api's shapes (`AdvisorSession`), each quoting only
 * figures its own `lookedAt` carries. `e2e/support/mock-advisor.ts` is the same set of bodies for Playwright (e2e
 * never imports from `src/`).
 */
import { BRIEF_DISCLAIMER } from '../brief/disclaimer.ts';
import type { AdvisorOverview, AdvisorSession } from './advisor-words.ts';

export const LOCAL_MODEL = `qwen2.5:7b-instruct-q4_K@sha256:${'3f'.repeat(32)}`;
export const LOCAL_ENGINE = {
  provider: 'ollama',
  providerName: 'Local model',
  model: LOCAL_MODEL,
  egress: 'local',
} satisfies NonNullable<AdvisorSession['engine']>;
export const HOSTED_ENGINE = {
  provider: 'anthropic',
  providerName: 'Anthropic',
  model: 'anthropic:claude-sonnet-5-5',
  egress: 'hosted',
} satisfies NonNullable<AdvisorSession['engine']>;

export const QUESTION = 'How could I build up my emergency fund faster?';

export const LOOKED_AT_LINE = 'I looked at: emergency fund runway, as of 2026-10-28.';

export const LOOKED_AT = {
  line: LOOKED_AT_LINE,
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
} satisfies NonNullable<AdvisorSession['lookedAt']>;

export const CLARIFICATION = {
  restatement: 'You want to know how your emergency fund could grow faster.',
  questions: [
    'How many months of essentials would you like set aside?',
    'Is there a date in mind?',
  ],
  assumed: [
    { about: 'Monthly essentials', valueRef: 'essentials', value: '$3,100.00' },
    { about: 'Cash set aside', valueRef: 'cash', value: '$6,200.00' },
  ],
} satisfies NonNullable<AdvisorSession['clarification']>;

export const OPTIONS = [
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
    note: '',
  },
] satisfies NonNullable<AdvisorSession['options']>;

export const PLAN = [
  { text: 'Review the emergency fund goal.', href: '/goals', label: 'Goals' },
  { text: 'Check which account holds the cash.', href: '/accounts', label: 'Accounts' },
  { text: 'See what the plan assumes.', href: '/plan', label: 'Plan' },
] satisfies NonNullable<AdvisorSession['plan']>;

export function session(
  id: string,
  status: AdvisorSession['status'],
  overrides: Partial<AdvisorSession> = {},
): AdvisorSession {
  return {
    id,
    question: QUESTION,
    status,
    createdAt: '2026-10-28T14:22:00.000Z',
    updatedAt: '2026-10-28T14:22:09.000Z',
    finishedAt: ['tracked', 'completed', 'refused', 'unanswerable', 'failed', 'cancelled'].includes(
      status,
    )
      ? '2026-10-28T14:22:09.000Z'
      : null,
    engine: LOCAL_ENGINE,
    aiAssisted: true,
    disclaimer: BRIEF_DISCLAIMER,
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
    tokens: { used: 1200, budget: 8000, hostedWindowLeft: null },
    ...overrides,
  };
}

export const clarifying = (id = 'sess-clarify', overrides: Partial<AdvisorSession> = {}) =>
  session(id, 'clarifying', { clarification: CLARIFICATION, ...overrides });

export const awaitingPick = (id = 'sess-pick', overrides: Partial<AdvisorSession> = {}) =>
  session(id, 'awaiting_pick', {
    clarification: CLARIFICATION,
    answers: ['Six months', 'By spring'],
    lookedAt: LOOKED_AT,
    options: OPTIONS,
    ...overrides,
  });

export const tracked = (id = 'sess-tracked', overrides: Partial<AdvisorSession> = {}) =>
  session(id, 'tracked', {
    clarification: CLARIFICATION,
    answers: ['Six months', 'By spring'],
    lookedAt: LOOKED_AT,
    options: OPTIONS,
    pickedOption: 'o1',
    plan: PLAN,
    tracked: {
      kind: 'emergency_runway',
      label: 'Emergency fund runway',
      baseline: { text: '2.0 months', asOf: '2026-10-28' },
      latest: null,
      direction: null,
      status: 'following',
      checkedAt: null,
      brief: { outcome: 'out-1', path: '/brief' },
      target: { text: '6.0 months' },
      pickedAt: '2026-10-28',
      reached: false,
      wording:
        'Emergency fund runway was 2.0 months when you picked this plan on 2026-10-28. It has not been checked since.',
    },
    ...overrides,
  });

/** WP 11.5e: the plan's watched figure reached its target; the watcher stopped. */
export const completed = (id = 'sess-completed', overrides: Partial<AdvisorSession> = {}) => {
  const base = tracked(id);
  return {
    ...base,
    status: 'completed',
    finishedAt: '2026-12-02T08:00:00.000Z',
    tracked: {
      ...base.tracked!,
      latest: { text: '6.1 months', asOf: '2026-12-01' },
      direction: 'up',
      status: 'reached',
      reached: true,
      checkedAt: '2026-12-02T08:00:00.000Z',
      wording:
        'Emergency fund runway was 2.0 months when you picked this plan on 2026-10-28. It is 6.1 months now: up since then, and past the 6.0 months target.',
    },
    ...overrides,
  } satisfies AdvisorSession;
};

export const FINDING_ID = '0190c000-0000-7000-8000-0000000000f1';
export const FINDING_TITLE = 'Your cash covers 2.4 months of spending';

/** WP 11.5e: a session opened from a finding in the Brief of 2026-W43, with two calculations gathered first. */
export const fromFinding = (id = 'sess-origin', overrides: Partial<AdvisorSession> = {}) =>
  clarifying(id, {
    question: `What could be done about “${FINDING_TITLE}”?`,
    origin: {
      insightId: FINDING_ID,
      ruleId: 'C4',
      title: FINDING_TITLE,
      briefWeek: '2026-W43',
    },
    pregathered: { seeded: ['cash.emergency_fund'], finding: 'joined' },
    ...overrides,
  });

export const COST_MISSING_MESSAGE =
  'An option came back without its cost, so no options are shown. Nothing was offered.';

export const refused = (id = 'sess-refused', overrides: Partial<AdvisorSession> = {}) =>
  session(id, 'refused', {
    refusal: { step: 'tradeoffs', class: 'tradeoffs.cost_missing', message: COST_MISSING_MESSAGE },
    ...overrides,
  });

export const OUT_OF_SCOPE_MESSAGE =
  'Choosing investments is outside what the advisor covers. It sets out options for your own figures.';

export const unanswerable = (id = 'sess-out', overrides: Partial<AdvisorSession> = {}) =>
  session(id, 'unanswerable', {
    question: 'Which stock should I pick?',
    engine: null,
    unanswerable: {
      reason: 'out_of_scope',
      topic: 'investment_selection',
      message: OUT_OF_SCOPE_MESSAGE,
      nearestScreen: { path: '/investments', label: 'Investments' },
    },
    ...overrides,
  });

export const FAILED_MESSAGE = 'The model did not answer in time. Nothing was shown.';

export const failed = (id = 'sess-failed', overrides: Partial<AdvisorSession> = {}) =>
  session(id, 'failed', {
    failure: { code: 'advisor.timeout', message: FAILED_MESSAGE },
    ...overrides,
  });

export function overview(
  sessions: AdvisorSession[] = [],
  overrides: Partial<AdvisorOverview> = {},
): AdvisorOverview {
  return {
    availability: { state: 'ready', reason: null, step: null, message: null },
    engine: { ...LOCAL_ENGINE, hostedConsented: false, hostedFallback: null },
    disclaimer: BRIEF_DISCLAIMER,
    maxQuestionLength: 500,
    maxAnswerLength: 300,
    tokenBudget: 8000,
    examples: [
      'How could I build up my emergency fund faster?',
      'How should I weigh debt against saving?',
    ],
    sessions,
    ...overrides,
  };
}
