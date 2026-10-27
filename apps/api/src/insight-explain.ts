// SPDX-License-Identifier: MIT
/**
 * WP 11.3: "Explain this" — the composition root's half. `@ctx/insights` owns
 * `insight.explain`'s subject, kill ladder, approval, run row, validator and
 * cache; `@advisor/local-model` owns the prompt and the call. This file joins
 * them:
 *
 *   * `createExplainRuntime` — which model explains for a holder: **the
 *     narrator's own provider**, resolved through the narrator runtime's
 *     per-holder view (`resolve(userId)`). The local model by default (the
 *     narrator's pin, its endpoint policy, digest pin, timeout and abort); a
 *     hosted provider only when the holder has made it the narrator under
 *     WP 10.6's consent — and then with the narrator's key and the narrator's
 *     hourly window (`budgets`). No consent of its own: the payload class is
 *     the narrator's (the same minimised findings envelope, the scopes bounded
 *     by the narrator's grant), so nothing beyond what the narrator already
 *     sends leaves the machine. Off is off.
 *   * `createExplainJob` — `insights.explain`, in the worker only: the api has
 *     no path to a model, so an explanation the cache does not hold is always
 *     run here (the WP 10.16 job pattern: the api answers 202, the screen
 *     polls).
 *   * `createExplainPrefetch` — the Brief's prefetch of its ranked items, at
 *     most five, each only if the holder could explain it now and the cache
 *     does not already hold it.
 *   * `explainProbeFor` — the controls self-test's reach into the explain
 *     model (`explain_grounding`).
 */
import {
  createHostedExplainAdapter,
  createLocalExplainAdapter,
  EXPLAIN_CONTROL_FIGURE,
  HOSTED_DEFAULT_MODELS,
  HOSTED_TIMEOUT_CEILING_MS,
  type ExplainModelAdapter,
  type HostedProvider,
  type LocalModelLogger,
  type LocalModelTransport,
} from '@advisor/local-model';
import type { Database } from '@core/db';
import { newId, systemClock, type Clock } from '@core/kernel';
import {
  defineJob,
  platformExecutor,
  type HttpTransport,
  type JobHandlerRegistration,
  type Resolver,
} from '@core/platform';
import {
  EXPLAIN_JOB_KIND,
  EXPLAIN_PREFETCH_MAX,
  INSIGHT_EXPLAIN_MANIFEST,
  buildExplainRequest,
  enqueueExplain,
  ensureInsightExplainAdvisor,
  explainUnavailable,
  findExplanation,
  isHealthComponentId,
  loadInsightExplainTarget,
  loadPillarExplainTarget,
  runInsightExplain,
  type ExplainJobPayload,
  type ExplainProbeModel,
  type ExplainSourceOutcome,
  type InsightExplainResult,
  type RunSwitches,
} from '@ctx/insights';
import type { NarratorRuntime, NarratorStores } from './narrator-wiring.ts';

// ---------------------------------------------------------------------------
// Which model explains for a holder
// ---------------------------------------------------------------------------

export type ExplainUnavailableModel =
  | 'off'
  | 'not_configured'
  | 'consent_required'
  | 'key_missing'
  | 'key_unopenable'
  | 'endpoint_refused';

export interface ExplainResolution {
  readonly provider: 'ollama' | HostedProvider | 'off';
  readonly adapter: ExplainModelAdapter | null;
  readonly reason: ExplainUnavailableModel | null;
}

export interface ExplainRuntime {
  resolve(userId: string): Promise<ExplainResolution>;
}

