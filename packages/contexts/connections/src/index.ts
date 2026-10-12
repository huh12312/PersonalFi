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
 *   sync ─┬─ delta ▶ ┌ BEGIN ─────────────────────────────────┐
 *         │          │ LedgerWriter.applyProviderTransactions │
 *         │          │ UPDATE connections.transactions_cursor │
 *         │          │ UPDATE sync_runs (counts)              │
 *         │          └ COMMIT ────────────────────────────────┘
 *         └─ done ─▶ sync_runs.status, connection.status, SyncRunCompleted
 * ```
 *
 * One "delta" is the whole accumulated page sequence for a cursor provider
 * (`incremental_sync`) and one page for a window provider — see
 * `src/orchestrator.ts`, invariant 2. Either way the rows and the cursor that
 * describes them commit together or not at all.
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
  ProviderCredentialsChanged,
  SyncRunCompleted,
} from './events.ts';

// --- the registry -----------------------------------------------------------
export {
  ConnectorRegistry,
  DEFAULT_DYNAMIC_TTL_MS,
  type ConnectorRegistryOptions as ConnectorRegistryConstructorOptions,
  type DynamicConnector,
  type RegisteredConnector,
} from './registry.ts';

// --- a holder's provider API credentials, sealed (WP 10.1, migration 0041) ---
export {
  OpenedProviderCredentials,
  credentialRef,
  eraseCredentialKey,
  getProviderCredentialStatus,
  openProviderCredentials,
  removeProviderCredentials,
  setProviderCredentials,
  type CredentialField,
  type ProviderCredentialStatus,
  type SetProviderCredentialsInput,
  type SetProviderCredentialsResult,
} from './provider-credentials.ts';
export {
  PROVIDER_CREDENTIAL_ENVS,
  PROVIDER_CREDENTIAL_PROVIDERS,
  type ProviderCredentialEnv,
  type ProviderCredentialProvider,
} from '../schema/index.ts';
export {
  PROVIDER_CREDENTIALS_CONSUMER,
  createProviderCredentialsConsumer,
} from './provider-credentials-consumer.ts';

// --- durable staging for the process-local connectors (decision D-5) --------
export { createCsvStagingStore, createManualStagingStore } from './staging.ts';

// --- what a provider's dataset legs observed (WP 3.7, migration 0018) -------
//
// The writers are the orchestrator's alone and are not exported: a fact is
// written by the leg that fetched it, inside the transaction that settles that
// leg's `sync_runs` row, or it is not written. The readers are published
// because two consumers live outside this context — `@ctx/investments`' lot
// engine, through `InvestmentSyncPort.factsForRun`, and WP 3.10's
// `liabilities.terms` scope, through the snapshot builder's
// `investments.liabilities(...)` port. Both are satisfied in
// `apps/api/src/domain.ts`.
export {
  investmentFactsForRun,
  liabilityTermsFor,
  type LiabilityTerms,
  type RunHoldingFact,
  type RunInvestmentFacts,
  type RunInvestmentTransactionFact,
} from './staging.ts';

// --- lifecycle --------------------------------------------------------------
export {
  accountMap,
  countConnectionsByProvider,
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
  MAX_RESTARTS,
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
  connectorManifestSchema,
  createConnectionRequestSchema,
  createConnectionResponseSchema,
  syncNowResponseSchema,
  syncRunSchema,
  type ConnectionAccountView,
  type ConnectionDetail,
  type ConnectionSummary,
  type ConnectorManifestView,
  type CreateConnectionRequest,
  type SyncRunView,
} from './schemas.ts';
