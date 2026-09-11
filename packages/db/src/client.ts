// SPDX-License-Identifier: MIT
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { installTypeParsers } from './types.ts';

const { Pool } = pg;

export type Database = NodePgDatabase<Record<string, never>>;

export interface PoolOptions {
  readonly databaseUrl: string;
  readonly max?: number;
  readonly statementTimeoutMs?: number;
  readonly applicationName?: string;
}

/**
 * Create the connection pool.
 *
 * `pg` is the pure-JS driver on purpose: no native module, so the same lockfile
 * builds on glibc and on musl without a compiler in the image.
 */
export function createPool(options: PoolOptions): pg.Pool {
  installTypeParsers();
  return new Pool({
    connectionString: options.databaseUrl,
    max: options.max ?? 10,
    application_name: options.applicationName ?? 'personalfi',
    statement_timeout: options.statementTimeoutMs ?? 30_000,
    // A caller that holds a connection past this is leaking one.
    idleTimeoutMillis: 30_000,
  });
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool);
}

/** Liveness probe for `/ready`. Cheap, and fails fast rather than hanging. */
export async function checkConnection(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
