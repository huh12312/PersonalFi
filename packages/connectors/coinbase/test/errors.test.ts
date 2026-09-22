// SPDX-License-Identifier: MIT
/**
 * Every row of the error map, and the policy each one produces.
 *
 * The table in `errors.ts` is only useful if it is enumerable, so this asserts
 * **every entry** rather than the three somebody remembered — and it asserts the
 * *policy* the orchestrator derives, because "which kind?" is a means and "does
 * this retry, and does the user have to act?" is the end.
 */
import { describe, expect, it } from 'vitest';
import { retryPolicyFor, type ConnectorError } from '@connector/port';
import {
  COINBASE_CONDITION_BY_NAME,
  COINBASE_CONDITION_BY_STATUS,
  asCoinbaseTransportError,
  coinbaseErrorShapeOf,
  mapCoinbaseError,
  retryAfterMsOf,
} from '../src/errors.ts';
import { harness } from './harness.ts';

function classify(body: unknown, status: number): ConnectorError {
  return mapCoinbaseError(coinbaseErrorShapeOf(body, status), { endpoint: 'accounts' });
}

describe('the error map', () => {
  it('classifies every name in the table', () => {
    for (const [name, expected] of Object.entries(COINBASE_CONDITION_BY_NAME)) {
      const error = classify({ error: name, message: 'x' }, 400);
      expect(error.condition, `${name} classified wrongly`).toBe(expected.condition ?? null);
      expect(error.providerCode).toBe(name);
    }
  });

  it('classifies every status in the table when the body names nothing', () => {
    for (const [status, expected] of Object.entries(COINBASE_CONDITION_BY_STATUS)) {
      const error = classify(null, Number(status));
      expect(error.condition, `HTTP ${status} classified wrongly`).toBe(expected.condition ?? null);
      expect(error.providerCode).toBe(`http_${status}`);
    }
  });

  it('prefers the body name over the status, because the name is the specific statement', () => {
    // A 400 carrying PERMISSION_DENIED is a scope problem, not a bad request,
    // and v3 really does answer that way.
    expect(classify({ error: 'PERMISSION_DENIED' }, 400).condition).toBe('INSUFFICIENT_SCOPE');
  });

  it('falls through to PROVIDER_DOWN rather than to permanent', () => {
    // Deliberate: we know this was a network call to someone else's service, and
    // calling an unfamiliar failure `permanent` would disable a healthy
    // connection because Coinbase had a bad afternoon.
    const error = classify({ error: 'SOMETHING_NEW' }, 418);
    expect(error.condition).toBe('PROVIDER_DOWN');
    expect(retryPolicyFor(error)).toMatchObject({ retryable: true, userActionRequired: false });
  });

  it.each([
    ['UNAUTHENTICATED', { retryable: false, userActionRequired: true }],
    ['PERMISSION_DENIED', { retryable: false, userActionRequired: true }],
    ['RESOURCE_EXHAUSTED', { retryable: true, userActionRequired: false }],
    ['UNAVAILABLE', { retryable: true, userActionRequired: false }],
    ['INVALID_ARGUMENT', { retryable: false, userActionRequired: true }],
    ['NOT_FOUND', { retryable: false, userActionRequired: true }],
  ])('%s produces the policy the orchestrator needs', (name, policy) => {
    expect(retryPolicyFor(classify({ error: name }, 400))).toMatchObject(policy);
  });

  it('carries an expired paging cursor as a restart from null, never as a deletion', () => {
    const error = classify({ error: 'OUT_OF_RANGE' }, 400);
    expect(error.condition).toBe('CURSOR_EXPIRED');
    expect(error.restart).toBe('from_null');
  });

  it('reads Retry-After in seconds and refuses anything else', () => {
    expect(retryAfterMsOf({ 'retry-after': '30' })).toBe(30_000);
    expect(retryAfterMsOf({ 'Retry-After': '1.5' })).toBe(1_500);
    expect(retryAfterMsOf({})).toBeNull();
    expect(retryAfterMsOf({ 'retry-after': '-1' })).toBeNull();
    // The HTTP-date form is legal and Coinbase does not send it. Parsing it
    // would need a Clock this function has no business holding, and `null` is
    // the safe direction: the orchestrator falls back to jittered backoff.
    expect(retryAfterMsOf({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' })).toBeNull();
  });

  it('a rate limit reaches the caller as retryAfterMs, end to end', async () => {
    const { connector, handle, options } = harness({
      failures: {
        accounts: {
          status: 429,
          body: { error: 'RESOURCE_EXHAUSTED', message: 'too many requests' },
          headers: { 'retry-after': '45' },
        },
      },
    });

    const thrown = (await connector
      .syncBalances(handle, options)
      .catch((error: unknown) => error)) as ConnectorError;

    expect(thrown).toMatchObject({ kind: 'rate_limited', condition: 'RATE_LIMITED' });
    expect(thrown.retryAfterMs).toBe(45_000);
    expect(retryPolicyFor(thrown)).toMatchObject({ retryable: true, retryAfterMs: 45_000 });
  });

  it('never attaches a cause, because the response carried our own bearer token', () => {
    const error = classify({ error: 'UNAVAILABLE' }, 503);
    expect(error.cause).toBeUndefined();
    expect(error.redactedContext).toEqual({
      endpoint: 'accounts',
      errorName: 'UNAVAILABLE',
      httpStatus: 503,
    });
  });

  it('turns a transport failure into PROVIDER_DOWN with only its class name', () => {
    const cause = Object.assign(new TypeError('fetch failed for https://api.coinbase.com/…'), {
      code: 'ECONNREFUSED',
    });
    const error = asCoinbaseTransportError(cause, 'accounts');
    expect(error.condition).toBe('PROVIDER_DOWN');
    expect(error.providerCode).toBe('ECONNREFUSED');
    expect(error.message).not.toContain('https://');
    expect(error.cause).toBeUndefined();
  });

  it('reads the three body shapes v3 actually uses', () => {
    expect(coinbaseErrorShapeOf({ error: 'A', message: 'm' }, 400)).toEqual({
      error: 'A',
      message: 'm',
      httpStatus: 400,
    });
    expect(coinbaseErrorShapeOf({ error: 'A', error_details: 'd' }, 400).message).toBe('d');
    expect(coinbaseErrorShapeOf('not json at all', 502)).toEqual({
      error: null,
      message: null,
      httpStatus: 502,
    });
  });

  it('treats a 200 with a non-object body as MALFORMED_RESPONSE, not as success', async () => {
    const { connector, handle, options } = harness({
      failures: { accounts: { status: 200, body: 'this is not json' } },
    });
    await expect(connector.syncBalances(handle, options)).rejects.toMatchObject({
      condition: 'MALFORMED_RESPONSE',
      kind: 'permanent',
    });
  });

  it('refuses a cursor it never issued rather than silently starting from scratch', async () => {
    const { connector, handle, options } = harness();
    const thrown = (await connector
      .syncTransactions(handle, 'cb1.not-a-real-cursor' as never, options)
      .catch((error: unknown) => error)) as ConnectorError;
    expect(thrown).toMatchObject({ condition: 'CURSOR_EXPIRED', restart: 'from_null' });
    // The cursor itself is not in the context: it is a record of the user's
    // balances and `sync_runs.last_error` is rendered in the UI.
    expect(JSON.stringify(thrown.redactedContext)).not.toContain('not-a-real-cursor');
  });

  it('raises rather than truncating when the run is out of time or aborted', async () => {
    const { connector, handle, clock, options } = harness();
    const aborter = new AbortController();
    aborter.abort();
    await expect(
      connector.syncTransactions(handle, null, { ...options, signal: aborter.signal }),
    ).rejects.toMatchObject({ kind: 'transient', redactedContext: { reason: 'aborted' } });

    clock.advanceMs(120_000);
    await expect(connector.syncBalances(handle, options)).rejects.toMatchObject({
      kind: 'transient',
      redactedContext: { reason: 'deadline' },
    });
  });
});
