// SPDX-License-Identifier: MIT
/**
 * Drizzle table definitions owned by `@ctx/connections`.
 *
 * Tables declared here must appear in this package's OWNERSHIP.md, and nowhere
 * else's. Hand-written SQL for them still lives in `packages/db/migrations/` so
 * there is one ordered, forward-only history for the whole database.
 *
 * `accounts` and `transactions` are deliberately absent: `@ctx/ledger` owns
 * them, and this context reaches them through the injected `LedgerWriter` rather
 * than by importing a table definition. `connection_accounts.account_id` is an
 * opaque UUID here for exactly that reason.
 */
export {
  CONNECTION_STATUSES,
  SYNC_OPERATIONS,
  SYNC_RUN_STATUSES,
  SYNC_TRIGGERS,
  connectionAccounts,
  connections,
  syncRuns,
  type ConnectionAccountRow,
  type ConnectionRow,
  type ConnectionStatus,
  type NewConnectionAccountRow,
  type NewConnectionRow,
  type NewSyncRunRow,
  type SyncOperation,
  type SyncRunRow,
  type SyncRunStatus,
  type SyncTrigger,
} from './connections.ts';
export {
  STAGED_FACT_KINDS,
  connectionStagedFacts,
  type ConnectionStagedFactRow,
  type NewConnectionStagedFactRow,
  type StagedFactKind,
} from './staging.ts';
export {
  SYNC_FACT_KINDS,
  connectionSyncFacts,
  type ConnectionSyncFactRow,
  type NewConnectionSyncFactRow,
  type SyncFactKind,
} from './sync-facts.ts';
export {
  PROVIDER_CREDENTIAL_ENVS,
  PROVIDER_CREDENTIAL_PROVIDERS,
  providerCredentials,
  type NewProviderCredentialRow,
  type ProviderCredentialEnv,
  type ProviderCredentialProvider,
  type ProviderCredentialRow,
} from './provider-credentials.ts';
