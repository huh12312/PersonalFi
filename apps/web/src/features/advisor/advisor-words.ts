// SPDX-License-Identifier: MIT
/**
 * The Advisor (WP 11.5d), in words. Pure functions over the `AdvisorSession` shape, so every sentence the screen can
 * say is tested without rendering, and no state is carried by colour alone. Copy follows 07 section 7.2: the
 * advisor sets out options with their costs and never tells the holder what to do.
 */
import { format } from 'date-fns';

import type {
  AdvisorOverview,
  AdvisorSession,
  AdvisorSettings,
} from '../../api/generated/types.gen.ts';
import { BRIEF_DISCLAIMER } from '../brief/disclaimer.ts';
import { explanationModelText } from '../insights/ExplainThis.tsx';

export type { AdvisorOverview, AdvisorSession, AdvisorSettings };
export type AdvisorStatus = AdvisorSession['status'];
export type AdvisorEngine = NonNullable<AdvisorSession['engine']>;
export type AdvisorOption = NonNullable<AdvisorSession['options']>[number];
export type AdvisorLookedAt = NonNullable<AdvisorSession['lookedAt']>;
export type AdvisorLookedAtItem = AdvisorLookedAt['items'][number];
export type AdvisorPlanStep = NonNullable<AdvisorSession['plan']>[number];
export type AdvisorJudge = NonNullable<AdvisorSession['judge']>;

/** The standing disclaimer (07 section 7.2): the same constant the Brief and Ask quote. */
export const ADVISOR_DISCLAIMER = BRIEF_DISCLAIMER;

/** How often `GET /advisor/sessions/{id}` is read while the worker is going. */
export const ADVISOR_POLL_MS = 1_500;

/**
 * True while the worker has a step to do for this session: it is not waiting on the holder and is not finished.
 * `clarifying` is going until the restatement arrives, then it waits for the holder's answers.
 */
export function isWorking(session: Pick<AdvisorSession, 'status' | 'clarification'>): boolean {
  switch (session.status) {
    case 'gathering':
    case 'options':
    case 'tradeoffs':
    case 'planning':
      return true;
    case 'clarifying':
      return session.clarification === null;
    default:
      return false;
  }
}

/** True when the session waits on the holder: answers to the questions, or a pick. */
export function isWaiting(session: Pick<AdvisorSession, 'status' | 'clarification'>): boolean {
  return (
    session.status === 'awaiting_pick' ||
    (session.status === 'clarifying' && session.clarification !== null)
  );
}

/**
 * True once the session can no longer move. `tracked` is an ending too: the Brief carries it from there. So is
 * `completed` (WP 11.5e): the plan's watched figure reached its target and the watcher stopped.
 */
export function isEnded(status: AdvisorStatus): boolean {
  return (
    status === 'tracked' ||
    status === 'completed' ||
    status === 'refused' ||
    status === 'unanswerable' ||
    status === 'failed' ||
    status === 'cancelled'
  );
}

/** What the polite live region says while a step is going. */
export function stepWords(session: Pick<AdvisorSession, 'status' | 'clarification'>): string {
  switch (session.status) {
    case 'clarifying':
      return session.clarification === null ? 'Restating your question…' : '';
    case 'gathering':
      return 'Gathering your figures…';
    case 'options':
      return 'Setting out the options…';
    case 'tradeoffs':
      return 'Working out what each option costs…';
    case 'planning':
      return 'Writing the steps…';
    default:
      return '';
  }
}

/** What the live region says when a session reaches a state that waits or ends (read by screen readers, not drawn). */
export function outcomeWords(session: Pick<AdvisorSession, 'status' | 'clarification'>): string {
  switch (session.status) {
    case 'clarifying':
      return session.clarification === null ? '' : 'The advisor has a question for you.';
    case 'awaiting_pick':
      return 'The options are ready.';
    case 'tracked':
      return 'The plan is ready and is being followed in the Brief.';
    case 'completed':
      return "The plan's target is reached and the plan is no longer followed.";
    case 'refused':
      return 'The session was refused.';
    case 'unanswerable':
      return 'This question is outside what the advisor covers.';
    case 'failed':
      return 'The session failed.';
    case 'cancelled':
      return 'The session was closed.';
    default:
      return '';
  }
}

