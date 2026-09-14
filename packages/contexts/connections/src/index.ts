// SPDX-License-Identifier: MIT
/**
 * `@ctx/connections` — Connections & Providers.
 *
 * The `Connector` port, the registry that maps a provider id to an adapter, the
 * connection lifecycle (link, re-link, status, disconnect), and the
 * `SyncOrchestrator` that turns a provider's pages into ledger rows one atomic
 * commit at a time.
 *
 * ```text
 *   connect ──▶ SecretBox.seal ──▶ connections ──▶ ledger.upsertAccount
 *                                       │                 │
 *                                       │                 └─▶ connection_accounts
 *                                       └─▶ ConnectionCreated ──▶ enqueue sync
 *
 *   sync ─┬─ page ─▶ ┌ BEGIN ─────────────────────────────────┐
 *         │          │ LedgerWriter.applyProviderTransactions │
 *         │          │ UPDATE connections.transactions_cursor │
 *         │          │ UPDATE sync_runs (counts)              │
 *         │          └ COMMIT ────────────────────────────────┘
 *         └─ done ─▶ sync_runs.status, connection.status, SyncRunCompleted
 * ```
 *
 * Depends on the Ledger and does not import it: see `src/ledger-writer.ts`. The
 * asymmetry — Connections knows about Ledger, Ledger has no idea Plaid exists —
 * is what makes swapping the aggregator a one-context change.
 *
 * This file is the context's **only** public surface. Everything else under
 * `src/` is internal, and no other context may import from it.
 */

/** Stable identifier used by feature flags (`module.connections`) and event metadata. */
export const CONTEXT_ID = 'connections' as const;

// --- the port, re-exported so a consumer needs one package name -------------
export * from './port.ts';

// --- errors -----------------------------------------------------------------
export {
  CONNECTIONS_ERROR_CODES,
  ConnectionsError,
  isConnectionsError,
  type ConnectionsErrorCode,
} from './errors.ts';

// --- the executor shapes a caller needs -------------------------------------
export {
  platformOf,
  type ConnectionsContext,
  type ConnectionsDatabase,
  type ConnectionsExecutor,
} from './db.ts';

// --- events -----------------------------------------------------------------
export {
  CONNECTIONS_EVENTS,
  ConnectionCreated,
  ConnectionStatusChanged,
  SyncRunCompleted,
} from './events.ts';

// --- the registry -----------------------------------------------------------
export { ConnectorRegistry, type RegisteredConnector } from './registry.ts';

// --- lifecycle --------------------------------------------------------------
export {
  accountMap,
  createConnection,
  disconnectConnection,
  getConnection,
  linkAccounts,
  listConnections,
  listSyncableConnections,
  openHandle,
  requireConnection,
  setConnectionStatus,
  type CreateConnectionInput,
  type CreateConnectionResult,
  type DisconnectInput,
  type LinkAccountsInput,
  type SetStatusInput,
} from './connections.ts';

// --- orchestration ----------------------------------------------------------
export {
  DEFAULT_DEADLINE_MS,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGES,
  NIGHTLY_CRON,
  NIGHTLY_SCHEDULE_NAME,
  SYNC_FANOUT_JOB_KIND,
  SYNC_JOB_KIND,
  SyncOrchestrator,
  syncAllJob,
  type SyncConnectionInput,
  type SyncOrchestratorOptions,
  type SyncRunSummary,
} from './orchestrator.ts';

// --- read models ------------------------------------------------------------
export {
  RECENT_RUN_LIMIT,
  getConnectionDetail,
  listConnectionSummaries,
  listSyncRuns,
} from './read.ts';

// --- wire contracts (routes are WP 1.5) -------------------------------------
export {
  capabilitiesSchema,
  connectionAccountSchema,
  connectionDetailSchema,
  connectionSummarySchema,
  createConnectionRequestSchema,
  createConnectionResponseSchema,
  syncNowResponseSchema,
  syncRunSchema,
  type ConnectionAccountView,
  type ConnectionDetail,
  type ConnectionSummary,
  type CreateConnectionRequest,
  type SyncRunView,
} from './schemas.ts';
