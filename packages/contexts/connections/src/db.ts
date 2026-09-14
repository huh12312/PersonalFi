// SPDX-License-Identifier: MIT
import type { Database } from '@core/db';
import type { Clock } from '@core/kernel';
import type { Executor } from '@core/platform';
import type { SQL } from 'drizzle-orm';

/**
 * The database surface this context needs.
 *
 * A `Pick` rather than the full `Database`, so a Drizzle transaction handle and
 * the pool-backed database both satisfy it structurally. That is not a
 * convenience: the orchestrator's central invariant is that a page's ledger
 * writes and the cursor advance happen in **one** transaction, which means every
 * function it calls must accept a caller-supplied handle. A writer that could
 * only take the pool could not participate.
 */
export type ConnectionsExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

/** The pool-backed database, which can also open transactions. */
export type ConnectionsDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`
 * and `enqueueJob`.
 *
 * One cast, in one place, for the reason `@ctx/ledger` makes the identical one:
 * Drizzle's `execute()` returns `PgRaw`, a lazily-executed thenable, where the
 * platform's `Executor` declares a `Promise`. They are interchangeable at
 * runtime and not assignable at compile time. Doing it here keeps
 * `appendEvent(tx, …)` honest — the handle that writes the rows is the handle
 * that appends the event, so an event cannot outlive a rolled-back write.
 */
export function platformOf(executor: ConnectionsExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/** Everything a write path needs that is not data. */
export interface ConnectionsContext {
  readonly userId: string;
  readonly clock: Clock;
  /** Ties a whole sync run together in the event log and the logs. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}
