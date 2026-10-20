// SPDX-License-Identifier: MIT
/**
 * The narrator's half of the worker's composition root (WP 9.5; Phase 5 gate
 * C5-4, G5-6, B5b) — extracted from `worker.ts` so that the three things that
 * must run the narrator *as shipped* run this function and not a copy of it:
 *
 *   * `worker.ts`'s `main()`, which binds what it returns into `appModules`
 *     (`narratorModel`, `promptRenderer`, `localModelConfigured`);
 *   * `scripts/advisor-eval.ts --live` and `--brief`, the counted evaluation
 *     and the 5-item Brief measurement — the gate's G5-6 found both Phase 5
 *     live numbers taken on an adapter built with a reply format the worker
 *     never passed, a different template hash and a different query shape;
 *   * `apps/api/test/db/narrator-composition.test.ts`, which asserts through it
 *     that an accepted narration lands (B5b) and what format it sends.
 *
 * It takes **no `format` and no sampling options** on purpose: the adapter's
 * default `format` is the narrator's reply format (`@advisor/local-model`'s
 * `NARRATION_FORMAT`, pinned equal to `@ctx/insights`' `NARRATOR_REPLY_FORMAT`),
 * and there is no parameter through which a caller could measure a different
 * one. Importable from a plain script: nothing here reads config, opens a
 * database or boots anything (`worker.ts` cannot be imported outside Vitest).
 */
import {
  createHostedBudget,
  createHostedModelAdapter,
  createLocalModelAdapter,
  HOSTED_DEFAULT_MODELS,
  HOSTED_PROVIDERS,
  HOSTED_TIMEOUT_CEILING_MS,
  type HostedBudget,
  type HostedModelAdapter,
  type HostedModelKey,
  type HostedProvider,
  type LocalModelAdapter,
  type LocalModelAdapterConfig,
  type LocalModelLogger,
  type LocalModelTransport,
} from '@advisor/local-model';
import { systemClock, type Clock } from '@core/kernel';
import type { HttpTransport, Resolver } from '@core/platform';
import type { ControlProbeModel, HolderNarrator } from '@ctx/insights';

export interface NarratorWiringDeps {
  readonly logger?: LocalModelLogger;
  readonly clock?: Clock;
  /** Tests and the eval's loopback smoke only; production resolves through the policy. */
  readonly transport?: LocalModelTransport;
  /** WP 10.6: an optional bearer token for an Ollama endpoint behind a proxy (stored in Settings). */
  readonly bearer?: { reveal(): string };
}

export interface NarratorWiring {
  /** The adapter; its `promptRenderer` is what `appModules` binds for preview and approval. */
  readonly localModel: LocalModelAdapter;
  /**
   * What `insightsModule` wraps with `createNarratorAdvisor` — the adapter
   * itself: `LocalModelAdapter.run` satisfies `NarratorModelPort`
   * structurally, so there is nothing to adapt (W-C's own note).
   */
  readonly narratorModel: LocalModelAdapter;
}

/**
 * `undefined` exactly when no model is configured (`config.localModel`), the
 * W-A/W-C rule: then `insightsModule` registers no narrator either. Throws on
 * a malformed digest or an endpoint the local-endpoint policy refuses — boot
 * fails on purpose (`worker.ts`'s own comment).
 */
export function createNarratorWiring(
  config: LocalModelAdapterConfig | undefined,
  deps: NarratorWiringDeps = {},
): NarratorWiring | undefined {
  if (config === undefined) return undefined;
  const localModel = createLocalModelAdapter(config, {
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.transport === undefined ? {} : { transport: deps.transport }),
    ...(deps.bearer === undefined ? {} : { bearer: deps.bearer }),
  });
  return Object.freeze({ localModel, narratorModel: localModel });
}

