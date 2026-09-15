// SPDX-License-Identifier: MIT
/**
 * Plaid's error vocabulary → the port's six kinds, as a table.
 *
 * ## Why a table and not a `switch`
 *
 * 08 §2.4's design is that the *adapter classifies* and the *orchestrator
 * decides*. A table makes the classification enumerable, which is what lets
 * `errors.test.ts` assert every row rather than the three rows someone
 * remembered. Every entry below is reachable from a test.
 *
 * ## The cause is deliberately dropped
 *
 * `ConnectorError` accepts a `cause` and this file never passes one. That is not
 * an oversight, it is the single most important line in the file:
 *
 * > An axios error carries `config`, `config` carries `data`, and `data` is the
 * > request body — which for **every** Plaid call after linking contains
 * > `access_token`, and for the client itself contains `PLAID-SECRET` in
 * > `config.headers`.
 *
 * `new Error(message, { cause })` keeps that object alive on the error, and
 * `sync_runs.last_error`, a pino serialiser, a `util.inspect` in a debugger and
 * an unhandled-rejection dump will all walk it. So the classifier reads the four
 * fields it needs, puts them in `redactedContext`, and lets the axios error go.
 * `no-token-in-logs.test.ts` throws a fake whose `config.data` contains a
 * recognisable token and asserts it survives nowhere.
 *
 * ## Where a row has a `kind` and no `condition`
 *
 * The port's twelve conditions were written from 08 §2.4 and three Plaid
 * conditions have no honest home in them: an access token that is simply invalid
 * (not "the user must re-authenticate" — the token is wrong), a product that is
 * not ready yet, and an institution Plaid has dropped. Inventing a condition
 * would put a wrong word in the sync-run detail UI; claiming `INTERNAL` would
 * say Plaid broke its own contract. So those rows carry the `kind` only and the
 * verbatim Plaid code travels in `providerCode`, which is exactly what the
 * orchestrator writes to `sync_runs.error_code` when `condition` is null.
 */
import { ConnectorError, type ConnectorCondition, type ConnectorErrorKind } from '@connector/port';

/**
 * The fields of Plaid's error envelope that we are willing to look at.
 *
 * Structural rather than the SDK's `PlaidError` so that classification works on
 * a response body parsed from anywhere — a recorded fixture, a webhook, the
 * `item.error` field of `/item/get` — without an instanceof or an import that
 * would drag the SDK into a pure module.
 */
export interface PlaidErrorShape {
  readonly error_type: string;
  readonly error_code: string;
  readonly error_message?: string;
  readonly request_id?: string;
  readonly status?: number | null;
}

/** One row. Either a port condition (the kind follows from it) or a bare kind. */
interface Classification {
  readonly condition?: ConnectorCondition;
  readonly kind?: ConnectorErrorKind;
}

/**
 * By `error_code`. Consulted first, because the code is the specific statement.
 *
 * Sources: 01 §1.7 (Item lifecycle), 01 §1.8 (rate limits), 01 §5.1 (mutation
 * during pagination), and Plaid's error reference.
 */
