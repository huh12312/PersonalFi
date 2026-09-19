// SPDX-License-Identifier: MIT
/**
 * The handles this context writes through.
 *
 * `NotificationsExecutor` is a `Pick` rather than the full `Database`, so a
 * Drizzle transaction handle and the pool-backed database both satisfy it
 * structurally — the same shape `@ctx/budgeting` and `@ctx/recurring` use. Every
 * write path takes one, because queueing a notification must be able to happen
 * in the same transaction as the write that caused it: a notification queued for
 * a fact that then rolled back has told the user something untrue, and the
 * outbox's whole reason for existing is that it cannot.
 */
import type { Database } from '@core/db';
import type { Clock } from '@core/kernel';
import type { Executor } from '@core/platform';
import type { SQL } from 'drizzle-orm';

export type NotificationsExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

/** The pool-backed database, which can also open transactions. */
export type NotificationsDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`.
 *
 * One cast, in one place, for the reason `@ctx/budgeting` and `@ctx/recurring`
 * each make the identical one: Drizzle's `execute()` returns `PgRaw`, a lazily
 * executed thenable, where the platform's `Executor` declares a `Promise`. They
 * are interchangeable at runtime and not assignable at compile time. Doing it
 * here keeps `appendEvent(tx, …)` honest — the handle that writes the outbox row
 * is the handle that appends the event.
 */
export function outboxOf(executor: NotificationsExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/** Everything a write path needs that is not data. */
export interface NotificationsContext {
  readonly userId: string;
  readonly clock: Clock;
  /** Ties a notification back to the sync or the click that caused it. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}