export interface ExplainRuntimeOptions {
  readonly mode: 'run' | 'preview';
  readonly narrator: Pick<NarratorRuntime, 'resolve' | 'budgets'>;
  readonly stores: NarratorStores;
  /** The worker's `config.localModel` (endpoint, name, digest); `undefined` in the api. */
  readonly localModel:
    { readonly endpoint: string; readonly name: string; readonly digest: string } | undefined;
  readonly timeoutMs: number;
  readonly allowRemote: boolean;
  /** The operator's non-empty key files (a file wins over a stored key, as for the narrator). */
  readonly fileKeys: Readonly<Partial<Record<HostedProvider, { reveal(): string } | undefined>>>;
  readonly logger?: LocalModelLogger;
  readonly clock?: Clock;
  /** Tests only. */
  readonly localTransport?: LocalModelTransport;
  readonly hostedTransport?: HttpTransport;
  readonly resolveHost?: Resolver;
}

/** The api renders and approves; it never calls a model. Every transport it builds says so. */
const PREVIEW_ONLY_LOCAL: LocalModelTransport = Object.freeze({
  request: () =>
    Promise.reject(
      new Error('the api process holds no model endpoint: it renders and previews, it never calls'),
    ),
});
const PREVIEW_ONLY_HOSTED: HttpTransport = () =>
  Promise.reject(new Error('the api process never calls a hosted model'));

/** `name@sha256:<64 hex>` → its parts; `null` for anything else. */
function pinOfLabel(label: string): { readonly name: string; readonly digest: string } | null {
  const at = label.lastIndexOf('@sha256:');
  if (at <= 0) return null;
  return { name: label.slice(0, at), digest: label.slice(at + 1) };
}