export const PLAID_CONDITION_BY_CODE: Readonly<Record<string, Classification>> = Object.freeze({
  // --- The user must go back through Link -----------------------------------
  ITEM_LOGIN_REQUIRED: { condition: 'AUTH_REQUIRED' },
  USER_SETUP_REQUIRED: { condition: 'AUTH_REQUIRED' },
  MFA_NOT_SUPPORTED: { condition: 'MFA_REQUIRED' },
  // Consent, not credentials. 01 §1.7: PENDING_EXPIRATION fires 7 days ahead in
  // the EU/UK, PENDING_DISCONNECT is the US/CA and institution-migration case.
  PENDING_EXPIRATION: { condition: 'CONSENT_EXPIRED' },
  PENDING_DISCONNECT: { condition: 'CONSENT_EXPIRED' },
  ACCESS_NOT_GRANTED: { condition: 'CONSENT_EXPIRED' },
  ADDITIONAL_CONSENT_REQUIRED: { condition: 'CONSENT_EXPIRED' },
  USER_PERMISSION_REVOKED: { condition: 'CONSENT_EXPIRED' },
  USER_ACCOUNT_REVOKED: { condition: 'CONSENT_EXPIRED' },

  // --- Come back later ------------------------------------------------------
  RATE_LIMIT_EXCEEDED: { condition: 'RATE_LIMITED' },
  ITEM_LOCKED: { condition: 'ITEM_LOCKED' },
  INSTITUTION_DOWN: { condition: 'PROVIDER_DOWN' },
  INSTITUTION_NOT_RESPONDING: { condition: 'PROVIDER_DOWN' },
  INSTITUTION_NOT_AVAILABLE: { condition: 'PROVIDER_DOWN' },
  INTERNAL_SERVER_ERROR: { condition: 'PROVIDER_DOWN' },
  PLANNED_MAINTENANCE: { condition: 'PROVIDER_DOWN' },
  // Plaid is still pulling the first extract. Retrying is the documented fix,
  // and there is no port condition for "not yet" — see the file comment.
  PRODUCT_NOT_READY: { kind: 'transient' },

  // --- Restart the pagination loop -----------------------------------------
  // 01 §5.1: "the entire pagination request loop must be restarted beginning
  // with the cursor for the first page". The condition carries `restart:
  // 'page_one'` by default, which is the whole reason it exists.
  TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: { condition: 'MUTATION_DURING_PAGINATION' },

  // --- This connection will not work again without a new Item ---------------
  INVALID_ACCESS_TOKEN: { kind: 'permanent' },
  ITEM_NOT_FOUND: { kind: 'permanent' },
  ITEM_NOT_SUPPORTED: { kind: 'permanent' },
  INSTITUTION_NO_LONGER_SUPPORTED: { kind: 'permanent' },

  // --- We asked for something this Item was never linked for ---------------
  PRODUCTS_NOT_SUPPORTED: { condition: 'INSUFFICIENT_SCOPE' },
  PRODUCT_NOT_ENABLED: { condition: 'INSUFFICIENT_SCOPE' },
  NO_ACCOUNTS: { condition: 'INSUFFICIENT_SCOPE' },
  NO_INVESTMENT_ACCOUNTS: { condition: 'INSUFFICIENT_SCOPE' },
  NO_LIABILITY_ACCOUNTS: { condition: 'INSUFFICIENT_SCOPE' },

  // --- Our mistake ----------------------------------------------------------
  INVALID_API_KEYS: { condition: 'CONFIG_ERROR' },
  INVALID_CLIENT_ID: { condition: 'CONFIG_ERROR' },
  UNAUTHORIZED_ENVIRONMENT: { condition: 'CONFIG_ERROR' },
  INVALID_PUBLIC_TOKEN: { condition: 'CONFIG_ERROR' },
  INVALID_FIELD: { condition: 'CONFIG_ERROR' },
  INVALID_BODY: { condition: 'CONFIG_ERROR' },
  MISSING_FIELDS: { condition: 'CONFIG_ERROR' },
  UNKNOWN_FIELDS: { condition: 'CONFIG_ERROR' },
});

/**
 * By `error_type`, for a code the table above has never seen.
 *
 * Plaid adds error codes continuously. A new `INSTITUTION_ERROR` code should
 * still back off and retry rather than stop a healthy connection, and that is
 * what this second lookup buys over falling straight through to `INTERNAL`.
 */
export const PLAID_CONDITION_BY_TYPE: Readonly<Record<string, Classification>> = Object.freeze({
  ITEM_ERROR: { condition: 'AUTH_REQUIRED' },
  INSTITUTION_ERROR: { condition: 'PROVIDER_DOWN' },
  API_ERROR: { condition: 'PROVIDER_DOWN' },
  RATE_LIMIT_EXCEEDED: { condition: 'RATE_LIMITED' },
  OAUTH_ERROR: { condition: 'AUTH_REQUIRED' },
  RECAPTCHA_ERROR: { condition: 'AUTH_REQUIRED' },
  INVALID_REQUEST: { condition: 'CONFIG_ERROR' },
  INVALID_INPUT: { condition: 'CONFIG_ERROR' },
  SANDBOX_ERROR: { condition: 'CONFIG_ERROR' },
  INVALID_RESULT: { condition: 'MALFORMED_RESPONSE' },
});

export interface MapPlaidErrorOptions {
  /** Which of our eleven calls produced it. Debugging context, never a secret. */
  readonly endpoint: string;
  /** Parsed from a `Retry-After` header when the provider sent one. */
  readonly retryAfterMs?: number | null;
}

