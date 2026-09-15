// SPDX-License-Identifier: MIT
/**
 * Every row of the Plaid → port error map, asserted.
 *
 * `errors.ts` is a table rather than a `switch` for exactly this reason: a table
 * is enumerable, so this file can assert *all* of it — `PLAID_CONDITION_BY_CODE`
 * and `PLAID_CONDITION_BY_TYPE` are iterated, not sampled — and a row added
 * without a decision about its kind fails here rather than in production at
 * 04:00 on a Sunday.
 *
 * The expected values live in `EXPECTED_BY_CODE` / `EXPECTED_BY_TYPE` below,
 * spelled out independently of the source table. Asserting `table[code]` against
 * `table[code]` would be a tautology; the point of a second copy is that
 * changing one requires deliberately changing the other.
 */
import {
  CONNECTOR_CONDITIONS,
  KIND_OF_CONDITION,
  isConnectorError,
  type ConnectorCondition,
  type ConnectorError,
  type ConnectorErrorKind,
} from '@connector/port';
import { describe, expect, it } from 'vitest';
import {
  PLAID_CONDITION_BY_CODE,
  PLAID_CONDITION_BY_TYPE,
  asPlaidConnectorError,
  mapPlaidError,
  plaidErrorShapeOf,
  retryAfterMsOf,
} from '../src/errors.ts';
import { PlaidConnector } from '../src/connector.ts';
import { FAKE_PLAID_SECRET, PLAID_ERRORS, plaidAxiosError } from './fake.ts';
import { ACCESS_TOKEN, harness } from './harness.ts';

/** condition, or a bare kind where the port has no honest condition. */
type Expectation = ConnectorCondition | { readonly kind: ConnectorErrorKind };

const EXPECTED_BY_CODE: Readonly<Record<string, Expectation>> = {
  // The user must go back through Link.
  ITEM_LOGIN_REQUIRED: 'AUTH_REQUIRED',
  USER_SETUP_REQUIRED: 'AUTH_REQUIRED',
  MFA_NOT_SUPPORTED: 'MFA_REQUIRED',
  // Consent, not credentials (01 §1.7).
  PENDING_EXPIRATION: 'CONSENT_EXPIRED',
  PENDING_DISCONNECT: 'CONSENT_EXPIRED',
  ACCESS_NOT_GRANTED: 'CONSENT_EXPIRED',
  ADDITIONAL_CONSENT_REQUIRED: 'CONSENT_EXPIRED',
  USER_PERMISSION_REVOKED: 'CONSENT_EXPIRED',
  USER_ACCOUNT_REVOKED: 'CONSENT_EXPIRED',
  // Come back later.
  RATE_LIMIT_EXCEEDED: 'RATE_LIMITED',
  ITEM_LOCKED: 'ITEM_LOCKED',
  INSTITUTION_DOWN: 'PROVIDER_DOWN',
  INSTITUTION_NOT_RESPONDING: 'PROVIDER_DOWN',
  INSTITUTION_NOT_AVAILABLE: 'PROVIDER_DOWN',
  INTERNAL_SERVER_ERROR: 'PROVIDER_DOWN',
  PLANNED_MAINTENANCE: 'PROVIDER_DOWN',
  PRODUCT_NOT_READY: { kind: 'transient' },
  // Restart the pagination loop from page one (01 §5.1).
  TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: 'MUTATION_DURING_PAGINATION',
  // Dead until there is a new Item.
  INVALID_ACCESS_TOKEN: { kind: 'permanent' },
  ITEM_NOT_FOUND: { kind: 'permanent' },
  ITEM_NOT_SUPPORTED: { kind: 'permanent' },
  INSTITUTION_NO_LONGER_SUPPORTED: { kind: 'permanent' },
  // We asked for something this Item was never linked for.
  PRODUCTS_NOT_SUPPORTED: 'INSUFFICIENT_SCOPE',
  PRODUCT_NOT_ENABLED: 'INSUFFICIENT_SCOPE',
  NO_ACCOUNTS: 'INSUFFICIENT_SCOPE',
  NO_INVESTMENT_ACCOUNTS: 'INSUFFICIENT_SCOPE',
  NO_LIABILITY_ACCOUNTS: 'INSUFFICIENT_SCOPE',
  // Our mistake.
  INVALID_API_KEYS: 'CONFIG_ERROR',
  INVALID_CLIENT_ID: 'CONFIG_ERROR',
  UNAUTHORIZED_ENVIRONMENT: 'CONFIG_ERROR',
  INVALID_PUBLIC_TOKEN: 'CONFIG_ERROR',
  INVALID_FIELD: 'CONFIG_ERROR',
  INVALID_BODY: 'CONFIG_ERROR',
  MISSING_FIELDS: 'CONFIG_ERROR',
  UNKNOWN_FIELDS: 'CONFIG_ERROR',
};

