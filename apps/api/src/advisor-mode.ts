// SPDX-License-Identifier: MIT
/**
 * WP 11.5d: Ask PersonalFi, advisor mode — the composition root's half.
 * `@ctx/insights` owns the protocol (the six query types' requests,
 * validators, gate, approvals, run rows, the session and its steps, the
 * watcher); `@advisor/local-model` owns the prompts and the calls; the
 * catalogue (11.5b) and the knowledge base (11.5a) are bound here as they are
 * for Ask PersonalFi.
 *
 *   * `createAdvisorRuntime` — which model runs the protocol for a holder.
 *     **D31**: a hosted provider only under the advisor's *own* consent (a
 *     tick-box separate from the narrator's, `advisor_settings`), on the
 *     provider the holder chose for it (default: the narrator's own), with
 *     the narrator's standing consent and key for that provider and its
 *     hourly window. Unticked — or a hosted provider unavailable — the local
 *     model runs it: the narrator's pin (the environment's in the worker).
 *     Off is off. Preview mode (the api) builds rejecting transports: **the
 *     api renders and approves, it never calls a model**.
 *   * `createAdvisorStepJob` — `insights.advisor_step`, in the worker only.
 *   * `createAdvisorFollowUpJob` — `insights.advisor_follow_up`: the watchers,
 *     no model.
 */
import {
  createHostedAdvisorAdapter,
  createHostedAskCompileAdapter,
  createLocalAdvisorAdapter,
  createLocalAskCompileAdapter,
  HOSTED_DEFAULT_MODELS,
  HOSTED_TIMEOUT_CEILING_MS,
  type AdvisorModelStep,
  type HostedProvider,
} from '@advisor/local-model';
import type { Database } from '@core/db';
import { newId, systemClock, todayIn, type Clock } from '@core/kernel';
import { defineJob, type JobHandlerRegistration } from '@core/platform';
import {
  ADVISOR_FOLLOW_UP_JOB_KIND,
  ADVISOR_STEP_JOB_KIND,
  advisorHostedConsented,
  ensureAdvisorStepAdvisors,
  ensureFollowUpAdvisor,
  evaluateAdvisorWatcher,
  listTrackedAdvisorSessions,
  readAdvisorSettings,
  runAdvisorPass,
  type AdvisorModels,
  type AdvisorPassResult,
  type AdvisorStepJobPayload,
  type InsightsExecutor,
  type RunSwitches,
} from '@ctx/insights';
import type { MonteCarloRunner } from '@ctx/planning';
import { createAdvisorCatalogueDependencies } from './advisor-catalogue.ts';
import type { ExplainRuntimeOptions, ExplainUnavailableModel } from './insight-explain.ts';
import { createAdvisorKnowledgeBase } from './knowledge-base.ts';

export type AdvisorUnavailableModel = ExplainUnavailableModel | 'advisor_consent_required';

export interface AdvisorResolution {
  readonly provider: 'ollama' | HostedProvider | 'off';
  readonly egress: 'local' | 'hosted' | null;
  readonly models: AdvisorModels | null;
  readonly reason: AdvisorUnavailableModel | null;
  /** The advisor's own hosted consent (D31) covers today's text. */
  readonly hostedConsented: boolean;
  /** Ticked, but the hosted provider could not be used: why, and the local model ran instead. */
  readonly hostedFallback: string | null;
}

export interface AdvisorRuntime {
  resolve(userId: string): Promise<AdvisorResolution>;
}

export interface AdvisorRuntimeOptions extends ExplainRuntimeOptions {
  /** Where the advisor's own consent is read. */
  readonly database: Database;
  /** The api's `config.localModelPin`: the local model's name and digest, no endpoint. */
  readonly localModelPin?: { readonly name: string; readonly digest: string } | undefined;
}

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

const STEPS: readonly AdvisorModelStep[] = ['clarify', 'options', 'tradeoffs', 'plan', 'judge'];

