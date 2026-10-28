// SPDX-License-Identifier: MIT
/**
 * Ask PersonalFi fixtures for the unit tests (WP 11.5c): sessions in the api's shapes
 * (`apps/api/src/routes/ask.ts`, `AskSession`), each quoting only figures its own `lookedAt` carries.
 * `e2e/support/mock-ask.ts` is the same set of bodies for Playwright (e2e never imports from `src/`).
 */
import type { AskOverview, AskSession } from './ask-words.ts';

export const LOCAL_MODEL = `qwen2.5:7b-instruct-q4_K@sha256:${'3f'.repeat(32)}`;

export const LOOKED_AT_LINE = 'I looked at: contribution room (2026, IRA), as of 2026-10-28.';

export const LOOKED_AT = {
  line: LOOKED_AT_LINE,
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
} satisfies NonNullable<AskSession['lookedAt']>;

export const ANSWER_TEXT =
  'You have $2,500.00 of IRA contribution room left for 2026: the limit is $7,000.00 and $4,500.00 is already in.';

export function session(
  id: string,
  status: AskSession['status'],
  overrides: Partial<AskSession> = {},
): AskSession {
  return {
    id,
    question: 'How much IRA contribution room is left?',
    status,
    createdAt: '2026-10-28T14:22:00.000Z',
    finishedAt: ['compiling', 'running', 'narrating'].includes(status)
      ? null
      : '2026-10-28T14:22:09.000Z',
    answer: null,
    lookedAt: null,
    fallback: false,
    refusal: null,
    unanswerable: null,
    failure: null,
    ...overrides,
  };
}

export function shownSession(id = 'sess-shown', overrides: Partial<AskSession> = {}): AskSession {
  return session(id, 'shown', {
    answer: {
      text: ANSWER_TEXT,
      provider: 'ollama',
      providerName: 'Local model',
      model: LOCAL_MODEL,
      aiAssisted: true,
    },
    lookedAt: LOOKED_AT,
    ...overrides,
  });
}

export const NARRATE_REFUSED_MESSAGE =
  "The draft didn't pass the checks; here is the arithmetic without the prose.";

export function refusedSession(
  id = 'sess-refused',
  overrides: Partial<AskSession> = {},
): AskSession {
  return session(id, 'refused', {
    lookedAt: LOOKED_AT,
    fallback: true,
    refusal: { step: 'narrate', class: 'narrate.numeral', message: NARRATE_REFUSED_MESSAGE },
    ...overrides,
  });
}

export function unanswerableSession(
  id = 'sess-out',
  overrides: Partial<AskSession> = {},
): AskSession {
  return session(id, 'unanswerable', {
    question: 'Which stock should I buy?',
    unanswerable: {
      reason: 'out_of_scope',
      topic: 'investment_selection',
      message:
        'Choosing investments is outside what Ask PersonalFi answers. It reports on your own figures.',
      nearestScreen: { path: '/investments', label: 'Investments' },
    },
    ...overrides,
  });
}

export function overview(
  sessions: AskSession[] = [],
  overrides: Partial<AskOverview> = {},
): AskOverview {
  return {
    availability: { state: 'ready', reason: null, step: null, message: null },
    maxQuestionLength: 500,
    maxAnswerLength: 900,
    examples: ['How much IRA contribution room is left?', 'What did I spend on dining last month?'],
    sessions,
    ...overrides,
  };
}
