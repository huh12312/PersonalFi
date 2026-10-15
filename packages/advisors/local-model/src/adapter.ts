// SPDX-License-Identifier: MIT
/**
 * `createLocalModelAdapter` — what `apps/api/src/worker.ts` calls with
 * `config.localModel` (05-phase-5-dispatch.md §4 W-C: the adapter is built in
 * `worker.ts` from config, and the narrator is registered only when
 * `LOCAL_MODEL_ENDPOINT` and `LOCAL_MODEL_DIGEST` are both set).
 *
 * A run, in order — and every step before the fourth sends nothing:
 *
 *   1. the signal is checked; a cancelled run never renders;
 *   2. `renderPrompt(request)` — pure; the same bytes the preview showed;
 *   3. the prompt's size is checked against `num_ctx` (`prompt_too_large`):
 *      Ollama truncates an oversized context **from the front**, which is
 *      where the grounding rules are, so an oversized prompt is refused
 *      rather than sent;
 *   4. `GET /api/tags`: the served digest must equal the pinned one, or
 *      `model_digest_mismatch` — **before any prompt is sent**;
 *   4a. the warm-up (WP 9.5, Phase 5 gate C5-2): `GET /api/ps`, and if the
 *      pinned model is not loaded, one data-free chat that loads it
 *      (`WARM_UP_MESSAGES`, one token) — in the request's deadline's headroom
 *      above `LOCAL_MODEL_TIMEOUT_MS`, never inside the narration's own
 *      timeout, logged on its own and never retried (see `warmUpIfCold`);
 *   5. `POST /api/chat`, streamed, under the byte cap, the deadline (the
 *      earlier of `LOCAL_MODEL_TIMEOUT_MS` and the request's own
 *      `limits.deadline`) and the caller's signal;
 *   6. `GET /api/tags` again: a model re-tagged *during* the generation is
 *      caught, and its reply is discarded;
 *   7. the reply is wrapped into an `AdvisorResponse`. **The envelope is
 *      written from the request** — `contract_version`, `request_id`,
 *      `advisor_id`, `advisor_version` — and only the model's `insights` is
 *      taken from its reply, so a model cannot forge who it is or which run
 *      it answers. The result is `unknown` to the platform (`registry.ts`'s
 *      `Advisor.run`) and goes through `validateResponse` like any other.
 *
 * **Logging** (03 §8.3): shape, byte sizes, digest, durations, token counts
 * and sanitiser counts by kind. Never a prompt, a reply, a snapshot byte, a
 * sanitiser path, or Ollama's error text. `test/ollama-client.test.ts` plants
 * a canary in a goal name and in the model's reply and greps every logger
 * argument for it.
 */
import { systemClock, type Clock } from '@core/kernel';
import {
  configHash,
  createLocalEndpointPolicy,
  createLocalEndpointTransport,
  type LocalEndpointPolicy,
} from '@core/platform';
import { LocalModelError } from './errors.ts';
import { NARRATION_FORMAT } from './format.ts';
import {
  createOllamaClient,
  DEFAULT_GENERATION_OPTIONS,
  normaliseDigest,
  type GenerationOptions,
  type LocalModelTransport,
  type OllamaClient,
} from './ollama-client.ts';
import {
  PROMPT_TEMPLATE_HASH,
  renderPrompt,
  WARM_UP_MESSAGES,
  type RenderedPrompt,
} from './prompt.ts';
import {
  insightsFromReply,
  narratorResponse,
  requestShape,
  sanitiserWarnings,
  type NarratorReplyResponse,
} from './reply.ts';
import type { LocalModelRequest } from './request.ts';
import { countFlags } from './sanitise.ts';

/** `@core/config`'s `LocalModelConfig`, structurally — this layer does not import `@core/config`. */
export interface LocalModelAdapterConfig {
  readonly endpoint: string;
  readonly name: string;
  readonly digest: string;
  readonly timeoutMs: number;
  readonly allowRemote: boolean;
}

/** pino-compatible (`obj, msg`). Only `info` and `warn` are used. */
export interface LocalModelLogger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
}

const SILENT: LocalModelLogger = Object.freeze({ info: () => undefined, warn: () => undefined });

