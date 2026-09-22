// SPDX-License-Identifier: MIT
/**
 * Coinbase's error vocabulary → the port's six kinds, as a table.
 *
 * Same shape as `@connector/plaid`'s `errors.ts` and for the same reason: the
 * adapter classifies, the orchestrator decides, and a table is enumerable by a
 * test in a way a `switch` buried in a request helper is not.
 *
 * ## Advanced Trade speaks gRPC status names over HTTP
 *
 * v3 answers with a Google-RPC-shaped body — `{"error":"PERMISSION_DENIED",
 * "code":7,"message":"…","error_details":"…"}` — and the *name* is the reliable
 * part; the numeric `code` is the gRPC enum and the HTTP status is sometimes
 * just `400`. So the name is consulted first and the status is the fallback,
 * which is the inverse of nothing and the same belt-and-braces as Plaid's
 * code-then-type lookup.
 *
 * ## The two rows that are security decisions, not classifications
 *
 *   * **`PERMISSION_DENIED` → `INSUFFICIENT_SCOPE` → `permanent`.** A CDP key
 *     that cannot read what we asked for will not start being able to, and
 *     `permanent` is what stops the orchestrator burning a day of retries on it.
 *     It is also what `key_permissions` raises when a key can trade — see
 *     `connector.ts` — so the *refusal* and the provider's own refusal classify
 *     identically and the UI says the same thing either way.
 *   * **`UNAUTHENTICATED` / 401 → `AUTH_REQUIRED`.** For Coinbase this means the
 *     JWT was rejected: expired, wrong algorithm, wrong `uri`, or a key that has
 *     been revoked in the CDP portal. Every one of those needs a human, and
 *     three of the four need a *new key*. Retrying is guaranteed to fail and
 *     burns the rate limit the reconnect will want (04 §4.5).
 *
 * ## No `cause`, ever
 *
 * The same rule as Plaid's file, for a different reason. There is no axios here
 * — the transport is `fetch` — but a `Request`/`Response` pair carries
 * `headers`, and our `Authorization` header is a **bearer token that is valid
 * for the next 120 seconds**. Attaching one to an error would put a live
 * credential into `sync_runs.last_error`. `client.ts` reads status, body name
 * and `Retry-After` and lets the rest go.
 */
import { ConnectorError, type ConnectorCondition, type ConnectorErrorKind } from '@connector/port';

/** The fields of Coinbase's error envelope we are willing to look at. */
export interface CoinbaseErrorShape {
  /** The gRPC status name: `PERMISSION_DENIED`, `UNAUTHENTICATED`, … */
  readonly error: string | null;
  /** Coinbase's operator-facing text. Names no account and holds no balance. */
  readonly message: string | null;
  readonly httpStatus: number;
}

interface Classification {
  readonly condition?: ConnectorCondition;
  readonly kind?: ConnectorErrorKind;
}

/**
 * By the gRPC status name in the body. Consulted first.
 *
 * `INVALID_ARGUMENT` is `CONFIG_ERROR` rather than `MALFORMED_RESPONSE`: it
 * means *we* sent something wrong — a bad `product_id`, an out-of-range limit —
 * and the honest classification for our own bug is `invalid_input`, which is not
 * retryable and shows up as something to fix.
 */
export const COINBASE_CONDITION_BY_NAME: Readonly<Record<string, Classification>> = Object.freeze({
  UNAUTHENTICATED: { condition: 'AUTH_REQUIRED' },
  PERMISSION_DENIED: { condition: 'INSUFFICIENT_SCOPE' },
  // Coinbase's own spelling of the same two, seen on the older App API surface
  // and still emitted by some v3 error paths.
  unauthorized: { condition: 'AUTH_REQUIRED' },
  invalid_token: { condition: 'AUTH_REQUIRED' },
  authentication_error: { condition: 'AUTH_REQUIRED' },
  RESOURCE_EXHAUSTED: { condition: 'RATE_LIMITED' },
  rate_limit_exceeded: { condition: 'RATE_LIMITED' },
  UNAVAILABLE: { condition: 'PROVIDER_DOWN' },
  DEADLINE_EXCEEDED: { condition: 'PROVIDER_DOWN' },
  INTERNAL: { condition: 'PROVIDER_DOWN' },
  ABORTED: { condition: 'PROVIDER_DOWN' },
  NOT_FOUND: { condition: 'DATA_UNAVAILABLE' },
  not_found: { condition: 'DATA_UNAVAILABLE' },
  INVALID_ARGUMENT: { condition: 'CONFIG_ERROR' },
  invalid_request: { condition: 'CONFIG_ERROR' },
  FAILED_PRECONDITION: { condition: 'CONFIG_ERROR' },
  // v3 answers a cursor it does not recognise this way. Ours is a local
  // watermark rather than a provider token (see `cursor.ts`), so this row is
  // here for the fills endpoint's own paging cursor.
  OUT_OF_RANGE: { condition: 'CURSOR_EXPIRED' },
});

