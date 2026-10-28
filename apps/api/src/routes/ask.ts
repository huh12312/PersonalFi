// SPDX-License-Identifier: MIT
/**
 * Ask PersonalFi, reporting mode (WP 11.5c; 11 §3.2, 12 §4).
 *
 * | Operation | Guard | What |
 * | --- | --- | --- |
 * | `GET /ask` | session | whether this holder can ask now (both query types approved, the narrator on, a scope granted) and why not, the question cap, example questions, and the holder's recent questions from `ask_sessions` |
 * | `POST /ask` | session | one question: the deterministic pre-check first — a refused or out-of-scope question is answered at once (200), **no model asked**; otherwise, when the holder can ask, a `compiling` session is written and `insights.ask` enqueued for the worker (202), and the screen polls |
 * | `GET /ask/{sessionId}` | session | one question as it stands |
 *
 * **The api has no path to a model** (the WP 10.16 job pattern): this process
 * resolves the holder's Ask models in preview mode only for their template
 * hashes, which key the approvals, and reads `ask_sessions`. Nothing here
 * writes an approval, a grant, a consent or a setting.
 *
 * The answer's text is only ever a narration the validator passed; the "I
 * looked at" line and the arithmetic beside it are the app's own rendering of
 * the results it computed, so a refused or failed narration still shows the
 * figures — never nothing.
 */
import { HOSTED_DISPLAY_NAMES, type HostedProvider } from '@advisor/local-model';
import {
  ASK_ANSWER_MAX,
  ASK_CATALOGUE_VERSION,
  ASK_NEAREST_SCREENS,
  ASK_QUESTION_MAX,
  ASK_TOPIC_WORDS,
  askAnswerDisplayText,
  askLookedAtLine,
  askUnavailable,
  createAskSession,
  enqueueAsk,
  findAskSession,
  inFlightAskSession,
  isAskNearestScreen,
  listAskSessions,
  precheckQuestion,
  type AskOutOfScopeTopic,
  type AskResultView,
  type RunSwitches,
  type StoredAskSession,
} from '@ctx/insights';
import { platformExecutor } from '@core/platform';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AskRuntime } from '../ask.ts';
import { correlationIdOf } from '../control-checks.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

const PROVIDERS = ['ollama', 'openai', 'openrouter', 'anthropic'] as const;
const STATUSES = [
  'compiling',
  'running',
  'narrating',
  'shown',
  'refused',
  'unanswerable',
  'failed',
  'cancelled',
] as const;

/** A question in flight for longer than this no longer blocks a new one. */
export const ASK_IN_FLIGHT_WINDOW_MS = 10 * 60_000;

export const ASK_EXAMPLE_QUESTIONS: readonly string[] = Object.freeze([
  'How many months of spending does my cash cover?',
  'How much IRA room do I have left this year?',
  'What would paying my cards avalanche-style with $200 extra a month save in interest?',
  'Which changes move my plan’s chance of success the most?',
]);

const screenSchema = z.object({ path: z.string(), label: z.string() });

const lookedAtItemSchema = z.object({
  function: z.string(),
  /** The app's words for the call, with its arguments. */
  label: z.string(),
  status: z.enum(['ok', 'not_available', 'refused']),
  asOf: z.string().nullable(),
  /** The figures as the app wrote them; the screen expands each item to these. */
  figures: z.array(z.object({ label: z.string(), text: z.string() })),
  /** Why it could not be computed, or how many more figures its own screen has. */
  note: z.string().nullable(),
  screen: screenSchema,
});

export const askSessionSchema = z
  .object({
    id: z.uuid(),
    question: z.string(),
    status: z.enum(STATUSES),
    createdAt: isoInstant,
    finishedAt: isoInstant.nullable(),
    /** Set when `status` is `shown`: wording a validator passed, citation markers removed. */
    answer: z
      .object({
        text: z.string(),
        provider: z.enum(PROVIDERS),
        /** The provider in words, for the badge: "Local model", "OpenAI", … */
        providerName: z.string(),
        /** `name@sha256:…` or `provider:model`, as the run recorded it. */
        model: z.string(),
        /** Always true: the words are a model's, the figures the app's. */
        aiAssisted: z.literal(true),
      })
      .nullable(),
    /** "I looked at: …" — the app's line, and each call's figures. `null` before any call ran. */
    lookedAt: z.object({ line: z.string(), items: z.array(lookedAtItemSchema) }).nullable(),
    /** Show the arithmetic without the prose: there are results and no answer to show. */
    fallback: z.boolean(),
    refusal: z
      .object({
        step: z.enum(['question', 'compile', 'narrate']),
        class: z.string(),
        message: z.string(),
      })
      .nullable(),
    unanswerable: z
      .object({
        reason: z.enum(['out_of_scope', 'not_computable']),
        topic: z.string().nullable(),
        message: z.string(),
        nearestScreen: screenSchema,
      })
      .nullable(),
    failure: z.object({ code: z.string(), message: z.string() }).nullable(),
  })
  .meta({ id: 'AskSession' });

