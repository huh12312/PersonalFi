// SPDX-License-Identifier: MIT
/**
 * "Explain this" (WP 11.3; 11 §3.2's Explain-this row, §4's `insight.explain`).
 *
 * | Operation | Guard | What |
 * | --- | --- | --- |
 * | `POST /insights/{insightId}/explain` | session + the approval gate | the explanation for the insight's evidence as it stands: 200 with it (or its refusal) when the cache holds one for this evidence digest; 200 `unavailable` with the reason when it cannot be asked for (the narrator Off, the payload not approved, a scope not granted, a switch off); else 202 `computing` — `insights.explain` is enqueued for the worker and the screen polls GET |
 * | `GET /insights/{insightId}/explain` | session | the same answer without enqueueing anything: `idle` when nothing has been asked for this evidence yet, `failed` when the last run for it failed |
 * | `POST`/`GET /insights/health/{pillar}/explain` | as above | the same for a scored health pillar |
 *
 * The api has no path to a model: everything that calls one is the worker's
 * (the WP 10.16 job pattern). This process resolves the holder's explain
 * model in preview mode — for its template hash, which keys the approval — and
 * reads the cache, the job queue and the run inspector. Nothing here writes an
 * approval, a grant, a consent or a setting.
 */
import { HOSTED_DISPLAY_NAMES, type HostedProvider } from '@advisor/local-model';
import {
  HEALTH_COMPONENT_IDS,
  createRunSwitches,
  explainDedupeKey,
  enqueueExplain,
  explainUnavailable,
  findExplanation,
  latestExplainRun,
  type ExplainEntityKind,
  type RunSwitches,
  type StoredExplanation,
} from '@ctx/insights';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PLATFORM_FLAGS, createFlagService, platformExecutor } from '@core/platform';
import { correlationIdOf } from '../control-checks.ts';
import { explainDigestOf, loadExplainTarget, type ExplainRuntime } from '../insight-explain.ts';
import { ADVISOR_KIND_FLAGS, MODULE_FLAGS } from '../platform.ts';
import { AppError, problems } from '../problem.ts';
import { isoInstant } from '../wire.ts';
import type { RouteDeps } from './deps.ts';

const PROVIDERS = ['ollama', 'openai', 'openrouter', 'anthropic'] as const;

export const explainStateSchema = z
  .object({
    state: z.enum(['idle', 'computing', 'shown', 'refused', 'unavailable', 'failed']),
    entityKind: z.enum(['insight', 'health_pillar']),
    entityId: z.string(),
    /** Set when `state` is `shown`. Plain text; the screen renders no Markdown beyond the narrator's subset. */
    explanation: z
      .object({
        text: z.string(),
        provider: z.enum(PROVIDERS),
        /** The provider in words, for the badge: "Local model", "OpenAI", … */
        providerName: z.string(),
        /** `name@sha256:…` or `provider:model`, as the run recorded it. */
        model: z.string(),
        createdAt: isoInstant,
        runId: z.uuid(),
      })
      .nullable(),
    /** The validator's refusal class when `state` is `refused`. */
    refusal: z.string().nullable(),
    /** A code: why it is `unavailable` or `failed`. */
    reason: z.string().nullable(),
    /** The same, in words. */
    message: z.string().nullable(),
  })
  .meta({ id: 'InsightExplanationState' });

type ExplainStateWire = z.infer<typeof explainStateSchema>;

const UNAVAILABLE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  off: 'The language model is Off in Settings, so nothing can be explained.',
  not_configured: 'No language model is configured for you.',
  consent_required: 'The hosted provider has no standing consent: nothing may be sent to it.',
  key_missing: 'The language model provider has no key.',
  key_unopenable: 'The stored key cannot be opened (is the install unlocked?).',
  endpoint_refused: 'The local endpoint set in Settings is refused by the local-endpoint policy.',
  advisors_disabled: 'Advisors are switched off for this install.',
  module_disabled: 'Insights are switched off.',
  kind_disabled: 'The language model is switched off in Advisor management.',
  advisor_disabled: '"Explain this" is switched off in Advisor management.',
  advisor_quarantined: '"Explain this" is paused after repeated failures; see Advisor management.',
  payload_not_approved:
    'The payload "Explain this" sends has not been approved yet. Review and approve it in Advisor management.',
  scope_not_granted:
    'This finding is built from data you have not let the language model read. Grant it in Advisor management.',
  narration: 'This is wording, not a finding: explain the finding it words instead.',
  not_builtin: 'Only findings the built-in rules made can be explained.',
  no_evidence: 'This finding has no evidence rows to explain from.',
  source_run_unknown:
    'The run that made this finding is no longer on record, so its data cannot be bounded.',
  pillar_not_scored: 'This pillar is not scored, so there is nothing to explain yet.',
  health_not_computed: 'No health score has been computed yet.',
});

