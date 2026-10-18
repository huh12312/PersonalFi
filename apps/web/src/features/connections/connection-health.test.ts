// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { ConnectionSummary } from '../../api/generated/types.gen.ts';
import {
  canSyncNow,
  describeConnectionHealth,
  formatLastSynced,
  shouldOfferReconnect,
} from './connection-health.ts';

function connection(overrides: Partial<ConnectionSummary> = {}): ConnectionSummary {
  return {
    id: 'conn_1',
    provider: 'manual',
    displayName: 'My accounts',
    status: 'active',
    capabilities: {
      supports: ['accounts', 'balances', 'transactions'],
      historyWindowDays: 'unbounded',
      minSyncIntervalSeconds: 0,
      refreshBudgetPerDay: null,
      supportsWebhooks: false,
      reconnectFlow: 'none',
      consentWindowDays: null,
      currencies: 'multi',
    },
    accountCount: 1,
    lastSyncedAt: null,
    consentExpiresAt: null,
    errorSince: null,
    lastErrorKind: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('describeConnectionHealth', () => {
  it('labels an active connection as connected, success tone', () => {
    expect(describeConnectionHealth(connection({ status: 'active' }))).toEqual({
      label: 'Connected',
      tone: 'success',
    });
  });

  it('labels reauth_required as needing reconnection, warning tone', () => {
    expect(describeConnectionHealth(connection({ status: 'reauth_required' }))).toEqual({
      label: 'Needs reconnection',
      tone: 'warning',
    });
  });

  it('surfaces the specific error kind when present, danger tone', () => {
    expect(
      describeConnectionHealth(connection({ status: 'error', lastErrorKind: 'rate_limited' })),
    ).toEqual({ label: 'Rate limited', tone: 'danger' });
  });

  it('falls back to a bare "Error" when the kind is unknown', () => {
    expect(describeConnectionHealth(connection({ status: 'error', lastErrorKind: null }))).toEqual({
      label: 'Error',
      tone: 'danger',
    });
  });

  it('labels disconnected as neutral', () => {
    expect(describeConnectionHealth(connection({ status: 'disconnected' }))).toEqual({
      label: 'Disconnected',
      tone: 'neutral',
    });
  });
});

describe('formatLastSynced', () => {
  it('reports "Never synced" for a connection with no sync yet', () => {
    expect(formatLastSynced(null)).toBe('Never synced');
  });

  it('reports a relative time otherwise', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(formatLastSynced(past)).toMatch(/^Synced .+ ago$/);
  });
});

describe('canSyncNow', () => {
  it('is true for every status except disconnected', () => {
    expect(canSyncNow(connection({ status: 'active' }))).toBe(true);
    expect(canSyncNow(connection({ status: 'error' }))).toBe(true);
    expect(canSyncNow(connection({ status: 'reauth_required' }))).toBe(true);
    expect(canSyncNow(connection({ status: 'disconnected' }))).toBe(false);
  });
});

describe('shouldOfferReconnect', () => {
  it('is false when the adapter has no reconnect flow, even if unhealthy', () => {
    const conn = connection({
      status: 'reauth_required',
      capabilities: { ...connection().capabilities, reconnectFlow: 'none' },
    });
    expect(shouldOfferReconnect(conn)).toBe(false);
  });

  it('is false for a healthy connection even with a reconnect flow available', () => {
    const conn = connection({
      status: 'active',
      capabilities: { ...connection().capabilities, reconnectFlow: 'provider_hosted' },
    });
    expect(shouldOfferReconnect(conn)).toBe(false);
  });

  it('is true when unhealthy and a reconnect flow exists', () => {
    const conn = connection({
      status: 'reauth_required',
      capabilities: { ...connection().capabilities, reconnectFlow: 'provider_hosted' },
    });
    expect(shouldOfferReconnect(conn)).toBe(true);
  });
});
