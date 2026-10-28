// SPDX-License-Identifier: MIT
/**
 * Ask PersonalFi (WP 11.5c), in words. Pure functions over the `AskSession` shape, so every sentence the screen
 * can say is tested without rendering, and no state is carried by colour alone.
 */
import { format } from 'date-fns';

import type { AskOverview, AskSession } from '../../api/generated/types.gen.ts';
import { BRIEF_DISCLAIMER } from '../brief/disclaimer.ts';
import { explanationModelText } from '../insights/ExplainThis.tsx';

export type { AskOverview, AskSession };
export type AskStatus = AskSession['status'];
export type AskAnswer = NonNullable<AskSession['answer']>;
export type AskLookedAt = NonNullable<AskSession['lookedAt']>;
export type AskLookedAtItem = AskLookedAt['items'][number];

/** The standing disclaimer (07 §7.2) on every advisory surface: the same constant the Brief quotes. */
export const ASK_DISCLAIMER = BRIEF_DISCLAIMER;

/** How often `GET /ask/{id}` is read while the worker is going. */
export const ASK_POLL_MS = 1_500;

/** The statuses that mean the worker has not finished. */
export function isInFlight(status: AskStatus): boolean {
  return status === 'compiling' || status === 'running' || status === 'narrating';
}

/** What the polite live region says while a question is going. */
export function stepWords(status: AskStatus): string {
  switch (status) {
    case 'compiling':
      return 'Turning your question into calculations…';
    case 'running':
      return 'Running the calculations…';
    case 'narrating':
      return 'Writing the answer…';
    default:
      return '';
  }
}

/** What the live region says once a question is done (read by screen readers, not drawn). */
export function outcomeWords(status: AskStatus): string {
  switch (status) {
    case 'shown':
      return 'The answer is ready.';
    case 'refused':
      return 'The question was refused.';
    case 'unanswerable':
      return 'This question is outside what can be answered.';
    case 'failed':
      return 'The question failed.';
    case 'cancelled':
      return 'The question was cancelled.';
    default:
      return '';
  }
}

/** The status in a word or two, for the history list. */
export function statusWords(status: AskStatus): string {
  switch (status) {
    case 'compiling':
      return 'Starting';
    case 'running':
      return 'Running the calculations';
    case 'narrating':
      return 'Writing the answer';
    case 'shown':
      return 'Answered';
    case 'refused':
      return 'Refused';
    case 'unanswerable':
      return 'Out of scope';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return String(status);
  }
}

/** "29 Oct 2026, 14:22", in the holder's own time zone. */
export function formatAskTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format(date, 'd MMM yyyy, HH:mm');
}

/**
 * The badge's words (07 §7.5 rule 3): who wrote the answer's wording - "Answered by the local model
 * qwen2.5:7b-instruct-q4_K_M@sha256:3f3f3f3f3f3f…", "Answered by Anthropic claude-sonnet-5-5". It always names the
 * provider and the model.
 */
export function answeredByLabel(
  answer: Pick<AskAnswer, 'provider' | 'providerName' | 'model'>,
): string {
  const model = explanationModelText(answer.provider, answer.model);
  if (answer.provider === 'ollama') return `Answered by the local model ${model}`;
  return `Answered by ${answer.providerName} ${model}`;
}

/** Said when a refusal at the narrate step carries no message of its own (the api always sends one). */
export const NARRATE_REFUSED_WORDS =
  "The draft didn't pass the checks; here is the arithmetic without the prose.";
/** Said when a refusal or failure carries no message of its own. */
export const REFUSED_FALLBACK_WORDS = 'This question was not answered.';
export const FAILED_FALLBACK_WORDS = 'The question could not be answered right now.';
/** Said when `unavailable` carries no message of its own. */
export const UNAVAILABLE_FALLBACK_WORDS = 'Questions cannot be asked right now.';
/** Said when a `POST` itself fails (no session came back to say why). */
export const REQUEST_FAILED_WORDS = 'The question could not be sent. Nothing was asked of a model.';
export const IN_FLIGHT_WORDS =
  'A question is already being worked on; its answer will show here when it is done.';
export const EMPTY_QUESTION_WORDS = 'The question is empty.';

/** The reasons that mean no language model is set up at all: Settings › Language model is the way out. */
export const NO_MODEL_REASONS: ReadonlySet<string> = new Set(['off', 'not_configured']);

/** The screens a `screen.path` may name: the app's own routes, so a link can never leave the app. */
const KNOWN_SCREENS: ReadonlySet<string> = new Set([
  '/',
  '/reports',
  '/cash-flow',
  '/budget',
  '/transactions',
  '/recurring',
  '/accounts',
  '/investments',
  '/plan',
  '/goals',
  '/health',
  '/brief',
  '/insights',
  '/inbox',
  '/ask',
]);

export function isKnownScreen(path: string): boolean {
  return KNOWN_SCREENS.has(path);
}
