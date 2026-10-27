// SPDX-License-Identifier: MIT
/**
 * `createHostedModelAdapter` — the narrator on a hosted provider with the
 * holder's own key (WP 10.6; decision D30, which revises D22).
 *
 * OpenAI (Chat Completions, `response_format: json_schema`, `strict: true`),
 * OpenRouter (the same shape at `openrouter.ai`, with its attribution headers
 * and `provider.require_parameters` so it routes only to an endpoint that
 * honours the schema) and Anthropic (Messages API, `output_config.format:
 * json_schema`). One adapter, three request/reply shapes, and **everything
 * else shared with the local model**:
 *
 *   * the prompt is `renderPrompt(request)` — the bytes the payload preview
 *     showed and the holder approved, the same sanitiser, the same fences;
 *   * the reply format is `NARRATION_FORMAT` (`hosted-format.ts` derives the
 *     vendor's schema from it and from nothing else);
 *   * the reply is wrapped by `reply.ts`'s `narratorResponse`, the function
 *     the local adapter uses, and is `unknown` to the platform: it goes
 *     through `@ctx/insights`' `validateResponse` — the reply format, the 1:1
 *     narration match, the numerals check — byte for byte as a local reply;
 *   * one call, one reply, no retry, no streaming.
 *
 * What is different, and why:
 *
 *   * **Egress: exactly one host per adapter, checked in code.**
 *     `HOSTED_MODEL_HOSTS` names `api.openai.com`, `openrouter.ai` and
 *     `api.anthropic.com`; each adapter's `@core/platform` egress policy
 *     allows its own host, HTTPS, port 443, and nothing else. The URL is
 *     built from that constant and a constant path; DNS is classified before
 *     the connect (a private or loopback answer is refused) and the socket
 *     goes to the address the guard validated. A redirect is never followed.
 *   * **The key** is read through `key.reveal()` at the one place a header is
 *     built, and redacted — with any `sk-…`-shaped token and any bearer value
 *     — from every provider-authored string before it is logged. A thrown
 *     `HostedModelError` carries a code and an HTTP status, never the
 *     provider's prose.
 *   * **A budget window per provider** (`createHostedBudget`): at most
 *     `HOSTED_RATE_WINDOW.maxRequests` calls an hour, shared by every holder
 *     and adapter the runtime builds, so a looping job cannot spend a key.
 *   * **The timeout** is the earlier of the configured one (never above
 *     `HOSTED_TIMEOUT_CEILING_MS`, the local model's own 300 s ceiling) and
 *     the request's `limits.deadline`, enforced here with the caller's
 *     `AbortSignal` — the run's kill switches reach the socket.
 *   * `diagnostics.model` is `provider:model` (e.g. `anthropic:claude-sonnet-5-5`),
 *     which the run records and the Brief's narration badge reads.
 *
 * This file imports `@core/kernel` and `@core/platform` only — the layer
 * rule (`scripts/eslint-boundaries.js`) and `test/structure.test.ts` hold it
 * to that. No vendor SDK: the package may add no dependency, and an SDK
 * would bring its own HTTP client past the egress guard.
 */
import { systemClock, type Clock } from '@core/kernel';
import {
  assertHeaderValueSafe,
  checkUrl,
  configHash,
  createEgressPolicy,
  createNodeTransport,
  guardUrl,
  isEgressRefusedError,
  systemResolver,
  type EgressPolicy,
  type HttpTransport,
  type Resolver,
} from '@core/platform';
import type { LocalModelLogger } from './adapter.ts';
import { withControlInstruction, type ControlProbeId, type EgressVerdict } from './control.ts';
import { hostedNarrationFormat, HOSTED_PROVIDERS, type HostedProvider } from './hosted-format.ts';
import { DEFAULT_GENERATION_OPTIONS } from './ollama-client.ts';
import {
  PROMPT_TEMPLATE_HASH,
  renderPrompt,
  type PromptMessage,
  type RenderedPrompt,
} from './prompt.ts';
import { insightsFromReply, narratorResponse, requestShape, sanitiserWarnings } from './reply.ts';
import type { LocalModelRequest } from './request.ts';
import { countFlags } from './sanitise.ts';

export { HOSTED_PROVIDERS, type HostedProvider };