/** The status in a word or two, for the history list. */
export function statusWords(session: Pick<AdvisorSession, 'status' | 'clarification'>): string {
  switch (session.status) {
    case 'clarifying':
      return session.clarification === null ? 'Starting' : 'Waiting for your answers';
    case 'gathering':
      return 'Gathering figures';
    case 'options':
      return 'Setting out options';
    case 'tradeoffs':
      return 'Working out costs';
    case 'awaiting_pick':
      return 'Waiting for a pick';
    case 'planning':
      return 'Writing the steps';
    case 'tracked':
      return 'Followed in the Brief';
    case 'completed':
      return 'Target reached';
    case 'refused':
      return 'Refused';
    case 'unanswerable':
      return 'Out of scope';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Closed';
    default:
      return String(session.status);
  }
}

/** "29 Oct 2026, 14:22", in the holder's own time zone. */
export function formatAdvisorTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : format(date, 'd MMM yyyy, HH:mm');
}

/** The model as shown: a hosted provider prefix dropped, a local digest shortened. */
export function engineModelText(engine: Pick<AdvisorEngine, 'provider' | 'model'>): string {
  return explanationModelText(engine.provider, engine.model);
}

/**
 * The badge's words (07 section 7.5 rule 3): which provider and model the advisor runs on - "Runs on Local model
 * qwen2.5:7b-instruct-q4_K_M@sha256:3f3f3f3f3f3f…", "Runs on Anthropic claude-sonnet-5-5". It always names both.
 */
export function runsOnLabel(
  engine: Pick<AdvisorEngine, 'provider' | 'providerName' | 'model'>,
): string {
  return `Runs on ${engine.providerName} ${engineModelText(engine)}`;
}

/** Whether that is the local model or a hosted provider under the advisor's own consent, in a sentence. */
export function egressWords(engine: Pick<AdvisorEngine, 'providerName' | 'egress'>): string {
  return engine.egress === 'hosted'
    ? `This is a hosted provider (${engine.providerName}), used because the advisor's own hosted consent is ticked in Advisor management. The payloads it is sent are the ones approved there.`
    : 'This is the local model: nothing about the session leaves this machine.';
}

/** The count of playbook pages held back, in plain words. */
export function withheldWords(count: number): string {
  return `Playbook pages not yet reviewed were not used: ${String(count)}`;
}

/** The rubric line: "Rubric check: 2 of 3 criteria met". `null` when the judge produced no score. */
export function judgeWords(judge: AdvisorJudge): string | null {
  if (judge.criteria.length === 0) return null;
  const met = judge.criteria.filter((criterion) => criterion.met).length;
  return `Rubric check: ${String(met)} of ${String(judge.criteria.length)} criteria met`;
}

/** "Stopped at the trade-offs step: tradeoffs.cost_missing". */
const REFUSAL_STEP_WORDS: Readonly<Record<NonNullable<AdvisorSession['refusal']>['step'], string>> =
  {
    question: 'question',
    answer: 'answers',
    clarify: 'clarify',
    gather: 'gather',
    options: 'options',
    tradeoffs: 'trade-offs',
    plan: 'plan',
  };

export function refusalStepWords(step: keyof typeof REFUSAL_STEP_WORDS): string {
  return REFUSAL_STEP_WORDS[step];
}

/** Said when a refusal carries no message of its own. */
export const REFUSED_FALLBACK_WORDS = 'This session was not carried further.';
export const FAILED_FALLBACK_WORDS = 'The session could not be completed right now.';
export const CANCELLED_WORDS = 'This session was closed.';
export const UNAVAILABLE_FALLBACK_WORDS = 'The advisor cannot start a session right now.';
export const REQUEST_FAILED_WORDS = 'The request could not be sent. Nothing was asked of a model.';
export const IN_FLIGHT_WORDS =
  'Another session is still being worked on; this one can start when it is done.';
export const EMPTY_QUESTION_WORDS = 'The question is empty.';
/** WP 11.5e: a finding the advisor was opened from (`origin`) that the api could not take up. */
export const FINDING_NOT_FOUND_WORDS = 'That finding could not be found; it may have been removed.';
export const FINDING_NOT_SUPPORTED_WORDS =
  'The advisor does not take up this kind of finding yet. A question of your own can still be asked below.';
export const FINDING_NOT_GRANTED_WORDS =
  "This finding comes from a built-in check that has not been approved for the advisor's use. Approvals are in Advisor management.";
export const BRIEF_UNKNOWN_WORDS = 'That Brief could not be found.';
/** WP 11.5e: said in the tracked box once the plan's watched figure has reached its target. */
export const REACHED_WORDS = "Reached: the plan's target is met; this plan is no longer followed.";
export const NO_OPTIONS_WORDS =
  'No option came with its cost, so none is shown. The advisor does not offer a choice without what it costs.';

/** The reasons that mean no language model is set up at all: Settings, Language model is the way out. */
export const NO_MODEL_REASONS: ReadonlySet<string> = new Set(['off', 'not_configured']);