const EXPECTED_BY_TYPE: Readonly<Record<string, Expectation>> = {
  ITEM_ERROR: 'AUTH_REQUIRED',
  INSTITUTION_ERROR: 'PROVIDER_DOWN',
  API_ERROR: 'PROVIDER_DOWN',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMITED',
  OAUTH_ERROR: 'AUTH_REQUIRED',
  RECAPTCHA_ERROR: 'AUTH_REQUIRED',
  INVALID_REQUEST: 'CONFIG_ERROR',
  INVALID_INPUT: 'CONFIG_ERROR',
  SANDBOX_ERROR: 'CONFIG_ERROR',
  INVALID_RESULT: 'MALFORMED_RESPONSE',
};

function expectMatches(error: ConnectorError, expected: Expectation): void {
  if (typeof expected === 'string') {
    expect(error.condition).toBe(expected);
    // The kind must *follow* from the condition, never be set beside it.
    expect(error.kind).toBe(KIND_OF_CONDITION[expected]);
    return;
  }
  expect(error.kind).toBe(expected.kind);
  // A bare kind means the port has no honest condition for it; the verbatim
  // Plaid code is what the orchestrator writes to `sync_runs.error_code`
  // instead, so it must not be null.
  expect(error.condition).toBeNull();
  expect(error.providerCode).not.toBeNull();
}

// ---------------------------------------------------------------------------
// Every row
// ---------------------------------------------------------------------------

describe('the error map is complete and enumerable', () => {
  it('the source table and the expectation table name the same codes', () => {
    expect(Object.keys(PLAID_CONDITION_BY_CODE).sort()).toEqual(
      Object.keys(EXPECTED_BY_CODE).sort(),
    );
  });

  it('the source table and the expectation table name the same types', () => {
    expect(Object.keys(PLAID_CONDITION_BY_TYPE).sort()).toEqual(
      Object.keys(EXPECTED_BY_TYPE).sort(),
    );
  });

  it.each(Object.entries(EXPECTED_BY_CODE))('error_code %s', (code, expected) => {
    const error = mapPlaidError(
      // A type the by-type table would classify differently, so a passing row
      // proves the *code* decided — the by-code lookup really is first.
      { error_type: 'API_ERROR', error_code: code, error_message: 'provider text' },
      { endpoint: 'transactions/sync' },
    );
    expectMatches(error, expected);
    expect(error.providerCode).toBe(code);
  });

  it.each(Object.entries(EXPECTED_BY_TYPE))(
    'error_type %s, for an unseen code',
    (type, expected) => {
      // Plaid adds error codes continuously; a new `INSTITUTION_ERROR` code should
      // still back off and retry rather than stop a healthy connection.
      const error = mapPlaidError(
        { error_type: type, error_code: 'A_CODE_PLAID_ADDED_LAST_TUESDAY' },
        { endpoint: 'transactions/sync' },
      );
      expectMatches(error, expected);
      expect(error.providerCode).toBe('A_CODE_PLAID_ADDED_LAST_TUESDAY');
    },
  );

  it('every condition the map produces is one the port declares', () => {
    const produced = [
      ...Object.values(PLAID_CONDITION_BY_CODE),
      ...Object.values(PLAID_CONDITION_BY_TYPE),
    ].flatMap((row) => (row.condition === undefined ? [] : [row.condition]));
    for (const condition of produced) {
      expect(CONNECTOR_CONDITIONS).toContain(condition);
    }
  });

  it('falls through to INTERNAL/permanent when neither table knows the error', () => {
    const error = mapPlaidError(
      { error_type: 'SOMETHING_NEW_ERROR', error_code: 'SOMETHING_NEW' },
      { endpoint: 'item/get' },
    );
    expect(error.condition).toBe('INTERNAL');
    expect(error.kind).toBe('permanent');
    // `permanent` is not fatal: 08 §2.4's policy leaves the connection scheduled
    // and backing off, it only stops the *job* burning retries on the same
    // answer.
    expect(error.policy()).toMatchObject({ retryable: false, userActionRequired: true });
  });
});

// ---------------------------------------------------------------------------
// The three rows whose recovery is special
// ---------------------------------------------------------------------------

