// SPDX-License-Identifier: MIT
/**
 * The SMTP adapter, over `nodemailer` — the one third-party network client the
 * boundary lint lets into this repository, and only into this package
 * (`scripts/eslint-boundaries.js`, layer `notifications`).
 *
 * ## TLS is mandatory, in both shapes, with no downgrade
 *
 * `smtps` is implicit TLS (port 465): the socket is TLS from the first byte.
 * `smtp+starttls` is submission (port 587) with `requireTLS: true`, which makes
 * nodemailer *fail* rather than continue if the server does not offer
 * `STARTTLS`. Opportunistic STARTTLS — nodemailer's default when neither flag
 * is set — is not reachable from here and is not a member of the schema's
 * scheme enum, because an attacker who can strip `STARTTLS` from the EHLO
 * response silently downgrades the session to cleartext and a client that only
 * *prefers* TLS never notices.
 *
 * `rejectUnauthorized` is `true` and `minVersion` is TLS 1.2. There is no
 * option on this adapter that changes either.
 *
 * ## The socket connects to a validated address, not to a name
 *
 * The same DNS-rebinding close as `transport.ts`: `guardDestination` resolves
 * and classifies, and the address it validated is what goes into
 * nodemailer's `host`, with `tls.servername` set to the hostname so certificate
 * verification is still against the name the operator allow-listed. Handing
 * nodemailer the hostname would let a resolver answer `127.0.0.1` on the second
 * lookup, which is the whole attack.
 *
 * ## Nothing here sends mail in a test
 *
 * `createTransport` is injected. Every suite in this package passes a stub, and
 * 02-phase-2-dispatch.md's rule for WP 2.4 is explicit that no test may send a
 * real email. The production default is `nodemailer.createTransport` and is
 * reached only from the composition root.
 */
import nodemailer from 'nodemailer';
import {
  guardDestination,
  isEgressRefusedError,
  systemResolver,
  type EgressPolicy,
  type Resolver,
} from '../egress.ts';
import type {
  ChannelCapabilities,
  ChannelConfig,
  DeliveryResult,
  Notification,
  NotificationChannel,
  SmtpChannelConfig,
  VerifyResult,
} from '../channel.ts';

const CAPABILITIES: ChannelCapabilities = Object.freeze({
  markdown: false,
  actions: false,
  attachments: false,
  maxBytes: 65_536,
});

/** The subset of a nodemailer transport this adapter uses. */
export interface SmtpTransport {
  sendMail(message: SmtpMessage): Promise<{ readonly messageId?: string }>;
  verify(): Promise<boolean>;
  close?(): void;
}

