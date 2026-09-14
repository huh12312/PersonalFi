// SPDX-License-Identifier: MIT
/**
 * The database surface this context needs, and the small adapters around it.
 *
 * Shaped the same way `@ctx/ledger`'s `db.ts` is, and for the same reason: a
 * `Pick` of `Database` rather than the whole thing, so a Drizzle transaction
 * handle and the pool-backed database both satisfy it structurally. That is not
 * a convenience — `appendEvent` requires a transaction handle by construction, so
 * a writer that could not accept one could not emit its own events atomically,
 * and an assignment that is written without its event is an assignment the
 * budget will never hear about.
 */
import type { Database } from '@core/db';
import type { Clock } from '@core/kernel';
import type { Executor } from '@core/platform';
import type { SQL } from 'drizzle-orm';

export type CategorizationExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

export type CategorizationDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`.
 *
 * One cast, in one place, for one reason: Drizzle's `execute()` returns `PgRaw`,
 * a lazily-executed thenable, where the platform's `Executor` declares a
 * `Promise`. They are interchangeable at runtime and not assignable at compile
 * time, which is why `@core/platform` makes the identical cast in
 * `platformExecutor()`.
 */
export function outboxOf(executor: CategorizationExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/** Everything a write path needs that is not data. */
export interface CategorizationContext {
  readonly userId: string;
  readonly clock: Clock;
  /** Ties a whole categorisation pass together in the event log and the logs. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}

/**
 * `NUMERIC(5,4)` as a string, rounded and clamped.
 *
 * The column is numeric rather than a float (see the migration), so a confidence
 * crosses this boundary as text. Clamping rather than throwing is deliberate: a
 * model that returns 1.0000000002 through floating-point drift should not fail a
 * sync page, and the fifth decimal of "how sure are we?" changes no answer.
 */
export function confidenceText(value: number): string {
  if (!Number.isFinite(value)) return '0.0000';
  return Math.min(1, Math.max(0, value)).toFixed(4);
}