/** The one host each adapter may reach. The egress allow-list, per provider, in code. */
export const HOSTED_MODEL_HOSTS: Readonly<Record<HostedProvider, string>> = Object.freeze({
  openai: 'api.openai.com',
  openrouter: 'openrouter.ai',
  anthropic: 'api.anthropic.com',
});

/** The one path each adapter posts to. */
export const HOSTED_MODEL_PATHS: Readonly<Record<HostedProvider, string>> = Object.freeze({
  openai: '/v1/chat/completions',
  openrouter: '/api/v1/chat/completions',
  anthropic: '/v1/messages',
});

/**
 * The model each provider uses when the holder names none. Read from each
 * vendor's own current documentation on 2026-10-15 (the WP 10.6 evidence):
 * Anthropic's current Sonnet (`claude-api` skill's model table), OpenAI's
 * balanced tier (its models page: "balances performance and cost"; Chat
 * Completions and Structured Outputs supported), and the same Sonnet through
 * OpenRouter (its slug, with a dot).
 */
export const HOSTED_DEFAULT_MODELS: Readonly<Record<HostedProvider, string>> = Object.freeze({
  openai: 'gpt-6.1-sol',
  openrouter: 'anthropic/claude-sonnet-5.5',
  anthropic: 'claude-sonnet-5-5',
});

export const HOSTED_DISPLAY_NAMES: Readonly<Record<HostedProvider, string>> = Object.freeze({
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
});

/** A model id the product will send: what a vendor's ids look like, nothing that could be a path or a header. */
export const HOSTED_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/u;

/** The local model's own ceiling (`LOCAL_MODEL_TIMEOUT_MS_CEILING`); a hosted call never waits longer. */
export const HOSTED_TIMEOUT_CEILING_MS = 300_000;

/** The largest reply body read. A narration is a few kilobytes; a vendor envelope adds little. */
export const HOSTED_MAX_RESPONSE_BYTES = 512 * 1024;

/** The output-token cap per call (Anthropic `max_tokens`, OpenAI `max_completion_tokens`). Room for a reasoning model's thinking. */
export const HOSTED_MAX_OUTPUT_TOKENS = 16_000;

/** The probe's cap: it asks for an empty narration. Also the controls self-test's probes' (WP 10.16). */
export const HOSTED_PROBE_MAX_OUTPUT_TOKENS = 1_024;

/** The Test's and the self-test's probes wait at most this long (never above the configured timeout). */
export const HOSTED_PROBE_TIMEOUT_MS = 60_000;

/** Per provider, per runtime: at most this many calls in this window. */
export const HOSTED_RATE_WINDOW = Object.freeze({ maxRequests: 30, windowMs: 60 * 60_000 });

/** Anthropic's API version header (the `claude-api` skill's raw-HTTP shape). */
export const ANTHROPIC_VERSION = '2023-06-01';

/** OpenRouter's attribution headers: the project, never this deployment. */
export const OPENROUTER_ATTRIBUTION: Readonly<Record<string, string>> = Object.freeze({
  'http-referer': 'https://github.com/huh12312/PersonalFi',
  'x-openrouter-title': 'PersonalFi',
});

export const HOSTED_USER_AGENT = 'PersonalFi/0.9 (self-hosted personal finance; narrator)';

/**
 * Sent by the Settings screen's Test button: fixed, and carrying no personal
 * data at all — no snapshot, no finding, nothing from the database. It asks
 * for an empty narration under the same reply format a narration uses, so a
 * schema the vendor will not compile fails here, on a press, not on a Sunday.
 */
export const PROBE_MESSAGES: readonly PromptMessage[] = Object.freeze([
  Object.freeze({
    role: 'system' as const,
    content:
      'You are a connectivity check for a personal-finance app. There is nothing to narrate. ' +
      'Reply with the JSON object {"insights": []} and nothing else.',
  }),
  Object.freeze({ role: 'user' as const, content: 'Reply now.' }),
]);

