// SPDX-License-Identifier: MIT
/**
 * `@connector/port` — the contract between `@ctx/connections` and every adapter.
 *
 * Types, one error class, and four pure functions. No database, no I/O, no
 * provider SDK. See `OWNERSHIP.md` for why this is a package rather than a
 * module inside `@ctx/connections` (short version: the boundary lint denies
 * `packages/connectors/*` → `@ctx/*`, so a port that lived inside the context
 * could not be imported by the adapters that implement it).
 */
export {
  CAPABILITIES,
  RECONNECT_FLOWS,
  supports,
  type Capability,
  type ConnectorCapabilities,
  type ReconnectFlow,
} from './capabilities.ts';

export {
  PROVIDER_ACCOUNT_TYPES,
  type ProviderAccountFact,
  type ProviderAccountType,
  type ProviderBalanceFact,
  type ProviderCounterparty,
  type ProviderHoldingFact,
  type ProviderLiabilityFact,
  type ProviderTransactionFact,
} from './facts.ts';

export {
  CONNECTOR_CONDITIONS,
  CONNECTOR_ERROR_KINDS,
  ConnectorError,
  KIND_OF_CONDITION,
  RESTART_MODES,
  asConnectorError,
  isConnectorError,
  retryPolicyFor,
  type ConnectorCondition,
  type ConnectorErrorKind,
  type ConnectorErrorOptions,
  type RestartMode,
  type RetryPolicy,
} from './errors.ts';

export {
  LINK_KINDS,
  SYNC_REASONS,
  cursorOf,
  windowStart,
  type ConnectResult,
  type ConnectionHandle,
  type Connector,
  type ConnectorHealth,
  type ConnectorManifest,
  type Cursor,
  type LinkKind,
  type ProviderTransactionRef,
  type SyncOptions,
  type SyncReason,
  type TransactionPage,
} from './connector.ts';

export {
  fingerprintOf,
  importedTransactionIdOf,
  normaliseDescription,
  occurrencesOf,
  type FingerprintInput,
  type ImportedIdInput,
} from './fingerprint.ts';

export { assertSupports, emptyPage, unsupported } from './helpers.ts';

export {
  connectorConformanceChecks,
  type ConformanceCheck,
  type ConformanceSubject,
} from './conformance.ts';
