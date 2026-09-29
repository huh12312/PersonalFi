// SPDX-License-Identifier: MIT
/**
 * The Ollama client: two documented endpoints over `@core/platform`'s
 * local-endpoint transport, and nothing else (05-phase-5-dispatch.md §3 WP 5.2
 * part 2, §4 item 10).
 *
 *   * `GET /api/tags` — the served models and their digests. The model is
 *     **pinned by digest like an image**: `checkModelDigest` refuses
 *     `model_digest_mismatch` unless the served digest for `LOCAL_MODEL_NAME`
 *     equals `LOCAL_MODEL_DIGEST`. A tag that moved is a different model, and
 *     the ≥95% measured on one says nothing about another.
 *   * `POST /api/chat` — `stream: true`, a `format` schema, `temperature: 0`,
 *     a fixed `seed`, bounded `num_ctx` and `num_predict`. The stream is
 *     newline-delimited JSON; the transport bounds its bytes **as they
 *     arrive** and closes the socket on the caller's signal, so a kill stops
 *     the generation rather than abandoning it to finish into a void.
 *
 * Not the `ollama` npm package, for the five reasons in 05 §4 item 10 — the
 * short form: this is ~one endpoint and one metadata call; the SDK reads
 * `OLLAMA_HOST` from `process.env`, which this repo bans outside
 * `@core/config`; it would own the socket, so address pinning, the streaming
 * byte cap and the redirect refusal would be its behaviour and not ours; it
 * would inherit proxy environment variables; and D14's dependency budget.
 */
import type { Clock } from '@core/kernel';
import {
  isLocalEndpointRefusedError,
  type LocalEndpointRequest,
  type LocalEndpointResponse,
} from '@core/platform';
import { LocalModelError } from './errors.ts';
import type { PromptMessage } from './prompt.ts';

/** The one capability the client needs: `createLocalEndpointTransport(...)` satisfies it. */
export interface LocalModelTransport {
  request(request: LocalEndpointRequest): Promise<LocalEndpointResponse>;
}

export interface PinnedModel {
  readonly name: string;
  /** `sha256:` + 64 lowercase hex — `LOCAL_MODEL_DIGEST`. */
  readonly digest: string;
}

/** Sampling and size limits. Fixed per deployment so a run is repeatable. */
export interface GenerationOptions {
  /** Context window. A prompt that would not fit is refused before it is sent. */
  readonly numCtx: number;
  /** The reply's token ceiling — the model's half of the byte cap. */
  readonly numPredict: number;
  readonly seed: number;
  /** Cap on the raw NDJSON stream, enforced while it arrives. */
  readonly maxStreamBytes: number;
  /** Cap on `GET /api/tags`. */
  readonly maxTagsBytes: number;
  /** Largest rendered prompt, in UTF-8 bytes, that fits `numCtx` with room for `numPredict`. */
  readonly maxPromptBytes: number;
}

export const DEFAULT_GENERATION_OPTIONS: GenerationOptions = Object.freeze({
  numCtx: 8192,
  numPredict: 1024,
  seed: 20_260_929,
  // ~130 bytes of NDJSON envelope per streamed token plus the token itself:
  // 1024 tokens is ~150 KiB; 512 KiB is the headroom, not the budget.
  maxStreamBytes: 512 * 1024,
  maxTagsBytes: 256 * 1024,
  // (8192 − 1024) tokens × ~2.8 bytes per token of dense JSON, rounded down.
  maxPromptBytes: 20_000,
});