// ---------------------------------------------------------------------------
// WP 10.6 (D30): the holder's own narrator, resolved per run
// ---------------------------------------------------------------------------
//
// Settings, Language model lets a holder choose the local model, a hosted
// provider with their own key (OpenAI, OpenRouter, Anthropic), or Off — and
// change it without a restart. `createNarratorRuntime` is the one place that
// answer becomes an adapter, for every process that needs one:
//
//   * the worker (`mode: 'run'`), whose `insightsModule` binds `forUser` to
//     `InsightsDependencies.narratorFor`, kill level 2's per-holder
//     configured-kinds, and the Brief's narration enqueue;
//   * the api (`mode: 'preview'`), whose preview and approval routes render
//     the holder's prompt and key the approval to the holder's provider and
//     model — and never call one: every transport it builds rejects.
//
// The local model is still built through `createNarratorWiring` above (the
// G5-6 rule: the worker, the counted eval and the composition test construct
// it the same way), and a hosted one through `@advisor/local-model`'s
// `createHostedModelAdapter`. With no settings row the answer is today's: the
// operator's environment, else nothing. A 30 s cache per holder, a generation
// counter and `invalidate()` — WP 10.1/10.4's registry shape — so the
// `insights.NarratorSettingsChanged` and `connections.ProviderCredentialsChanged`
// consumers drop it the moment a holder changes anything.

/** What a holder's settings say, read by the composition root (`narrator-stores.ts`). */
export interface NarratorSettingsSnapshot {
  readonly activeProvider: 'ollama' | 'openai' | 'openrouter' | 'anthropic' | 'off';
  /** No settings row: the environment decides, as before WP 10.6. */
  readonly hasRow: boolean;
  readonly models: Readonly<Partial<Record<HostedProvider, string | null>>>;
  readonly ollama: {
    readonly endpoint: string;
    readonly name: string;
    readonly digest: string;
  } | null;
  /** Hosted providers with a standing consent to the current consent text. */
  readonly consented: ReadonlySet<HostedProvider>;
}

export interface NarratorStores {
  settings(userId: string): Promise<NarratorSettingsSnapshot>;
  /** The holder's stored key for a provider: `null` none, `'unopenable'` a row that will not open. */
  storedKey(
    userId: string,
    provider: HostedProvider | 'ollama',
  ): Promise<HostedModelKey | 'unopenable' | null>;
}

/** Who narrates for a holder, and through what. `null` from `forUser` is Off or nothing configured. */
export interface ResolvedNarrator extends HolderNarrator {
  readonly provider: 'ollama' | HostedProvider;
  /** The model id (Ollama's name for the local model). */
  readonly modelId: string;
  /** `provider:model` for a hosted one, `name@sha256:…` for the local one — what the run records. */
  readonly label: string;
  /** Where the key came from, for a hosted provider. */
  readonly keySource: 'file' | 'stored' | null;
  /**
   * WP 10.16: the controls self-test's reach into this narrator — run mode
   * only (the worker). The preview runtime the api holds has none: the api
   * never calls a model.
   */
  readonly control?: ControlProbeModel;
}

export type NarratorUnavailableReason =
  | 'off'
  | 'not_configured'
  | 'consent_required'
  | 'key_missing'
  | 'key_unopenable'
  | 'endpoint_refused';

export interface NarratorResolution {
  readonly provider: 'ollama' | HostedProvider | 'off';
  readonly narrator: ResolvedNarrator | null;
  /** Why `narrator` is null. */
  readonly reason: NarratorUnavailableReason | null;
}

export interface NarratorRuntimeOptions {
  readonly mode: 'run' | 'preview';
  readonly stores: NarratorStores;
  /** The worker's full `config.localModel` (the environment), or undefined. */
  readonly localModel: LocalModelAdapterConfig | undefined;
  /** The api's `config.localModelPin`: name and digest without an endpoint. */
  readonly localModelPin?: { readonly name: string; readonly digest: string } | undefined;
  /** `LOCAL_MODEL_TIMEOUT_MS` and `LOCAL_MODEL_ALLOW_REMOTE`, for a model set in Settings and for hosted calls. */
  readonly timeoutMs: number;
  readonly allowRemote: boolean;
  /** The operator's non-empty secret files. A file wins over a stored key. */
  readonly fileKeys: Readonly<Partial<Record<HostedProvider, HostedModelKey | undefined>>>;
  readonly logger?: LocalModelLogger;
  readonly clock?: Clock;
  /** Tests only: the hosted adapters' transport and DNS. */
  readonly hostedTransport?: HttpTransport;
  readonly resolve?: Resolver;
  /** Tests only: the local adapter's transport. */
  readonly localTransport?: LocalModelTransport;
  /** Defaults to `NARRATOR_CACHE_TTL_MS`. */
  readonly cacheTtlMs?: number;
}