type AskSessionWire = z.infer<typeof askSessionSchema>;

export const askOverviewSchema = z
  .object({
    availability: z.object({
      state: z.enum(['ready', 'unavailable']),
      /** A code when unavailable: `payload_not_approved`, `off`, `scope_not_granted`, … */
      reason: z.string().nullable(),
      /** Which query type is missing its approval or switch, when that is the reason. */
      step: z.enum(['compile', 'narrate']).nullable(),
      message: z.string().nullable(),
    }),
    maxQuestionLength: z.number().int(),
    maxAnswerLength: z.number().int(),
    examples: z.array(z.string()),
    sessions: z.array(askSessionSchema),
  })
  .meta({ id: 'AskOverview' });

const UNAVAILABLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  off: 'The language model is Off in Settings, so no question can be answered in words.',
  not_configured: 'No language model is configured for you.',
  consent_required: 'The hosted provider has no standing consent: nothing may be sent to it.',
  key_missing: 'The language model provider has no key.',
  key_unopenable: 'The stored key cannot be opened (is the install unlocked?).',
  endpoint_refused: 'The local endpoint set in Settings is refused by the local-endpoint policy.',
  advisors_disabled: 'Advisors are switched off for this install.',
  module_disabled: 'Insights are switched off.',
  kind_disabled: 'The language model is switched off in Advisor management.',
  advisor_disabled: 'Ask PersonalFi is switched off in Advisor management.',
  advisor_quarantined: 'Ask PersonalFi is paused after repeated failures; see Advisor management.',
  payload_not_approved:
    'The payloads Ask PersonalFi sends have not been approved yet. Review and approve both in Advisor management.',
  scope_not_granted:
    'You have not let the language model read any of your data, so no calculation can be listed. Grant it in Advisor management.',
  advisor_token_secret_unconfigured: 'This install has no advisor token secret configured.',
});

const QUESTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'question.empty': 'Type a question first.',
  'question.too_long': `Questions are limited to ${String(ASK_QUESTION_MAX)} characters.`,
  'question.instruction':
    'That reads as an instruction to the model rather than a question, so nothing was sent. Ask about your own figures instead.',
  'question.merchant_token':
    'That carries an internal merchant reference, so nothing was sent. Ask in your own words.',
  'question.markup': 'Questions are plain text; nothing was sent.',
});

const FAILED_WORDS =
  'The language model did not answer this time. Any figures below are the arithmetic the app computed; you can ask again.';

function providerName(provider: string): string {
  return provider === 'ollama'
    ? 'Local model'
    : (HOSTED_DISPLAY_NAMES[provider as HostedProvider] ?? provider);
}

function screenOf(path: string | null): { path: string; label: string } {
  const safe = path !== null && isAskNearestScreen(path) ? path : '/';
  return { path: safe, label: ASK_NEAREST_SCREENS[safe] };
}

function noteOf(result: AskResultView): string | null {
  if (result.status === 'not_available') return result.not_available?.reason ?? 'Not available.';
  if (result.status === 'refused') return 'This calculation could not run for what was asked.';
  return result.figures_total > result.figures.length
    ? `${String(result.figures_total - result.figures.length)} more figures are on the ${screenOf(result.screen).label} screen.`
    : null;
}