export interface ChatRequest {
  readonly messages: readonly PromptMessage[];
  readonly format: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface ChatResult {
  /** The assembled assistant text. Returned to the caller; never logged. */
  readonly content: string;
  readonly contentBytes: number;
  readonly streamBytes: number;
  /** `stop`, `length`, … — `length` means `num_predict` cut the reply short. */
  readonly doneReason: string | null;
  readonly promptEvalCount: number | null;
  readonly evalCount: number | null;
  readonly durationMs: number;
}

export interface DigestCheck {
  readonly served: string;
  readonly durationMs: number;
}

export interface OllamaClient {
  checkModelDigest(signal: AbortSignal): Promise<DigestCheck>;
  chat(request: ChatRequest): Promise<ChatResult>;
}

export interface OllamaClientOptions {
  readonly transport: LocalModelTransport;
  readonly model: PinnedModel;
  readonly clock: Clock;
  readonly generation?: Partial<GenerationOptions>;
}

const JSON_HEADERS = Object.freeze({ accept: 'application/json' });

/** Ollama reports a bare 64-hex digest; the config carries `sha256:`. Compare one form. */
export function normaliseDigest(digest: string): string {
  const lower = digest.trim().toLowerCase();
  return lower.startsWith('sha256:') ? lower : `sha256:${lower}`;
}

/** `qwen2.5` is `qwen2.5:latest` to Ollama. */
function withTag(name: string): string {
  const lastSegment = name.slice(name.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? name : `${name}:latest`;
}

export function createOllamaClient(options: OllamaClientOptions): OllamaClient {
  const generation: GenerationOptions = { ...DEFAULT_GENERATION_OPTIONS, ...options.generation };
  const { transport, model, clock } = options;
  const pinned = normaliseDigest(model.digest);
  const wanted = withTag(model.name);

  async function send(request: LocalEndpointRequest): Promise<LocalEndpointResponse> {
    try {
      return await transport.request(request);
    } catch (error) {
      throw translate(error);
    }
  }

  async function checkModelDigest(signal: AbortSignal): Promise<DigestCheck> {
    const started = clock.nowMs();
    const response = await send({
      method: 'GET',
      path: '/api/tags',
      headers: JSON_HEADERS,
      signal,
      maxResponseBytes: generation.maxTagsBytes,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new LocalModelError(
        'model_unavailable',
        `GET /api/tags answered ${String(response.status)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new LocalModelError('model_protocol_error', 'GET /api/tags did not answer JSON');
    }
    const models = (parsed as { models?: unknown }).models;
    if (!Array.isArray(models)) {
      throw new LocalModelError('model_protocol_error', 'GET /api/tags has no models array');
    }
    const entry = models.find((candidate: unknown) => {
      if (candidate === null || typeof candidate !== 'object') return false;
      const { name, model: modelName } = candidate as { name?: unknown; model?: unknown };
      return name === wanted || modelName === wanted;
    }) as { digest?: unknown } | undefined;
    if (entry === undefined) {
      throw new LocalModelError(
        'model_digest_mismatch',
        `${wanted} is not served; pull it through the local-llm-pull profile and pin its digest`,
      );
    }
    const served = typeof entry.digest === 'string' ? normaliseDigest(entry.digest) : '(none)';
    if (served !== pinned) {
      throw new LocalModelError(
        'model_digest_mismatch',
        `${wanted} is served at ${served}, pinned at ${pinned}; a moved tag is a different model`,
      );
    }
    return { served, durationMs: clock.nowMs() - started };
  }

  async function chat(request: ChatRequest): Promise<ChatResult> {
    const started = clock.nowMs();
    const body = JSON.stringify({
      model: wanted,
      messages: request.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
      stream: true,
      format: request.format,
      options: {
        temperature: 0,
        seed: generation.seed,
        num_ctx: generation.numCtx,
        num_predict: generation.numPredict,
      },
    });
    const response = await send({
      method: 'POST',
      path: '/api/chat',
      headers: { ...JSON_HEADERS, 'content-type': 'application/json' },
      body,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
      maxResponseBytes: generation.maxStreamBytes,
    });
    if (response.status < 200 || response.status >= 300) {
      // Ollama's own error text is not echoed: it can quote the request.
      throw new LocalModelError(
        response.status >= 500 ? 'model_unavailable' : 'model_protocol_error',
        `POST /api/chat answered ${String(response.status)}`,
      );
    }

    let content = '';
    let done = false;
    let doneReason: string | null = null;
    let promptEvalCount: number | null = null;
    let evalCount: number | null = null;
    for (const line of response.body.split('\n')) {
      if (line.trim().length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        throw new LocalModelError('model_protocol_error', 'a stream line was not JSON');
      }
      if (event === null || typeof event !== 'object') {
        throw new LocalModelError('model_protocol_error', 'a stream line was not an object');
      }
      const record = event as Record<string, unknown>;
      if (record['error'] !== undefined) {
        throw new LocalModelError('model_unavailable', 'the stream carried an error event');
      }
      const message = record['message'];
      if (message !== null && typeof message === 'object') {
        const piece = (message as { content?: unknown }).content;
        if (typeof piece === 'string') content += piece;
      }
      if (record['done'] === true) {
        done = true;
        doneReason = typeof record['done_reason'] === 'string' ? record['done_reason'] : null;
        promptEvalCount =
          typeof record['prompt_eval_count'] === 'number' ? record['prompt_eval_count'] : null;
        evalCount = typeof record['eval_count'] === 'number' ? record['eval_count'] : null;
        break;
      }
    }
    if (!done) {
      throw new LocalModelError('model_protocol_error', 'the stream ended without a done event');
    }

    return {
      content,
      contentBytes: new TextEncoder().encode(content).length,
      streamBytes: response.bytesRead,
      doneReason,
      promptEvalCount,
      evalCount,
      durationMs: clock.nowMs() - started,
    };
  }

  return Object.freeze({ checkModelDigest, chat });
}

/** Transport refusals, as the adapter's closed vocabulary. The cause is kept for a debugger, not a log. */
function translate(error: unknown): LocalModelError {
  if (error instanceof LocalModelError) return error;
  if (isLocalEndpointRefusedError(error)) {
    switch (error.code) {
      case 'response_too_large':
        return new LocalModelError(
          'model_reply_too_large',
          'the reply passed the byte cap while it arrived',
          { cause: error },
        );
      case 'timeout':
        return new LocalModelError('model_timeout', 'the deadline passed', { cause: error });
      case 'aborted':
        return new LocalModelError('aborted', 'the run was cancelled; the socket was closed', {
          cause: error,
        });
      case 'dns_resolution_failed':
      case 'connection_failed':
        return new LocalModelError(
          'model_unavailable',
          `the endpoint is unreachable (${error.code})`,
          { cause: error },
        );
      default:
        return new LocalModelError(
          'endpoint_refused',
          `the endpoint policy refused (${error.code})`,
          { cause: error },
        );
    }
  }
  return new LocalModelError('model_unavailable', 'the request failed', { cause: error });
}