export const HOSTED_MODEL_ERROR_CODES = [
  /** The caller's signal fired: a kill at some level. The socket was closed. */
  'aborted',
  /** The deadline — ours — passed. */
  'model_timeout',
  /** The provider could not be reached, or answered with a server error. */
  'model_unavailable',
  /** The egress policy refused the destination (a host other than the provider's, a private address, a redirect). */
  'endpoint_refused',
  /** HTTP 401 or 403: the provider did not accept the key. */
  'key_rejected',
  /** HTTP 429: the provider's own rate limit or quota. */
  'provider_rate_limited',
  /** This install's own window for the provider is spent. Nothing was sent. */
  'budget_exhausted',
  /** HTTP 400, 404 or 422: the provider refused the request (an unknown model id, a schema it will not compile). */
  'request_refused',
  /** The provider answered 2xx, but not in the shape it documents. */
  'model_protocol_error',
  /** The model declined to answer (a safety refusal). */
  'model_refused',
  /** The reply is larger than the request's own `max_response_bytes`. */
  'model_reply_too_large',
  /** The rendered prompt is over the same ceiling the local model has. Nothing was sent. */
  'prompt_too_large',
] as const;
export type HostedModelErrorCode = (typeof HOSTED_MODEL_ERROR_CODES)[number];

/** Never carries a prompt, a reply, a key, or the provider's prose: a code, and a status at most. */
export class HostedModelError extends Error {
  readonly code: HostedModelErrorCode;
  readonly status: number | null;
  constructor(
    code: HostedModelErrorCode,
    detail: string,
    options?: { readonly status?: number; readonly cause?: unknown },
  ) {
    super(
      `hosted model (${code}): ${detail}`,
      options?.cause === undefined ? {} : { cause: options.cause },
    );
    this.name = 'HostedModelError';
    this.code = code;
    this.status = options?.status ?? null;
  }
}

export function isHostedModelError(error: unknown): error is HostedModelError {
  return error instanceof HostedModelError;
}

/** A sliding window of call times. One per provider per runtime. */
export interface HostedBudget {
  readonly maxRequests: number;
  readonly windowMs: number;
  /** Spend one call if the window allows it. */
  take(nowMs: number): boolean;
  /** Calls left in the window now. */
  remaining(nowMs: number): number;
}

export function createHostedBudget(
  window: { readonly maxRequests: number; readonly windowMs: number } = HOSTED_RATE_WINDOW,
): HostedBudget {
  const calls: number[] = [];
  function prune(nowMs: number): void {
    while (calls.length > 0 && (calls[0] ?? 0) <= nowMs - window.windowMs) calls.shift();
  }
  return {
    maxRequests: window.maxRequests,
    windowMs: window.windowMs,
    take(nowMs) {
      prune(nowMs);
      if (calls.length >= window.maxRequests) return false;
      calls.push(nowMs);
      return true;
    },
    remaining(nowMs) {
      prune(nowMs);
      return Math.max(0, window.maxRequests - calls.length);
    },
  };
}

const REDACTED = '[REDACTED]';
/** Token shapes the three vendors issue, and any bearer value: redacted even when they are not this key. */
const TOKEN_SHAPES: readonly RegExp[] = [/sk-[A-Za-z0-9_-]{8,}/gu, /\bBearer\s+[^\s"',;]+/giu];
const PROVIDER_TEXT_CAP = 200;

/**
 * WP 3.4's `redactSecrets` pattern for a provider's own words: every secret
 * this process holds is removed (a secret under 8 characters is skipped — it
 * would redact half of every sentence), then anything shaped like a vendor
 * key, then the text is capped. Used before any provider-authored string
 * reaches a log line; nothing provider-authored reaches an error message.
 */
export function redactProviderText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join(REDACTED);
  }
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, REDACTED);
  return out.length > PROVIDER_TEXT_CAP ? `${out.slice(0, PROVIDER_TEXT_CAP - 1)}…` : out;
}

/** The provider's own error message from an error body, if it has the documented shape. */
function providerErrorText(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object') return null;
    const error = (parsed as Record<string, unknown>)['error'];
    if (error !== null && typeof error === 'object') {
      const message = (error as Record<string, unknown>)['message'];
      if (typeof message === 'string') return message;
    }
    return null;
  } catch {
    return null;
  }
}

export interface HostedModelKey {
  /** The key, at the one place a header is built. Never stored on the adapter as a field. */
  reveal(): string;
}

export interface HostedModelConfig {
  readonly provider: HostedProvider;
  /** A vendor model id (`HOSTED_MODEL_ID_PATTERN`). */
  readonly model: string;
  /** Never above `HOSTED_TIMEOUT_CEILING_MS`. */
  readonly timeoutMs: number;
  readonly key: HostedModelKey;
}

