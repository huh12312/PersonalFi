// SPDX-License-Identifier: MIT
/**
 * One KEK derivation at a time, across every process on the database (WP 9.11;
 * 09 §6 Q9; WP 9.9's boot peak).
 *
 * Deriving the KEK is Argon2id at m = 1 GiB, and two processes derive it at
 * boot: the api (`auth/runtime.ts`) and the worker (`worker.ts`) — plus
 * `bootstrap-user` by hand. On a cold `up` the two boot together, so for about
 * 3.4 s the stack held two 1 GiB Argon2 blocks at once: WP 9.9 measured a
 * whole-stack peak of 2.31–2.43 GiB against §3.4's 2 GiB, and only that window
 * exceeded it. Q9's default is to stagger the two derivations, not to weaken
 * the KDF.
 *
 * The ordering is a Postgres session advisory lock held for exactly the
 * derivation: whichever process asks first derives, the other waits on the
 * lock (an idle connection, no memory) and derives after. Postgres is the one
 * thing both containers already share and already wait for, it needs no new
 * service or file, and a session lock dies with its connection, so a process
 * killed mid-derivation cannot leave the other waiting forever.
 *
 * It fails OPEN, on purpose: if the lock cannot be taken (no connection, the
 * pool's statement timeout while another process holds it far longer than a
 * derivation takes) the derivation runs anyway and the report says so. The
 * lock is a memory-peak control, never a reason for a process to stay locked.
 */
import type { IdentityQueryable } from './db.ts';

/** `pg_advisory_lock` key. Arbitrary, fixed, and used for nothing else. */
export const KEK_DERIVATION_LOCK_KEY = '7066091100000001';

/** A pool: the lock is held on one dedicated connection for the derivation. */
export interface DerivationLockPool {
  connect(): Promise<IdentityQueryable & { release(destroy?: boolean): void }>;
}

export interface DerivationLockReport {
  /** Whether the derivation ran under the lock. False means it failed open. */
  readonly locked: boolean;
  /** How long this process waited for another's derivation to finish. */
  readonly waitedMs: number;
  /** Why the lock was not taken, when it was not. */
  readonly error?: string;
}

export async function withKekDerivationLock<T>(
  pool: DerivationLockPool,
  derive: () => Promise<T>,
  nowMs: () => number = Date.now,
): Promise<{ readonly result: T; readonly lock: DerivationLockReport }> {
  const started = nowMs();
  let client: (IdentityQueryable & { release(destroy?: boolean): void }) | null = null;
  let locked = false;
  let error: string | undefined;
  try {
    client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1::bigint)', [KEK_DERIVATION_LOCK_KEY]);
    locked = true;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const waitedMs = nowMs() - started;
  try {
    const result = await derive();
    return {
      result,
      lock: error === undefined ? { locked, waitedMs } : { locked, waitedMs, error },
    };
  } finally {
    if (client !== null) {
      let unlocked = !locked;
      if (locked) {
        unlocked = await client
          .query('SELECT pg_advisory_unlock($1::bigint)', [KEK_DERIVATION_LOCK_KEY])
          .then(() => true)
          .catch(() => false);
      }
      // A connection that may still hold the lock is closed, never pooled:
      // closing it is what releases a session lock.
      client.release(!unlocked);
    }
  }
}
