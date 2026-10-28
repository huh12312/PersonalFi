// SPDX-License-Identifier: MIT
/**
 * WP 11.5c: Ask PersonalFi, reporting mode — the composition root's half.
 * `@ctx/insights` owns the two query types (`ask.compile`, `ask.narrate`),
 * their gate, approvals, run rows, validators, the session row and the run;
 * `@advisor/local-model` owns the prompts and the calls; the catalogue (11.5b)
 * and the knowledge base (11.5a) are bound here as they are for their routes.
 *
 *   * `createAskRuntime` — which model compiles and narrates for a holder:
 *     **the narrator's own provider**, resolved through the narrator runtime's
 *     per-holder view exactly as `brief-narration.ts` resolves it (the local
 *     model by default with the narrator's pin; a hosted provider only under
 *     the narrator's WP 10.6 consent, with its key and its hourly window).
 *     Both steps on the same provider. Preview mode (the api) builds rejecting
 *     transports: **the api renders and approves, it never calls a model**.
 *   * `createAskJob` — `insights.ask`, in the worker only: compile → the
 *     catalogue calls (in process, under the holder's grants) → narrate.
 *   * `askProbeFor` — the controls self-test's reach into the narrate model
 *     (`ask_grounding`).
 */
import {
  ASK_CONTROL_FIGURE,
  createHostedAskCompileAdapter,
  createHostedAskNarrateAdapter,
  createLocalAskCompileAdapter,
  createLocalAskNarrateAdapter,
  HOSTED_DEFAULT_MODELS,
  HOSTED_TIMEOUT_CEILING_MS,
  type AskCompileModelAdapter,
  type AskNarrateModelAdapter,
  type HostedProvider,
} from '@advisor/local-model';
import type { Database } from '@core/db';
import { newId, systemClock, type Clock } from '@core/kernel';
import { defineJob, type JobHandlerRegistration } from '@core/platform';
import {
  ASK_JOB_KIND,
  ensureAskAdvisors,
  runAskSession,
  type AskJobPayload,
  type AskProbeModel,
  type AskRunResult,
  type RunSwitches,
} from '@ctx/insights';
import type { MonteCarloRunner } from '@ctx/planning';
import { createAdvisorCatalogueDependencies } from './advisor-catalogue.ts';
import type { ExplainRuntimeOptions, ExplainUnavailableModel } from './insight-explain.ts';
import { createAdvisorKnowledgeBase } from './knowledge-base.ts';

export interface AskResolution {
  readonly provider: 'ollama' | HostedProvider | 'off';
  readonly compile: AskCompileModelAdapter | null;
  readonly narrate: AskNarrateModelAdapter | null;
  readonly reason: ExplainUnavailableModel | null;
}

export interface AskRuntime {
  resolve(userId: string): Promise<AskResolution>;
}

export type AskRuntimeOptions = ExplainRuntimeOptions;

const PREVIEW_ONLY_LOCAL = Object.freeze({
  request: () =>
    Promise.reject(
      new Error('the api process holds no model endpoint: it renders and previews, it never calls'),
    ),
});
const PREVIEW_ONLY_HOSTED = (): Promise<never> =>
  Promise.reject(new Error('the api process never calls a hosted model'));

/** `name@sha256:<64 hex>` → its parts; `null` for anything else. */
function pinOfLabel(label: string): { readonly name: string; readonly digest: string } | null {
  const at = label.lastIndexOf('@sha256:');
  if (at <= 0) return null;
  return { name: label.slice(0, at), digest: label.slice(at + 1) };
}