export interface HostedModelDeps {
  /** Defaults to `@core/platform`'s pinned node transport. Tests inject a recorded-shape fake. */
  readonly transport?: HttpTransport;
  /** Defaults to the system resolver. Tests answer a fixed public address. */
  readonly resolve?: Resolver;
  readonly clock?: Clock;
  readonly logger?: LocalModelLogger;
  /** Defaults to a fresh window; the runtime shares one per provider. */
  readonly budget?: HostedBudget;
}

export interface HostedProbeResult {
  readonly provider: HostedProvider;
  readonly model: string;
  /** `ok`, or the error code that ended the probe. */
  readonly outcome: 'ok' | HostedModelErrorCode;
  readonly roundTripMs: number;
  /** HTTP status when the provider answered. */
  readonly status: number | null;
  /** Whether the reply parsed as a JSON object with an `insights` array. */
  readonly replyShaped: boolean;
}

export interface HostedModelAdapter {
  run(request: LocalModelRequest, signal: AbortSignal): Promise<unknown>;
  /** The Settings screen's Test: `PROBE_MESSAGES`, no personal data. Never throws a provider error; reports it. */
  probe(signal: AbortSignal): Promise<HostedProbeResult>;
  renderPrompt(request: LocalModelRequest): RenderedPrompt;
  readonly provider: HostedProvider;
  readonly model: string;
  /** `provider:model` — `diagnostics.model`, `advisor_runs.llm_model`, the badge. */
  readonly label: string;
  readonly host: string;
  /** The schema actually sent: `hostedNarrationFormat(provider)`. */
  readonly format: Readonly<Record<string, unknown>>;
  /** Over the template, the format, the provider and the model: a switch is a new shape needing a new approval. */
  readonly promptTemplateHash: string;
  /** `@ctx/insights`' `PromptRenderer`, structurally (`ports.ts`). */
  readonly promptRenderer: {
    readonly templateHash: string;
    readonly model: string;
    readonly provider: HostedProvider;
    render(request: LocalModelRequest): { readonly text: string; readonly hash: string };
  };
  readonly policy: EgressPolicy;
  /**
   * WP 10.16, the controls self-test: `run` with one fixed control instruction
   * (`control.ts`) appended to the rendered narration, under the probe's
   * output-token cap. Same host, key, window, format and wrap as `run`.
   */
  controlProbe(
    id: ControlProbeId,
    request: LocalModelRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
  /**
   * How many calls this adapter has seen torn down by the caller's signal while
   * the request was on the wire (the transport rejected after the abort). A
   * counter, never a payload: the self-test's level-4 check reads it.
   */
  aborts(): number;
  /** The provider's hourly window this adapter spends against (shared per runtime). */
  readonly budget: HostedBudget;
  /**
   * WP 10.16: this adapter's egress policy, as a classifier over a URL —
   * `checkUrl`, syntactic: never a DNS lookup, never a connect.
   */
  readonly egress: {
    readonly kind: 'hosted';
    /** The one URL this adapter posts to. */
    readonly url: string;
    classify(url: string): EgressVerdict;
  };
}

export interface VendorReply {
  readonly content: string | null;
  readonly refused: boolean;
  readonly truncated: boolean;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
}

const SILENT: LocalModelLogger = Object.freeze({ info: () => undefined, warn: () => undefined });

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function numberOr(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The request body, per vendor. `messages` is the rendered prompt (system then
 * user). `schemaName` is OpenAI's and OpenRouter's `json_schema.name`
 * (Anthropic's format has none): `narration` for the narrator, and WP 11.2's
 * category suggestions (`suggest.ts`) name theirs.
 */
export function hostedRequestBody(
  provider: HostedProvider,
  model: string,
  messages: readonly PromptMessage[],
  format: Readonly<Record<string, unknown>>,
  maxOutputTokens: number,
  schemaName = 'narration',
): Record<string, unknown> {
  if (provider === 'anthropic') {
    return {
      model,
      max_tokens: maxOutputTokens,
      system: messages
        .filter((message) => message.role === 'system')
        .map((message) => message.content)
        .join('\n\n'),
      messages: messages
        .filter((message) => message.role === 'user')
        .map((message) => ({ role: 'user', content: message.content })),
      output_config: { format: { type: 'json_schema', schema: format } },
    };
  }
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema: format },
    },
  };
  if (provider === 'openai') {
    body['max_completion_tokens'] = maxOutputTokens;
  } else {
    body['max_tokens'] = maxOutputTokens;
    // Route only to an endpoint that honours `response_format` (OpenRouter's
    // structured-outputs guide): a provider that would ignore the schema is
    // not a provider this request may land on.
    body['provider'] = { require_parameters: true };
  }
  return body;
}

