// SPDX-License-Identifier: MIT
import type { AppConfig } from '@core/config';
import { REDACTED_MARKER } from '@core/config';
import { systemClock } from '@core/kernel';
import type { LoggerOptions } from 'pino';

/**
 * Everything that must never reach a log line.
 *
 * This list is a P0 security control (master plan §4.12): a CI test greps captured
 * sync logs and fails on a token or an account number. Adding a field that holds a
 * credential without adding it here is the failure mode this exists to prevent, so
 * prefer over-broad paths.
 */
/**
 * Field names that may never appear in a log line, matched case-insensitively
 * at **any** depth by {@link censorDeep}.
 *
 * This is the list that does the work. {@link REDACTED_PATHS} below is pino's
 * own `redact` config, kept as a second layer, but it cannot be the primary
 * control: `fast-redact` compiles each path to a fixed property access, so `*`
 * matches exactly one level and there is no `**`. The gate demonstrated the
 * consequence — `{plaid:{access_token}}` was censored while
 * `{plaid:{item:{access_token}}}`, a bare top-level `access_token`, and
 * `{err:{config:{headers:{authorization}}}}` all went to the log in clear.
 *
 * The last shape is the one that matters. `app.ts` logs `{ err: error }` on
 * every unhandled error, and an HTTP-client error from the Plaid SDK carries its
 * whole request config — `Authorization`, `PLAID-SECRET`, and a body holding
 * `client_secret` and `access_token` — hanging off the error at exactly that
 * depth. Nothing in Phase 0 makes such a call. Phase 1 makes it on day one.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // Transport-level credentials.
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'plaid-verification',
  // Plaid sends its credentials as headers on every request (Phase 1).
  'plaid-secret',
  'plaid-client-id',

  // Provider and session credentials.
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'public_token',
  'publictoken',
  'link_token',
  'linktoken',
  'id_token',
  'idtoken',
  'client_secret',
  'clientsecret',
  'api_key',
  'apikey',
  'secret',
  'password',
  'passphrase',
  'private_key',
  'privatekey',
  'master_key',
  'masterkey',
  'kek',
  'dek',
  'session_token',
  'sessiontoken',
  'csrf_token',

  // Personally identifying account detail.
  'account_number',
  'accountnumber',
  'routing_number',
  'routingnumber',
  'iban',
  'wire_routing',
  'ssn',
  'tax_id',
  'taxid',
  'card_number',
  'cardnumber',
  'cvv',
  'xpub',
  'mnemonic',
]);

/**
 * Properties of an **error** that are request/response envelopes rather than
 * diagnostics. Dropped wholesale rather than walked.
 *
 * An axios-style error's `config`/`request`/`response` is an unbounded object
 * graph containing the credential *and* the request body *and* the raw socket.
 * Worse, `config.data` is the request body as an already-serialised JSON
 * *string*, so key-by-key censoring cannot reach the `client_secret` inside it.
 * Dropping the envelope keeps `name`, `message`, `code` and the stack —
 * everything actually used to diagnose a failed sync — and never carries the
 * credential at all.
 *
 * **Only inside an error.** These names are far too ordinary to drop globally:
 * `main.ts` logs `{ config: describeConfig(config) }` at boot, which is the
 * P0-2 configuration snapshot and the thing `log-hygiene.test.ts` reads. An
 * earlier revision of this fix censored that line to `"config":"[redacted]"` and
 * destroyed the evidence it was meant to protect.
 */
const DROPPED_ERROR_KEYS: ReadonlySet<string> = new Set(['config', 'request', 'response', 'agent']);

/** Depth cap. Deeper than this is a cycle or a socket, not a diagnostic. */
const MAX_DEPTH = 12;

/**
 * Recursively censor sensitive keys, whatever their depth.
 *
 * Returns a new structure; the caller's object is never mutated, because a
 * logger that edits the objects handed to it changes program behaviour on a
 * `LOG_LEVEL` change. Cycles are tracked with a `WeakSet` (an error's `config`
 * routinely points back at the error), and anything past {@link MAX_DEPTH} is
 * replaced rather than walked.
 */
export function censorDeep(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
  /** True once we are inside an error, which is the only place envelopes are dropped. */
  inError = false,
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return REDACTED_MARKER;
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => censorDeep(item, depth + 1, seen, inError));
  }

  // Buffers, streams and sockets hang off HTTP-client errors and serialise to
  // megabytes of noise that may itself contain a credential.
  if (Buffer.isBuffer(value)) return `[Buffer ${String(value.length)}]`;

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      type: value.name,
      message: value.message,
      stack: value.stack,
    };
    for (const key of Object.keys(value)) {
      if (DROPPED_ERROR_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTED_MARKER;
        continue;
      }
      out[key] = censorDeep(
        (value as unknown as Record<string, unknown>)[key],
        depth + 1,
        seen,
        true,
      );
    }
    if (value.cause !== undefined) {
      out['cause'] = censorDeep(value.cause, depth + 1, seen, true);
    }
    return out;
  }

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalised = key.toLowerCase();
    if (SENSITIVE_KEYS.has(normalised)) {
      out[key] = REDACTED_MARKER;
      continue;
    }
    if (inError && DROPPED_ERROR_KEYS.has(normalised)) {
      out[key] = REDACTED_MARKER;
      continue;
    }
    out[key] = censorDeep(item, depth + 1, seen, inError);
  }
  return out;
}