export function createAskRuntime(options: AskRuntimeOptions): AskRuntime {
  const preview = options.mode === 'preview';

  async function resolve(userId: string): Promise<AskResolution> {
    const narrator = await options.narrator.resolve(userId);
    const none = (reason: ExplainUnavailableModel): AskResolution => ({
      provider: narrator.provider,
      compile: null,
      narrate: null,
      reason,
    });
    if (narrator.provider === 'off') return none('off');
    if (narrator.narrator === null) {
      const reason = narrator.reason ?? 'not_configured';
      return none(reason === 'off' ? 'off' : reason);
    }

    if (narrator.provider === 'ollama') {
      const stored = await options.stores.settings(userId);
      const configured = options.localModel ?? stored.ollama;
      const pin = configured === null ? pinOfLabel(narrator.narrator.label) : null;
      const config =
        configured ?? (pin === null ? null : { endpoint: stored.ollama?.endpoint ?? '', ...pin });
      if (config === null) return none('not_configured');
      const token = await options.stores.storedKey(userId, 'ollama');
      if (token === 'unopenable') return none('key_unopenable');
      try {
        const transport = preview ? PREVIEW_ONLY_LOCAL : options.localTransport;
        const adapterConfig = {
          endpoint: preview ? '' : config.endpoint,
          name: config.name,
          digest: config.digest,
          timeoutMs: preview ? 1_000 : options.timeoutMs,
          allowRemote: options.allowRemote,
        };
        const deps = {
          ...(transport === undefined ? {} : { transport }),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
          ...(options.clock === undefined ? {} : { clock: options.clock }),
          ...(token === null ? {} : { bearer: token }),
        };
        return {
          provider: 'ollama',
          compile: createLocalAskCompileAdapter(adapterConfig, deps),
          narrate: createLocalAskNarrateAdapter(adapterConfig, deps),
          reason: null,
        };
      } catch {
        options.logger?.warn(
          { event: 'ask.endpoint_refused', userId },
          'the local endpoint for Ask PersonalFi is refused by the local-endpoint policy',
        );
        return none('endpoint_refused');
      }
    }

    // A hosted narrator: its resolution already required the standing consent
    // and a key. The same key (a file wins), the narrator's model, its window.
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
    const hostedConfig = {
      provider,
      model: narrator.narrator.modelId ?? HOSTED_DEFAULT_MODELS[provider],
      timeoutMs: Math.min(options.timeoutMs, HOSTED_TIMEOUT_CEILING_MS),
      key,
    };
    const deps = {
      ...(preview
        ? { transport: PREVIEW_ONLY_HOSTED }
        : options.hostedTransport === undefined
          ? {}
          : { transport: options.hostedTransport }),
      ...(options.resolveHost === undefined ? {} : { resolve: options.resolveHost }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(budget === undefined ? {} : { budget }),
    };
    return {
      provider,
      compile: createHostedAskCompileAdapter(hostedConfig, deps),
      narrate: createHostedAskNarrateAdapter(hostedConfig, deps),
      reason: null,
    };
  }

  return Object.freeze({ resolve });
}

// ---------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------

export interface AskJobDependencies {
  readonly database: Database;
  readonly runtime: AskRuntime;
  readonly switches: RunSwitches;
  /** The holder's IANA zone (D6: one holder per deployment, as the other jobs read it). */
  readonly timeZone: string;
  readonly monteCarlo: MonteCarloRunner | null;
  /** `config.secrets.advisor_token_secret`, revealed. */
  readonly tokenSecret: string;
  readonly clock?: Clock;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

/** One question's pass. Exported for the api-db tests, the red team and the evaluation harness. */
export async function runAskPass(
  dependencies: AskJobDependencies,
  context: { readonly userId: string; readonly correlationId: string; readonly sessionId: string },
): Promise<AskRunResult> {
  const clock = dependencies.clock ?? systemClock;
  const { database } = dependencies;
  const ctx = { userId: context.userId, clock, correlationId: context.correlationId };
  await ensureAskAdvisors(database, ctx);
  const resolution = await dependencies.runtime.resolve(context.userId);
  return runAskSession(
    database,
    ctx,
    {
      switches: dependencies.switches,
      compileModel: resolution.compile,
      narrateModel: resolution.narrate,
      catalogue: createAdvisorCatalogueDependencies({
        database,
        clock,
        timeZone: dependencies.timeZone,
        monteCarlo: dependencies.monteCarlo,
        tokenSecret: dependencies.tokenSecret,
      }),
      knowledge: createAdvisorKnowledgeBase(),
      ...(dependencies.runWatchPollMs === undefined
        ? {}
        : { runWatchPollMs: dependencies.runWatchPollMs }),
    },
    { sessionId: context.sessionId, trigger: 'manual' },
  );
}

/** `insights.ask`: concurrency 1 (the model is one), never retried, in the worker only. */
export function createAskJob(dependencies: AskJobDependencies): JobHandlerRegistration {
  return defineJob<AskJobPayload>(
    ASK_JOB_KIND,
    async (payload, job) => {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        typeof payload.sessionId !== 'string'
      ) {
        return;
      }
      const result = await runAskPass(dependencies, {
        userId: job.userId,
        correlationId: job.correlationId ?? newId(),
        sessionId: payload.sessionId,
      });
      job.logger.info(
        {
          job: ASK_JOB_KIND,
          sessionId: payload.sessionId,
          status: result.status,
          modelCalls: result.modelCalls,
          refusal: result.session?.refusal ?? null,
          errorCode: result.session?.errorCode ?? null,
        },
        'Ask PersonalFi: pass finished',
      );
    },
    { concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// The controls self-test
// ---------------------------------------------------------------------------

/** WP 11.5c: the holder's Ask narration model's grounding probe, for `ask_grounding`. */
export function askProbeFor(runtime: AskRuntime) {
  return async (userId: string): Promise<AskProbeModel | null> => {
    const resolution = await runtime.resolve(userId);
    const adapter = resolution.narrate;
    if (adapter === null) return null;
    return {
      label: adapter.label,
      figure: ASK_CONTROL_FIGURE,
      probe: (request, signal) => adapter.controlProbe('ask_grounding', request, signal),
    };
  };
}
