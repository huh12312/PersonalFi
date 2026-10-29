// SPDX-License-Identifier: MIT
/**
 * Ask PersonalFi, advisor mode (WP 11.5d; 12 §2.3, §4; D31).
 *
 * | Operation | Guard | What |
 * | --- | --- | --- |
 * | `GET /advisor/sessions` | session | whether this holder can start a session now and why not, which model runs the advisor (and whether that is the hosted provider under the advisor's own consent), the disclaimer, examples, recent sessions |
 * | `POST /advisor/sessions` | session | one opening question: the deterministic pre-check first — refused or out of scope is answered at once (200), **no model asked**; otherwise a `clarifying` session is written and `insights.advisor_step` enqueued for the worker (202). WP 11.5e: or an `origin` instead of a question — "Talk this through" on a finding: the question is built from the finding by its rule family's template, the session records the finding, and the worker pre-gathers on it |
 * | `GET /advisor/sessions/{id}` | session | the session as it stands, with **the inspector**: every step's `advisor_runs` id, input digest (the payload kept for the run inspector at `/advisors/runs/{runId}`), provider, model, knowledge read and outcome, and the context object's digest |
 * | `POST /advisor/sessions/{id}/answers` | session | the holder's answers to the clarifying questions (each through the pre-check) → `gathering`, enqueued |
 * | `POST /advisor/sessions/{id}/pick` | session | the option the holder picks → `planning`, enqueued |
 * | `POST /advisor/sessions/{id}/cancel` | session | closes the session; a step's run in flight is asked to stop (kill level 4) |
 * | `GET /advisor/settings` | session | the advisor's own hosted consent (D31): its text, version and sha256, and whether it is ticked |
 * | `PUT /advisor/settings` | fresh session | tick (naming the text's sha256), untick, or choose the hosted provider |
 *
 * **The api has no path to a model**: it resolves the holder's advisor models
 * in preview mode only for their template hashes (which key the approvals),
 * reads and writes `advisor_sessions`, and enqueues. Options are only ever
 * shown with their costs: a session's options reach the wire merged with
 * their trade-offs, never before.
 */
import { HOSTED_DISPLAY_NAMES, type HostedProvider } from '@advisor/local-model';
import {
  ADVISOR_ANSWER_MAX,
  ADVISOR_CONSENT_TEXT,
  ADVISOR_CONSENT_VERSION,
  ADVISOR_DISCLAIMER,
  ADVISOR_QUESTION_MAX,
  ADVISOR_CANCELLABLE,
  ADVISOR_SESSION_TOKEN_BUDGET,
  ASK_CATALOGUE_VERSION,
  ASK_NEAREST_SCREENS,
  ASK_TOPIC_WORDS,
  AdvisorConsentMismatch,
  advisorConsentSha256,
  advisorDisplayText,
  advisorUnavailable,
  askLookedAtLine,
  busyAdvisorSession,
  createAdvisorSession,
  enqueueAdvisorStep,
  findAdvisorSession,
  isAskNearestScreen,
  listAdvisorSessions,
  listAdvisorSteps,
  precheckQuestion,
  readAdvisorSettings,
  requestRunCancel,
  transitionAdvisorSession,
  writeAdvisorSettings,
  briefProgressOf,
  findBriefByWeek,
  loadTalkThroughFinding,
  narratorGrantCeiling,
  sessionOriginOf,
  talkThroughQuestion,
  type AdvisorGathered,
  type AdvisorOption,
  type AdvisorPlanStep,
  type AdvisorTradeoff,
  type AdvisorWatcher,
  type AdvisorSessionOrigin,
  type AskOutOfScopeTopic,
  type AskResultView,
  type InsightsExecutor,
  type RunSwitches,
  type StoredAdvisorSession,
  type StoredAdvisorStep,
  type StoredClarification,
} from '@ctx/insights';
import { platformExecutor } from '@core/platform';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AdvisorRuntime } from '../advisor-mode.ts';
import { correlationIdOf } from '../control-checks.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

const PROVIDERS = ['ollama', 'openai', 'openrouter', 'anthropic'] as const;
const HOSTED = ['openai', 'openrouter', 'anthropic'] as const;
const STATUSES = [
  'clarifying',
  'gathering',
  'options',
  'tradeoffs',
  'awaiting_pick',
  'planning',
  'tracked',
  'completed',
  'refused',
  'unanswerable',
  'failed',
  'cancelled',
] as const;
const STEPS = ['clarify', 'gather', 'options', 'tradeoffs', 'plan', 'judge'] as const;

/** A session working for longer than this no longer blocks a new one. */
export const ADVISOR_BUSY_WINDOW_MS = 10 * 60_000;

/** 12 §3's three worked examples, and one more. */
export const ADVISOR_EXAMPLE_QUESTIONS: readonly string[] = Object.freeze([
  'Should I pay off my car loan or invest the extra $400 a month?',
  'Can I retire at 60?',
  'Where should I put $15,000 that’s sitting in checking?',
  'How should I fill my tax-advantaged accounts this year?',
]);

const figureSchema = z.object({ label: z.string(), text: z.string() });
const screenSchema = z.object({ path: z.string(), label: z.string() });
const engineSchema = z.object({
  provider: z.enum(PROVIDERS),
  /** The provider in words, for the badge: "Local model", "OpenAI", … */
  providerName: z.string(),
  /** `name@sha256:…` or `provider:model`. */
  model: z.string(),
  egress: z.enum(['local', 'hosted']),
});