/** By HTTP status, for a name the table above has never seen — or no name at all. */
export const COINBASE_CONDITION_BY_STATUS: Readonly<Record<number, Classification>> = Object.freeze(
  {
    400: { condition: 'CONFIG_ERROR' },
    401: { condition: 'AUTH_REQUIRED' },
    403: { condition: 'INSUFFICIENT_SCOPE' },
    404: { condition: 'DATA_UNAVAILABLE' },
    408: { condition: 'PROVIDER_DOWN' },
    429: { condition: 'RATE_LIMITED' },
    500: { condition: 'PROVIDER_DOWN' },
    502: { condition: 'PROVIDER_DOWN' },
    503: { condition: 'PROVIDER_DOWN' },
    504: { condition: 'PROVIDER_DOWN' },
  },
);

export interface MapCoinbaseErrorOptions {
  /** Which of our five calls produced it. Debugging context, never a secret. */
  readonly endpoint: string;
  /** Parsed from `Retry-After` when Coinbase sent one. */
  readonly retryAfterMs?: number | null;
}

/**
 * Classify one Coinbase error envelope.
 *
 * An unrecognised name **and** an unrecognised status fall through to
 * `PROVIDER_DOWN` rather than to `INTERNAL`. That is the same departure
 * `asPlaidConnectorError` makes and for the same reason: we know this was a
 * network call to someone else's service, and calling an unfamiliar 5xx
 * `permanent` would disable a healthy connection because Coinbase had a bad
 * afternoon. A *malformed body* is a different matter and is raised by
 * `amount.ts` as `MALFORMED_RESPONSE`.
 */
export function mapCoinbaseError(
  error: CoinbaseErrorShape,
  options: MapCoinbaseErrorOptions,
): ConnectorError {
  const byName = error.error === null ? undefined : COINBASE_CONDITION_BY_NAME[error.error];
  const classification =
    byName ??
    COINBASE_CONDITION_BY_STATUS[error.httpStatus] ??
    ({ condition: 'PROVIDER_DOWN' } as const);

  const label = error.error ?? `http_${error.httpStatus}`;
  const message = `coinbase ${label}: ${error.message ?? 'no message'}`;
  const redactedContext = {
    endpoint: options.endpoint,
    errorName: error.error,
    httpStatus: error.httpStatus,
  };
  const retryAfterMs = options.retryAfterMs ?? null;

  if (classification.condition !== undefined) {
    return ConnectorError.fromCondition(classification.condition, message, {
      providerCode: label,
      redactedContext,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    });
  }
  return new ConnectorError(message, {
    kind: classification.kind ?? 'permanent',
    providerCode: label,
    redactedContext,
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Read Coinbase's envelope out of a parsed response body.
 *
 * Tolerant on purpose: the body may be `{error}`, `{error, message}`,
 * `{error_details}`, or not JSON at all. The status is always known, so a
 * classification is always possible; the body only ever makes it finer.
 */
export function coinbaseErrorShapeOf(body: unknown, httpStatus: number): CoinbaseErrorShape {
  if (!isRecord(body)) return { error: null, message: null, httpStatus };
  const name =
    typeof body['error'] === 'string'
      ? body['error']
      : typeof body['error_type'] === 'string'
        ? body['error_type']
        : null;
  const message =
    typeof body['message'] === 'string'
      ? body['message']
      : typeof body['error_details'] === 'string'
        ? body['error_details']
        : typeof body['error_description'] === 'string'
          ? body['error_description']
          : null;
  return { error: name, message, httpStatus };
}

/**
 * `Retry-After`, in milliseconds.
 *
 * Seconds only. The HTTP-date form is legal, but parsing it needs a `Clock` this
 * function has no business holding, and an unparseable value yielding `null` is
 * the safe direction: the orchestrator falls back to its own jittered backoff
 * (`@core/platform`'s `backoffDelayMs`) rather than to zero.
 */
export function retryAfterMsOf(headers: Readonly<Record<string, string>>): number | null {
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined) return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1_000);
}

/**
 * The one funnel a transport-level rejection goes through.
 *
 * DNS failure, socket timeout, TLS error, an aborted request: all
 * `PROVIDER_DOWN`. The message is reduced to the error's class name and `code`
 * so that a `fetch` error containing a full URL — which for a signed request is
 * not secret but is noise — cannot travel with it. The original is **not**
 * attached as a `cause`: see the file comment.
 */
export function asCoinbaseTransportError(cause: unknown, endpoint: string): ConnectorError {
  const name = cause instanceof Error ? cause.name : typeof cause;
  const code = isRecord(cause) && typeof cause['code'] === 'string' ? cause['code'] : null;
  return ConnectorError.fromCondition(
    'PROVIDER_DOWN',
    `coinbase ${endpoint} failed before a response arrived (${name})`,
    {
      ...(code === null ? {} : { providerCode: code }),
      redactedContext: { endpoint, transport: name, code },
    },
  );
}