describe('the rows whose recovery differs', () => {
  it('MUTATION_DURING_PAGINATION restarts at page one, not at the failed page', () => {
    // 01 §5.1: "the entire pagination request loop must be restarted beginning
    // with the cursor for the first page". Retrying the single failed call
    // corrupts the stream.
    const error = mapPlaidError(PLAID_ERRORS.MUTATION_DURING_PAGINATION, {
      endpoint: 'transactions/sync',
    });
    expect(error.condition).toBe('MUTATION_DURING_PAGINATION');
    expect(error.kind).toBe('transient');
    expect(error.restart).toBe('page_one');
    expect(error.policy().retryable).toBe(true);
  });

  it('a rate limit carries the provider Retry-After rather than our guess', () => {
    const thrown = plaidAxiosError(
      'transactions/sync',
      PLAID_ERRORS.RATE_LIMIT_EXCEEDED,
      {},
      {
        status: 429,
        headers: { 'retry-after': '30' },
      },
    );
    const error = asPlaidConnectorError(thrown, 'transactions/sync');
    expect(error.kind).toBe('rate_limited');
    expect(error.condition).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.policy()).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
  });

  it('ITEM_LOGIN_REQUIRED stops the schedule and asks the user, rather than retrying', () => {
    // 04 §4.5: every further call is guaranteed to fail and burns the rate
    // limit the *reconnect* will need.
    const error = mapPlaidError(PLAID_ERRORS.ITEM_LOGIN_REQUIRED, {
      endpoint: 'transactions/sync',
    });
    expect(error.kind).toBe('auth_required');
    expect(error.condition).toBe('AUTH_REQUIRED');
    expect(error.policy()).toMatchObject({ retryable: false, userActionRequired: true });
  });
});

// ---------------------------------------------------------------------------
// Retry-After parsing
// ---------------------------------------------------------------------------