/** The headers, per vendor. Names from a fixed set; the key only here. */
export function hostedRequestHeaders(
  provider: HostedProvider,
  key: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': HOSTED_USER_AGENT,
  };
  if (provider === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = ANTHROPIC_VERSION;
  } else {
    headers['authorization'] = `Bearer ${key}`;
  }
  if (provider === 'openrouter') Object.assign(headers, OPENROUTER_ATTRIBUTION);
  for (const [name, value] of Object.entries(headers)) assertHeaderValueSafe(name, value);
  return headers;
}

/** Read a 2xx body in the vendor's documented shape. `null` content: not that shape. */
export function parseVendorReply(provider: HostedProvider, body: string): VendorReply | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (provider === 'anthropic') {
    const content = record['content'];
    if (!Array.isArray(content)) return null;
    const stop = record['stop_reason'];
    const usage = (record['usage'] ?? {}) as Record<string, unknown>;
    const text = content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          block !== null &&
          typeof block === 'object' &&
          (block as Record<string, unknown>)['type'] === 'text' &&
          typeof (block as Record<string, unknown>)['text'] === 'string',
      )
      .map((block) => block.text)
      .join('');
    return {
      content: stop === 'refusal' ? null : text,
      refused: stop === 'refusal',
      truncated: stop === 'max_tokens',
      inputTokens: numberOr(usage['input_tokens']),
      outputTokens: numberOr(usage['output_tokens']),
    };
  }
  const choices = record['choices'];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as Record<string, unknown> | null;
  if (choice === null || typeof choice !== 'object') return null;
  const message = choice['message'];
  if (message === null || typeof message !== 'object') return null;
  const messageRecord = message as Record<string, unknown>;
  const refusal = messageRecord['refusal'];
  const content = messageRecord['content'];
  const finish = choice['finish_reason'];
  const usage = (record['usage'] ?? {}) as Record<string, unknown>;
  const refused =
    (typeof refusal === 'string' && refusal.length > 0) || finish === 'content_filter';
  if (!refused && typeof content !== 'string') return null;
  return {
    content: refused ? null : (content as string),
    refused,
    truncated: finish === 'length',
    inputTokens: numberOr(usage['prompt_tokens']),
    outputTokens: numberOr(usage['completion_tokens']),
  };
}

/** What one hosted call returns: the vendor's reply in its documented shape. */
export interface HostedCallResult {
  readonly reply: VendorReply;
  readonly status: number;
  readonly bodyBytes: number;
}

/**
 * The part of a hosted adapter that is not the narration (WP 11.2): the
 * config checks, the one-host egress policy, the window, the key, the POST
 * and its error mapping and redaction. `createHostedModelAdapter` and the
 * category-suggestion adapter (`suggest.ts`) are each built over one, so the
 * two cannot drift on any of that; each brings its own prompt, reply format
 * and `json_schema` name. Not exported from the package index.
 */
export interface HostedCaller {
  readonly provider: HostedProvider;
  readonly model: string;
  readonly host: string;
  readonly url: string;
  /** `provider:model`. */
  readonly label: string;
  readonly policy: EgressPolicy;
  readonly budget: HostedBudget;
  readonly clock: Clock;
  readonly logger: LocalModelLogger;
  /** One POST. Throws `HostedModelError`; logs the provider's words redacted. */
  call(
    messages: readonly PromptMessage[],
    signal: AbortSignal,
    timeoutMs: number,
    maxOutputTokens: number,
    stage: { value: string },
    format: Readonly<Record<string, unknown>>,
    schemaName: string,
  ): Promise<HostedCallResult>;
  /** Calls torn down by the caller's signal while on the wire. */
  aborts(): number;
}

