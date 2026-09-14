// SPDX-License-Identifier: MIT
/**
 * The `Connector` port, as this context publishes it.
 *
 * The *definitions* live in `@connector/port` and are re-exported here verbatim.
 * That is not indirection for its own sake — it is forced, and the reason is
 * worth stating where someone looking for the port will read it:
 *
 * > `personalfi/layer-imports` denies `packages/connectors/*` → `@ctx/*`. A
 * > `Connector` interface declared inside this context could therefore not be
 * > imported by `@connector/manual` or `@connector/csv`, and every adapter would
 * > have to re-declare the whole contract structurally. A port that each
 * > implementer copies is not a port.
 *
 * It is the same argument, mechanised by the same lint rule, that put
 * `SecretBox` in `@core/secretbox` rather than inside `@ctx/identity`.
 *
 * So: the shared contract sits below both, this file is the surface a consumer
 * of *this context* reads, and `src/index.ts` re-exports it once more so
 * `apps/api` needs to know only one package name.
 *
 * What this file adds on top of the re-export is everything that needs a
 * database or a ledger, and therefore cannot live in a package that has neither.
 */
export {
  CAPABILITIES,
  CONNECTOR_CONDITIONS,
  CONNECTOR_ERROR_KINDS,
  ConnectorError,
  KIND_OF_CONDITION,
  RECONNECT_FLOWS,
  RESTART_MODES,
  SYNC_REASONS,
  asConnectorError,
  assertSupports,
  connectorConformanceChecks,
  cursorOf,
  emptyPage,
  fingerprintOf,
  importedTransactionIdOf,
  isConnectorError,
  normaliseDescription,
  occurrencesOf,
  retryPolicyFor,
  supports,
  unsupported,
  windowStart,
  type Capability,
  type ConformanceCheck,
  type ConformanceSubject,
  type ConnectResult,
  type ConnectionHandle,
  type Connector,
  type ConnectorCapabilities,
  type ConnectorCondition,
  type ConnectorErrorKind,
  type ConnectorHealth,
  type ConnectorManifest,
  type Cursor,
  type ProviderAccountFact,
  type ProviderAccountType,
  type ProviderBalanceFact,
  type ProviderCounterparty,
  type ProviderHoldingFact,
  type ProviderLiabilityFact,
  type ProviderTransactionFact,
  type ProviderTransactionRef,
  type ReconnectFlow,
  type RestartMode,
  type RetryPolicy,
  type SyncOptions,
  type SyncReason,
  type TransactionPage,
} from '@connector/port';

export type {
  LedgerApplyInput,
  LedgerApplyResult,
  LedgerRecordBalanceInput,
  LedgerUpsertAccountInput,
  LedgerUpsertAccountResult,
  LedgerWriteContext,
  LedgerWriter,
} from './ledger-writer.ts';