export function createAdvisorRuntime(options: AdvisorRuntimeOptions): AdvisorRuntime {
  const preview = options.mode === 'preview';
  const clock = options.clock ?? systemClock;

  async function local(
    userId: string,
    narratorLabel: string | null,
  ): Promise<{ readonly models: AdvisorModels } | { readonly reason: AdvisorUnavailableModel }> {
    const stored = await options.stores.settings(userId);
    const environment =
      options.localModel ??
      (preview && options.localModelPin !== undefined
        ? { endpoint: '', ...options.localModelPin }
        : undefined);
    const pin = narratorLabel === null ? null : pinOfLabel(narratorLabel);
    const config = environment ?? stored.ollama ?? (pin === null ? null : { endpoint: '', ...pin });
    if (config === null) return { reason: 'not_configured' };
    const token = await options.stores.storedKey(userId, 'ollama');
    if (token === 'unopenable') return { reason: 'key_unopenable' };
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
      const steps = Object.fromEntries(
        STEPS.map((step) => [step, createLocalAdvisorAdapter(step, adapterConfig, deps)]),
      ) as Record<AdvisorModelStep, ReturnType<typeof createLocalAdvisorAdapter>>;
      return {
        models: Object.freeze({
          provider: 'ollama' as const,
          egress: 'local' as const,
          gather: createLocalAskCompileAdapter(adapterConfig, deps),
          ...steps,
          windowLeft: () => null,
        }),
      };
    } catch {
      options.logger?.warn(
        { event: 'advisor.endpoint_refused', userId },
        'the local endpoint for the advisor is refused by the local-endpoint policy',
      );
      return { reason: 'endpoint_refused' };
    }
  }

  async function hosted(
    userId: string,
    provider: HostedProvider,
    narratorModel: string | null,
  ): Promise<{ readonly models: AdvisorModels } | { readonly reason: AdvisorUnavailableModel }> {
    const stored = await options.stores.settings(userId);
    // The narrator's standing consent to this provider, as for every hosted call.
    if (!stored.consented.has(provider)) return { reason: 'consent_required' };
    const file = options.fileKeys[provider];
    let key: { reveal(): string } | null = file ?? null;
    if (key === null) {
      const storedKey = await options.stores.storedKey(userId, provider);
      if (storedKey === 'unopenable') return { reason: 'key_unopenable' };
      key = storedKey;
    }
    if (key === null) return { reason: 'key_missing' };
    const budget = options.narrator.budgets.get(provider);
    const config = {
      provider,
      model: narratorModel ?? stored.models[provider] ?? HOSTED_DEFAULT_MODELS[provider],
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
    const steps = Object.fromEntries(
      STEPS.map((step) => [step, createHostedAdvisorAdapter(step, config, deps)]),
    ) as Record<AdvisorModelStep, ReturnType<typeof createHostedAdvisorAdapter>>;
    return {
      models: Object.freeze({
        provider,
        egress: 'hosted' as const,
        gather: createHostedAskCompileAdapter(config, deps),
        ...steps,
        windowLeft: () => (budget === undefined ? null : budget.remaining(clock.nowMs())),
      }),
    };
  }

  async function resolve(userId: string): Promise<AdvisorResolution> {
    const narrator = await options.narrator.resolve(userId);
    const settings = await readAdvisorSettings(
      options.database as unknown as InsightsExecutor,
      userId,
    );
    const consented = advisorHostedConsented(settings);
    const none = (
      reason: AdvisorUnavailableModel,
      provider: AdvisorResolution['provider'] = narrator.provider,
    ): AdvisorResolution => ({
      provider,
      egress: null,
      models: null,
      reason,
      hostedConsented: consented,
      hostedFallback: null,
    });
    // Off is off: no model of any kind.
    if (narrator.provider === 'off') return none('off');

    let hostedFallback: string | null = null;
    if (consented) {
      // D31: the advisor's own tick-box. The provider the holder chose for it, else the narrator's.
      const provider =
        settings.hostedProvider ?? (narrator.provider === 'ollama' ? null : narrator.provider);
      if (provider === null) {
        hostedFallback = 'no_hosted_provider';
      } else {
        const narratorModel =
          narrator.provider === provider && narrator.narrator !== null
            ? narrator.narrator.modelId
            : null;
        const outcome = await hosted(userId, provider, narratorModel);
        if ('models' in outcome) {
          return {
            provider,
            egress: 'hosted',
            models: outcome.models,
            reason: null,
            hostedConsented: true,
            hostedFallback: null,
          };
        }
        hostedFallback = outcome.reason;
      }
    }
    // Unticked (the default), or ticked with no usable hosted provider: the local model.
    const outcome = await local(
      userId,
      narrator.provider === 'ollama' && narrator.narrator !== null ? narrator.narrator.label : null,
    );
    if ('models' in outcome) {
      return {
        provider: 'ollama',
        egress: 'local',
        models: outcome.models,
        reason: null,
        hostedConsented: consented,
        hostedFallback,
      };
    }
    // No local model. A hosted narrator the holder has not ticked the advisor's box for is
    // not used: that is D31's rule, and the screen says which box would change it.
    if (!consented && narrator.provider !== 'ollama')
      return none('advisor_consent_required', 'ollama');
    return none(outcome.reason, 'ollama');
  }

  return Object.freeze({ resolve });
}

// ---------------------------------------------------------------------------
// The jobs
// ---------------------------------------------------------------------------