export interface LocalModelAdapterDeps {
  /**
   * Defaults to `createLocalEndpointTransport(createLocalEndpointPolicy(config))`.
   * Tests inject a transport built the same way over a resolver they control.
   */
  readonly transport?: LocalModelTransport;
  readonly logger?: LocalModelLogger;
  readonly clock?: Clock;
  /** WP 5.3's narrower narration schema, if it wants one. Still a convenience, never a control. */
  readonly format?: Readonly<Record<string, unknown>>;
  readonly generation?: Partial<GenerationOptions>;
  /**
   * WP 10.6: an optional bearer token for an Ollama endpoint behind a proxy
   * that asks for one (stored in Settings, sealed). Sent as `authorization` on
   * every request to the local endpoint and nowhere else; read at send time.
   */
  readonly bearer?: { reveal(): string };
}

/** The `AdvisorResponse` v1 shape the adapter builds (`reply.ts`, shared with `hosted.ts`). */
export type LocalModelResponse = NarratorReplyResponse;

export interface LocalModelAdapter {
  /** The `Advisor.run` half. WP 5.3's narrator supplies the manifest. */
  run(request: LocalModelRequest, signal: AbortSignal): Promise<unknown>;
  /** The `PromptRenderer` port WP 5.1 declares: the exact bytes, invoking nothing. */
  renderPrompt(request: LocalModelRequest): RenderedPrompt;
  /** The digest pin on its own — for a readiness probe or the run inspector. */
  checkModel(signal: AbortSignal): Promise<void>;
  readonly model: { readonly name: string; readonly digest: string };
  /**
   * `sha256:` over everything fixed that the model sees besides the data: the
   * prompt template (`PROMPT_TEMPLATE_HASH`), the `format` schema, and the
   * sampling options. WP 5.1's query shape includes it, so changing any of
   * them is a new shape that needs a new approval.
   */
  readonly promptTemplateHash: string;
  /**
   * WP 5.1's `PromptRenderer` port (`packages/contexts/insights/src/ports.ts`),
   * implemented exactly: `templateHash`, `model` as `name@sha256:<digest>`,
   * and a pure `render` returning `{ text, hash }` with `hash` the sha256 of
   * `text`. The composition root binds this object; nothing here imports the
   * port's type (this layer may not import `@ctx/insights`).
   */
  readonly promptRenderer: {
    readonly templateHash: string;
    readonly model: string;
    /** WP 10.6: which provider the approval records. Always `ollama` here. */
    readonly provider: 'ollama';
    render(request: LocalModelRequest): { readonly text: string; readonly hash: string };
  };
  /** `null` when a transport was injected. */
  readonly policy: LocalEndpointPolicy | null;
}

/**
 * What the warm-up stage did (WP 9.5, C5-2), for the run's log line and the
 * Brief measurement: whether the model was loaded before (`warm`, `cold`, or
 * `unknown` when `GET /api/ps` could not say), and what was done about it.
 */
export interface WarmUpOutcome {
  readonly before: 'warm' | 'cold' | 'unknown' | 'unchecked';
  readonly outcome: 'not_needed' | 'loaded' | 'failed' | 'no_headroom';
  readonly durationMs: number | null;
}

/** Below this much headroom a warm-up is not attempted: it could not load a model anyway. */
export const MIN_WARM_UP_MS = 5_000;