export function createHostedCaller(
  config: HostedModelConfig,
  deps: HostedModelDeps = {},
): HostedCaller {
  if (!(HOSTED_PROVIDERS as readonly string[]).includes(config.provider)) {
    throw new TypeError(`unknown hosted provider ${String(config.provider)}`);
  }
  if (!HOSTED_MODEL_ID_PATTERN.test(config.model)) {
    throw new TypeError('the model id is not a plain vendor model id');
  }
  if (
    !Number.isInteger(config.timeoutMs) ||
    config.timeoutMs <= 0 ||
    config.timeoutMs > HOSTED_TIMEOUT_CEILING_MS
  ) {
    throw new RangeError(
      `a hosted model's timeout is a positive integer no greater than ${String(HOSTED_TIMEOUT_CEILING_MS)} ms`,
    );
  }
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? SILENT;
  const transport = deps.transport ?? createNodeTransport();
  const resolve = deps.resolve ?? systemResolver;
  const budget = deps.budget ?? createHostedBudget();
  const provider = config.provider;
  const host = HOSTED_MODEL_HOSTS[provider];
  const url = `https://${host}${HOSTED_MODEL_PATHS[provider]}`;
  const policy = createEgressPolicy({
    allowedHosts: [host],
    allowedSchemes: ['https'],
    allowedPorts: [443],
    maxResponseBytes: HOSTED_MAX_RESPONSE_BYTES,
    timeoutMs: config.timeoutMs,
  });
  const label = `${provider}:${config.model}`;

  let abortsObserved = 0;

  /** One POST. Throws `HostedModelError`; logs the provider's words redacted. */
  async function call(
    messages: readonly PromptMessage[],
    signal: AbortSignal,
    timeoutMs: number,
    maxOutputTokens: number,
    stage: { value: string },
    format: Readonly<Record<string, unknown>>,
    schemaName: string,
  ): Promise<HostedCallResult> {
    if (signal.aborted)
      throw new HostedModelError('aborted', 'the run was cancelled before the call');
    if (!budget.take(clock.nowMs())) {
      throw new HostedModelError(
        'budget_exhausted',
        `this install's window for ${provider} (${String(budget.maxRequests)} calls an hour) is spent`,
      );
    }
    stage.value = 'egress_guard';
    const decision = await guardUrl(url, policy, resolve);
    if (!decision.ok) {
      throw new HostedModelError(
        'endpoint_refused',
        `the egress policy refused ${host} (${decision.code})`,
      );
    }
    const secret = config.key.reveal();
    let headers: Record<string, string>;
    try {
      headers = hostedRequestHeaders(provider, secret);
    } catch {
      throw new HostedModelError(
        'endpoint_refused',
        'a header value was refused by the egress policy',
      );
    }
    const body = JSON.stringify(
      hostedRequestBody(provider, config.model, messages, format, maxOutputTokens, schemaName),
    );

    stage.value = 'call';
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onAbort = (): void => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    let response;
    try {
      response = await transport({
        destination: decision.destination,
        method: 'POST',
        headers,
        body,
        timeoutMs,
        maxResponseBytes: HOSTED_MAX_RESPONSE_BYTES,
        secure: true,
        signal: controller.signal,
      });
    } catch (error) {
      if (signal.aborted) {
        // The caller's signal reached the socket and the transport gave up.
        abortsObserved += 1;
        throw new HostedModelError('aborted', 'the run was cancelled during the call');
      }
      if (timedOut)
        throw new HostedModelError('model_timeout', `no reply within ${String(timeoutMs)} ms`);
      if (isEgressRefusedError(error)) {
        if (error.code === 'timeout') {
          throw new HostedModelError('model_timeout', `no reply within ${String(timeoutMs)} ms`);
        }
        if (error.code === 'response_too_large') {
          throw new HostedModelError('model_reply_too_large', 'the reply passed the byte cap');
        }
        throw new HostedModelError(
          'endpoint_refused',
          `the egress policy refused the call (${error.code})`,
        );
      }
      logger.warn(
        {
          event: 'hosted_model.transport_error',
          provider,
          model: config.model,
          detail: redactProviderText(error instanceof Error ? error.message : String(error), [
            secret,
          ]),
        },
        'hosted model transport error',
      );
      throw new HostedModelError('model_unavailable', `${host} could not be reached`);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }

    stage.value = 'reply';
    const status = response.status;
    if (status >= 300 && status < 400) {
      throw new HostedModelError(
        'endpoint_refused',
        `${host} answered ${String(status)}; redirects are never followed`,
        { status },
      );
    }
    if (status < 200 || status >= 300) {
      const text = providerErrorText(response.body);
      logger.warn(
        {
          event: 'hosted_model.http_error',
          provider,
          model: config.model,
          status,
          provider_error: text === null ? null : redactProviderText(text, [secret]),
        },
        'hosted model answered with an error',
      );
      const code: HostedModelErrorCode =
        status === 401 || status === 403
          ? 'key_rejected'
          : status === 429
            ? 'provider_rate_limited'
            : status === 400 || status === 404 || status === 422
              ? 'request_refused'
              : 'model_unavailable';
      throw new HostedModelError(code, `${host} answered HTTP ${String(status)}`, { status });
    }
    const reply = parseVendorReply(provider, response.body);
    if (reply === null) {
      throw new HostedModelError(
        'model_protocol_error',
        `${host} answered, but not in its documented shape`,
        { status },
      );
    }
    if (reply.refused) {
      throw new HostedModelError('model_refused', 'the model declined to answer', { status });
    }
    return { reply, status, bodyBytes: response.bytesRead };
  }

  return Object.freeze({
    provider,
    model: config.model,
    host,
    url,
    label,
    policy,
    budget,
    clock,
    logger,
    call,
    aborts: () => abortsObserved,
  });
}