/**
 * Classify one Plaid error envelope.
 *
 * Unknown `error_type` falls through to `INTERNAL` (→ `permanent`), matching
 * `asConnectorError`'s fail-closed default. `permanent` is not fatal: 08 §2.4's
 * policy leaves the connection scheduled and backing off, it only stops the
 * *job* from burning its retries to reach the same answer.
 */
export function mapPlaidError(
  error: PlaidErrorShape,
  options: MapPlaidErrorOptions,
): ConnectorError {
  const classification =
    PLAID_CONDITION_BY_CODE[error.error_code] ??
    PLAID_CONDITION_BY_TYPE[error.error_type] ??
    ({ condition: 'INTERNAL' } as const);

  // Plaid's `error_message` is its own operator-facing text ("the login details
  // of this item have changed"). It names no account and holds no balance, so it
  // is safe to carry; the user's data never travels in an error from here.
  const message = `plaid ${error.error_code}: ${error.error_message ?? error.error_type}`;
  const redactedContext = {
    endpoint: options.endpoint,
    errorType: error.error_type,
    errorCode: error.error_code,
    requestId: error.request_id ?? null,
    httpStatus: error.status ?? null,
  };
  const retryAfterMs = options.retryAfterMs ?? null;

  if (classification.condition !== undefined) {
    return ConnectorError.fromCondition(classification.condition, message, {
      providerCode: error.error_code,
      redactedContext,
      ...(retryAfterMs === null ? {} : { retryAfterMs }),
    });
  }
  return new ConnectorError(message, {
    kind: classification.kind ?? 'permanent',
    providerCode: error.error_code,
    redactedContext,
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Pull Plaid's envelope out of whatever axios (or a fixture) actually threw. */
export function plaidErrorShapeOf(value: unknown): PlaidErrorShape | null {
  if (!isRecord(value)) return null;
  const body = isRecord(value['response']) ? value['response']['data'] : value;
  if (!isRecord(body)) return null;
  if (typeof body['error_type'] !== 'string' || typeof body['error_code'] !== 'string') return null;

  const status = isRecord(value['response']) ? value['response']['status'] : body['status'];
  return {
    error_type: body['error_type'],
    error_code: body['error_code'],
    ...(typeof body['error_message'] === 'string' ? { error_message: body['error_message'] } : {}),
    ...(typeof body['request_id'] === 'string' ? { request_id: body['request_id'] } : {}),
    ...(typeof status === 'number' ? { status } : {}),
  };
}

/**
 * `Retry-After`, in milliseconds, when the response carried one.
 *
 * Seconds only: the HTTP-date form is legal but Plaid does not send it, and
 * parsing a date here would need a `Clock` this function has no business
 * holding. An unparseable value yields `null` and the orchestrator falls back to
 * its own jittered backoff, which is the safe direction.
 */
export function retryAfterMsOf(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const response = value['response'];
  if (!isRecord(response)) return null;
  const headers = response['headers'];
  if (!isRecord(headers)) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  const seconds = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1_000);
}

/**
 * The one funnel every Plaid call's rejection goes through.
 *
 * Anything that is not a recognisable Plaid envelope — a DNS failure, a socket
 * timeout, an axios error with no response — is `PROVIDER_DOWN`. That is a
 * deliberate departure from `asConnectorError`'s "unrecognised is permanent":
 * here we *know* it is a network call to someone else's service, and treating a
 * timeout as permanent would disable a connection because a cable was unplugged.
 * The message is reduced to the error's class name so an axios message
 * containing a URL, a header dump or a body cannot travel with it.
 */
export function asPlaidConnectorError(cause: unknown, endpoint: string): ConnectorError {
  const shape = plaidErrorShapeOf(cause);
  if (shape !== null) {
    return mapPlaidError(shape, { endpoint, retryAfterMs: retryAfterMsOf(cause) });
  }
  const name = cause instanceof Error ? cause.name : typeof cause;
  const code = isRecord(cause) && typeof cause['code'] === 'string' ? cause['code'] : null;
  return ConnectorError.fromCondition(
    'PROVIDER_DOWN',
    `plaid ${endpoint} failed without a Plaid error envelope (${name})`,
    {
      ...(code === null ? {} : { providerCode: code }),
      redactedContext: { endpoint, transport: name, code },
    },
  );
}