const FAILED_WORDS =
  'The language model did not answer this time. The evidence below is the arithmetic; you can ask again.';

function providerName(provider: string): string {
  return provider === 'ollama'
    ? 'Local model'
    : (HOSTED_DISPLAY_NAMES[provider as HostedProvider] ?? provider);
}

function shownOrRefused(
  entity: { readonly entityKind: ExplainEntityKind; readonly entityId: string },
  stored: StoredExplanation,
): ExplainStateWire {
  if (stored.text === null) {
    return {
      state: 'refused',
      ...entity,
      explanation: null,
      refusal: stored.refusal,
      reason: null,
      message: "The explanation didn't pass the checks; the evidence below is the arithmetic.",
    };
  }
  return {
    state: 'shown',
    ...entity,
    explanation: {
      text: stored.text,
      provider: stored.provider as (typeof PROVIDERS)[number],
      providerName: providerName(stored.provider),
      model: stored.model,
      createdAt: stored.createdAt.toISOString(),
      runId: stored.runId,
    },
    refusal: null,
    reason: null,
    message: null,
  };
}

/**
 * Kill levels 1 and 2 as this process reads them for "Explain this", uncached
 * (`ttlMs: 0`). The api is never configured with a model endpoint, so the
 * model half of level 2 is the holder's resolution (a template hash, or none),
 * which `explainUnavailable` adds; the flag half is `advisors.kind.local_model`.
 */
export function explainSwitchesOf(deps: Pick<RouteDeps, 'config' | 'database'>): RunSwitches {
  return createRunSwitches({
    advisorsEnabled: deps.config.env.ADVISORS_ENABLED,
    flags: createFlagService({
      db: platformExecutor(deps.database),
      defaults: [...PLATFORM_FLAGS, ...MODULE_FLAGS, ...ADVISOR_KIND_FLAGS],
      ttlMs: 0,
    }),
    configuredKinds: new Set(['builtin', 'local_model']),
  });
}

export interface ExplainRouteOptions {
  /** The api's preview-mode explain runtime: resolves and renders, never calls a model. */
  readonly runtime: ExplainRuntime;
  readonly switches: RunSwitches;
}

