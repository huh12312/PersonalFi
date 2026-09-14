// SPDX-License-Identifier: MIT
/**
 * `@connector/manual` — the user as a provider, and the demo dataset as one too.
 */
export {
  MANUAL_CAPABILITIES,
  MANUAL_MANIFEST,
  MANUAL_PROVIDER,
  ManualConnector,
  manualTransaction,
  type ManualConnectorOptions,
  type ManualTransactionInput,
} from './connector.ts';
export {
  ManualStore,
  type ManualBatch,
  type ManualEntry,
  type ManualEntryKind,
} from './store.ts';
export {
  SEED_PROVIDER,
  SeedConnector,
  seedBatches,
  type SeedAccountLike,
  type SeedBatchOptions,
  type SeedConnectorOptions,
  type SeedDatasetLike,
  type SeedMerchantLike,
  type SeedTransactionLike,
} from './seed.ts';
