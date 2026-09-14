// SPDX-License-Identifier: MIT
/**
 * The manual connector's "provider": an append-only log, in memory.
 *
 * A real provider is a remote system with its own change log, and
 * `/transactions/sync` is a window onto it. `ManualStore` is that log for a user
 * who *is* the provider — the UI appends to it when Chris types a transaction,
 * and the orchestrator reads it through exactly the same cursor contract it uses
 * for Plaid.
 *
 * Modelling it as an append-only log rather than "the current set of manual
 * rows" is what makes every cursor property true by construction rather than by
 * care:
 *
 *   * **Idempotent** — a page is a slice of an immutable prefix, so the same
 *     cursor twice is the same page twice.
 *   * **Monotonic** — the cursor is the highest sequence number consumed, and
 *     sequence numbers only go up.
 *   * **Terminating** — every page consumes at least one entry until the log is
 *     exhausted, so `hasMore` cannot cycle.
 *   * **Removals stay removed** — a removal is an entry, not a deletion. Nothing
 *     is ever taken out of the log, so a removed id cannot reappear unless the
 *     user genuinely re-adds it (which appends a new `added` entry, and is the
 *     right answer).
 *
 * It is in memory because manual entry is durable in `@ctx/ledger`, not here:
 * the store is the *delivery* mechanism for rows the user has already typed, and
 * it is refilled from the pending queue on each sync. Nothing in it needs to
 * survive a restart, which is also why this package owns no table.
 */
import type { ProviderAccountFact, ProviderBalanceFact, ProviderTransactionFact } from '@connector/port';

export type ManualEntryKind = 'added' | 'modified' | 'removed';

export interface ManualEntry {
  /** 1-based, strictly increasing per connection. The cursor is one of these. */
  readonly seq: number;
  readonly kind: ManualEntryKind;
  readonly providerAccountId: string;
  readonly providerTransactionId: string;
  /** `null` for a removal — Plaid's `removed[]` carries ids only, and so do we. */
  readonly fact: ProviderTransactionFact | null;
}

interface ConnectionState {
  readonly accounts: Map<string, ProviderAccountFact>;
  readonly balances: Map<string, ProviderBalanceFact>;
  readonly log: ManualEntry[];
}

export interface ManualBatch {
  readonly accounts?: readonly ProviderAccountFact[];
  readonly balances?: readonly ProviderBalanceFact[];
  readonly added?: readonly ProviderTransactionFact[];
  readonly modified?: readonly ProviderTransactionFact[];
  readonly removed?: readonly { readonly providerAccountId: string; readonly providerTransactionId: string }[];
}

export class ManualStore {
  readonly #connections = new Map<string, ConnectionState>();

  /** Create the connection's log. Called by `connect`, idempotent on re-link. */
  open(providerConnectionId: string): void {
    if (this.#connections.has(providerConnectionId)) return;
    this.#connections.set(providerConnectionId, {
      accounts: new Map(),
      balances: new Map(),
      log: [],
    });
  }

  has(providerConnectionId: string): boolean {
    return this.#connections.has(providerConnectionId);
  }

  /** Forget everything. `disconnect`'s local half. */
  close(providerConnectionId: string): void {
    this.#connections.delete(providerConnectionId);
  }

  /**
   * Append one batch. Accounts and balances are *state* (last write wins);
   * transactions are *log* entries (append only).
   */
  append(providerConnectionId: string, batch: ManualBatch): void {
    const state = this.#state(providerConnectionId);
    for (const account of batch.accounts ?? []) state.accounts.set(account.providerAccountId, account);
    for (const balance of batch.balances ?? []) {
      state.balances.set(balance.providerAccountId, balance);
    }
    for (const fact of batch.added ?? []) this.#push(state, 'added', fact.providerAccountId, fact.providerTransactionId, fact);
    for (const fact of batch.modified ?? []) {
      this.#push(state, 'modified', fact.providerAccountId, fact.providerTransactionId, fact);
    }
    for (const ref of batch.removed ?? []) {
      this.#push(state, 'removed', ref.providerAccountId, ref.providerTransactionId, null);
    }
  }

  accounts(providerConnectionId: string): readonly ProviderAccountFact[] {
    return [...this.#state(providerConnectionId).accounts.values()];
  }

  balances(providerConnectionId: string): readonly ProviderBalanceFact[] {
    return [...this.#state(providerConnectionId).balances.values()];
  }

  /** Entries with `seq > after`, at most `limit` of them, in order. */
  entriesAfter(providerConnectionId: string, after: number, limit: number): readonly ManualEntry[] {
    const log = this.#state(providerConnectionId).log;
    const from = log.findIndex((entry) => entry.seq > after);
    if (from === -1) return [];
    return log.slice(from, from + limit);
  }

  highestSeq(providerConnectionId: string): number {
    return this.#state(providerConnectionId).log.at(-1)?.seq ?? 0;
  }

  #state(providerConnectionId: string): ConnectionState {
    const state = this.#connections.get(providerConnectionId);
    if (state === undefined) {
      throw new Error(`manual store has no connection ${providerConnectionId}`);
    }
    return state;
  }

  #push(
    state: ConnectionState,
    kind: ManualEntryKind,
    providerAccountId: string,
    providerTransactionId: string,
    fact: ProviderTransactionFact | null,
  ): void {
    state.log.push({
      seq: (state.log.at(-1)?.seq ?? 0) + 1,
      kind,
      providerAccountId,
      providerTransactionId,
      fact,
    });
  }
}