const stepSchema = z.object({
  step: z.enum(STEPS),
  runId: z.uuid(),
  /** `advisor_runs.input_digest`: sha256 over the payload the model was sent (07 §7.3). */
  inputDigest: z.string(),
  provider: z.enum(PROVIDERS),
  providerName: z.string(),
  model: z.string(),
  egress: z.enum(['local', 'hosted']),
  outcome: z.enum(['accepted', 'refused', 'failed', 'cancelled']).nullable(),
  refusal: z.string().nullable(),
  errorCode: z.string().nullable(),
  knowledgeRead: z.record(z.string(), z.unknown()).nullable(),
  tokens: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: isoInstant,
  finishedAt: isoInstant.nullable(),
  /** The run inspector, where the retained payload is re-digested against `inputDigest`. */
  inspectorPath: z.string(),
});

export const advisorSessionSchema = z
  .object({
    id: z.uuid(),
    question: z.string(),
    status: z.enum(STATUSES),
    createdAt: isoInstant,
    updatedAt: isoInstant,
    finishedAt: isoInstant.nullable(),
    /** The model that wrote the latest step: the badge. `null` before any model step. */
    engine: engineSchema.nullable(),
    /** Always true once a model wrote anything: the words are a model's, the figures the app's. */
    aiAssisted: z.boolean(),
    disclaimer: z.string(),
    clarification: z
      .object({
        restatement: z.string(),
        questions: z.array(z.string()),
        assumed: z.array(z.object({ about: z.string(), valueRef: z.string(), value: z.string() })),
      })
      .nullable(),
    answers: z.array(z.string()).nullable(),
    /**
     * WP 11.5e: the finding a "Talk this through" session was opened from — its title as the holder saw it,
     * the rule that made it and the Brief week it was opened from — or `null` for a typed question.
     */
    origin: z
      .object({
        insightId: z.uuid(),
        ruleId: z.string(),
        title: z.string(),
        briefWeek: z.string().nullable(),
      })
      .nullable(),
    /**
     * WP 11.5e: what was pre-gathered for a session opened from a finding: the seeded calls (always run) and
     * whether the finding's own figures joined the context object (`joined`) or why not. `null` otherwise or
     * before the gather step.
     */
    pregathered: z
      .object({
        seeded: z.array(z.string()),
        finding: z.string().nullable(),
      })
      .nullable(),
    /** "I looked at: …" — the app's line, and each call's figures. */
    lookedAt: z
      .object({
        line: z.string(),
        items: z.array(
          z.object({
            function: z.string(),
            label: z.string(),
            status: z.enum(['ok', 'not_available', 'refused']),
            asOf: z.string().nullable(),
            figures: z.array(figureSchema),
            screen: screenSchema,
          }),
        ),
      })
      .nullable(),
    knowledge: z
      .object({
        pagesRead: z.array(z.string()),
        withheld: z.array(z.object({ key: z.string(), code: z.string() })),
      })
      .nullable(),
    /** Only with their trade-offs: an option never reaches the wire without its cost. */
    options: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          summary: z.string(),
          backing: z.array(figureSchema),
          benefit: z.array(figureSchema),
          cost: z.array(figureSchema).min(1),
          note: z.string(),
        }),
      )
      .nullable(),
    optionsDropped: z.number().int(),
    pickedOption: z.string().nullable(),
    plan: z.array(z.object({ text: z.string(), href: z.string(), label: z.string() })).nullable(),
    tracked: z
      .object({
        kind: z.string(),
        label: z.string(),
        baseline: z.object({ text: z.string(), asOf: z.string().nullable() }),
        latest: z.object({ text: z.string(), asOf: z.string().nullable() }).nullable(),
        direction: z.enum(['down', 'up', 'same']).nullable(),
        status: z.string(),
        checkedAt: z.string().nullable(),
        brief: z.object({ outcome: z.string(), path: z.string() }),
        /** WP 11.5e: what the plan aims at (`$0.00` left to go), or `null` for a figure with no target. */
        target: z.object({ text: z.string() }).nullable(),
        /** WP 11.5e: the day the plan was picked. */
        pickedAt: z.string().nullable(),
        /** WP 11.5e: the target is reached and the session completed; the watcher has stopped. */
        reached: z.boolean(),
        /** WP 11.5e: the progress sentence the Brief carries: a template, the watcher's own figures only. */
        wording: z.string(),
      })
      .nullable(),
    judge: z
      .object({
        score: z.string().nullable(),
        page: z.string().nullable(),
        criteria: z.array(
          z.object({ criterion: z.string(), met: z.boolean(), reason: z.string() }),
        ),
        runId: z.string().nullable(),
        error: z.string().nullable(),
      })
      .nullable(),
    /** Show the arithmetic without the prose: results exist and no options with costs do. */
    fallback: z.boolean(),
    refusal: z
      .object({
        step: z.enum(['question', 'answer', 'clarify', 'gather', 'options', 'tradeoffs', 'plan']),
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
    tokens: z.object({
      used: z.number().int(),
      budget: z.number().int(),
      hostedWindowLeft: z.number().int().nullable(),
    }),
  })
  .meta({ id: 'AdvisorSession' });

export const advisorSessionDetailSchema = advisorSessionSchema
  .extend({
    inspector: z.object({
      contextDigest: z.string().nullable(),
      steps: z.array(stepSchema),
    }),
  })
  .meta({ id: 'AdvisorSessionDetail' });