export interface NarratorRuntime {
  forUser(userId: string): Promise<ResolvedNarrator | null>;
  resolve(userId: string): Promise<NarratorResolution>;
  /** Drop every cached answer (a consumer saw a change). */
  invalidate(): void;
  readonly generation: () => number;
  /** One budget window per hosted provider for this runtime's life, shared by every holder. */
  readonly budgets: ReadonlyMap<HostedProvider, HostedBudget>;
}

export const NARRATOR_CACHE_TTL_MS = 30_000;

/** The api renders and approves; it never calls a model. Every transport it builds says so. */
const PREVIEW_ONLY_LOCAL: LocalModelTransport = Object.freeze({
  request: () =>
    Promise.reject(
      new Error('the api process holds no model endpoint: it renders and previews, it never calls'),
    ),
});
const PREVIEW_ONLY_HOSTED: HttpTransport = () =>
  Promise.reject(
    new Error('the api process never narrates: a hosted adapter here renders and previews only'),
  );

export function createNarratorRuntime(options: NarratorRuntimeOptions): NarratorRuntime {
  const ttl = options.cacheTtlMs ?? NARRATOR_CACHE_TTL_MS;
  const nowMs = (): number => (options.clock ?? systemClock).nowMs();
  const budgets = new Map<HostedProvider, HostedBudget>(
    HOSTED_PROVIDERS.map((provider) => [provider, createHostedBudget()]),
  );
  const timeoutMs = Math.min(options.timeoutMs, HOSTED_TIMEOUT_CEILING_MS);
  let generation = 0;
  const cache = new Map<
    string,
    {
      readonly expiresAt: number;
      readonly generation: number;
      readonly value: Promise<NarratorResolution>;
    }
  >();

  function local(
    config: { endpoint: string; name: string; digest: string },
    bearer: HostedModelKey | null,
  ): ResolvedNarrator {
    const preview = options.mode === 'preview';
    const transport = preview ? PREVIEW_ONLY_LOCAL : options.localTransport;
    const wiring = createNarratorWiring(
      {
        endpoint: preview ? '' : config.endpoint,
        name: config.name,
        digest: config.digest,
        timeoutMs: preview ? 1_000 : options.timeoutMs,
        allowRemote: options.allowRemote,
      },
      {
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(transport === undefined ? {} : { transport }),
        ...(bearer === null ? {} : { bearer }),
      },
    );
    if (wiring === undefined) throw new Error('unreachable: a local config was given');
    const adapter = wiring.localModel;
    return Object.freeze({
      provider: 'ollama' as const,
      modelId: config.name,
      label: adapter.promptRenderer.model,
      keySource: null,
      renderer: adapter.promptRenderer,
      model: wiring.narratorModel,
      ...(preview ? {} : { control: controlProbeModelOf('ollama', adapter) }),
    });
  }

  async function compute(userId: string): Promise<NarratorResolution> {
    const settings = await options.stores.settings(userId);
    const provider = settings.activeProvider;
    if (provider === 'off') return { provider, narrator: null, reason: 'off' };
    if (provider === 'ollama') {
      // The operator's environment wins over a model set in Settings.
      const environment =
        options.mode === 'run'
          ? options.localModel
          : options.localModelPin === undefined
            ? undefined
            : { endpoint: '', ...options.localModelPin };
      const config = environment ?? settings.ollama;
      if (config === null || config === undefined) {
        return { provider, narrator: null, reason: 'not_configured' };
      }
      const token = await options.stores.storedKey(userId, 'ollama');
      if (token === 'unopenable') return { provider, narrator: null, reason: 'key_unopenable' };
      try {
        return { provider, narrator: local(config, token), reason: null };
      } catch (error) {
        // A model set in Settings that the local-endpoint policy refuses is
        // not configured; one from the environment fails boot as before.
        if (environment !== undefined) throw error;
        options.logger?.warn(
          { event: 'narrator.endpoint_refused', provider: 'ollama' },
          'the local endpoint set in Settings is refused by the local-endpoint policy',
        );
        return { provider, narrator: null, reason: 'endpoint_refused' };
      }
    }
    // A hosted provider: consent, then a key (the file wins), then the model.
    if (!settings.consented.has(provider)) {
      return { provider, narrator: null, reason: 'consent_required' };
    }
    const file = options.fileKeys[provider];
    let key: HostedModelKey | null = file ?? null;
    let keySource: 'file' | 'stored' | null = file === undefined ? null : 'file';
    if (key === null) {
      const stored = await options.stores.storedKey(userId, provider);
      if (stored === 'unopenable') return { provider, narrator: null, reason: 'key_unopenable' };
      key = stored;
      keySource = stored === null ? null : 'stored';
    }
    if (key === null) return { provider, narrator: null, reason: 'key_missing' };
    const modelId = settings.models[provider] ?? HOSTED_DEFAULT_MODELS[provider];
    const transport = options.mode === 'preview' ? PREVIEW_ONLY_HOSTED : options.hostedTransport;
    const adapter = createHostedModelAdapter(
      { provider, model: modelId, timeoutMs, key },
      {
        ...(transport === undefined ? {} : { transport }),
        ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
        ...(budgets.get(provider) === undefined
          ? {}
          : { budget: budgets.get(provider) as HostedBudget }),
      },
    );
    return {
      provider,
      reason: null,
      narrator: Object.freeze({
        provider,
        modelId,
        label: adapter.label,
        keySource,
        renderer: adapter.promptRenderer,
        model: { run: adapter.run },
        ...(options.mode === 'run' ? { control: controlProbeModelOf(provider, adapter) } : {}),
      }),
    };
  }

  function resolve(userId: string): Promise<NarratorResolution> {
    const now = nowMs();
    const hit = cache.get(userId);
    if (hit !== undefined && hit.generation === generation && hit.expiresAt > now) return hit.value;
    const value = compute(userId);
    const entry = { expiresAt: now + ttl, generation, value };
    cache.set(userId, entry);
    // A failed resolution is not cached: the next call tries again.
    value.catch(() => {
      if (cache.get(userId) === entry) cache.delete(userId);
    });
    return value;
  }

  return Object.freeze({
    resolve,
    forUser: async (userId: string) => (await resolve(userId)).narrator,
    invalidate: () => {
      generation += 1;
      cache.clear();
    },
    generation: () => generation,
    budgets,
  });
}

