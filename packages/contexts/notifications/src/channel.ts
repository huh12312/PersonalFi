// SPDX-License-Identifier: MIT
/**
 * The `NotificationChannel` port (08 §4.5).
 *
 * > "Symmetric design, much simpler, same principle — one port, adapters, no
 * > context knows the channels."
 *
 * Two departures from the memo's sketch, both deliberate:
 *
 * 1. **`send` takes the config as well as the notification.** The memo's
 *    `send(n)` implies one adapter instance per configured channel; here one
 *    `NtfyChannel` serves every ntfy row, and the secrets arrive per call,
 *    freshly opened from `SecretBox`. That keeps the window in which a
 *    plaintext token exists as narrow as the call itself rather than as long
 *    as the worker's uptime.
 * 2. **A failure is a returned value, not a thrown error, and it carries an
 *    *outcome* rather than a boolean.** `retryable`, `permanent` and `refused`
 *    are three different operational facts: try again later, stop trying, and
 *    *we declined to connect*. The last one is the SSRF signal, and an
 *    interface that collapsed it into "false" would bury it.
 *
 * The `kind` union includes `fake`, which has no schema row and no adapter in
 * production. It exists so `test/db/*` can drive the outbox, the backoff ladder
 * and the dead-letter path without a socket — 02-phase-2-dispatch.md's rule for
 * this package is that no test ever sends a real email or a real ntfy push.
 */
import { z } from 'zod';
import type { RefusalCode } from './egress.ts';
import type { ChannelKind, NotificationPriority } from '../schema/index.ts';

export type AdapterKind = ChannelKind | 'fake';

export interface ChannelCapabilities {
  readonly markdown: boolean;
  readonly actions: boolean;
  readonly attachments: boolean;
  /** Bytes of body the channel will carry. Longer bodies are truncated, not dropped. */
  readonly maxBytes: number;
}

export interface NotificationAction {
  readonly label: string;
  readonly url: string;
}

/** 08 §4.5's `Notification`, with the money discipline the repo applies elsewhere. */
export interface Notification {
  /** UNIQUE in `notification_outbox` — at-most-once delivery. */
  readonly dedupeKey: string;
  readonly priority: NotificationPriority;
  readonly title: string;
  readonly bodyMd: string;
  /** Back into the UI. Rendered as a link on channels without a click action. */
  readonly deepLink?: string | null;
  /** Degraded to links on channels without actions. */
  readonly actions?: readonly NotificationAction[];
  /** Coalescing key for digests. */
  readonly groupKey?: string | null;
  /** How many facts this notification stands for. 1 unless coalesced. */
  readonly groupCount?: number;
}

export type DeliveryOutcome = 'delivered' | 'retryable' | 'permanent' | 'refused';

export interface DeliveryResult {
  readonly outcome: DeliveryOutcome;
  /** Set exactly when `outcome === 'refused'`. */
  readonly refusalCode?: RefusalCode | null;
  readonly httpStatus?: number | null;
  /** Short, already-redacted. Never a response body, never a URL with a secret. */
  readonly detail?: string | null;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly refusalCode?: RefusalCode | null;
  readonly detail?: string | null;
}

export interface NotificationChannel {
  readonly kind: AdapterKind;
  readonly capabilities: ChannelCapabilities;
  /** Deliver, or say precisely why not. Never throws for an expected failure. */
  send(notification: Notification, config: ChannelConfig): Promise<DeliveryResult>;
  /** The "send test notification" button. Reaches the destination for real. */
  verify(config: ChannelConfig): Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Channel configuration — the part that is sealed
// ---------------------------------------------------------------------------

/**
 * What lives inside `notification_channels.sealed_config`.
 *
 * `host`, `port` and `scheme` are here *as well as* in their own clear columns,
 * and the mismatch between the two is a hard error in `openChannelConfig`. The
 * clear columns are what the operator audits and what the allow-list is checked
 * against; the sealed copy is what proves the clear ones were not edited by
 * anyone without the passphrase. A row whose `destination_host` was rewritten
 * in `psql` to `db` fails to open, because the AAD covers the row and the
 * comparison covers the value.
 */
export const ntfyConfigSchema = z.object({
  kind: z.literal('ntfy'),
  scheme: z.literal('https'),
  host: z.string().min(1),
  port: z.int().min(1).max(65_535),
  /** ntfy's topic. Path-safe by construction; validated, never interpolated raw. */
  topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** `tk_...`. Null for an unauthenticated topic on a private server. */
  accessToken: z.string().min(1).max(512).nullable(),
});

export const smtpConfigSchema = z.object({
  kind: z.literal('smtp'),
  scheme: z.enum(['smtps', 'smtp+starttls']),
  host: z.string().min(1),
  port: z.int().min(1).max(65_535),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(512),
  /** Envelope sender. */
  from: z.email(),
  /** The one recipient. There is no list: this is a single-tenant app (D6). */
  to: z.email(),
});

export const channelConfigSchema = z.discriminatedUnion('kind', [
  ntfyConfigSchema,
  smtpConfigSchema,
]);

export type NtfyChannelConfig = z.infer<typeof ntfyConfigSchema>;
export type SmtpChannelConfig = z.infer<typeof smtpConfigSchema>;
export type ChannelConfig = z.infer<typeof channelConfigSchema>;

/**
 * Everything about a channel that is safe to render, log, or put in an event.
 *
 * Note what is absent: the token and the password. A `RedactedChannel` is what
 * a read model returns and what an error message may name.
 */
export interface RedactedChannel {
  readonly id: string;
  readonly kind: ChannelKind;
  readonly displayName: string;
  readonly destinationHost: string;
  readonly destinationPort: number;
  readonly scheme: string;
  readonly enabled: boolean;
  readonly verifiedAt: Date | null;
  readonly verifyFailureCode: string | null;
  readonly lastDeliveryAt: Date | null;
}