type AdvisorSessionWire = z.infer<typeof advisorSessionSchema>;

const availabilitySchema = z.object({
  state: z.enum(['ready', 'unavailable']),
  reason: z.string().nullable(),
  step: z.enum(STEPS).nullable(),
  message: z.string().nullable(),
});

export const advisorOverviewSchema = z
  .object({
    availability: availabilitySchema,
    /** Which model runs the protocol for this holder now, and why (D31). */
    engine: engineSchema
      .extend({
        hostedConsented: z.boolean(),
        /** Ticked, but the hosted provider could not be used: the local model runs instead. */
        hostedFallback: z.string().nullable(),
      })
      .nullable(),
    disclaimer: z.string(),
    maxQuestionLength: z.number().int(),
    maxAnswerLength: z.number().int(),
    tokenBudget: z.number().int(),
    examples: z.array(z.string()),
    sessions: z.array(advisorSessionSchema),
  })
  .meta({ id: 'AdvisorOverview' });

export const advisorSettingsSchema = z
  .object({
    consent: z.object({ version: z.string(), sha256: z.string(), text: z.string() }),
    hostedConsented: z.boolean(),
    hostedConsentedAt: isoInstant.nullable(),
    hostedProvider: z.enum(HOSTED).nullable(),
  })
  .meta({ id: 'AdvisorSettings' });

const UNAVAILABLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  off: 'The language model is Off in Settings, so the advisor cannot run.',
  not_configured:
    'No local language model is configured for you, so the advisor has nothing to run on.',
  advisor_consent_required:
    'Your language model is a hosted provider and the advisor’s own hosted box is not ticked, so the advisor would run on the local model — and none is configured. Tick the box in Advisor management, or set up the local model.',
  consent_required: 'The hosted provider has no standing consent: nothing may be sent to it.',
  key_missing: 'The language model provider has no key.',
  key_unopenable: 'The stored key cannot be opened (is the install unlocked?).',
  endpoint_refused: 'The local endpoint set in Settings is refused by the local-endpoint policy.',
  advisors_disabled: 'Advisors are switched off for this install.',
  module_disabled: 'Insights are switched off.',
  kind_disabled: 'The language model is switched off in Advisor management.',
  advisor_disabled: 'A step of the advisor is switched off in Advisor management.',
  advisor_quarantined:
    'A step of the advisor is paused after repeated failures; see Advisor management.',
  payload_not_approved:
    'The payloads the advisor sends have not all been approved yet. Review and approve each step in Advisor management.',
  scope_not_granted:
    'You have not let the language model read any of your data, so the advisor has no calculation to work from. Grant it in Advisor management.',
  advisor_token_secret_unconfigured: 'This install has no advisor token secret configured.',
  token_budget_exhausted:
    'This session used its whole token budget, so it stopped. Start a new session to continue.',
  step_interrupted: 'A step of this session was interrupted. Start a new session.',
  context_changed: 'The figures this session was working from changed. Start a new session.',
  watcher_unavailable: 'The plan was written, but nothing in it could be followed.',
  holder_cancelled: 'You closed this session.',
});

/** Why a ticked hosted provider is not in use (the local model runs instead), in words. */
const FALLBACK_WORDS: Readonly<Record<string, string>> = Object.freeze({
  no_hosted_provider: 'no hosted provider is chosen, and the narrator is the local model',
  consent_required: 'the hosted provider has no standing consent in Settings, Language model',
  key_missing: 'the hosted provider has no key',
  key_unopenable: 'the stored key cannot be opened',
});

const QUESTION_WORDS: Readonly<Record<string, string>> = Object.freeze({
  'question.empty': 'Type a question first.',
  'question.too_long': `Questions are limited to ${String(ADVISOR_QUESTION_MAX)} characters.`,
  'question.instruction':
    'That reads as an instruction to the model rather than a question, so nothing was sent.',
  'question.merchant_token':
    'That carries an internal merchant reference, so nothing was sent. Ask in your own words.',
  'question.markup': 'Questions are plain text; nothing was sent.',
  'answer.empty': 'Answer each question first.',
  'answer.too_long': `Answers are limited to ${String(ADVISOR_ANSWER_MAX)} characters.`,
  'answer.instruction':
    'An answer read as an instruction to the model rather than an answer, so nothing was sent.',
  'answer.merchant_token': 'An answer carried an internal merchant reference, so nothing was sent.',
  'answer.markup': 'Answers are plain text; nothing was sent.',
});

const STEP_WORDS: Readonly<Record<string, string>> = Object.freeze({
  clarify: 'The advisor’s restatement didn’t pass the checks, so nothing more was asked.',
  gather:
    'The advisor’s draft of calculations didn’t pass the checks, so nothing was computed. Try asking in other words.',
  options:
    'The advisor’s options didn’t pass the checks; here is the arithmetic without the prose.',
  tradeoffs:
    'The advisor’s draft didn’t pass the checks — every option must carry its cost; here is the arithmetic without the prose.',
  plan: 'The advisor’s plan didn’t pass the checks — every step must be a screen of this app.',
});

function providerName(provider: string): string {
  return provider === 'ollama'
    ? 'Local model'
    : (HOSTED_DISPLAY_NAMES[provider as HostedProvider] ?? provider);
}

function screenOf(path: string | null): { path: string; label: string } {
  const safe = path !== null && isAskNearestScreen(path) ? path : '/';
  return { path: safe, label: ASK_NEAREST_SCREENS[safe] };
}