export const REDACTED_PATHS: readonly string[] = [
  // Transport-level credentials.
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["plaid-verification"]',
  'res.headers["set-cookie"]',

  // Header bags one level down, wherever they hang. `fast-redact` has no `**`,
  // so these are the enumerated shapes that actually occur; `censorDeep` is what
  // covers the ones nobody enumerated.
  '*.headers.authorization',
  '*.headers.cookie',
  '*.headers["set-cookie"]',
  '*.headers["x-api-key"]',
  '*.headers["plaid-secret"]',
  '*.headers["plaid-client-id"]',
  'err.config.headers.*',
  'err.response.config.headers.*',
  'err.config.data',
  'err.response.data',

  // Bare, at the top level. `*.x` does not match `{ x: ... }`.
  'access_token',
  'refresh_token',
  'client_secret',
  'secret',
  'password',
  'passphrase',
  'authorization',
  'cookie',

  // Provider and session credentials, one level down.
  '*.access_token',
  '*.accessToken',
  '*.refresh_token',
  '*.refreshToken',
  '*.public_token',
  '*.publicToken',
  '*.link_token',
  '*.linkToken',
  '*.id_token',
  '*.client_secret',
  '*.clientSecret',
  '*.api_key',
  '*.apiKey',
  '*.secret',
  '*.password',
  '*.passphrase',
  '*.private_key',
  '*.privateKey',
  '*.master_key',
  '*.kek',
  '*.dek',
  '*.session_token',
  '*.cookie',
  '*.authorization',

  // Personally identifying account detail.
  '*.account_number',
  '*.accountNumber',
  '*.routing_number',
  '*.routingNumber',
  '*.iban',
  '*.wire_routing',
  '*.ssn',
  '*.tax_id',
  '*.card_number',
  '*.cvv',
  '*.xpub',
  '*.mnemonic',
];

export function buildLoggerOptions(config: AppConfig): LoggerOptions {
  return {
    level: config.env.LOG_LEVEL,
    // A second line of defence behind `Redacted<T>`: the type stops a secret being
    // serialised at all, this stops one that slipped into a plain object.
    redact: { paths: [...REDACTED_PATHS], censor: REDACTED_MARKER, remove: false },
    base: { service: 'api' },
    // Instants in logs are ISO-8601 UTC so a log line and a timestamptz column
    // can be compared without guessing a zone.
    timestamp: () => `,"time":"${systemClock.now().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: label }),
      /**
       * The depth-independent half of the control (H-3).
       *
       * `formatters.log` sees the merged object of every call, so one pass here
       * covers `log.error({ err })`, `log.info({ plaid: { item: {...} } })` and
       * anything a future context invents, without that context having to know
       * about this file. `redact` above still runs — two independent mechanisms
       * for a P0 control is the point, not duplication.
       *
       * **`req` and `res` are passed through untouched, and must be.** This hook
       * runs *before* the serializers below, so `object.req` here is the whole
       * live Fastify request — `raw`, its `socket`, and the libuv handle behind
       * it, with getters that throw on a half-closed connection and cycles a
       * dozen levels deep. An earlier revision walked it and every real HTTP
       * request died mid-flight ("other side closed") while `app.inject()` tests
       * stayed green, because `inject` has no socket. The `req`/`res`
       * serializers already reduce those to four safe fields.
       */
      log: (object) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(object)) {
          if (key === 'req' || key === 'res') {
            out[key] = value;
            continue;
          }
          try {
            out[key] = censorDeep(value, 0, new WeakSet<object>(), key === 'err');
          } catch {
            // Fail closed. A value we cannot safely walk is a value we do not
            // print: a logger must never take a request down, and must never
            // emit something unexamined as the price of staying up.
            out[key] = REDACTED_MARKER;
          }
        }
        return out;
      },
    },
    serializers: {
      /**
       * Errors are serialised here rather than by `pino.stdSerializers.err`
       * because the standard serialiser faithfully copies every own property of
       * the error — which, for an HTTP-client error, is the request config that
       * carries the credential.
       */
      err: (error: unknown) => censorDeep(error, 0, new WeakSet<object>(), true),
      req: (request: {
        id: string;
        method: string;
        url: string;
        headers: Record<string, unknown>;
      }) => ({
        id: request.id,
        method: request.method,
        url: request.url,
        headers: { host: request.headers['host'], 'user-agent': request.headers['user-agent'] },
      }),
      res: (reply: { statusCode: number }) => ({ statusCode: reply.statusCode }),
    },
    ...(config.env.LOG_PRETTY
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  };
}
