// SPDX-License-Identifier: MIT
/**
 * `LedgerWriter` — the Ledger, as a port.
 *
 * ## Why this is an interface and not an import
 *
 * `@ctx/connections` depends on `@ctx/ledger`: this context's own OWNERSHIP.md
 * says so, and 08 §1.3 says so. It may not *import* it. `personalfi/layer-imports`
 * denies `@ctx/*` → `@ctx/*` unconditionally (decision D8) and its error message
 * names the two alternatives: "a domain event or its published port".
 *
 * An event will not do here. The orchestrator's central invariant is that a
 * page's rows and the cursor that describes them commit in **one** transaction;
 * an event is a past-tense fact published after a write, not a way to perform
 * one. So it is the other alternative: this context declares the three functions
 * it needs, and the composition root — `apps/api`, which is the only layer
 * allowed to wire things together — passes `@ctx/ledger`'s implementations in.
 *
 * ## The three methods are `@ctx/ledger`'s actual signatures
 *
 * Not an idealised subset. `applyProviderTransactions`, `upsertAccount` and
 * `recordBalance` are declared below exactly as `@ctx/ledger` exports them, so
 * the wiring in WP 1.5 is:
 *
 * ```ts
 * const ledgerWriter: LedgerWriter = {
 *   applyProviderTransactions,
 *   upsertAccount,
 *   recordBalance,
 * };
 * ```
 *
 * — three references, no adapter functions, and a compile error the moment the
 * ledger changes a signature. That compile error is the whole safety mechanism,
 * and it fires in `apps/api` rather than here, which is the one real cost of not
 * being allowed to import: **nothing in this package's own test suite can prove
 * the shapes still match.** See the evidence note for WP 1.2, "deferred".
 */
import type { Clock, Money } from '@core/kernel';
import type { ProviderAccountFact, ProviderTransactionFact } from '@connector/port';
import type { ConnectionsExecutor } from './db.ts';

/** `@ctx/ledger`'s `UpsertAccountInput`. */
export interface LedgerUpsertAccountInput {
  readonly userId: string;
  readonly provider: string;
  readonly providerAccountId: string;
  readonly connectionId?: string | null;
  readonly name: string;
  readonly officialName?: string | null;
  readonly type: ProviderAccountFact['type'];
  readonly subtype?: string | null;
  readonly currency: string;
  readonly mask?: string | null;
  readonly includeInNetWorth?: boolean;
}

export interface LedgerUpsertAccountResult {
  readonly accountId: string;
  readonly created: boolean;
  readonly changedFields: readonly string[];
}

/** `@ctx/ledger`'s `LedgerWriteContext`. */
export interface LedgerWriteContext {
  readonly clock: Clock;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

/**
 * `@ctx/ledger`'s `ApplyProviderTransactionsInput`.
 *
 * `added`/`modified` are `ProviderTransactionFact[]` here and
 * `ProviderTransactionInput[]` there. The fact type is the input type plus
 * `providerAccountId` and `fingerprint`, and TypeScript allows the extra
 * properties because the array is a variable and not a fresh object literal —
 * which is exactly why the port's fact shape mirrors the ledger's input field
 * for field rather than being an independent "canonical transaction" that would
 * need a mapping step.
 */
export interface LedgerApplyInput {
  readonly userId: string;
  readonly accountId: string;
  readonly provider: string;
  readonly added?: readonly ProviderTransactionFact[];
  readonly modified?: readonly ProviderTransactionFact[];
  /** Provider transaction ids only. */
  readonly removed?: readonly string[];
  readonly clock: Clock;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface LedgerApplyResult {
  readonly addedTransactionIds: readonly string[];
  readonly updatedTransactionIds: readonly string[];
  readonly removedTransactionIds: readonly string[];
  readonly unchangedFactCount: number;
}

export interface LedgerRecordBalanceInput {
  readonly userId: string;
  readonly accountId: string;
  /** The account's *contribution to net worth*: a card you owe $420 on is -42000n. */
  readonly current: Money;
  readonly available?: Money | null;
  /** A magnitude, not a contribution, so it stays positive. */
  readonly limit?: Money | null;
  readonly asOf: Date;
  readonly source: 'provider' | 'manual' | 'derived';
}

/**
 * Everything this context asks of the system of record.
 *
 * Every method takes the executor first, because every one of them has to be
 * callable inside the orchestrator's per-page transaction.
 */
export interface LedgerWriter {
  applyProviderTransactions(
    executor: ConnectionsExecutor,
    input: LedgerApplyInput,
  ): Promise<LedgerApplyResult>;

  upsertAccount(
    executor: ConnectionsExecutor,
    input: LedgerUpsertAccountInput,
    context: LedgerWriteContext,
  ): Promise<LedgerUpsertAccountResult>;

  recordBalance(
    executor: ConnectionsExecutor,
    input: LedgerRecordBalanceInput,
    context: LedgerWriteContext,
  ): Promise<unknown>;
}