// ---------------------------------------------------------------------------
// WP 10.16: the controls self-test's reach into a resolved narrator
// ---------------------------------------------------------------------------

/**
 * The worker's probe model, from the adapter the run-mode runtime built for
 * the holder: the narration's own adapter, so the probes share its key, its
 * window, its egress policy and its format.
 */
export function controlProbeModelOf(
  provider: 'ollama' | 'openai' | 'openrouter' | 'anthropic',
  adapter: HostedModelAdapter | LocalModelAdapter,
): ControlProbeModel {
  if ('egress' in adapter && adapter.egress.kind === 'hosted') {
    const hosted = adapter as HostedModelAdapter;
    return {
      provider,
      label: hosted.label,
      probe: (id) => ({ run: (request, signal) => hosted.controlProbe(id, request, signal) }),
      aborts: () => hosted.aborts(),
      budget: hosted.budget,
      egress: {
        kind: 'hosted',
        url: hosted.egress.url,
        classify: (url) => hosted.egress.classify(url),
      },
    };
  }
  const local = adapter as LocalModelAdapter;
  return {
    provider: 'ollama',
    label: local.promptRenderer.model,
    probe: (id) => ({ run: (request, signal) => local.controlProbe(id, request, signal) }),
    aborts: () => local.aborts(),
    budget: null,
    egress: {
      kind: 'local',
      classify: (endpoint) => local.egress.classify(endpoint),
      configured: () => local.egress.configured(),
    },
    modelPin: (signal) => local.modelPin(signal),
  };
}