/** One session as the screen reads it. Exported for the tests. */
export function askSessionWire(row: StoredAskSession): AskSessionWire {
  const results = (row.results ?? null) as readonly AskResultView[] | null;
  const lookedAt =
    results === null
      ? null
      : {
          line: askLookedAtLine(results),
          items: results.map((result) => ({
            function: result.function,
            label: result.label,
            status: result.status,
            asOf: result.as_of,
            figures: result.figures.map((figure) => ({ label: figure.label, text: figure.text })),
            note: noteOf(result),
            screen: screenOf(result.screen),
          })),
        };
  const shown = row.status === 'shown' && row.narrationText !== null;
  const step = row.refusal?.split('.')[0] ?? null;
  const refusal =
    row.status === 'refused' && row.refusal !== null
      ? {
          step: (step === 'question' || step === 'compile' ? step : 'narrate') as
            'question' | 'compile' | 'narrate',
          class: row.refusal,
          message:
            step === 'question'
              ? (QUESTION_WORDS[row.refusal] ?? 'That question was not sent.')
              : step === 'compile'
                ? 'The draft of calculations didn’t pass the checks, so nothing was computed. Try asking in other words.'
                : 'The draft didn’t pass the checks; here is the arithmetic without the prose.',
        }
      : null;
  const unanswerable =
    row.status === 'unanswerable' && row.unanswerableReason !== null
      ? {
          reason: row.unanswerableReason,
          topic: row.unanswerableTopic,
          nearestScreen: screenOf(row.nearestScreen),
          message:
            row.unanswerableReason === 'out_of_scope'
              ? `This is outside what PersonalFi answers: ${
                  ASK_TOPIC_WORDS[row.unanswerableTopic as AskOutOfScopeTopic]?.words ??
                  'it is not a question about your own figures'
                }. Here is the nearest screen.`
              : 'I can’t compute that yet — here is the nearest screen.',
        }
      : null;
  const failure =
    (row.status === 'failed' || row.status === 'cancelled') && row.errorCode !== null
      ? {
          code: row.errorCode,
          message:
            row.status === 'cancelled'
              ? 'This question was stopped before it finished.'
              : (UNAVAILABLE_WORDS[row.errorCode] ?? FAILED_WORDS),
        }
      : null;
  return {
    id: row.id,
    question: row.question,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    answer:
      shown && row.llmProvider !== null && row.llmModel !== null
        ? {
            text: askAnswerDisplayText(row.narrationText ?? ''),
            provider: row.llmProvider as (typeof PROVIDERS)[number],
            providerName: providerName(row.llmProvider),
            model: row.llmModel,
            aiAssisted: true as const,
          }
        : null,
    lookedAt,
    fallback: !shown && results !== null && results.length > 0,
    refusal,
    unanswerable,
    failure,
  };
}

export interface AskRouteOptions {
  /** The api's preview-mode Ask runtime: resolves and renders, never calls a model. */
  readonly runtime: AskRuntime;
  readonly switches: RunSwitches;
}