function figuresOf(list: readonly { label: string; text: string }[]) {
  return list.map((figure) => ({ label: figure.label, text: figure.text }));
}

function stepWire(row: StoredAdvisorStep) {
  return {
    step: row.step,
    runId: row.runId,
    inputDigest: row.inputDigest,
    provider: row.llmProvider as (typeof PROVIDERS)[number],
    providerName: providerName(row.llmProvider),
    model: row.llmModel,
    egress: row.egress,
    outcome: row.outcome,
    refusal: row.refusal,
    errorCode: row.errorCode,
    knowledgeRead: row.knowledgeRead ?? null,
    tokens: row.tokens,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    inspectorPath: `/advisors/runs/${row.runId}`,
  };
}

/** One session as the screen reads it. Exported for the tests. */
export function advisorSessionWire(
  row: StoredAdvisorSession,
  steps: readonly StoredAdvisorStep[],
): AdvisorSessionWire {
  const clarification = row.clarification as unknown as StoredClarification | null;
  const gathered = row.gathered as unknown as AdvisorGathered | null;
  const results = (gathered?.results ?? null) as readonly AskResultView[] | null;
  const options = (row.options ?? null) as unknown as readonly AdvisorOption[] | null;
  const tradeoffs = (row.tradeoffs ?? null) as unknown as readonly AdvisorTradeoff[] | null;
  const plan = (row.plan ?? null) as unknown as readonly AdvisorPlanStep[] | null;
  const watcher = (row.watcher ?? null) as unknown as AdvisorWatcher | null;
  const modelSteps = steps.filter((step) => step.step !== 'judge');
  const latest = modelSteps[modelSteps.length - 1] ?? null;
  const merged =
    options === null || tradeoffs === null
      ? null
      : options.flatMap((option) => {
          const trade = tradeoffs.find((entry) => entry.option === option.id);
          // Never a card without a cost.
          if (trade === undefined || trade.cost.length === 0) return [];
          return [
            {
              id: option.id,
              label: advisorDisplayText(option.label),
              summary: advisorDisplayText(option.summary),
              backing: figuresOf(option.backed_by),
              benefit: figuresOf(trade.benefit),
              cost: figuresOf(trade.cost),
              note: advisorDisplayText(trade.note),
            },
          ];
        });
  const step = row.refusal?.split('.')[0] ?? null;
  const refusal =
    row.status === 'refused' && row.refusal !== null && step !== null
      ? {
          step: step as
            'question' | 'answer' | 'clarify' | 'gather' | 'options' | 'tradeoffs' | 'plan',
          class: row.refusal,
          message: QUESTION_WORDS[row.refusal] ?? STEP_WORDS[step] ?? 'That was not sent.',
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
              ? `This is outside what PersonalFi advises on: ${
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
            UNAVAILABLE_WORDS[row.errorCode] ??
            (row.status === 'cancelled'
              ? 'This session was stopped before it finished.'
              : 'The language model did not answer this time. Any figures below are the arithmetic the app computed.'),
        }
      : null;
  const judgeDetail = row.judgeDetail as {
    page?: string;
    criteria?: { criterion: string; met: boolean; reason: string }[];
  } | null;
  return {
    id: row.id,
    question: row.question,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    engine:
      latest === null
        ? null
        : {
            provider: latest.llmProvider as (typeof PROVIDERS)[number],
            providerName: providerName(latest.llmProvider),
            model: latest.llmModel,
            egress: latest.egress,
          },
    aiAssisted: latest !== null,
    disclaimer: ADVISOR_DISCLAIMER,
    clarification:
      clarification === null
        ? null
        : {
            restatement: advisorDisplayText(clarification.restatement),
            questions: [...clarification.questions],
            assumed: clarification.assumed.map((entry) => ({
              about: entry.about,
              valueRef: entry.value_ref,
              value:
                clarification.defaults_sent.find((sent) => sent.ref === entry.value_ref)?.value ??
                '',
            })),
          },
    answers: row.answers === null ? null : [...row.answers],
    lookedAt:
      results === null
        ? null
        : {
            line: askLookedAtLine(results),
            items: results.map((result) => ({
              function: result.function,
              label: result.label,
              status: result.status,
              asOf: result.as_of,
              figures: result.figures
                .slice(0, 24)
                .map((figure) => ({ label: figure.label, text: figure.text })),
              screen: screenOf(result.screen),
            })),
          },
    knowledge:
      gathered === null
        ? null
        : {
            pagesRead: gathered.pages.map((page) => page.key),
            withheld: gathered.withheld.map((entry) => ({ key: entry.key, code: entry.code })),
          },
    options: merged,
    optionsDropped: gathered?.options_dropped ?? 0,
    pickedOption: row.pickedOption,
    plan:
      plan === null
        ? null
        : plan.map((entry) => ({
            text: advisorDisplayText(entry.text),
            href: entry.action_href,
            label: entry.action_label,
          })),
    origin: (() => {
      const origin = sessionOriginOf(row);
      return origin === null
        ? null
        : {
            insightId: origin.insight_ref,
            ruleId: origin.rule_id,
            title: origin.title,
            briefWeek: origin.brief_week,
          };
    })(),
    pregathered:
      gathered === null || gathered.seeded_calls === undefined
        ? null
        : {
            seeded: gathered.seeded_calls.map((call) => call.name),
            finding: gathered.finding?.outcome ?? null,
          },
    tracked:
      (row.status !== 'tracked' && row.status !== 'completed') || watcher === null
        ? null
        : {
            kind: watcher.kind,
            label: watcher.figure_label,
            baseline: { text: watcher.baseline.text, asOf: watcher.baseline.as_of },
            latest:
              watcher.latest === null
                ? null
                : { text: watcher.latest.text, asOf: watcher.latest.as_of },
            direction: watcher.direction,
            status: watcher.status,
            checkedAt: watcher.checked_at,
            brief: { outcome: watcher.brief.outcome, path: '/brief' },
            ...(() => {
              const progress = briefProgressOf(row);
              return {
                target: progress?.target ?? null,
                pickedAt: progress?.picked_at ?? null,
                reached: row.status === 'completed',
                wording: progress?.wording ?? '',
              };
            })(),
          },
    judge:
      row.judgeScore === null && row.judgeError === null
        ? null
        : {
            score: row.judgeScore,
            page: judgeDetail?.page ?? null,
            criteria: judgeDetail?.criteria ?? [],
            runId: row.judgeRunId,
            error: row.judgeError,
          },
    fallback:
      (merged === null || merged.length === 0) &&
      results !== null &&
      results.length > 0 &&
      ['refused', 'failed', 'cancelled', 'unanswerable'].includes(row.status),
    refusal,
    unanswerable,
    failure,
    tokens: {
      used: row.tokensUsed,
      budget: row.tokenBudget,
      hostedWindowLeft: row.hostedWindowLeft,
    },
  };
}

export interface AdvisorRouteOptions {
  /** The api's preview-mode advisor runtime: resolves and renders, never calls a model. */
  readonly runtime: AdvisorRuntime;
  readonly switches: RunSwitches;
}

function notFound(id: string): AppError {
  return new AppError({
    status: 404,
    code: 'insights.advisor_session_not_found',
    title: 'Not Found',
    detail: `no advisor session ${id}`,
    family: 'user',
  });
}

function conflict(code: string, detail: string): AppError {
  return new AppError({ status: 409, code, title: 'Conflict', detail, family: 'domain' });
}

export const advisorSessionRoutes = (
  deps: RouteDeps,
  options: AdvisorRouteOptions,
): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;
  const executor = database as unknown as InsightsExecutor;

  async function availabilityOf(userId: string) {
    if (deps.config.secrets.advisor_token_secret === undefined) {
      const reason = 'advisor_token_secret_unconfigured';
      return {
        state: 'unavailable' as const,
        reason,
        step: null,
        message: UNAVAILABLE_WORDS[reason] ?? null,
      };
    }
    const resolution = await options.runtime.resolve(userId);
    if (resolution.models === null) {
      const reason = resolution.reason ?? 'not_configured';
      return {
        state: 'unavailable' as const,
        reason,
        step: null,
        message: UNAVAILABLE_WORDS[reason] ?? null,
      };
    }
    const models = resolution.models;
    const gate = await advisorUnavailable(database, options.switches, {
      userId,
      templateHashes: {
        clarify: models.clarify.templateHash,
        gather: models.gather.templateHash,
        options: models.options.templateHash,
        tradeoffs: models.tradeoffs.templateHash,
        plan: models.plan.templateHash,
        judge: models.judge.templateHash,
      },
    });
    if (gate !== null) {
      return {
        state: 'unavailable' as const,
        reason: gate.reason,
        step: gate.step,
        message: UNAVAILABLE_WORDS[gate.reason] ?? 'The advisor is not available right now.',
      };
    }
    return { state: 'ready' as const, reason: null, step: null, message: null };
  }

  async function engineOf(userId: string) {
    const resolution = await options.runtime.resolve(userId);
    if (resolution.models === null) return null;
    return {
      provider: resolution.models.provider,
      providerName: providerName(resolution.models.provider),
      model: resolution.models.clarify.label,
      egress: resolution.models.egress,
      hostedConsented: resolution.hostedConsented,
      hostedFallback:
        resolution.hostedFallback === null
          ? null
          : (FALLBACK_WORDS[resolution.hostedFallback] ?? 'the hosted provider cannot be reached'),
    };
  }

  /**
   * WP 11.5e: a finding the holder may talk through — a built-in's, of a rule the table answers, built from
   * scopes the language model is granted — and the question its rule family's template makes of it.
   */
  async function openFromFinding(
    userId: string,
    insightId: string,
    briefWeek: string | null,
  ): Promise<{ readonly origin: AdvisorSessionOrigin; readonly question: string }> {
    const loaded = await loadTalkThroughFinding(database, userId, insightId);
    if (loaded.status === 'not_found') {
      throw new AppError({
        status: 404,
        code: 'insights.advisor_finding_not_found',
        title: 'Not Found',
        detail: `no finding ${insightId}`,
        family: 'user',
      });
    }
    if (loaded.status !== 'found') {
      throw conflict(
        'insights.advisor_finding_not_supported',
        'This finding has no calculation the advisor can work from yet, so it cannot be talked through.',
      );
    }
    const ceiling = await narratorGrantCeiling(database, userId);
    if (!loaded.finding.scopes.every((scope) => ceiling.includes(scope))) {
      throw conflict(
        'insights.advisor_finding_not_granted',
        'The language model is not allowed to read what this finding is built from. Grant it in Advisor management.',
      );
    }
    if (briefWeek !== null && (await findBriefByWeek(database, userId, briefWeek)) === null) {
      throw new AppError({
        status: 400,
        code: 'insights.advisor_brief_unknown',
        title: 'Bad Request',
        detail: `no Brief for ${briefWeek}`,
        family: 'user',
      });
    }
    const finding = loaded.finding;
    return {
      origin: {
        insightRef: finding.insightId,
        ruleId: finding.ruleId,
        title: finding.title,
        briefWeek,
      },
      question: talkThroughQuestion({
        family: finding.family,
        title: finding.title,
        ruleName: finding.ruleName,
      }),
    };
  }

  async function sessionOr404(userId: string, id: string): Promise<StoredAdvisorSession> {
    const row = await findAdvisorSession(database, userId, id);
    if (row === null) throw notFound(id);
    return row;
  }

  async function detail(userId: string, row: StoredAdvisorSession) {
    const steps = await listAdvisorSteps(database, userId, row.id);
    return {
      ...advisorSessionWire(row, steps),
      inspector: { contextDigest: row.contextDigest, steps: steps.map(stepWire) },
    };
  }

  async function settingsView(userId: string) {
    const settings = await readAdvisorSettings(executor, userId);
    return {
      consent: {
        version: ADVISOR_CONSENT_VERSION,
        sha256: advisorConsentSha256(),
        text: ADVISOR_CONSENT_TEXT,
      },
      hostedConsented:
        settings.hostedConsentedAt !== null &&
        settings.hostedConsentTextHash === advisorConsentSha256(),
      hostedConsentedAt:
        settings.hostedConsentedAt === null ? null : settings.hostedConsentedAt.toISOString(),
      hostedProvider: settings.hostedProvider,
    };
  }

  return async (app) => {
    app.get(
      '/advisor/sessions',
      {
        schema: {
          operationId: 'getAdvisorOverview',
          summary:
            'Whether this holder can start an advisor session now, and their recent sessions',
          description:
            'Needs a session. `availability` says why a session cannot start now (a step not ' +
            'approved in Advisor management, the narrator Off, nothing granted); `engine` says ' +
            'which model runs the advisor — the hosted provider only under the advisor’s own ' +
            'consent (D31), otherwise the local model. Asks nothing.',
          tags: ['insights'],
          response: { 200: advisorOverviewSchema, ...problems(401) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const rows = await listAdvisorSessions(database, session.userId, 20);
        const sessions = [];
        for (const row of rows) {
          sessions.push(
            advisorSessionWire(row, await listAdvisorSteps(database, session.userId, row.id)),
          );
        }
        return {
          availability: await availabilityOf(session.userId),
          engine: await engineOf(session.userId),
          disclaimer: ADVISOR_DISCLAIMER,
          maxQuestionLength: ADVISOR_QUESTION_MAX,
          maxAnswerLength: ADVISOR_ANSWER_MAX,
          tokenBudget: ADVISOR_SESSION_TOKEN_BUDGET,
          examples: [...ADVISOR_EXAMPLE_QUESTIONS],
          sessions,
        };
      },
    );

    app.post(
      '/advisor/sessions',
      {
        schema: {
          operationId: 'startAdvisorSession',
          summary: 'Start an advisor session with one question',
          description:
            'Needs a session. The deterministic pre-check runs first: an instruction or a ' +
            'merchant pseudonym is refused, and a question outside what PersonalFi advises on ' +
            '(security selection, timing, tax filing, insurance, estate, moving money) is answered ' +
            'with the nearest screen — both 200, no model asked. Otherwise 202 `clarifying`: the ' +
            'worker restates the question (this process never calls a model). 409 ' +
            '`insights.advisor_unavailable`, or `insights.advisor_in_flight` while another session ' +
            'has a step running.',
          tags: ['insights'],
          body: z.object({
            question: z
              .string()
              .max(ADVISOR_QUESTION_MAX * 4)
              .optional(),
            /**
             * WP 11.5e, "Talk this through": the finding to talk through instead of a typed question — its
             * insight id, and the ISO week of the Brief it was opened from (absent from an insight card).
             */
            origin: z
              .object({
                insightId: z.uuid(),
                briefWeek: z
                  .string()
                  .regex(/^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$/u)
                  .optional(),
              })
              .optional(),
          }),
          response: {
            200: advisorSessionDetailSchema,
            202: advisorSessionDetailSchema,
            ...problems(400, 401, 404, 409),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const userId = session.userId;
        const context = { userId, clock, correlationId: correlationIdOf(request.id) };
        const { question, origin: asked } = request.body;
        if ((question === undefined) === (asked === undefined)) {
          throw new AppError({
            status: 400,
            code: 'insights.advisor_question_or_origin',
            title: 'Bad Request',
            detail: 'send either a question or the finding to talk through, not both',
            family: 'user',
          });
        }
        // WP 11.5e: "Talk this through" — the question is built from the finding, never typed or modelled.
        let origin: AdvisorSessionOrigin | null = null;
        let raw = question ?? '';
        if (asked !== undefined) {
          const opened = await openFromFinding(userId, asked.insightId, asked.briefWeek ?? null);
          origin = opened.origin;
          raw = opened.question;
        }
        const pre = precheckQuestion(raw);
        const stored = raw.replace(/\s+/gu, ' ').trim().slice(0, ADVISOR_QUESTION_MAX);
        const base = {
          question: stored,
          catalogueVersion: ASK_CATALOGUE_VERSION,
          tokenBudget: ADVISOR_SESSION_TOKEN_BUDGET,
          origin,
        };
        if (pre.kind === 'refused') {
          if (pre.refusal === 'question.empty') {
            throw new AppError({
              status: 400,
              code: 'insights.advisor_question_empty',
              title: 'Bad Request',
              detail: 'the question is empty',
              family: 'user',
            });
          }
          const row = await createAdvisorSession(database, context, {
            ...base,
            opening: { status: 'refused', refusal: pre.refusal },
          });
          return reply.code(200).send(await detail(userId, row));
        }
        if (pre.kind === 'out_of_scope') {
          const row = await createAdvisorSession(database, context, {
            ...base,
            opening: {
              status: 'unanswerable',
              reason: 'out_of_scope',
              topic: pre.topic,
              nearestScreen: pre.screen,
            },
          });
          return reply.code(200).send(await detail(userId, row));
        }
        const availability = await availabilityOf(userId);
        if (availability.state !== 'ready') {
          throw conflict(
            'insights.advisor_unavailable',
            `${availability.reason ?? 'unavailable'}: ${availability.message ?? ''}`,
          );
        }
        const busy = await busyAdvisorSession(
          database,
          userId,
          new Date(clock.nowMs() - ADVISOR_BUSY_WINDOW_MS),
        );
        if (busy !== null) {
          throw conflict('insights.advisor_in_flight', `session ${busy.id} has a step running`);
        }
        const row = await database.transaction(async (tx) => {
          const created = await createAdvisorSession(tx, context, {
            ...base,
            question: pre.question.slice(0, ADVISOR_QUESTION_MAX),
            opening: { status: 'clarifying' },
          });
          await enqueueAdvisorStep(platformExecutor(tx), {
            userId,
            sessionId: created.id,
            stage: 'start',
            correlationId: context.correlationId,
          });
          return created;
        });
        return reply.code(202).send(await detail(userId, row));
      },
    );

    app.get(
      '/advisor/sessions/:sessionId',
      {
        schema: {
          operationId: 'getAdvisorSession',
          summary: 'One advisor session as it stands, with the inspector',
          description:
            'Needs a session. `inspector.steps` lists every model call the session made: its ' +
            '`advisor_runs` id, the digest of the payload it was sent (re-verified by the run ' +
            'inspector at `inspectorPath`), the provider and model, what it read from the ' +
            'knowledge base and its outcome; `inspector.contextDigest` is the context object’s.',
          tags: ['insights'],
          params: z.object({ sessionId: z.uuid() }),
          response: { 200: advisorSessionDetailSchema, ...problems(401, 404) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const row = await sessionOr404(session.userId, request.params.sessionId);
        return detail(session.userId, row);
      },
    );

    app.post(
      '/advisor/sessions/:sessionId/answers',
      {
        schema: {
          operationId: 'answerAdvisorSession',
          summary: 'Answer the clarifying questions, and let the advisor gather',
          description:
            'Needs a session. One answer per question, in order (none when there were none). Each ' +
            'goes through the same pre-check as a question: an instruction, a merchant pseudonym ' +
            'or markup refuses the session at once (200, no model). Otherwise 202 `gathering`.',
          tags: ['insights'],
          params: z.object({ sessionId: z.uuid() }),
          body: z.object({ answers: z.array(z.string().max(ADVISOR_ANSWER_MAX * 4)).max(2) }),
          response: {
            200: advisorSessionDetailSchema,
            202: advisorSessionDetailSchema,
            ...problems(400, 401, 404, 409),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const userId = session.userId;
        const context = { userId, clock, correlationId: correlationIdOf(request.id) };
        const row = await sessionOr404(userId, request.params.sessionId);
        const clarification = row.clarification as unknown as StoredClarification | null;
        if (row.status !== 'clarifying' || clarification === null || row.answers !== null) {
          throw conflict(
            'insights.advisor_not_awaiting_answers',
            `session ${row.id} is ${row.status}`,
          );
        }
        if (request.body.answers.length !== clarification.questions.length) {
          throw new AppError({
            status: 400,
            code: 'insights.advisor_answers_count',
            title: 'Bad Request',
            detail: `${String(clarification.questions.length)} answer(s) expected`,
            family: 'user',
          });
        }
        const answers: string[] = [];
        for (const raw of request.body.answers) {
          const text = raw.replace(/\s+/gu, ' ').trim();
          if ([...text].length > ADVISOR_ANSWER_MAX) {
            const refused = await transitionAdvisorSession(database, context, {
              sessionId: row.id,
              from: ['clarifying'],
              to: 'refused',
              fields: { refusal: 'answer.too_long' },
            });
            return reply.code(200).send(await detail(userId, refused ?? row));
          }
          const pre = text.length === 0 ? null : precheckQuestion(text);
          if (pre !== null && pre.kind === 'refused') {
            const refused = await transitionAdvisorSession(database, context, {
              sessionId: row.id,
              from: ['clarifying'],
              to: 'refused',
              fields: { refusal: pre.refusal.replace(/^question\./u, 'answer.') },
            });
            return reply.code(200).send(await detail(userId, refused ?? row));
          }
          answers.push(text);
        }
        const moved = await database.transaction(async (tx) => {
          const next = await transitionAdvisorSession(tx, context, {
            sessionId: row.id,
            from: ['clarifying'],
            to: 'gathering',
            fields: { answers },
          });
          if (next === null) return null;
          await enqueueAdvisorStep(platformExecutor(tx), {
            userId,
            sessionId: row.id,
            stage: 'answers',
            correlationId: context.correlationId,
          });
          return next;
        });
        if (moved === null)
          throw conflict('insights.advisor_not_awaiting_answers', `session ${row.id} moved`);
        return reply.code(202).send(await detail(userId, moved));
      },
    );

    app.post(
      '/advisor/sessions/:sessionId/pick',
      {
        schema: {
          operationId: 'pickAdvisorOption',
          summary: 'Pick one of the options, and let the advisor write the plan',
          description:
            'Needs a session. Only while the session awaits a pick, and only an option it shows ' +
            '(each with its cost). 202 `planning`: the worker writes the steps, each a link to a ' +
            'screen of this app — nothing is ever done for you.',
          tags: ['insights'],
          params: z.object({ sessionId: z.uuid() }),
          body: z.object({ optionId: z.string().regex(/^o[1-4]$/u) }),
          response: { 202: advisorSessionDetailSchema, ...problems(400, 401, 404, 409) },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const userId = session.userId;
        const context = { userId, clock, correlationId: correlationIdOf(request.id) };
        const row = await sessionOr404(userId, request.params.sessionId);
        if (row.status !== 'awaiting_pick') {
          throw conflict(
            'insights.advisor_not_awaiting_pick',
            `session ${row.id} is ${row.status}`,
          );
        }
        const shown = advisorSessionWire(row, []).options ?? [];
        if (!shown.some((option) => option.id === request.body.optionId)) {
          throw new AppError({
            status: 400,
            code: 'insights.advisor_option_unknown',
            title: 'Bad Request',
            detail: `no option ${request.body.optionId} in this session`,
            family: 'user',
          });
        }
        const moved = await database.transaction(async (tx) => {
          const next = await transitionAdvisorSession(tx, context, {
            sessionId: row.id,
            from: ['awaiting_pick'],
            to: 'planning',
            fields: { pickedOption: request.body.optionId },
          });
          if (next === null) return null;
          await enqueueAdvisorStep(platformExecutor(tx), {
            userId,
            sessionId: row.id,
            stage: 'pick',
            correlationId: context.correlationId,
          });
          return next;
        });
        if (moved === null)
          throw conflict('insights.advisor_not_awaiting_pick', `session ${row.id} moved`);
        return reply.code(202).send(await detail(userId, moved));
      },
    );

    app.post(
      '/advisor/sessions/:sessionId/cancel',
      {
        schema: {
          operationId: 'cancelAdvisorSession',
          summary: 'Close an advisor session; a step running is asked to stop',
          tags: ['insights'],
          params: z.object({ sessionId: z.uuid() }),
          response: { 200: advisorSessionDetailSchema, ...problems(401, 404, 409) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const userId = session.userId;
        const context = { userId, clock, correlationId: correlationIdOf(request.id) };
        const row = await sessionOr404(userId, request.params.sessionId);
        if (!ADVISOR_CANCELLABLE.includes(row.status)) {
          throw conflict('insights.advisor_session_closed', `session ${row.id} is ${row.status}`);
        }
        const closed = await transitionAdvisorSession(database, context, {
          sessionId: row.id,
          from: ADVISOR_CANCELLABLE,
          to: 'cancelled',
          fields: { errorCode: 'holder_cancelled' },
        });
        // Kill level 4: a step's run in flight is asked to stop; its barrier discards the reply.
        for (const step of await listAdvisorSteps(database, userId, row.id)) {
          if (step.outcome === null) await requestRunCancel(database, context, step.runId);
        }
        return detail(userId, closed ?? (await sessionOr404(userId, row.id)));
      },
    );

    app.get(
      '/advisor/settings',
      {
        schema: {
          operationId: 'getAdvisorSettings',
          summary: 'The advisor’s own hosted consent (D31)',
          tags: ['insights'],
          response: { 200: advisorSettingsSchema, ...problems(401) },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        return settingsView(session.userId);
      },
    );

    app.put(
      '/advisor/settings',
      {
        schema: {
          operationId: 'setAdvisorSettings',
          summary: 'Tick or untick the advisor’s hosted consent, or choose its provider',
          description:
            'D31: the advisor runs on the local model unless this is ticked. Ticking names the ' +
            'exact text’s sha256; a reworded consent is not covered by an old tick (409 ' +
            '`insights.advisor_consent_changed`). A hosted provider also needs its own standing ' +
            'consent and key in Settings, Language model. Needs a fresh session.',
          tags: ['insights'],
          body: z.object({
            hostedConsent: z.boolean().optional(),
            consentTextSha256: z.string().optional(),
            hostedProvider: z.enum(HOSTED).nullable().optional(),
          }),
          response: { 200: advisorSettingsSchema, ...problems(400, 401, 403, 409) },
        },
      },
      async (request) => {
        const session = await guards.requireFreshSession(request);
        const body = request.body;
        try {
          await writeAdvisorSettings(
            executor,
            { userId: session.userId, clock },
            {
              ...(body.hostedConsent === undefined
                ? {}
                : {
                    hostedConsentTextHash: body.hostedConsent
                      ? (body.consentTextSha256 ?? '')
                      : null,
                  }),
              ...(body.hostedProvider === undefined ? {} : { hostedProvider: body.hostedProvider }),
            },
          );
        } catch (error) {
          if (error instanceof AdvisorConsentMismatch) {
            throw conflict(
              'insights.advisor_consent_changed',
              'The consent text changed since it was shown. Read it again before ticking.',
            );
          }
          throw error;
        }
        return settingsView(session.userId);
      },
    );
  };
};