/** What the options step left out, in a sentence ("1 option was left out ..."). */
export function optionsDroppedWords(count: number): string {
  return count === 1
    ? '1 option was left out because it did not pass the checks.'
    : `${String(count)} options were left out because they did not pass the checks.`;
}

/** Options that carry a cost: the only ones the screen ever shows. */
export function optionsWithCost(session: Pick<AdvisorSession, 'options'>): AdvisorOption[] {
  return (session.options ?? []).filter((option) => option.cost.length > 0);
}

const ISO_WEEK = /^(\d{4})-W(\d{2})$/u;

/** "2026-W43" as "week 43 of 2026"; a value that is not an ISO week is returned as it came. */
export function weekLabel(isoWeek: string): string {
  const match = ISO_WEEK.exec(isoWeek);
  return match === null ? isoWeek : `week ${String(Number(match[2]))} of ${match[1]!}`;
}

/** Whether a string is an ISO week the api accepts (`YYYY-Www`). */
export function isIsoWeek(value: string): boolean {
  return ISO_WEEK.test(value);
}

/** "About: Avoidable fees this year, from the Brief of week 43 of 2026", or "About: <title>" with no week. */
export function originWords(origin: NonNullable<AdvisorSession['origin']>): string {
  return origin.briefWeek === null
    ? `About: ${origin.title}`
    : `About: ${origin.title}, from the Brief of ${weekLabel(origin.briefWeek)}`;
}

/** `emergency_runway` as "Emergency runway": the fallback when a calculation has no label of its own yet. */
export function humaniseFunction(name: string): string {
  const spaced = name.replace(/[_.-]+/gu, ' ').trim();
  return spaced === '' ? name : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

/**
 * What was gathered before the first question, for a session opened from a finding: the seeded calculations (by the
 * label the "I looked at" line gives them once it exists, else the function name humanised) and, when it joined,
 * the finding's own figures. `null` when nothing was gathered first.
 */
export function pregatheredWords(
  session: Pick<AdvisorSession, 'pregathered' | 'lookedAt'>,
): string | null {
  const pregathered = session.pregathered;
  if (pregathered === null) return null;
  const labels = new Map(
    (session.lookedAt?.items ?? []).map((item) => [item.function, item.label]),
  );
  const parts = pregathered.seeded.map((name) => labels.get(name) ?? humaniseFunction(name));
  if (pregathered.finding === 'joined') parts.push("the finding's own figures");
  if (parts.length === 0) return null;
  const list =
    parts.length === 1
      ? parts[0]!
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return `Gathered first: ${list}.`;
}

/** "Picked on 2026-10-01", or `null` when the day is not known. */
export function pickedOnWords(pickedAt: string | null): string | null {
  return pickedAt === null ? null : `Picked on ${pickedAt}`;
}

/** "Not checked yet" or "Latest: ...". */
export function latestWords(tracked: NonNullable<AdvisorSession['tracked']>): string {
  return tracked.latest === null ? 'Not checked yet' : `Latest: ${tracked.latest.text}`;
}

/** The direction of the tracked figure since it was picked, in words (never colour alone). */
export function directionWords(direction: NonNullable<AdvisorSession['tracked']>['direction']) {
  switch (direction) {
    case 'down':
      return 'Lower than when you picked it';
    case 'up':
      return 'Higher than when you picked it';
    case 'same':
      return 'Unchanged since you picked it';
    default:
      return null;
  }
}

/** The screens a link may name: the app's own routes, so a link can never leave the app. */
const KNOWN_SCREENS: ReadonlySet<string> = new Set([
  '/',
  '/reports',
  '/cash-flow',
  '/budget',
  '/transactions',
  '/recurring',
  '/accounts',
  '/accounts/connections',
  '/investments',
  '/plan',
  '/goals',
  '/health',
  '/brief',
  '/insights',
  '/inbox',
  '/ask',
  '/advisor',
  '/settings',
  '/settings/advisors',
]);

const KNOWN_SCREEN_FAMILIES = /^\/(accounts|categories|health)\/[A-Za-z0-9_-]+$/u;

export function isKnownScreen(path: string): boolean {
  return KNOWN_SCREENS.has(path) || KNOWN_SCREEN_FAMILIES.test(path);
}

/** `consent` text of the hosted tick-box is the api's own; these are the words around it. */
export const CONSENT_UNTICKED_WORDS =
  'Not ticked: advisor sessions run on the local model, and nothing about them is sent to a hosted provider.';
export const CONSENT_TICKED_WORDS =
  'Ticked: advisor sessions run on the hosted provider named below, with the payloads approved in Advisor management. Unticking withdraws it.';