export const askRoutes = (deps: RouteDeps, options: AskRouteOptions): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  async function availabilityOf(userId: string) {
    if (deps.config.secrets.advisor_token_secret === undefined) {
      return {
        state: 'unavailable' as const,
        reason: 'advisor_token_secret_unconfigured',
        step: null,
        message: UNAVAILABLE_WORDS['advisor_token_secret_unconfigured'] ?? null,
      };
    }
    const resolution = await options.runtime.resolve(userId);
    if (resolution.compile === null || resolution.narrate === null) {
      const reason = resolution.reason ?? 'not_configured';
      return {
        state: 'unavailable' as const,
        reason,
        step: null,
        message: UNAVAILABLE_WORDS[reason] ?? null,
      };
    }
    const gate = await askUnavailable(database, options.switches, {
      userId,
      compileTemplateHash: resolution.compile.templateHash,
      narrateTemplateHash: resolution.narrate.templateHash,
    });
    if (gate !== null) {
      return {
        state: 'unavailable' as const,
        reason: gate.reason,
        step: gate.step,
        message: UNAVAILABLE_WORDS[gate.reason] ?? 'Ask PersonalFi is not available right now.',
      };
    }
    return { state: 'ready' as const, reason: null, step: null, message: null };
  }

  return async (app) => {
    app.get(
      '/ask',
      {
        schema: {
          operationId: 'getAskOverview',
          summary: 'Whether this holder can ask now, and their recent questions',
          description:
            'Needs a session. `availability` says why a question cannot be answered in words now ' +
            '(a payload not approved in Advisor management, the narrator Off, nothing granted). ' +
            'Asks nothing.',
          tags: ['insights'],
          response: { 200: askOverviewSchema, ...problems(401) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const rows = await listAskSessions(database, session.userId, 20);
        return {
          availability: await availabilityOf(session.userId),
          maxQuestionLength: ASK_QUESTION_MAX,
          maxAnswerLength: ASK_ANSWER_MAX,
          examples: [...ASK_EXAMPLE_QUESTIONS],
          sessions: rows.map(askSessionWire),
        };
      },
    );

    app.post(
      '/ask',
      {
        schema: {
          operationId: 'askQuestion',
          summary: 'Ask one question about your own figures',
          description:
            'Needs a session. The deterministic pre-check runs first: a question that carries an ' +
            'instruction or a merchant pseudonym is refused, and one outside what PersonalFi ' +
            'answers (security selection, timing, tax filing, insurance, estate, moving money) is ' +
            'answered with the nearest screen — both 200, and no model is asked. Otherwise, when ' +
            'the holder can ask, 202 `compiling`: the worker compiles the question into catalogue ' +
            'calls, runs them and words the results (this process never calls a model); the ' +
            'screen polls GET /ask/{sessionId}. 409 `insights.ask_unavailable` when it cannot be ' +
            'asked now, 409 `insights.ask_in_flight` while another question is being answered.',
          tags: ['insights'],
          body: z.object({ question: z.string().max(ASK_QUESTION_MAX * 4) }),
          response: {
            200: askSessionSchema,
            202: askSessionSchema,
            ...problems(400, 401, 409),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const userId = session.userId;
        const context = { userId, clock, correlationId: correlationIdOf(request.id) };
        const raw = request.body.question;
        const pre = precheckQuestion(raw);
        const stored = raw.replace(/\s+/gu, ' ').trim().slice(0, ASK_QUESTION_MAX);
        if (pre.kind === 'refused') {
          if (pre.refusal === 'question.empty') {
            throw new AppError({
              status: 400,
              code: 'insights.ask_question_empty',
              title: 'Bad Request',
              detail: 'the question is empty',
              family: 'user',
            });
          }
          const row = await createAskSession(database, context, {
            question: stored,
            catalogueVersion: ASK_CATALOGUE_VERSION,
            opening: { status: 'refused', refusal: pre.refusal },
          });
          return reply.code(200).send(askSessionWire(row));
        }
        if (pre.kind === 'out_of_scope') {
          const row = await createAskSession(database, context, {
            question: stored,
            catalogueVersion: ASK_CATALOGUE_VERSION,
            opening: {
              status: 'unanswerable',
              reason: 'out_of_scope',
              topic: pre.topic,
              nearestScreen: pre.screen,
            },
          });
          return reply.code(200).send(askSessionWire(row));
        }
        const availability = await availabilityOf(userId);
        if (availability.state !== 'ready') {
          throw new AppError({
            status: 409,
            code: 'insights.ask_unavailable',
            title: 'Conflict',
            detail: `${availability.reason ?? 'unavailable'}: ${availability.message ?? ''}`,
            family: 'domain',
          });
        }
        const busy = await inFlightAskSession(
          database,
          userId,
          new Date(clock.nowMs() - ASK_IN_FLIGHT_WINDOW_MS),
        );
        if (busy !== null) {
          throw new AppError({
            status: 409,
            code: 'insights.ask_in_flight',
            title: 'Conflict',
            detail: `question ${busy.id} is still being answered`,
            family: 'domain',
          });
        }
        const row = await database.transaction(async (tx) => {
          const created = await createAskSession(tx, context, {
            question: pre.question,
            catalogueVersion: ASK_CATALOGUE_VERSION,
            opening: { status: 'compiling' },
          });
          await enqueueAsk(platformExecutor(tx), {
            userId,
            sessionId: created.id,
            correlationId: context.correlationId,
          });
          return created;
        });
        return reply.code(202).send(askSessionWire(row));
      },
    );

    app.get(
      '/ask/:sessionId',
      {
        schema: {
          operationId: 'getAskSession',
          summary: 'One question as it stands',
          tags: ['insights'],
          params: z.object({ sessionId: z.uuid() }),
          response: { 200: askSessionSchema, ...problems(401, 404) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const row = await findAskSession(database, session.userId, request.params.sessionId);
        if (row === null) {
          throw new AppError({
            status: 404,
            code: 'insights.ask_session_not_found',
            title: 'Not Found',
            detail: `no question ${request.params.sessionId}`,
            family: 'user',
          });
        }
        return askSessionWire(row);
      },
    );
  };
};
