// SPDX-License-Identifier: MIT
import type { Database } from '@core/db';
import type { SQL } from 'drizzle-orm';
import type { Executor, TransactionalExecutor } from './executor.ts';

/**
 * Adapt a Drizzle database to the platform's two structural interfaces.
 *
 * Drizzle's `Database` and its transaction handle already satisfy `Executor`
 * structurally, which is exactly why `appendEvent(tx, …)` accepts a context's own
 * transaction with no wrapping and no import of this file. The wrapper exists for
 * the other direction: the pump, the runner and the scheduler need to *open*
 * transactions, and pinning that to one narrow interface keeps them testable
 * against a fake and keeps Drizzle's very wide generic types out of their
 * signatures.
 */
export function platformExecutor(db: Database): TransactionalExecutor {
  const execute = <TRow extends Record<string, unknown>>(query: SQL): Promise<{ rows: TRow[] }> =>
    db.execute(query) as unknown as Promise<{ rows: TRow[] }>;

  return {
    execute,
    transaction: <T>(fn: (tx: Executor) => Promise<T>): Promise<T> =>
      db.transaction(async (tx) =>
        fn({
          execute: <TRow extends Record<string, unknown>>(query: SQL) =>
            tx.execute(query) as unknown as Promise<{ rows: TRow[] }>,
        }),
      ),
  };
}
