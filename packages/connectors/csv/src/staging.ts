// SPDX-License-Identifier: MIT
/**
 * `StagingStore` — the seam a durable backing store plugs into.
 *
 * Identical, deliberately, to `@connector/manual/src/staging.ts`'s interface
 * of the same name: `personalfi/layer-imports` denies
 * `packages/connectors/*` -> `packages/connectors/*` (each adapter is
 * allow-listed only against `@connector/port` and its own package — see
 * `scripts/eslint-boundaries.js`'s `connectors` layer entry), so this package
 * cannot import the other's declaration and re-declares the same shape
 * structurally, the same trick `SeedDatasetLike` (`@connector/manual/src/seed.ts`)
 * uses for `@core/seed`. `@ctx/connections`'s Postgres-backed implementation
 * (`src/staging.ts` there) satisfies both by construction, without importing
 * either.
 *
 * `CsvImportConnector` keeps its own in-memory `Staged` map as the fast,
 * synchronous source of truth `addFile` writes to — `addFile` is called
 * directly, unawaited, by `apps/api/src/routes/connections.ts`, so it cannot
 * become `async` without breaking that (unowned, concurrently-edited) call
 * site. `StagingStore` is the durable mirror `connector.ts`'s `#sync` flushes
 * to and hydrates from, on every call that carries a `ConnectionHandle` (every
 * public method except `connect` and `addFile`, neither of which is told a
 * `connectionId` or a `userId`).
 */
import type { ProviderAccountFact, ProviderBalanceFact, ProviderTransactionFact } from '@connector/port';

/**
 * CSV, OFX and QIF statements only ever add: "Re-import is zero new rows"
 * (see `import.ts`'s module comment), never a revision or a retraction of a
 * row already printed. `modified`/`removed` exist in the shape only so it
 * matches `@connector/manual`'s structurally, not because this connector ever
 * produces one.
 */
export type StagedTransactionKind = 'added' | 'modified' | 'removed';

export interface StagedTransactionInput {
  readonly kind: StagedTransactionKind;
  readonly providerAccountId: string;
  readonly providerTransactionId: string;
  readonly fact: ProviderTransactionFact | null;
}

export interface StagedEntry extends StagedTransactionInput {
  readonly seq: number;
}

export interface StagingStore {
  open(connectionId: string, userId: string): Promise<void>;
  has(connectionId: string): Promise<boolean>;
  close(connectionId: string): Promise<void>;
  putAccounts(
    connectionId: string,
    userId: string,
    accounts: readonly ProviderAccountFact[],
  ): Promise<void>;
  putBalances(
    connectionId: string,
    userId: string,
    balances: readonly ProviderBalanceFact[],
  ): Promise<void>;
  appendTransactions(
    connectionId: string,
    userId: string,
    entries: readonly StagedTransactionInput[],
  ): Promise<{ staged: number; skipped: number }>;
  accounts(connectionId: string): Promise<readonly ProviderAccountFact[]>;
  balances(connectionId: string): Promise<readonly ProviderBalanceFact[]>;
  entriesAfter(
    connectionId: string,
    after: number,
    limit: number,
  ): Promise<readonly StagedEntry[]>;
  highestSeq(connectionId: string): Promise<number>;
}
