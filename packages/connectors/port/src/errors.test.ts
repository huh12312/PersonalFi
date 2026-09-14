// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_CONDITIONS,
  CONNECTOR_ERROR_KINDS,
  ConnectorError,
  KIND_OF_CONDITION,
  asConnectorError,
  isConnectorError,
  retryPolicyFor,
} from './errors.ts';

describe('the error taxonomy', () => {
  it("maps every one of 08 §2.4's conditions to exactly one kind", () => {
    for (const condition of CONNECTOR_CONDITIONS) {
      const kind = KIND_OF_CONDITION[condition];
      expect(CONNECTOR_ERROR_KINDS, `${condition} maps to an unknown kind`).toContain(kind);
    }
    // Every kind must be reachable, or the discriminant has a dead branch that
    // nobody will notice until a provider produces it.
    const reached = new Set(Object.values(KIND_OF_CONDITION));
    for (const kind of CONNECTOR_ERROR_KINDS) expect([...reached]).toContain(kind);
  });

  it('takes the kind from the condition, so the two can never disagree', () => {
    const error = ConnectorError.fromCondition('ITEM_LOCKED', 'the institution is busy');
    expect(error.kind).toBe('provider_unavailable');
    expect(error.condition).toBe('ITEM_LOCKED');
  });

  it('stops retrying on auth_required, because every further call is wasted', () => {
    // 04 §4.5: reauth_required "stops scheduled syncs for that item (retrying is
    // guaranteed to fail and burns rate limit)".
    const policy = ConnectorError.fromCondition('AUTH_REQUIRED', 'consent revoked').policy();
    expect(policy).toMatchObject({
      retryable: false,
      userActionRequired: true,
      restart: 'resume',
    });
  });

  it('treats MFA and expired consent as the same policy as revoked credentials', () => {
    for (const condition of ['MFA_REQUIRED', 'CONSENT_EXPIRED'] as const) {
      expect(ConnectorError.fromCondition(condition, 'x').policy().retryable).toBe(false);
    }
  });

  it('restarts pagination from page one on a mutation during pagination', () => {
    // 01 §5.1: "the entire pagination request loop must be restarted beginning
    // with the cursor for the first page". Retrying the failed call corrupts it.
    const error = ConnectorError.fromCondition('MUTATION_DURING_PAGINATION', 'stream changed');
    expect(error.policy()).toMatchObject({ retryable: true, restart: 'page_one' });
  });

  it('restarts from null on an expired cursor, and never deletes data', () => {
    const error = ConnectorError.fromCondition('CURSOR_EXPIRED', 'stale token');
    expect(error.policy()).toMatchObject({ retryable: true, restart: 'from_null' });
  });

  it('honours a provider-supplied retryAfterMs on a rate limit', () => {
    const error = ConnectorError.fromCondition('RATE_LIMITED', '429', { retryAfterMs: 30_000 });
    expect(error.policy()).toMatchObject({ retryable: true, retryAfterMs: 30_000 });
  });

  it('refuses to retry a bad file or bad keys', () => {
    for (const kind of ['invalid_input', 'permanent'] as const) {
      expect(retryPolicyFor(new ConnectorError('x', { kind })).retryable).toBe(false);
    }
  });

  it('fails closed: an unrecognised exception is ours and is permanent', () => {
    const wrapped = asConnectorError(new TypeError('cannot read properties of undefined'));
    expect(isConnectorError(wrapped)).toBe(true);
    expect(wrapped.kind).toBe('permanent');
    expect(wrapped.condition).toBe('INTERNAL');
    expect(wrapped.policy().retryable).toBe(false);
  });

  it('passes a ConnectorError through untouched', () => {
    const original = ConnectorError.fromCondition('PROVIDER_DOWN', '503');
    expect(asConnectorError(original)).toBe(original);
  });

  it('wraps a thrown non-Error without losing what it said', () => {
    expect(asConnectorError('everything is on fire').message).toBe('everything is on fire');
  });

  it('keeps redacted context and the provider code for the sync-run detail view', () => {
    const error = ConnectorError.fromCondition('MALFORMED_RESPONSE', 'bad shape', {
      providerCode: 'INVALID_FIELD',
      redactedContext: { field: 'amount' },
    });
    expect(error.providerCode).toBe('INVALID_FIELD');
    expect(error.redactedContext).toEqual({ field: 'amount' });
  });
});