export function createHostedModelAdapter(
  config: HostedModelConfig,
  deps: HostedModelDeps = {},
): HostedModelAdapter {
  const caller = createHostedCaller(config, deps);
  const { provider, host, url, label, policy, budget, clock, logger } = caller;
  const format = hostedNarrationFormat(provider);
  const maxPromptBytes = DEFAULT_GENERATION_OPTIONS.maxPromptBytes;
  const promptTemplateHash = `sha256:${configHash({
    template: PROMPT_TEMPLATE_HASH,
    format,
    provider,
    model: config.model,
    options: { max_output_tokens: HOSTED_MAX_OUTPUT_TOKENS },
  })}`;

  /** The narrator's call: its format, its schema name. */
  function call(
    messages: readonly PromptMessage[],
    signal: AbortSignal,
    timeoutMs: number,
    maxOutputTokens: number,
    stage: { value: string },
  ): Promise<HostedCallResult> {
    return caller.call(messages, signal, timeoutMs, maxOutputTokens, stage, format, 'narration');
  }

  async function run(request: LocalModelRequest, signal: AbortSignal): Promise<unknown> {
    return execute(request, signal, null);
  }

  async function execute(
    request: LocalModelRequest,
    signal: AbortSignal,
    probe: ControlProbeId | null,
  ): Promise<unknown> {
    const started = clock.nowMs();
    const stage = { value: 'render' };
    let rendered: RenderedPrompt | null = null;
    try {
      if (signal.aborted)
        throw new HostedModelError('aborted', 'the run was cancelled before it started');
      rendered = renderPrompt(request);
      if (rendered.bytes > maxPromptBytes) {
        throw new HostedModelError(
          'prompt_too_large',
          `the rendered prompt is ${String(rendered.bytes)} bytes; the ceiling is ${String(maxPromptBytes)}`,
        );
      }
      const deadlineMs = Date.parse(request.limits.deadline);
      const remaining = Number.isFinite(deadlineMs) ? deadlineMs - clock.nowMs() : config.timeoutMs;
      const timeoutMs = Math.min(config.timeoutMs, remaining);
      if (timeoutMs <= 0)
        throw new HostedModelError('model_timeout', 'the request deadline has already passed');

      const { reply, status, bodyBytes } = await call(
        probe === null ? rendered.messages : withControlInstruction(rendered.messages, probe),
        signal,
        probe === null ? timeoutMs : Math.min(timeoutMs, HOSTED_PROBE_TIMEOUT_MS),
        probe === null ? HOSTED_MAX_OUTPUT_TOKENS : HOSTED_PROBE_MAX_OUTPUT_TOKENS,
        stage,
      );
      stage.value = 'wrap';
      const content = reply.content ?? '';
      const contentBytes = byteLength(content);
      if (contentBytes > request.limits.max_response_bytes) {
        throw new HostedModelError(
          'model_reply_too_large',
          `the reply is ${String(contentBytes)} bytes; the limit is ${String(request.limits.max_response_bytes)}`,
        );
      }
      const warnings: string[] = sanitiserWarnings(rendered.flags);
      if (reply.truncated)
        warnings.push(
          `model reply cut at the output-token cap ${String(HOSTED_MAX_OUTPUT_TOKENS)}`,
        );
      const parsedReply = insightsFromReply(content);
      warnings.push(...parsedReply.warnings);
      const runtimeMs = Math.max(0, clock.nowMs() - started);
      const response = narratorResponse({
        request,
        insights: parsedReply.insights,
        warnings,
        runtimeMs,
        model: label,
        producedAt: clock.now().toISOString(),
      });
      logger.info(
        {
          event: 'hosted_model.run',
          provider,
          model: config.model,
          host,
          request_id: request.request_id,
          advisor_id: request.advisor_id,
          prompt_hash: rendered.hash,
          prompt_template_hash: promptTemplateHash,
          prompt_bytes: rendered.bytes,
          status,
          body_bytes: bodyBytes,
          reply_bytes: contentBytes,
          input_tokens: reply.inputTokens,
          output_tokens: reply.outputTokens,
          truncated: reply.truncated,
          runtime_ms: runtimeMs,
          shape: requestShape(request),
          sanitiser: countFlags(rendered.flags),
          reply_is_json: parsedReply.isJson,
          ...(probe === null ? {} : { control_probe: probe }),
        },
        'hosted model run',
      );
      return response;
    } catch (error) {
      const failure =
        error instanceof HostedModelError
          ? error
          : new HostedModelError('model_unavailable', 'the run failed', { cause: error });
      logger.warn(
        {
          event: 'hosted_model.failed',
          provider,
          model: config.model,
          request_id: request.request_id,
          advisor_id: request.advisor_id,
          code: failure.code,
          status: failure.status,
          stage: stage.value,
          prompt_bytes: rendered?.bytes ?? null,
          runtime_ms: Math.max(0, clock.nowMs() - started),
          ...(probe === null ? {} : { control_probe: probe }),
        },
        'hosted model run failed',
      );
      throw failure;
    }
  }

  async function probe(signal: AbortSignal): Promise<HostedProbeResult> {
    const started = clock.nowMs();
    const stage = { value: 'probe' };
    try {
      const { reply, status } = await call(
        PROBE_MESSAGES,
        signal,
        Math.min(config.timeoutMs, HOSTED_PROBE_TIMEOUT_MS),
        HOSTED_PROBE_MAX_OUTPUT_TOKENS,
        stage,
      );
      const parsed = insightsFromReply(reply.content ?? '');
      return {
        provider,
        model: config.model,
        outcome: 'ok',
        roundTripMs: Math.max(0, clock.nowMs() - started),
        status,
        replyShaped: parsed.isJson && Array.isArray(parsed.insights),
      };
    } catch (error) {
      const failure =
        error instanceof HostedModelError
          ? error
          : new HostedModelError('model_unavailable', 'the probe failed', { cause: error });
      return {
        provider,
        model: config.model,
        outcome: failure.code,
        roundTripMs: Math.max(0, clock.nowMs() - started),
        status: failure.status,
        replyShaped: false,
      };
    }
  }

  return Object.freeze({
    run,
    probe,
    controlProbe: (id: ControlProbeId, request: LocalModelRequest, signal: AbortSignal) =>
      execute(request, signal, id),
    aborts: caller.aborts,
    budget,
    egress: Object.freeze({
      kind: 'hosted' as const,
      url,
      classify: (target: string): EgressVerdict => {
        const decision = checkUrl(target, policy);
        return decision.ok
          ? { allowed: true, code: null }
          : { allowed: false, code: decision.code };
      },
    }),
    renderPrompt,
    provider,
    model: config.model,
    label,
    host,
    format,
    promptTemplateHash,
    promptRenderer: Object.freeze({
      templateHash: promptTemplateHash,
      model: label,
      provider,
      render: (request: LocalModelRequest) => {
        const rendered = renderPrompt(request);
        return { text: rendered.text, hash: rendered.hash };
      },
    }),
    policy,
  });
}
