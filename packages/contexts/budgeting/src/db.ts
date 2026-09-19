// SPDX-License-Identifier: MIT
import type { Database } from '@core/db';
import type { Clock } from '@core/kernel';
import type { Executor } from '@core/platform';
import type { SQL } from 'drizzle-orm';

/**
 * The database surface this context needs.
 *
 * A `Pick` rather than the full `Database`, so a Drizzle transaction handle and
 * the pool-backed database both satisfy it structurally. Every write path here
 * takes one, because the cascade — recompute a period, append
 * `ReadyToAssignChanged`, mark the next period dirty — must be one transaction
 * or none: a budget that has emitted "you crossed 80%" for a recompute that then
 * rolled back has told the user something that is not true.
 */
export type BudgetingExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

/** The pool-backed database, which can also open transactions. */
export type BudgetingDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`.
 *
 * One cast, in one place, for the reason `@ctx/ledger` and `@ctx/connections`
 * each make the identical one: Drizzle's `execute()` returns `PgRaw`, a lazily
 * executed thenable, where the platform's `Executor` declares a `Promise`. They
 * are interchangeable at runtime and not assignable at compile time. Doing it
 * here keeps `appendEvent(tx, …)` honest — the handle that writes the envelopes
 * is the handle that appends the event, so an event cannot outlive a rolled-back
 * write.
 */
export function platformOf(executor: BudgetingExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/** Everything a write path needs that is not data. */
export interface BudgetingContext {
  readonly userId: string;
  readonly clock: Clock;
  /** Ties a recompute back to the sync or the click that caused it. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}