export const insightExplainRoutes = (
  deps: RouteDeps,
  options: ExplainRouteOptions,
): FastifyPluginAsyncZod => {
  const { guards, database, clock, pool } = deps;

  async function activeJob(key: string): Promise<boolean> {
    const result = await pool.query<{ status: string }>(
      `SELECT status FROM jobs WHERE dedupe_key = $1 AND status IN ('pending', 'running') LIMIT 1`,
      [key],
    );
    return result.rows.length > 0;
  }

  /** The one state machine both verbs share; `enqueue` is the POST's difference. */
  async function stateOf(
    userId: string,
    entity: { readonly entityKind: ExplainEntityKind; readonly entityId: string },
    enqueue: { readonly correlationId: string } | null,
  ): Promise<{ readonly status: 200 | 202; readonly body: ExplainStateWire }> {
    const unavailable = (reason: string): { status: 200; body: ExplainStateWire } => ({
      status: 200,
      body: {
        state: 'unavailable',
        ...entity,
        explanation: null,
        refusal: null,
        reason,
        message: UNAVAILABLE_WORDS[reason] ?? 'Explanations are not available right now.',
      },
    });
    const loaded = await loadExplainTarget(database, userId, entity);
    if (loaded.status === 'not_found') {
      throw new AppError({
        status: 404,
        code:
          entity.entityKind === 'insight'
            ? 'insights.insight_not_found'
            : 'insights.pillar_not_found',
        title: 'Not Found',
        detail: `no ${entity.entityKind === 'insight' ? 'insight' : 'pillar'} ${entity.entityId}`,
        family: 'user',
      });
    }
    if (loaded.status === 'not_explainable') return unavailable(loaded.reason);
    const resolution = await options.runtime.resolve(userId);
    if (resolution.adapter === null) return unavailable(resolution.reason ?? 'not_configured');
    const gate = await explainUnavailable(database, options.switches, {
      userId,
      templateHash: resolution.adapter.templateHash,
      target: loaded.target,
    });
    if (gate !== null) return unavailable(gate);

    const digest = explainDigestOf(loaded.target, clock);
    const cached = await findExplanation(database, userId, {
      entityKind: entity.entityKind,
      entityId: entity.entityId,
      evidenceDigest: digest,
    });
    if (cached !== null) return { status: 200, body: shownOrRefused(entity, cached) };

    const computing = {
      status: 202 as const,
      body: {
        state: 'computing' as const,
        ...entity,
        explanation: null,
        refusal: null,
        reason: null,
        message: null,
      },
    };
    const key = explainDedupeKey(userId, entity.entityKind, entity.entityId, digest);
    if (await activeJob(key)) return computing;
    if (enqueue !== null) {
      await enqueueExplain(platformExecutor(database), {
        userId,
        entityKind: entity.entityKind,
        entityId: entity.entityId,
        digest,
        trigger: 'manual',
        correlationId: enqueue.correlationId,
      });
      return computing;
    }
    const last = await latestExplainRun(database, userId, digest);
    if (last !== null && (last.status === 'failed' || last.status === 'cancelled')) {
      return {
        status: 200,
        body: {
          state: 'failed',
          ...entity,
          explanation: null,
          refusal: null,
          reason: last.errorCode ?? last.cancelReason ?? last.status,
          message: FAILED_WORDS,
        },
      };
    }
    return {
      status: 200,
      body: {
        state: 'idle',
        ...entity,
        explanation: null,
        refusal: null,
        reason: null,
        message: null,
      },
    };
  }

  const describePost =
    'Needs a session. Answers 200 with the explanation (or its refusal) when one exists for the ' +
    'evidence as it stands now, 200 `unavailable` with the reason when none can be asked for (the ' +
    'narrator Off, the payload not approved in Advisor management, a scope not granted, a switch ' +
    'off), else 202 `computing`: the worker is asked (this process never calls a model) and the ' +
    'screen polls GET. Writes no approval, grant, consent or setting.';
  const describeGet =
    'The same answer as POST without asking anything: `idle` when nothing has been asked for the ' +
    'evidence as it stands, `failed` when the last run for it failed.';

  return async (app) => {
    const insightParams = z.object({ insightId: z.uuid() });
    const pillarParams = z.object({ pillar: z.enum(HEALTH_COMPONENT_IDS) });

    app.post(
      '/insights/:insightId/explain',
      {
        schema: {
          operationId: 'explainInsight',
          summary: 'Explain this insight in plain words, from its evidence only',
          description: describePost,
          tags: ['insights'],
          params: insightParams,
          response: {
            200: explainStateSchema,
            202: explainStateSchema,
            ...problems(401, 404, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const answer = await stateOf(
          session.userId,
          { entityKind: 'insight', entityId: request.params.insightId },
          { correlationId: correlationIdOf(request.id) },
        );
        return reply.code(answer.status).send(answer.body);
      },
    );

    app.get(
      '/insights/:insightId/explain',
      {
        schema: {
          operationId: 'getInsightExplanation',
          summary: 'Where "Explain this" stands for this insight',
          description: describeGet,
          tags: ['insights'],
          params: insightParams,
          response: {
            200: explainStateSchema,
            202: explainStateSchema,
            ...problems(401, 404, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const answer = await stateOf(
          session.userId,
          { entityKind: 'insight', entityId: request.params.insightId },
          null,
        );
        return reply.code(answer.status).send(answer.body);
      },
    );

    app.post(
      '/insights/health/:pillar/explain',
      {
        schema: {
          operationId: 'explainHealthPillar',
          summary: 'Explain this health pillar in plain words, from its inputs only',
          description: describePost,
          tags: ['insights'],
          params: pillarParams,
          response: {
            200: explainStateSchema,
            202: explainStateSchema,
            ...problems(401, 404, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const answer = await stateOf(
          session.userId,
          { entityKind: 'health_pillar', entityId: request.params.pillar },
          { correlationId: correlationIdOf(request.id) },
        );
        return reply.code(answer.status).send(answer.body);
      },
    );

    app.get(
      '/insights/health/:pillar/explain',
      {
        schema: {
          operationId: 'getHealthPillarExplanation',
          summary: 'Where "Explain this" stands for this health pillar',
          description: describeGet,
          tags: ['insights'],
          params: pillarParams,
          response: {
            200: explainStateSchema,
            202: explainStateSchema,
            ...problems(401, 404, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const answer = await stateOf(
          session.userId,
          { entityKind: 'health_pillar', entityId: request.params.pillar },
          null,
        );
        return reply.code(answer.status).send(answer.body);
      },
    );
  };
};
