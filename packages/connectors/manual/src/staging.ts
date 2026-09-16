// SPDX-License-Identifier: MIT
/**
 * `StagingStore` — the seam a durable backing store plugs into.
 *
 * `ManualConnector` always writes its own in-memory `ManualStore` first (see
 * `connector.ts`'s `#local`): that keeps every existing synchronous test and
 * the conformance suite unchanged, and it is what lets `connect()` stage an
 * account before anyone has told this connector which user or which
 * `connections` row it belongs to. `StagingStore` is the *optional* mirror
 * `apps/api/src/domain.ts` attaches once, at boot, so that:
 *
 *   * a fresh process (the worker, or the api after a restart) can **hydrate**
 *     `#local` from what an earlier process durably staged, and
 *   * every write `#local` accepts gets **flushed** to that durable store
 *     before the caller's request finishes — see `connector.ts`'s `#sync`.
 *
 * Declared here, structurally, rather than imported from `@ctx/connections`:
 * `personalfi/layer-imports` denies `packages/connectors/*` -> `@ctx/*`
 * unconditionally (packages/connectors/port/OWNERSHIP.md explains the same
 * choice for the `Connector` port itself), so a context that wants to hand
 * this package a database-backed implementation has to satisfy this shape
 * rather than import it. `@connector/csv` declares the identical shape in its
 * own `src/staging.ts` for the same reason — the two are never imported
 * across that boundary, only structurally compatible, the same trick
 * `SeedDatasetLike` (`seed.ts`) uses for `@core/seed`.
 */
import type {
  ProviderAccountFact,
  ProviderBalanceFact,
  ProviderTransactionFact,
} from '@connector/port';
import type { ManualEntryKind } from './store.ts';

export type StagedTransactionKind = ManualEntryKind;

export interface StagedTransactionInput {
  readonly kind: StagedTransactionKind;
  readonly providerAccountId: string;
  readonly providerTransactionId: string;
  /** `null` for `removed` — a removal carries no fact, only a reference. */
  readonly fact: ProviderTransactionFact | null;
}

export interface StagedEntry extends StagedTransactionInput {
  /** Position in the durable log. Opaque to the connector beyond "increasing". */
  readonly seq: number;
}

export interface StagingStore {
  /** Idempotent: safe to call on a connection the store already knows about. */
  open(connectionId: string, userId: string): Promise<void>;
  has(connectionId: string): Promise<boolean>;
  /** Purge everything staged for this connection. `disconnect`'s durable half. */
  close(connectionId: string): Promise<void>;
  /** Last write wins, one row per account. */
  putAccounts(
    connectionId: string,
    userId: string,
    accounts: readonly ProviderAccountFact[],
  ): Promise<void>;
  /** Last write wins, one row per account. */
  putBalances(
    connectionId: string,
    userId: string,
    balances: readonly ProviderBalanceFact[],
  ): Promise<void>;
  /**
   * Append-only. `kind: 'added'` entries are deduplicated by
   * `providerTransactionId` — see the migration's header for why that is the
   * key and not `fingerprint` — and every other kind is always staged, because
   * a `modified`/`removed` legitimately targets the same id again later.
   */
  appendTransactions(
    connectionId: string,
    userId: string,
    entries: readonly StagedTransactionInput[],
  ): Promise<{ staged: number; skipped: number }>;
  accounts(connectionId: string): Promise<readonly ProviderAccountFact[]>;
  balances(connectionId: string): Promise<readonly ProviderBalanceFact[]>;
  /** Entries with `seq > after`, at most `limit` of them, in order. */
  entriesAfter(connectionId: string, after: number, limit: number): Promise<readonly StagedEntry[]>;
  highestSeq(connectionId: string): Promise<number>;
}
