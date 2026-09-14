// SPDX-License-Identifier: MIT
/**
 * The three tables migration `0005_connections.sql` creates.
 *
 * These definitions are the query surface and the ownership claim, not the DDL —
 * the hand-written SQL in `packages/db/migrations/` is the one ordered,
 * forward-only history, and the `CHECK` constraints that make an illegal row
 * impossible live there rather than here.
 */
import {
  byteaColumn,
  createdAtColumn,
  currencyColumn,
  flagColumn,
  idColumn,
  instantColumn,
  updatedAtColumn,
  userIdColumn,
} from '@core/db';
import { index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * The four states a connection can be in.
 *
 * 04 §4.5 draws five (`healthy | degraded | reauth_required | revoked`, plus the
 * implicit initial one) and this is four, with `degraded` folded into `error`.
 * That is deliberate: `degraded` describes *retry* state — "failing, backing
 * off, will heal itself" — and retry state already lives in `jobs`, where the
 * runner acts on it. Two sources of truth for "will this retry?" is worse than
 * one coarser status plus a job row that actually decides.
 */
export const CONNECTION_STATUSES = ['active', 'reauth_required', 'error', 'disconnected'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const SYNC_TRIGGERS = [
  'initial',
  'scheduled',
  'manual',
  'backfill',
  'repair',
  'webhook',
] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_OPERATIONS = ['transactions', 'balances', 'holdings', 'liabilities'] as const;
export type SyncOperation = (typeof SYNC_OPERATIONS)[number];

export const SYNC_RUN_STATUSES = ['running', 'success', 'partial', 'failed'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export const connections = pgTable(
  'connections',
  {
    id: idColumn(),
    userId: userIdColumn(),
    provider: text('provider').notNull(),
    /** The provider's natural key, kept separate from our UUIDv7 (decision D10). */
    providerConnectionId: text('provider_connection_id').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').$type<ConnectionStatus>().notNull().default('active'),
    /** `SecretBox` envelope. NULL when the provider has no credential at all. */
    sealedCredentials: byteaColumn('sealed_credentials'),
    /** Opaque. Never parsed, never compared, never constructed by us. */
    transactionsCursor: text('transactions_cursor'),
    /** Non-secret per-connection settings — a CSV mapping profile, enabled datasets. */
    config: jsonb('config').notNull().default({}),
    capabilities: jsonb('capabilities').notNull().default({}),
    lastSyncedAt: instantColumn('last_synced_at'),
    lastError: jsonb('last_error'),
    errorSince: instantColumn('error_since'),
    consentExpiresAt: instantColumn('consent_expires_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('connections_provider_key_idx').on(
      table.userId,
      table.provider,
      table.providerConnectionId,
    ),
    index('connections_user_status_idx').on(table.userId, table.status),
  ],
);

export const connectionAccounts = pgTable(
  'connection_accounts',
  {
    id: idColumn(),
    userId: userIdColumn(),
    connectionId: uuid('connection_id').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    /** `@ctx/ledger`'s `accounts.id`. Opaque here, and deliberately unconstrained. */
    accountId: uuid('account_id').notNull(),
    providerName: text('provider_name').notNull().default(''),
    currency: currencyColumn().notNull(),
    capabilities: jsonb('capabilities').notNull().default([]),
    enabled: flagColumn('enabled').notNull().default(true),
    linkedAt: instantColumn('linked_at').notNull().defaultNow(),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    uniqueIndex('connection_accounts_provider_key_idx').on(
      table.connectionId,
      table.providerAccountId,
    ),
    uniqueIndex('connection_accounts_account_idx').on(table.userId, table.accountId),
    index('connection_accounts_user_idx').on(table.userId),
  ],
);

export const syncRuns = pgTable(
  'sync_runs',
  {
    id: idColumn(),
    userId: userIdColumn(),
    connectionId: uuid('connection_id').notNull(),
    trigger: text('trigger').$type<SyncTrigger>().notNull(),
    operation: text('operation').$type<SyncOperation>().notNull().default('transactions'),
    status: text('status').$type<SyncRunStatus>().notNull().default('running'),
    cursorBefore: text('cursor_before'),
    cursorAfter: text('cursor_after'),
    pageCount: integer('page_count').notNull().default(0),
    addedCount: integer('added_count').notNull().default(0),
    modifiedCount: integer('modified_count').notNull().default(0),
    removedCount: integer('removed_count').notNull().default(0),
    restartCount: integer('restart_count').notNull().default(0),
    errorKind: text('error_kind'),
    errorCode: text('error_code'),
    errorDetail: jsonb('error_detail'),
    correlationId: uuid('correlation_id').notNull(),
    startedAt: instantColumn('started_at').notNull().defaultNow(),
    finishedAt: instantColumn('finished_at'),
    durationMs: integer('duration_ms'),
  },
  (table) => [
    index('sync_runs_connection_idx').on(table.connectionId, table.startedAt),
    index('sync_runs_user_idx').on(table.userId, table.startedAt),
  ],
);

export type ConnectionRow = typeof connections.$inferSelect;
export type NewConnectionRow = typeof connections.$inferInsert;
export type ConnectionAccountRow = typeof connectionAccounts.$inferSelect;
export type NewConnectionAccountRow = typeof connectionAccounts.$inferInsert;
export type SyncRunRow = typeof syncRuns.$inferSelect;
export type NewSyncRunRow = typeof syncRuns.$inferInsert;