export interface SmtpMessage {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

export interface SmtpTransportOptions {
  /** The **validated IP address**, never the hostname. */
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly requireTLS: boolean;
  readonly auth: { readonly user: string; readonly pass: string };
  readonly tls: {
    readonly servername: string;
    readonly rejectUnauthorized: true;
    readonly minVersion: 'TLSv1.2';
  };
  readonly connectionTimeout: number;
  readonly greetingTimeout: number;
  readonly socketTimeout: number;
}

export type SmtpTransportFactory = (options: SmtpTransportOptions) => SmtpTransport;

const nodemailerFactory: SmtpTransportFactory = (options) =>
  nodemailer.createTransport({ ...options, pool: false }) as unknown as SmtpTransport;

export interface SmtpChannelOptions {
  readonly policy: EgressPolicy;
  /** Injected in every test. Defaults to `nodemailer.createTransport`. */
  readonly createTransport?: SmtpTransportFactory;
  readonly resolve?: Resolver;
}

export function createSmtpChannel(options: SmtpChannelOptions): NotificationChannel {
  const factory = options.createTransport ?? nodemailerFactory;
  const resolve = options.resolve ?? systemResolver;

  async function withTransport<T>(
    config: ChannelConfig,
    use: (transport: SmtpTransport, config: SmtpChannelConfig) => Promise<T>,
  ): Promise<T | DeliveryResult> {
    if (config.kind !== 'smtp') {
      return { outcome: 'permanent', detail: 'this channel is not an SMTP channel' };
    }

    const decision = await guardDestination(
      { scheme: config.scheme, host: config.host, port: config.port },
      options.policy,
      resolve,
    );
    if (!decision.ok) {
      return { outcome: 'refused', refusalCode: decision.code, detail: decision.detail };
    }
    const address = decision.destination.addresses[0];
    if (address === undefined) {
      return { outcome: 'refused', refusalCode: 'private_address', detail: 'no validated address' };
    }

    const transport = factory({
      // The address, not the name. See the header.
      host: address,
      port: decision.destination.port,
      secure: config.scheme === 'smtps',
      requireTLS: true,
      auth: { user: config.username, pass: config.password },
      tls: {
        servername: decision.destination.host,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
      },
      connectionTimeout: options.policy.timeoutMs,
      greetingTimeout: options.policy.timeoutMs,
      socketTimeout: options.policy.timeoutMs * 3,
    });

    try {
      return await use(transport, config);
    } finally {
      transport.close?.();
    }
  }

  return {
    kind: 'smtp',
    capabilities: CAPABILITIES,

    async send(notification: Notification, channelConfig: ChannelConfig): Promise<DeliveryResult> {
      try {
        const result = await withTransport(
          channelConfig,
          async (transport, config): Promise<DeliveryResult> => {
            await transport.sendMail({
              from: config.from,
              to: config.to,
              subject: notification.title,
              text: bodyOf(notification),
            });
            return { outcome: 'delivered' };
          },
        );
        return result;
      } catch (error) {
        return classifyError(error);
      }
    },

    async verify(channelConfig: ChannelConfig): Promise<VerifyResult> {
      try {
        const result = await withTransport(
          channelConfig,
          async (transport): Promise<DeliveryResult> => {
            // `verify()` opens the connection, negotiates TLS and authenticates,
            // then hangs up. It proves the credential and the TLS posture
            // without putting a message in anybody's inbox.
            await transport.verify();
            return { outcome: 'delivered' };
          },
        );
        return result.outcome === 'delivered'
          ? { ok: true }
          : {
              ok: false,
              refusalCode: result.refusalCode ?? null,
              detail: result.detail ?? result.outcome,
            };
      } catch (error) {
        const failure = classifyError(error);
        return {
          ok: false,
          refusalCode: failure.refusalCode ?? null,
          detail: failure.detail ?? failure.outcome,
        };
      }
    },
  };
}

/**
 * A plain-text body. The deep link and any actions are appended as URLs,
 * which is 08 §4.5's "degraded to links on channels without actions".
 */
function bodyOf(notification: Notification): string {
  const lines = [notification.bodyMd];
  if (notification.groupCount !== undefined && notification.groupCount > 1) {
    lines.push('', `(${String(notification.groupCount)} related events in this digest)`);
  }
  for (const action of notification.actions ?? []) lines.push('', `${action.label}: ${action.url}`);
  if (notification.deepLink != null) lines.push('', notification.deepLink);
  return lines.join('\n');
}

/**
 * An SMTP error, classified.
 *
 * A 4xx enhanced status code is a deferral and a 5xx is a rejection; that is
 * the whole of SMTP's own retry advice and there is no reason to second-guess
 * it. Anything that is not a recognised SMTP response is a socket problem and
 * therefore retryable — up to `max_attempts`, after which the row dead-letters
 * and stays visible.
 */
function classifyError(error: unknown): DeliveryResult {
  if (isEgressRefusedError(error)) {
    return { outcome: 'refused', refusalCode: error.code, detail: error.message };
  }
  const code = (error as { responseCode?: unknown } | null)?.responseCode;
  if (typeof code === 'number' && code >= 500 && code < 600) {
    return { outcome: 'permanent', detail: `SMTP ${String(code)}` };
  }
  if (typeof code === 'number' && code >= 400 && code < 500) {
    return { outcome: 'retryable', detail: `SMTP ${String(code)}` };
  }
  return { outcome: 'retryable', detail: error instanceof Error ? error.message : String(error) };
}
