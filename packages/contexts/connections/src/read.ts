// SPDX-License-Identifier: MIT
/**
 * Read models: rows as the API returns them.
 *
 * Separate from `connections.ts` because these are the only functions in the
 * context whose output shape is a *contract with a client*, and keeping them
 * next to the zod schemas they satisfy makes drift visible in one file rather
 * than three.
 *
 * Note what never crosses this boundary: `sealed_credentials`, obviously, but
 * also `transactions_cursor`. The cursor is opaque to us and meaningless to a
 * client, and a value that appears in an API response is a value somebody will
 * eventually parse.
 */
import { toInstant, toInstantOrNull } from '@core/platform';
import { and, desc, eq } from 'drizzle-orm';
import {
  connectionAccounts,
  connections,
  syncRuns,
  type ConnectionRow,
} from '../schema/index.ts';
import { requireConnection } from './connections.ts';
import type { ConnectionsExecutor } from './db.ts';
import {
  connectionSummarySchema,
  type ConnectionAccountView,
  type ConnectionDetail,
  type ConnectionSummary,
  type SyncRunView,
} from './schemas.ts';

/** How many runs the detail view shows. The full history is its own endpoint. */
export const RECENT_RUN_LIMIT = 20;

export async function listConnectionSummaries(
  executor: ConnectionsExecutor,
  userId: string,
): Promise<ConnectionSummary[]> {
  const rows = await executor
    .select()
    .from(connections)
    .where(eq(connections.userId, userId))
    .orderBy(desc(connections.createdAt));

  const counts = await executor
    .select({ connectionId: connectionAccounts.connectionId, accountId: connectionAccounts.accountId })
    .from(connectionAccounts)
    .where(eq(connectionAccounts.userId, userId));

  const byConnection = new Map<string, number>();
  for (const row of counts) {
    byConnection.set(row.connectionId, (byConnection.get(row.connectionId) ?? 0) + 1);
  }

  return rows.map((row) => summaryOf(row, byConnection.get(row.id) ?? 0));
}

export async function getConnectionDetail(
  executor: ConnectionsExecutor,
  userId: string,
  connectionId: string,
): Promise<ConnectionDetail> {
  const row = await requireConnection(executor, userId, connectionId);

  const accounts = await executor
    .select()
    .from(connectionAccounts)
    .where(eq(connectionAccounts.connectionId, connectionId))
    .orderBy(connectionAccounts.linkedAt);

  const runs = await listSyncRuns(executor, userId, connectionId, RECENT_RUN_LIMIT);

  return {
    ...summaryOf(row, accounts.length),
    accounts: accounts.map(
      (account): ConnectionAccountView => ({
        id: account.id,
        accountId: account.accountId,
        providerName: account.providerName,
        currency: account.currency,
        capabilities: capabilityList(account.capabilities),
        enabled: account.enabled,
        linkedAt: toInstant(account.linkedAt).toISOString(),
      }),
    ),
    recentRuns: runs,
  };
}

export async function listSyncRuns(
  executor: ConnectionsExecutor,
  userId: string,
  connectionId: string,
  limit = RECENT_RUN_LIMIT,
): Promise<SyncRunView[]> {
  const rows = await executor
    .select()
    .from(syncRuns)
    .where(and(eq(syncRuns.userId, userId), eq(syncRuns.connectionId, connectionId)))
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit);

  return rows.map((row) => ({
    id: row.id,
    connectionId: row.connectionId,
    trigger: row.trigger,
    operation: row.operation,
    status: row.status,
    pageCount: row.pageCount,
    addedCount: row.addedCount,
    modifiedCount: row.modifiedCount,
    removedCount: row.removedCount,
    restartCount: row.restartCount,
    // The typed kind and the provider's code. Not `error_detail`, which holds a
    // message we do not want a client switching on.
    errorKind: asErrorKind(row.errorKind),
    errorCode: row.errorCode,
    startedAt: toInstant(row.startedAt).toISOString(),
    finishedAt: toInstantOrNull(row.finishedAt)?.toISOString() ?? null,
    durationMs: row.durationMs,
  }));
}

function summaryOf(row: ConnectionRow, accountCount: number): ConnectionSummary {
  const capabilities = row.capabilities as Record<string, unknown>;
  // Parsed, not cast. `capabilities` is a jsonb column written by a previous
  // release of this code, and a shape that has drifted should fail here — where
  // the row id is in the error — rather than in a client's rendering code.
  return connectionSummarySchema.parse({
    id: row.id,
    provider: row.provider,
    displayName: row.displayName,
    status: row.status,
    capabilities,
    accountCount,
    lastSyncedAt: toInstantOrNull(row.lastSyncedAt)?.toISOString() ?? null,
    consentExpiresAt: toInstantOrNull(row.consentExpiresAt)?.toISOString() ?? null,
    errorSince: toInstantOrNull(row.errorSince)?.toISOString() ?? null,
    lastErrorKind: asErrorKind((row.lastError as { kind?: unknown } | null)?.kind),
    createdAt: toInstant(row.createdAt).toISOString(),
  });
}

function capabilityList(value: unknown): ConnectionAccountView['capabilities'] {
  return Array.isArray(value) ? (value.filter((item) => typeof item === 'string') as never) : [];
}

function asErrorKind(value: unknown): SyncRunView['errorKind'] {
  return typeof value === 'string' ? (value as SyncRunView['errorKind']) : null;
}
