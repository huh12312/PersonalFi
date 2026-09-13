// SPDX-License-Identifier: MIT
import type pg from 'pg';

/**
 * Advisory lock keys.
 *
 * Every key is the ASCII of an eight-character mnemonic read as a signed int64,
 * the same convention `@core/db` uses for `MIGRATION_ADVISORY_LOCK_KEY`
 * (`0x50464d4947524154`, `PFMIGRAT`). The values must never collide and must
 * never change: a changed key means two processes that used to exclude each other
 * silently stop doing so.
 *
 * `0x50464d4947524154` — PFMIGRAT — migrations       (@core/db, do not reuse)
 * `0x5046455654534551` — PFEVTSEQ — outbox ordering  (held transaction-scoped in SQL)
 * `0x504653434845444c` — PFSCHEDL — scheduler leader
 * `0x504a4f4252454150` — PJOBREAP — job reaper leader
 * `0x50464556`         — PFEV     — classid for the per-consumer two-int lock
 */
export const EVENT_SEQUENCE_ADVISORY_LOCK_KEY = 0x5046455654534551n;
export const SCHEDULER_ADVISORY_LOCK_KEY = 0x504653434845444cn;
export const JOB_REAPER_ADVISORY_LOCK_KEY = 0x504a4f4252454150n;

/**
 * Per-consumer locks use the two-int form, `pg_try_advisory_lock(classid, objid)`,
 * so one constant plus a hash of the consumer name gives every consumer its own
 * lock without a registry of magic numbers.
 */
export const CONSUMER_ADVISORY_LOCK_CLASS = 0x50464556;

/**
 * FNV-1a, folded to a signed int32.
 *
 * Deliberately not Postgres's `hashtext()`: that function is an implementation
 * detail of the hash-index machinery, is undocumented, and has changed its
 * algorithm between major versions. A lock key that changes on a Postgres upgrade
 * would let two workers run the same consumer during the upgrade window.
 */
export function lockIdForName(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  // `| 0` reinterprets as signed int32, which is what pg_try_advisory_lock wants.
  return hash | 0;
}

/** A held session-scoped advisory lock. Release is idempotent. */
export interface AdvisoryLease {
  readonly client: pg.PoolClient;
  release(): Promise<void>;
}

/**
 * Try to take a session-scoped advisory lock on a dedicated connection.
 *
 * Session-scoped rather than transaction-scoped because the holder runs a loop,
 * not a statement: the point is "this process is the scheduler until it dies",
 * and a connection that drops releases the lock automatically, which is exactly
 * the failover behaviour wanted. Returns `null` if another process holds it.
 */
export async function tryAcquireAdvisoryLease(
  pool: pg.Pool,
  key: bigint,
): Promise<AdvisoryLease | null> {
  return tryAcquire(pool, '$1::bigint', [key.toString()]);
}

/** The two-int form, for locks keyed by a name rather than by a constant. */
export async function tryAcquireNamedAdvisoryLease(
  pool: pg.Pool,
  classId: number,
  name: string,
): Promise<AdvisoryLease | null> {
  return tryAcquire(pool, '$1::int, $2::int', [classId, lockIdForName(name)]);
}

/**
 * The shared body of both forms: take a connection, try the lock on it, and hand
 * back a lease that unlocks with the same argument list it locked with.
 *
 * The `args` string is a fixed placeholder list chosen by the two callers above,
 * never anything derived from input — the lock arguments themselves travel as
 * bound parameters.
 */
async function tryAcquire(
  pool: pg.Pool,
  args: string,
  params: readonly unknown[],
): Promise<AdvisoryLease | null> {
  const client = await pool.connect();
  try {
    const result = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${args}) AS locked`,
      [...params],
    );
    if (result.rows[0]?.locked !== true) {
      client.release();
      return null;
    }
  } catch (cause) {
    client.release();
    throw cause;
  }
  return makeLease(client, `SELECT pg_advisory_unlock(${args})`, params);
}

function makeLease(
  client: pg.PoolClient,
  unlockSql: string,
  params: readonly unknown[],
): AdvisoryLease {
  let released = false;
  return {
    client,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await client.query(unlockSql, [...params]);
      } finally {
        client.release();
      }
    },
  };
}
