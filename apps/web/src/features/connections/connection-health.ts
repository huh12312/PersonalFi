// SPDX-License-Identifier: MIT
import { formatDistanceToNowStrict } from 'date-fns';

import type { ConnectionSummary } from '../../api/generated/types.gen.ts';

export type HealthTone = 'good' | 'warning' | 'critical' | 'neutral';

export interface ConnectionHealth {
  readonly label: string;
  readonly tone: HealthTone;
}

/**
 * `ConnectionSummary.status` → a badge label + tone (never colour alone,
 * WCAG 1.4.1 — every tone pairs with distinct text). `errorSince`/
 * `lastErrorKind` refine the two failure states into something a user can
 * act on instead of a bare "error".
 */
export function describeConnectionHealth(connection: ConnectionSummary): ConnectionHealth {
  switch (connection.status) {
    case 'active':
      return { label: 'Connected', tone: 'good' };
    case 'reauth_required':
      return { label: 'Needs reconnection', tone: 'warning' };
    case 'error':
      return {
        label:
          connection.lastErrorKind !== null ? describeErrorKind(connection.lastErrorKind) : 'Error',
        tone: 'critical',
      };
    case 'disconnected':
      return { label: 'Disconnected', tone: 'neutral' };
  }
}

const ERROR_KIND_LABEL: Record<NonNullable<ConnectionSummary['lastErrorKind']>, string> = {
  auth_required: 'Sign-in needed',
  rate_limited: 'Rate limited',
  provider_unavailable: 'Provider unavailable',
  invalid_input: 'Invalid input',
  permanent: 'Connection broken',
  transient: 'Temporary error',
};

export function describeErrorKind(kind: NonNullable<ConnectionSummary['lastErrorKind']>): string {
  return ERROR_KIND_LABEL[kind];
}

/** "Synced 3 hours ago" / "Never synced" — the connections list and the connection detail share this. */
export function formatLastSynced(lastSyncedAt: string | null): string {
  if (lastSyncedAt === null) return 'Never synced';
  return `Synced ${formatDistanceToNowStrict(new Date(lastSyncedAt), { addSuffix: true })}`;
}

/** Whether a "Sync now" action makes sense right now — a disconnected connection has nothing to sync. */
export function canSyncNow(connection: ConnectionSummary): boolean {
  return connection.status !== 'disconnected';
}

/** Whether "Reconnect" should be offered: the adapter has a real reconnect flow *and* the connection is not already healthy-and-idle (a "reconnect" on a fine connection is confusing, not harmful). */
export function shouldOfferReconnect(connection: ConnectionSummary): boolean {
  return (
    connection.capabilities.reconnectFlow !== 'none' &&
    (connection.status === 'reauth_required' || connection.status === 'error')
  );
}
