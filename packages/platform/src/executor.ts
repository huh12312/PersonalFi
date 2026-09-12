// SPDX-License-Identifier: MIT
import type { SQL } from 'drizzle-orm';

/**
 * Anything that can run one SQL statement: a Drizzle `Database`, a Drizzle
 * transaction handle, or a test double.
 *
 * Structural on purpose. `appendEvent` and `enqueueJob` take one of these rather
 * than a pool, which is what makes "the event commits with the data" a property
 * of the *type* rather than of reviewer discipline — there is no overload that
 * writes to the outbox outside a caller-supplied transaction.
 */
export interface Executor {
  execute<TRow extends Record<string, unknown>>(query: SQL): Promise<{ rows: TRow[] }>;
}

/**
 * An executor that can also open a transaction. The pump and the job runner need
 * this; a context appending an event does not, because it already has one open.
 */
export interface TransactionalExecutor extends Executor {
  transaction<T>(fn: (tx: Executor) => Promise<T>): Promise<T>;
}

/** The subset of pino this package uses. Structural, so pino satisfies it. */
export interface PlatformLogger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** Swallows everything. The default for tests and for the pump's quiet paths. */
export const silentLogger: PlatformLogger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