export function createExplainRuntime(options: ExplainRuntimeOptions): ExplainRuntime {
  const preview = options.mode === 'preview';

  async function resolve(userId: string): Promise<ExplainResolution> {
    const narrator = await options.narrator.resolve(userId);
    const none = (reason: ExplainUnavailableModel): ExplainResolution => ({
      provider: narrator.provider,
      adapter: null,
      reason,
    });
    if (narrator.provider === 'off') return none('off');
    if (narrator.narrator === null) {
      const reason = narrator.reason ?? 'not_configured';
      return none(reason === 'off' ? 'off' : reason);
    }

    if (narrator.provider === 'ollama') {
      const stored = await options.stores.settings(userId);
      // The environment wins over Settings, as for the narrator. In the api the
      // environment carries only the pin: the narrator's label is
      // `name@sha256:digest`, exactly what rendering and approving need.
      const configured = options.localModel ?? stored.ollama;
      const pin = configured === null ? pinOfLabel(narrator.narrator.label) : null;
      const config =
        configured ?? (pin === null ? null : { endpoint: stored.ollama?.endpoint ?? '', ...pin });
      if (config === null) return none('not_configured');
      const token = await options.stores.storedKey(userId, 'ollama');
      if (token === 'unopenable') return none('key_unopenable');
      try {
        const transport = preview ? PREVIEW_ONLY_LOCAL : options.localTransport;
        const adapter = createLocalExplainAdapter(
          {
            endpoint: preview ? '' : config.endpoint,
            name: config.name,
            digest: config.digest,
            timeoutMs: preview ? 1_000 : options.timeoutMs,
            allowRemote: options.allowRemote,
          },
          {
            ...(transport === undefined ? {} : { transport }),
            ...(options.logger === undefined ? {} : { logger: options.logger }),
            ...(options.clock === undefined ? {} : { clock: options.clock }),
            ...(token === null ? {} : { bearer: token }),
          },
        );
        return { provider: 'ollama', adapter, reason: null };
      } catch {
        options.logger?.warn(
          { event: 'insight_explain.endpoint_refused', userId },
          'the local endpoint for explanations is refused by the local-endpoint policy',
        );
        return none('endpoint_refused');
      }
    }

    // A hosted narrator: the narrator's resolution already required its
    // standing consent and a key. The same key (a file wins), the narrator's
    // model, and the narrator's hourly window.
    const provider = narrator.provider;
    const file = options.fileKeys[provider];
    let key: { reveal(): string } | null = file ?? null;
    if (key === null) {
      const storedKey = await options.stores.storedKey(userId, provider);
      if (storedKey === 'unopenable') return none('key_unopenable');
      key = storedKey;
    }
    if (key === null) return none('key_missing');
    const budget = options.narrator.budgets.get(provider);
    const adapter = createHostedExplainAdapter(
      {
        provider,
        model: narrator.narrator.modelId ?? HOSTED_DEFAULT_MODELS[provider],
        timeoutMs: Math.min(options.timeoutMs, HOSTED_TIMEOUT_CEILING_MS),
        key,
      },
      {
        ...(preview
          ? { transport: PREVIEW_ONLY_HOSTED }
          : options.hostedTransport === undefined
            ? {}
            : { transport: options.hostedTransport }),
        ...(options.resolveHost === undefined ? {} : { resolve: options.resolveHost }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(budget === undefined ? {} : { budget }),
      },
    );
    return { provider, adapter, reason: null };
  }

  return Object.freeze({ resolve });
}

// ---------------------------------------------------------------------------
// The subject of a job or a route
// ---------------------------------------------------------------------------

/** Load the entity named by a job's payload or a route's path. */
export async function loadExplainTarget(
  database: Database,
  userId: string,
  entity: { readonly entityKind: ExplainJobPayload['entityKind']; readonly entityId: string },
): Promise<ExplainSourceOutcome> {
  if (entity.entityKind === 'insight') {
    return loadInsightExplainTarget(database, userId, entity.entityId);
  }
  if (!isHealthComponentId(entity.entityId)) return { status: 'not_found' };
  return loadPillarExplainTarget(database, userId, entity.entityId);
}

/** The digest a run of `target` would carry now — the cache key. Pure apart from the clock. */
export function explainDigestOf(
  target: Extract<ExplainSourceOutcome, { status: 'found' }>['target'],
  clock: Clock,
): string {
  return buildExplainRequest({
    target,
    now: clock.now(),
    timeoutMs: INSIGHT_EXPLAIN_MANIFEST.limits.timeout_ms,
    maxResponseBytes: INSIGHT_EXPLAIN_MANIFEST.limits.max_response_bytes,
  }).digest;
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface ExplainJobDependencies {
  readonly database: Database;
  readonly runtime: ExplainRuntime;
  readonly switches: RunSwitches;
  readonly clock?: Clock;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

export interface ExplainPassResult {
  readonly outcome: 'not_found' | 'not_explainable' | 'no_model' | InsightExplainResult['status'];
  readonly result: InsightExplainResult | null;
}

/** One explanation for one holder. Exported for the api-db tests. */
export async function runExplainPass(
  dependencies: ExplainJobDependencies,
  context: {
    readonly userId: string;
    readonly correlationId: string;
    readonly payload: ExplainJobPayload;
  },
): Promise<ExplainPassResult> {
  const clock = dependencies.clock ?? systemClock;
  const ctx = { userId: context.userId, clock, correlationId: context.correlationId };
  const loaded = await loadExplainTarget(dependencies.database, context.userId, context.payload);
  if (loaded.status !== 'found') return { outcome: loaded.status, result: null };
  await ensureInsightExplainAdvisor(dependencies.database, ctx);
  const resolution = await dependencies.runtime.resolve(context.userId);
  // No model (Off, nothing configured): no run row — the route already said
  // "unavailable"; a refusal row per tap would bury the inspector.
  if (resolution.adapter === null) return { outcome: 'no_model', result: null };
  const result = await runInsightExplain(
    dependencies.database,
    ctx,
    {
      switches: dependencies.switches,
      model: resolution.adapter,
      ...(dependencies.runWatchPollMs === undefined
        ? {}
        : { runWatchPollMs: dependencies.runWatchPollMs }),
    },
    { target: loaded.target, trigger: context.payload.trigger },
  );
  return { outcome: result.status, result };
}

/** `insights.explain`: concurrency 1 (the model is one), never retried, in the worker only. */
export function createExplainJob(dependencies: ExplainJobDependencies): JobHandlerRegistration {
  return defineJob<ExplainJobPayload>(
    EXPLAIN_JOB_KIND,
    async (payload, job) => {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        (payload.entityKind !== 'insight' && payload.entityKind !== 'health_pillar') ||
        typeof payload.entityId !== 'string'
      ) {
        return;
      }
      const pass = await runExplainPass(dependencies, {
        userId: job.userId,
        correlationId: job.correlationId ?? newId(),
        payload: {
          entityKind: payload.entityKind,
          entityId: payload.entityId,
          trigger: payload.trigger === 'event' ? 'event' : 'manual',
        },
      });
      job.logger.info(
        {
          job: EXPLAIN_JOB_KIND,
          entityKind: payload.entityKind,
          outcome: pass.outcome,
          runId: pass.result?.runId ?? null,
          replyRefusal: pass.result?.replyRefusal ?? null,
          errorCode: pass.result?.errorCode ?? null,
        },
        'Explain this: pass finished',
      );
    },
    { concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// The Brief's prefetch
// ---------------------------------------------------------------------------

/**
 * The Brief job's `explainPrefetch`: for each of the week's ranked items — at
 * most `EXPLAIN_PREFETCH_MAX`, enforced here a second time — enqueue
 * `insights.explain` only when the item is explainable, the holder could
 * explain it now (narrator on, kind and advisor switches on, the shape
 * approved, its scopes granted) and the cache holds nothing for its digest.
 * Returns how many were enqueued.
 */
export function createExplainPrefetch(dependencies: {
  readonly database: Database;
  readonly runtime: ExplainRuntime;
  readonly switches: RunSwitches;
  readonly clock?: Clock;
}) {
  return async (input: {
    readonly userId: string;
    readonly insightIds: readonly string[];
    readonly correlationId: string;
  }): Promise<number> => {
    const clock = dependencies.clock ?? systemClock;
    const { database } = dependencies;
    const resolution = await dependencies.runtime.resolve(input.userId);
    if (resolution.adapter === null) return 0;
    await ensureInsightExplainAdvisor(database, {
      userId: input.userId,
      clock,
      correlationId: input.correlationId,
    });
    let enqueued = 0;
    for (const insightId of input.insightIds.slice(0, EXPLAIN_PREFETCH_MAX)) {
      const loaded = await loadInsightExplainTarget(database, input.userId, insightId);
      if (loaded.status !== 'found') continue;
      const unavailable = await explainUnavailable(database, dependencies.switches, {
        userId: input.userId,
        templateHash: resolution.adapter.templateHash,
        target: loaded.target,
      });
      if (unavailable !== null) continue;
      const digest = explainDigestOf(loaded.target, clock);
      const cached = await findExplanation(database, input.userId, {
        entityKind: 'insight',
        entityId: insightId,
        evidenceDigest: digest,
      });
      if (cached !== null) continue;
      await enqueueExplain(platformExecutor(database), {
        userId: input.userId,
        entityKind: 'insight',
        entityId: insightId,
        digest,
        trigger: 'event',
        correlationId: input.correlationId,
      });
      enqueued += 1;
    }
    return enqueued;
  };
}

// ---------------------------------------------------------------------------
// The controls self-test
// ---------------------------------------------------------------------------

/** WP 11.3: the holder's explain model's grounding probe, for `explain_grounding`. */
export function explainProbeFor(runtime: ExplainRuntime) {
  return async (userId: string): Promise<ExplainProbeModel | null> => {
    const resolution = await runtime.resolve(userId);
    const adapter = resolution.adapter;
    if (adapter === null) return null;
    return {
      label: adapter.label,
      figure: EXPLAIN_CONTROL_FIGURE,
      probe: (request, signal) => adapter.controlProbe('explain_grounding', request, signal),
    };
  };
}