describe('retryAfterMsOf', () => {
  it.each([
    ['a seconds string', { 'retry-after': '30' }, 30_000],
    ['the capitalised spelling', { 'Retry-After': '5' }, 5_000],
    ['a number', { 'retry-after': 2 }, 2_000],
    ['a fractional value', { 'retry-after': '0.5' }, 500],
  ])('reads %s', (_label, headers, expected) => {
    expect(retryAfterMsOf({ response: { headers } })).toBe(expected);
  });

  it.each([
    ['an HTTP-date, which Plaid does not send', { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }],
    ['a negative value', { 'retry-after': '-1' }],
    ['nonsense', { 'retry-after': 'soon' }],
    ['no header at all', {}],
  ])(
    'returns null for %s, so the orchestrator uses its own jittered backoff',
    (_label, headers) => {
      expect(retryAfterMsOf({ response: { headers } })).toBeNull();
    },
  );

  it('returns null for anything that is not a response at all', () => {
    expect(retryAfterMsOf(null)).toBeNull();
    expect(retryAfterMsOf('a string')).toBeNull();
    expect(retryAfterMsOf({ response: null })).toBeNull();
    expect(retryAfterMsOf({ response: { headers: null } })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Envelope extraction
// ---------------------------------------------------------------------------

describe('plaidErrorShapeOf', () => {
  it('reads the envelope out of an axios rejection, status included', () => {
    const thrown = plaidAxiosError('item/get', PLAID_ERRORS.ITEM_LOGIN_REQUIRED, {});
    expect(plaidErrorShapeOf(thrown)).toEqual({
      error_type: 'ITEM_ERROR',
      error_code: 'ITEM_LOGIN_REQUIRED',
      error_message: PLAID_ERRORS.ITEM_LOGIN_REQUIRED.error_message,
      request_id: 'req-item-login-required',
      status: 400,
    });
  });

  it('reads a bare envelope, which is how item.error and a webhook arrive', () => {
    // The `item.error` field of a successful /item/get is not an exception and
    // never passes through axios, so the classifier has to work on the raw
    // object too (01 §1.7).
    expect(
      plaidErrorShapeOf({ error_type: 'ITEM_ERROR', error_code: 'PENDING_EXPIRATION' }),
    ).toEqual({ error_type: 'ITEM_ERROR', error_code: 'PENDING_EXPIRATION' });
  });

  it.each([
    ['null', null],
    ['a string', 'boom'],
    ['an error with no envelope', new Error('socket hang up')],
    ['a half-envelope', { error_type: 'ITEM_ERROR' }],
    ['a non-string code', { error_type: 'ITEM_ERROR', error_code: 7 }],
  ])('returns null for %s', (_label, value) => {
    expect(plaidErrorShapeOf(value)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The funnel
// ---------------------------------------------------------------------------

describe('asPlaidConnectorError', () => {
  it('treats a transport failure as PROVIDER_DOWN, not as permanent', () => {
    // A deliberate departure from `asConnectorError`'s "unrecognised is
    // permanent": here we *know* it is a network call to someone else, and
    // classifying an unplugged cable as permanent would disable a healthy
    // connection.
    const transport = Object.assign(new Error('connect ETIMEDOUT 52.0.0.1:443'), {
      name: 'AxiosError',
      code: 'ETIMEDOUT',
    });
    const error = asPlaidConnectorError(transport, 'transactions/sync');
    expect(error.condition).toBe('PROVIDER_DOWN');
    expect(error.kind).toBe('provider_unavailable');
    expect(error.providerCode).toBe('ETIMEDOUT');
    expect(error.policy().retryable).toBe(true);
  });

  it('reduces a transport message to the error class, so no URL travels with it', () => {
    const transport = Object.assign(new Error('connect ETIMEDOUT 52.0.0.1:443'), {
      name: 'AxiosError',
    });
    const error = asPlaidConnectorError(transport, 'transactions/sync');
    expect(error.message).not.toContain('52.0.0.1');
    expect(error.message).toContain('AxiosError');
  });

  it('carries endpoint, type, code, request id and status — and nothing else', () => {
    const thrown = plaidAxiosError('transactions/sync', PLAID_ERRORS.INSTITUTION_DOWN, {
      access_token: ACCESS_TOKEN,
    });
    const error = asPlaidConnectorError(thrown, 'transactions/sync');
    expect(error.redactedContext).toEqual({
      endpoint: 'transactions/sync',
      errorType: 'INSTITUTION_ERROR',
      errorCode: 'INSTITUTION_DOWN',
      requestId: 'req-institution-down',
      httpStatus: 400,
    });
  });

  it('never attaches the axios error as a cause', () => {
    // The single most important line in `errors.ts`: an axios error carries
    // `config.data` (the request body, containing `access_token`) and
    // `config.headers` (containing PLAID-SECRET). `new Error(msg, {cause})`
    // keeps that object alive, and a pino serialiser walks it.
    const thrown = plaidAxiosError('transactions/sync', PLAID_ERRORS.INSTITUTION_DOWN, {
      access_token: ACCESS_TOKEN,
    });
    const error = asPlaidConnectorError(thrown, 'transactions/sync');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(FAKE_PLAID_SECRET);
  });
});

// ---------------------------------------------------------------------------
// The rows the connector reaches for itself
// ---------------------------------------------------------------------------

describe('the connector classifies through the same map', () => {
  it('turns a broken Item into AUTH_REQUIRED on the sync path', async () => {
    const { connector, handle, options } = harness({
      failWith: { error: PLAID_ERRORS.ITEM_LOGIN_REQUIRED },
    });
    await expect(connector.syncTransactions(handle, null, options)).rejects.toMatchObject({
      name: 'ConnectorError',
      kind: 'auth_required',
      condition: 'AUTH_REQUIRED',
      providerCode: 'ITEM_LOGIN_REQUIRED',
    });
  });

  it('turns a rate limit into rate_limited with the provider Retry-After', async () => {
    const { connector, handle, options } = harness({
      failWith: {
        error: PLAID_ERRORS.RATE_LIMIT_EXCEEDED,
        status: 429,
        headers: { 'retry-after': '12' },
      },
    });
    await expect(connector.syncTransactions(handle, null, options)).rejects.toMatchObject({
      kind: 'rate_limited',
      condition: 'RATE_LIMITED',
      retryAfterMs: 12_000,
    });
  });

  it('classifies an item.error that arrived without being thrown', () => {
    // A webhook, or the `error` field of an otherwise successful /item/get. The
    // Item's error is the *authoritative* statement of a connection's health and
    // it does not always arrive as a rejection.
    const error = PlaidConnector.classifyItemError(PLAID_ERRORS.ITEM_LOGIN_REQUIRED);
    expect(error).not.toBeNull();
    expect(error?.condition).toBe('AUTH_REQUIRED');
    expect(PlaidConnector.classifyItemError(null)).toBeNull();
    expect(PlaidConnector.classifyItemError({ unrelated: true })).toBeNull();
  });

  it('a missing access token is invalid_input, not auth_required', async () => {
    // The user cannot fix a connection row whose sealed blob lacks the key this
    // adapter asks for. That is a wiring bug or a half-finished migration, and
    // sending them through Link would not repair it.
    const { connector, options } = harness();
    const empty = { ...harness().handle, secret: () => null };
    const thrown = await connector.syncTransactions(empty, null, options).catch((e: unknown) => e);
    expect(isConnectorError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ kind: 'invalid_input', condition: 'CONFIG_ERROR' });
    expect((thrown as ConnectorError).redactedContext).toMatchObject({
      credential: 'access_token',
    });
  });
});
