// SPDX-License-Identifier: MIT
/**
 * WP 10.6 — a hermetic stand-in for OpenAI, OpenRouter and Anthropic. **No test
 * in this repo calls a vendor**: the adapter's transport is replaced by this
 * one, which answers in each vendor's documented reply shape (recorded from
 * the vendors' own reference pages on 2026-10-15 and quoted in the WP 10.6
 * evidence), records every request it was handed, and can answer like a
 * vendor refusing the key (401), rate-limiting (429), refusing the schema
 * (400), being down (503), redirecting (307), declining to answer, or never
 * answering. Chris's first Test press is the live check.
 *
 * `PUBLIC_RESOLVE` answers a fixed public address for the egress guard (the
 * WP 10.4 precedent): the guard classifies it before the "connect", so a test
 * can also hand it a private address and watch the guard refuse.
 */
import type { HttpTransport, TransportRequest, TransportResponse } from '@core/platform';
import type { HostedProvider } from '../src/hosted-format.ts';

export const PUBLIC_RESOLVE = (): Promise<readonly string[]> => Promise.resolve(['93.184.216.34']);
export const PRIVATE_RESOLVE = (): Promise<readonly string[]> => Promise.resolve(['10.0.0.17']);

/** A synthetic key, long enough for the hint rule. gitleaks:allow — synthetic */
export const SYNTHETIC_KEY = 'sk-test-wp106-synthetic-key-0000000000000001'; // gitleaks:allow — synthetic

export interface RecordedHostedCall {
  readonly host: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
  readonly address: string;
  readonly timeoutMs: number;
}

/** The vendor's 2xx body around `content` (the model's JSON text). */
export function recordedReply(
  provider: HostedProvider,
  content: string,
  options: { readonly truncated?: boolean; readonly refused?: boolean } = {},
): string {
  if (provider === 'anthropic') {
    return JSON.stringify({
      id: 'msg_01WP106',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-5-5',
      content: options.refused === true ? [] : [{ type: 'text', text: content }],
      stop_reason:
        options.refused === true
          ? 'refusal'
          : options.truncated === true
            ? 'max_tokens'
            : 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 812, output_tokens: 96 },
    });
  }
  return JSON.stringify({
    id: 'chatcmpl-wp106',
    object: 'chat.completion',
    created: 1_760_000_000,
    model: provider === 'openai' ? 'gpt-6.1-sol' : 'anthropic/claude-sonnet-5.5',
    choices: [
      {
        index: 0,
        message:
          options.refused === true
            ? { role: 'assistant', content: null, refusal: 'I cannot help with that.' }
            : { role: 'assistant', content, refusal: null },
        finish_reason: options.truncated === true ? 'length' : 'stop',
      },
    ],
    usage: { prompt_tokens: 812, completion_tokens: 96, total_tokens: 908 },
  });
}

/** The vendor's error body: `{error: {message, …}}` for all three (Anthropic adds `type: 'error'`). */
export function vendorError(provider: HostedProvider, message: string): string {
  return provider === 'anthropic'
    ? JSON.stringify({ type: 'error', error: { type: 'authentication_error', message } })
    : JSON.stringify({ error: { message, type: 'invalid_request_error', code: null } });
}

export type FakeResponder = (
  call: RecordedHostedCall,
) => TransportResponse | Promise<TransportResponse>;

/** A transport that answers like the vendor and records what it was handed. */
export class FakeHostedTransport {
  readonly calls: RecordedHostedCall[] = [];
  readonly transport: HttpTransport;

  constructor(responder: FakeResponder) {
    this.transport = async (request: TransportRequest): Promise<TransportResponse> => {
      const call: RecordedHostedCall = {
        host: request.destination.host,
        path: request.destination.path,
        headers: request.headers,
        body: JSON.parse(request.body ?? '{}') as Record<string, unknown>,
        address: request.destination.addresses[0] ?? '',
        timeoutMs: request.timeoutMs,
      };
      this.calls.push(call);
      if (request.signal?.aborted === true) throw new Error('aborted before the call');
      return responder(call);
    };
  }

  /** Answers every call with `content` in the vendor's shape. */
  static answering(provider: HostedProvider, content: string): FakeHostedTransport {
    return new FakeHostedTransport(() => ok(recordedReply(provider, content)));
  }
}

export function ok(body: string, status = 200): TransportResponse {
  return { status, body, bytesRead: new TextEncoder().encode(body).byteLength, location: null };
}

export type RejectionMode =
  'unauthorized' | 'rate_limited' | 'schema_refused' | 'down' | 'redirect';

/**
 * The rejecting subclass: answers like a vendor refusing the request. The
 * error message can echo the key, the way a careless proxy or vendor might,
 * so a test can prove the redaction.
 */
export class RejectingHostedTransport extends FakeHostedTransport {
  constructor(provider: HostedProvider, mode: RejectionMode, echo = '') {
    super(() => {
      switch (mode) {
        case 'unauthorized':
          return ok(vendorError(provider, `Incorrect API key provided: ${echo}`), 401);
        case 'rate_limited':
          return ok(vendorError(provider, `Rate limit reached for ${echo}`), 429);
        case 'schema_refused':
          return ok(
            vendorError(provider, `Invalid schema for response_format 'narration' ${echo}`),
            400,
          );
        case 'down':
          return ok(vendorError(provider, `overloaded ${echo}`), 503);
        case 'redirect':
          return { status: 307, body: '', bytesRead: 0, location: 'https://evil.example/' };
      }
    });
  }
}

/** A narration reply in the B shape (slots, no digit), for finding 1. */
export function narrationJson(summary = 'Your {{e1}} subscription renews monthly.'): string {
  return JSON.stringify({
    insights: [
      {
        finding: 1,
        severity: 'info',
        title: 'A monthly subscription',
        summary_md: summary,
        confidence: 0.8,
        confidence_basis: 'model',
        horizon: 'this_period',
        requires_review: true,
        impact: {
          annualized: null,
          one_time: null,
          basis: 'As the app computed it.',
          derivation_id: null,
        },
        derivations: [],
        proposed_actions: [],
        caveats: [],
        expires_at: null,
      },
    ],
  });
}
