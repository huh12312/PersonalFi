// SPDX-License-Identifier: MIT
/**
 * The ntfy adapter.
 *
 * 02-phase-2-dispatch.md §6 question 3's default is "ntfy self-hosted topic",
 * so the destination is a host the operator runs and has named in the
 * allow-list — not `ntfy.sh`. Nothing here assumes that, because the guard does
 * not care whose server it is; what matters is that the host was named, resolves
 * publicly, and is reached over TLS on an allowed port.
 *
 * Three things this adapter deliberately does not do:
 *
 * * **It does not build a URL from user input.** The topic is validated against
 *   `/^[A-Za-z0-9_-]{1,64}$/` by `ntfyConfigSchema` before it reaches here, so
 *   there is no `..`, no `%2e%2e`, no `?`, and no second host to smuggle in.
 * * **It does not accept headers.** ntfy's HTTP API can carry the title,
 *   priority and actions as `X-Title` / `X-Priority` / `X-Actions` headers; this
 *   sends a JSON body instead, so there is exactly one code path by which user
 *   data reaches the wire and it is one that cannot split a request. The token
 *   is the only user value that becomes a header and
 *   `assertHeaderValueSafe` checks it.
 * * **It does not retry.** Retry is the delivery job's business, driven by the
 *   `delivery_attempts` ladder, so a retry is durable and visible rather than a
 *   loop inside one worker tick.
 */
import {
  classifyStatus,
  guardDestination,
  isEgressRefusedError,
  systemResolver,
  type EgressPolicy,
  type Resolver,
} from '../egress.ts';
import { createNodeTransport, type HttpTransport } from '../transport.ts';
import type {
  ChannelCapabilities,
  ChannelConfig,
  DeliveryResult,
  Notification,
  NotificationChannel,
  VerifyResult,
} from '../channel.ts';

/** ntfy's priority scale is 1–5; ours is three names. */
const NTFY_PRIORITY = { low: 2, normal: 3, high: 5 } as const;

const CAPABILITIES: ChannelCapabilities = Object.freeze({
  markdown: true,
  actions: true,
  attachments: false,
  // ntfy's default message cap is 4 KiB; longer bodies are truncated with an
  // ellipsis rather than rejected, because a truncated alert still alerts.
  maxBytes: 4096,
});

export interface NtfyChannelOptions {
  readonly policy: EgressPolicy;
  /** Overridden only by a test fixture; production uses the node transport. */
  readonly transport?: HttpTransport;
  readonly resolve?: Resolver;
}

export function createNtfyChannel(options: NtfyChannelOptions): NotificationChannel {
  const transport = options.transport ?? createNodeTransport();
  const resolve = options.resolve ?? systemResolver;

  async function post(
    config: ChannelConfig,
    payload: Record<string, unknown>,
  ): Promise<DeliveryResult> {
    if (config.kind !== 'ntfy') {
      return { outcome: 'permanent', detail: 'this channel is not an ntfy channel' };
    }

    const decision = await guardDestination(
      {
        scheme: 'https',
        host: config.host,
        port: config.port,
        // ntfy accepts the topic in the body when POSTing to the root.
        path: '/',
      },
      options.policy,
      resolve,
    );
    if (!decision.ok) {
      return { outcome: 'refused', refusalCode: decision.code, detail: decision.detail };
    }

    const body = JSON.stringify({ ...payload, topic: config.topic });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
      'user-agent': 'PersonalFi/1 (+notifications)',
      accept: 'application/json',
    };
    if (config.accessToken !== null) headers['authorization'] = `Bearer ${config.accessToken}`;

    try {
      const response = await transport({
        destination: decision.destination,
        method: 'POST',
        headers,
        body,
        secure: true,
        timeoutMs: options.policy.timeoutMs,
        maxResponseBytes: options.policy.maxResponseBytes,
      });

      const verdict = classifyStatus(response.status);
      if (typeof verdict !== 'string') {
        // A 3xx. `classifyStatus` returns the refusal rather than a class,
        // because not following a redirect is a decision we made, not a
        // failure they had.
        return {
          outcome: 'refused',
          refusalCode: verdict.code,
          httpStatus: response.status,
          detail: verdict.detail,
        };
      }
      if (verdict === 'ok') {
        return { outcome: 'delivered', httpStatus: response.status };
      }
      return {
        outcome: verdict,
        httpStatus: response.status,
        detail: `ntfy answered HTTP ${String(response.status)}`,
      };
    } catch (error) {
      if (isEgressRefusedError(error)) {
        return { outcome: 'refused', refusalCode: error.code, detail: error.message };
      }
      // A socket error. Transient until proven otherwise; the attempt ladder
      // is what decides it is permanent, after `max_attempts`.
      return { outcome: 'retryable', detail: describe(error) };
    }
  }

  return {
    kind: 'ntfy',
    capabilities: CAPABILITIES,

    async send(notification: Notification, config: ChannelConfig): Promise<DeliveryResult> {
      return post(config, {
        title: notification.title,
        message: truncate(notification.bodyMd, CAPABILITIES.maxBytes),
        priority: NTFY_PRIORITY[notification.priority],
        ...(notification.deepLink == null ? {} : { click: notification.deepLink }),
        ...(notification.actions === undefined || notification.actions.length === 0
          ? {}
          : {
              actions: notification.actions.slice(0, 3).map((action) => ({
                action: 'view',
                label: action.label,
                url: action.url,
              })),
            }),
      });
    },

    async verify(config: ChannelConfig): Promise<VerifyResult> {
      const result = await post(config, {
        title: 'PersonalFi test notification',
        message: 'If you can read this, the channel is configured correctly.',
        priority: NTFY_PRIORITY.low,
      });
      return result.outcome === 'delivered'
        ? { ok: true }
        : {
            ok: false,
            refusalCode: result.refusalCode ?? null,
            detail: result.detail ?? result.outcome,
          };
    },
  };
}

/** Truncate on a byte budget, not a character count, and say that we did. */
export function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const suffix = '…';
  const budget = maxBytes - Buffer.byteLength(suffix, 'utf8');
  const bytes = Buffer.from(text, 'utf8').subarray(0, budget);
  // Drop a trailing partial code point rather than emitting U+FFFD.
  return `${new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/�$/, '')}${suffix}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
