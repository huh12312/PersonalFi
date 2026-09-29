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
import { PROMPT_TEMPLATE_HASH, renderPrompt, type RenderedPrompt } from './prompt.ts';
import type { LocalModelRequest } from './request.ts';
import { countFlags, type SanitiserFlag } from './sanitise.ts';

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
}

/** The `AdvisorResponse` v1 shape the adapter builds. Returned as `unknown` from `run`. */
export interface LocalModelResponse {
  readonly contract_version: number;
  readonly request_id: string;
  readonly advisor_id: string;
  readonly advisor_version: string;
  readonly produced_at: string;
  readonly diagnostics: {
    readonly runtime_ms: number;
    readonly model: string;
    readonly warnings: readonly string[];
  };
  readonly insights: unknown;
}

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
    render(request: LocalModelRequest): { readonly text: string; readonly hash: string };
  };
  /** `null` when a transport was injected. */
  readonly policy: LocalEndpointPolicy | null;
}

/** `AdvisorResponse.diagnostics.warnings`: at most 16, each at most 240 characters. */
const MAX_WARNINGS = 16;
const MAX_WARNING_CHARS = 240;

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
      let insights: unknown = null;
      if (reply.contentBytes > request.limits.max_response_bytes) {
        throw new LocalModelError(
          'model_reply_too_large',
          `the reply is ${String(reply.contentBytes)} bytes; the limit is ${String(request.limits.max_response_bytes)}`,
        );
      }
      try {
        const parsed: unknown = JSON.parse(reply.content);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          insights = record['insights'] ?? null;
          const extra = Object.keys(record).filter((key) => key !== 'insights').length;
          if (extra > 0) {
            warnings.push(
              `model reply carried ${String(extra)} top-level field(s) besides insights; ignored`,
            );
          }
        } else {
          warnings.push('model reply was JSON but not an object');
        }
      } catch {
        warnings.push('model reply was not JSON');
      }

      const runtimeMs = Math.max(0, clock.nowMs() - started);
      const response: LocalModelResponse = {
        contract_version: request.contract_version,
        request_id: request.request_id,
        advisor_id: request.advisor_id,
        advisor_version: request.advisor_version,
        produced_at: clock.now().toISOString(),
        diagnostics: { runtime_ms: runtimeMs, model: modelLabel, warnings: capWarnings(warnings) },
        insights,
      };

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
          chat_ms: reply.durationMs,
          runtime_ms: runtimeMs,
          shape: requestShape(request),
          sanitiser: countFlags(rendered.flags),
          reply_is_json: !warnings.includes('model reply was not JSON'),
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
      render: (request: LocalModelRequest) => {
        const rendered = renderPrompt(request);
        return { text: rendered.text, hash: rendered.hash };
      },
    }),
    policy,
  });
}

/** Scope names and top-level snapshot keys: the contract's vocabulary, never its contents. */
function requestShape(request: LocalModelRequest): Record<string, unknown> {
  return {
    kind: request.kind,
    contract_version: request.contract_version,
    granted_scopes: [...request.granted_scopes].sort(),
    snapshot_blocks: Object.keys(request.snapshot).sort(),
    findings: Array.isArray(request.findings)
      ? request.findings.length
      : request.findings === undefined
        ? 0
        : 1,
  };
}

function sanitiserWarnings(flags: readonly SanitiserFlag[]): string[] {
  return flags.map(
    (flag) => `sanitiser removed ${flag.kind} x${String(flag.count)} at ${flag.path}`,
  );
}

function capWarnings(warnings: readonly string[]): string[] {
  const clipped = warnings.map((warning) =>
    warning.length > MAX_WARNING_CHARS ? `${warning.slice(0, MAX_WARNING_CHARS - 1)}…` : warning,
  );
  if (clipped.length <= MAX_WARNINGS) return clipped;
  const kept = clipped.slice(0, MAX_WARNINGS - 1);
  kept.push(`… and ${String(clipped.length - kept.length)} more warning(s)`);
  return kept;
}