export interface AdvisorJobDependencies {
  readonly database: Database;
  readonly runtime: AdvisorRuntime;
  readonly switches: RunSwitches;
  /** The holder's IANA zone (D6: one holder per deployment). */
  readonly timeZone: string;
  readonly monteCarlo: MonteCarloRunner | null;
  /** `config.secrets.advisor_token_secret`, revealed. */
  readonly tokenSecret: string;
  readonly clock?: Clock;
  /** Tests only. */
  readonly runWatchPollMs?: number;
}

function catalogueOf(dependencies: AdvisorJobDependencies, clock: Clock) {
  return createAdvisorCatalogueDependencies({
    database: dependencies.database,
    clock,
    timeZone: dependencies.timeZone,
    monteCarlo: dependencies.monteCarlo,
    tokenSecret: dependencies.tokenSecret,
  });
}

/** One session's pass. Exported for the api-db tests, the red team and the evaluation harness. */
export async function runAdvisorStepPass(
  dependencies: AdvisorJobDependencies,
  context: { readonly userId: string; readonly correlationId: string; readonly sessionId: string },
): Promise<AdvisorPassResult> {
  const clock = dependencies.clock ?? systemClock;
  const { database } = dependencies;
  const ctx = { userId: context.userId, clock, correlationId: context.correlationId };
  await ensureAdvisorStepAdvisors(database, ctx);
  const resolution = await dependencies.runtime.resolve(context.userId);
  return runAdvisorPass(
    database,
    ctx,
    {
      switches: dependencies.switches,
      models: resolution.models,
      catalogue: catalogueOf(dependencies, clock),
      knowledge: createAdvisorKnowledgeBase(),
      ...(dependencies.runWatchPollMs === undefined
        ? {}
        : { runWatchPollMs: dependencies.runWatchPollMs }),
    },
    { sessionId: context.sessionId, trigger: 'manual' },
  );
}

/** `insights.advisor_step`: concurrency 1 (the model is one), never retried, in the worker only. */
export function createAdvisorStepJob(dependencies: AdvisorJobDependencies): JobHandlerRegistration {
  return defineJob<AdvisorStepJobPayload>(
    ADVISOR_STEP_JOB_KIND,
    async (payload, job) => {
      if (
        payload === null ||
        typeof payload !== 'object' ||
        typeof payload.sessionId !== 'string'
      ) {
        return;
      }
      const result = await runAdvisorStepPass(dependencies, {
        userId: job.userId,
        correlationId: job.correlationId ?? newId(),
        sessionId: payload.sessionId,
      });
      job.logger.info(
        {
          job: ADVISOR_STEP_JOB_KIND,
          sessionId: payload.sessionId,
          status: result.status,
          modelCalls: result.modelCalls,
          refusal: result.session?.refusal ?? null,
          errorCode: result.session?.errorCode ?? null,
        },
        'advisor: pass finished',
      );
    },
    { concurrency: 1 },
  );
}

/** Every tracked session's watcher, checked once. No model. */
export async function runAdvisorFollowUps(
  dependencies: Omit<AdvisorJobDependencies, 'runtime' | 'switches'>,
  context: { readonly userId: string; readonly correlationId: string },
): Promise<number> {
  const clock = dependencies.clock ?? systemClock;
  const ctx = { userId: context.userId, clock, correlationId: context.correlationId };
  await ensureFollowUpAdvisor(dependencies.database, ctx);
  const catalogue = createAdvisorCatalogueDependencies({
    database: dependencies.database,
    clock,
    timeZone: dependencies.timeZone,
    monteCarlo: dependencies.monteCarlo,
    tokenSecret: dependencies.tokenSecret,
  });
  let checked = 0;
  for (const session of await listTrackedAdvisorSessions(dependencies.database, context.userId)) {
    await evaluateAdvisorWatcher(dependencies.database, ctx, { catalogue }, session);
    checked += 1;
  }
  return checked;
}

/** `insights.advisor_follow_up`: the deterministic watchers, concurrency 1, never a model. */
export function createAdvisorFollowUpJob(
  dependencies: Omit<AdvisorJobDependencies, 'runtime' | 'switches'>,
): JobHandlerRegistration {
  return defineJob<Record<string, never>>(
    ADVISOR_FOLLOW_UP_JOB_KIND,
    async (_payload, job) => {
      const checked = await runAdvisorFollowUps(dependencies, {
        userId: job.userId,
        correlationId: job.correlationId ?? newId(),
      });
      job.logger.info(
        {
          job: ADVISOR_FOLLOW_UP_JOB_KIND,
          checked,
          day: todayIn(dependencies.clock ?? systemClock, dependencies.timeZone),
        },
        'advisor: follow-up watchers checked',
      );
    },
    { concurrency: 1 },
  );
}
