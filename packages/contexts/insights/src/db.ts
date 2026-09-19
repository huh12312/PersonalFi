// SPDX-License-Identifier: MIT
/**
 * The database surface this context needs, and the context object every write
 * path carries.
 *
 * A `Pick` rather than the full `Database`, so a Drizzle transaction handle and
 * the pool-backed database both satisfy it structurally. Every write path here
 * takes one, because a run's effects must be one transaction or none: an
 * `advisor_runs` row that says "completed, 4 accepted" beside four insights
 * that rolled back is a log that lies, and it lies in the direction where
 * nobody goes looking.
 */
import type { Database } from '@core/db';
import type { Clock } from '@core/kernel';
import type { Executor } from '@core/platform';
import type { SQL } from 'drizzle-orm';

export type InsightsExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

/** The pool-backed database, which can also open transactions. */
export type InsightsDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`.
 *
 * One cast, in one place, for the reason `@ctx/ledger`, `@ctx/budgeting` and
 * `@ctx/recurring` each make the identical one: Drizzle's `execute()` returns
 * `PgRaw`, a lazily executed thenable, where the platform's `Executor` declares
 * a `Promise`. They are interchangeable at runtime and not assignable at
 * compile time. Doing it here keeps `appendEvent(tx, …)` honest — the handle
 * that writes the insights is the handle that appends the event, so an
 * `InsightProposed` cannot outlive a rolled-back insert.
 */
export function platformOf(executor: InsightsExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/** Everything a write path needs that is not data. */
export interface InsightsContext {
  readonly userId: string;
  readonly clock: Clock;
  /** Ties a run back to the schedule tick or the event that caused it. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}