export function createLocalModelAdapter(
  config: LocalModelAdapterConfig,
  deps: LocalModelAdapterDeps = {},
): LocalModelAdapter {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? SILENT;
  const format = deps.format ?? NARRATION_FORMAT;
  const generation: GenerationOptions = { ...DEFAULT_GENERATION_OPTIONS, ...deps.generation };
  const digest = normaliseDigest(config.digest);
  if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
    throw new TypeError(
      'LOCAL_MODEL_DIGEST must be sha256: followed by 64 lowercase hex characters',
    );
  }

  let policy: LocalEndpointPolicy | null = null;
  let transport = deps.transport;
  if (transport === undefined) {
    // Throws on an endpoint the policy refuses (a dotted name without
    // LOCAL_MODEL_ALLOW_REMOTE, http with it, an IP literal): a composition
    // root should let that fail boot, the stance `createEgressPolicy` takes.
    policy = createLocalEndpointPolicy({
      endpoint: config.endpoint,
      allowRemote: config.allowRemote,
      timeoutMs: config.timeoutMs,
      maxResponseBytes: generation.maxStreamBytes,
    });
    transport = createLocalEndpointTransport(policy);
  }
  if (deps.bearer !== undefined) {
    const inner = transport;
    const bearer = deps.bearer;
    transport = {
      request: (input) =>
        inner.request({
          ...input,
          headers: { ...input.headers, authorization: `Bearer ${bearer.reveal()}` },
        }),
    };
  }

  const model = Object.freeze({ name: config.name, digest });
  const client: OllamaClient = createOllamaClient({ transport, model, clock, generation });
  const modelLabel = `${config.name.slice(0, 24)}@${digest}`;
  const promptTemplateHash = `sha256:${configHash({
    template: PROMPT_TEMPLATE_HASH,
    format,
    options: {
      temperature: 0,
      seed: generation.seed,
      num_ctx: generation.numCtx,
      num_predict: generation.numPredict,
    },
  })}`;

  async function checkModel(signal: AbortSignal): Promise<void> {
    await client.checkModelDigest(signal);
  }

  /**
   * C5-2 (WP 9.5): **a cold model is warmed before the narration, not during
   * it.** Measured on this host (`docs/evidence/phase-9/wp9.5-narrator.md`):
   * a single-finding narration takes 121–155 s warm, and the first one of a
   * Brief, against a model nothing had loaded, ran past the 180 s deadline
   * (`model_timeout` at 180 005 ms, load 6.5) — the load and the uncached
   * system region spent the deadline the reply needed. So:
   *
   *   * the warm-up runs only in the headroom the **request's** deadline
   *     leaves above `LOCAL_MODEL_TIMEOUT_MS` (the narrator's manifest sets
   *     300 s, the platform ceiling, for exactly this: 120 s to load, then the
   *     narration's own full 180 s), and is not attempted below
   *     `MIN_WARM_UP_MS` of it — a caller whose deadline is the timeout gets
   *     the pre-9.5 behaviour, unchanged;
   *   * it sends two constants and no request data (`WARM_UP_MESSAGES`), after
   *     the digest pin and only inside a run the service already admitted
   *     (kill switches, consent, approval), so a stopped narrator warms nothing;
   *   * a warm model costs one `GET /api/ps` and nothing else;
   *   * a failed or timed-out warm-up is logged and **not retried**; the
   *     narration still gets its own full timeout and fails, once, on its own
   *     terms if the model is really gone. Only a cancellation stops the run.
   */
  async function warmUpIfCold(
    request: LocalModelRequest,
    signal: AbortSignal,
  ): Promise<WarmUpOutcome> {
    const deadlineMs = Date.parse(request.limits.deadline);
    const remaining = Number.isFinite(deadlineMs) ? deadlineMs - clock.nowMs() : 0;
    const budget = Math.min(config.timeoutMs, remaining - config.timeoutMs);
    if (budget < MIN_WARM_UP_MS) {
      return { before: 'unchecked', outcome: 'no_headroom', durationMs: null };
    }
    const loaded = await client.isLoaded(signal);
    if (loaded === true) return { before: 'warm', outcome: 'not_needed', durationMs: null };
    const before = loaded === false ? 'cold' : 'unknown';
    const started = clock.nowMs();
    try {
      await client.warmUp({ messages: WARM_UP_MESSAGES, signal, timeoutMs: budget });
      return { before, outcome: 'loaded', durationMs: clock.nowMs() - started };
    } catch (error) {
      if (signal.aborted) throw error;
      const code = error instanceof LocalModelError ? error.code : 'model_unavailable';
      logger.warn(
        {
          event: 'local_model.warm_up_failed',
          request_id: request.request_id,
          model: config.name,
          digest,
          code,
          warm_up_ms: clock.nowMs() - started,
        },
        'local model warm-up failed; the narration runs on its own timeout',
      );
      return { before, outcome: 'failed', durationMs: clock.nowMs() - started };
    }
  }

  async function run(request: LocalModelRequest, signal: AbortSignal): Promise<unknown> {
    const started = clock.nowMs();
    let stage = 'render';
    let rendered: RenderedPrompt | null = null;
    try {
      if (signal.aborted)
        throw new LocalModelError('aborted', 'the run was cancelled before it started');

      rendered = renderPrompt(request);
      if (rendered.bytes > generation.maxPromptBytes) {
        throw new LocalModelError(
          'prompt_too_large',
          `the rendered prompt is ${String(rendered.bytes)} bytes; the ceiling for num_ctx ` +
            `${String(generation.numCtx)} is ${String(generation.maxPromptBytes)}`,
        );
      }

      stage = 'digest_check';
      const before = await client.checkModelDigest(signal);

      stage = 'warm_up';
      const warm = await warmUpIfCold(request, signal);

      stage = 'chat';
      const deadlineMs = Date.parse(request.limits.deadline);
      const remaining = Number.isFinite(deadlineMs) ? deadlineMs - clock.nowMs() : config.timeoutMs;
      const timeoutMs = Math.min(config.timeoutMs, remaining);
      if (timeoutMs <= 0)
        throw new LocalModelError('model_timeout', 'the request deadline has already passed');
      const reply = await client.chat({ messages: rendered.messages, format, signal, timeoutMs });

      stage = 'digest_recheck';
      await client.checkModelDigest(signal);

      stage = 'wrap';
      const warnings: string[] = sanitiserWarnings(rendered.flags);
      if (reply.doneReason === 'length') {
        warnings.push(`model reply cut at num_predict ${String(generation.numPredict)}`);
      }
      if (reply.contentBytes > request.limits.max_response_bytes) {
        throw new LocalModelError(
          'model_reply_too_large',
          `the reply is ${String(reply.contentBytes)} bytes; the limit is ${String(request.limits.max_response_bytes)}`,
        );
      }
      const parsedReply = insightsFromReply(reply.content);
      warnings.push(...parsedReply.warnings);

      const runtimeMs = Math.max(0, clock.nowMs() - started);
      const response: LocalModelResponse = narratorResponse({
        request,
        insights: parsedReply.insights,
        warnings,
        runtimeMs,
        model: modelLabel,
        producedAt: clock.now().toISOString(),
      });

      logger.info(
        {
          event: 'local_model.run',
          request_id: request.request_id,
          advisor_id: request.advisor_id,
          model: config.name,
          digest,
          served_digest: before.served,
          prompt_hash: rendered.hash,
          prompt_template_hash: promptTemplateHash,
          prompt_bytes: rendered.bytes,
          stream_bytes: reply.streamBytes,
          reply_bytes: reply.contentBytes,
          prompt_eval_count: reply.promptEvalCount,
          eval_count: reply.evalCount,
          done_reason: reply.doneReason,
          digest_check_ms: before.durationMs,
          model_before: warm.before,
          warm_up: warm.outcome,
          warm_up_ms: warm.durationMs,
          chat_ms: reply.durationMs,
          runtime_ms: runtimeMs,
          shape: requestShape(request),
          sanitiser: countFlags(rendered.flags),
          reply_is_json: parsedReply.isJson,
        },
        'local model run',
      );
      return response;
    } catch (error) {
      const failure =
        error instanceof LocalModelError
          ? error
          : new LocalModelError('model_unavailable', 'the run failed', { cause: error });
      logger.warn(
        {
          event: 'local_model.failed',
          request_id: request.request_id,
          advisor_id: request.advisor_id,
          model: config.name,
          digest,
          code: failure.code,
          stage,
          prompt_bytes: rendered?.bytes ?? null,
          runtime_ms: Math.max(0, clock.nowMs() - started),
        },
        'local model run failed',
      );
      throw failure;
    }
  }

  return Object.freeze({
    run,
    renderPrompt,
    checkModel,
    model,
    promptTemplateHash,
    promptRenderer: Object.freeze({
      templateHash: promptTemplateHash,
      model: `${config.name}@${digest}`,
      provider: 'ollama' as const,
      render: (request: LocalModelRequest) => {
        const rendered = renderPrompt(request);
        return { text: rendered.text, hash: rendered.hash };
      },
    }),
    policy,
  });
}
