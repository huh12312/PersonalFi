// SPDX-License-Identifier: MIT
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { ADMIN_URL, createTestDatabase, endPool } from './database.ts';

describe('endPool', () => {
  it('resolves once pool.end() resolves', async () => {
    let ended = false;
    const fakePool = {
      end: async () => {
        ended = true;
      },
      on: () => undefined,
      totalCount: 0,
    } as unknown as pg.Pool;
    await endPool(fakePool, 1_000);
    expect(ended).toBe(true);
  });

  it('gives up after timeoutMs rather than hanging on a client an advisory lease still holds', async () => {
    // pool.end() never resolves while a client is checked out — this is the
    // exact shape of a test that threw before releasing one.
    const fakePool = {
      end: () => new Promise<void>(() => undefined),
      on: () => undefined,
      totalCount: 1,
    } as unknown as pg.Pool;
    const startedAt = Date.now();
    await endPool(fakePool, 50);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('swallows a pool.end() rejection rather than propagating it', async () => {
    const fakePool = {
      end: async () => {
        throw new Error('boom');
      },
      on: () => undefined,
      totalCount: 0,
    } as unknown as pg.Pool;
    await expect(endPool(fakePool, 1_000)).resolves.toBeUndefined();
  });
});

describe.skipIf(ADMIN_URL === undefined)('endPool against Postgres', () => {
  /**
   * Hold a client's Terminate back, the way a slow runner's socket does, and
   * report when it actually went out. pg-pool calls `client.end(cb)` from
   * `pool.end()`; the callback is what fires the pool's 'remove'.
   */
  function delayEnd(client: pg.PoolClient, ms: number): { closed: () => boolean } {
    let closed = false;
    const originalEnd = client.end.bind(client);
    (client as unknown as { end: unknown }).end = (cb?: (err?: Error) => void) => {
      setTimeout(() => {
        void originalEnd(() => {
          closed = true;
          cb?.();
        });
      }, ms);
    };
    return { closed: () => closed };
  }

  it('resolves only once every client has actually closed, not once pg-pool has asked it to', async () => {
    const pool = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    const client = await pool.connect();
    const socket = delayEnd(client, 200);
    client.release();

    await endPool(pool, 5_000);

    // Without this, a `DROP DATABASE … WITH (FORCE)` issued the moment endPool
    // resolves reaches a backend whose Terminate is still in flight.
    expect(socket.closed()).toBe(true);
  });

  it('a backend terminated while its client is still ending is not an uncaught error', async () => {
    const pool = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = rows[0]?.pid;
    delayEnd(client, 300);
    client.release();

    // The server's FATAL 57P01 lands on an idle, ending client; pg-pool
    // re-emits it as the pool's 'error'. With no listener, Node treats that as
    // an uncaught exception and vitest fails the whole run — which is exactly
    // what a FORCE drop did to a 1509-green CI run (41645348902, 2026-11-03).
    const ending = endPool(pool, 5_000);
    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      await admin.query('SELECT pg_terminate_backend($1)', [pid]);
    } finally {
      await admin.end();
    }
    await expect(ending).resolves.toBeUndefined();
  });
});

describe.skipIf(ADMIN_URL === undefined)('createTestDatabase', () => {
  it('creates a migrated scratch database with one seeded holder', async () => {
    const database = await createTestDatabase('personalfi_testkit_basic');
    try {
      expect(database.userId).toMatch(/^[0-9a-f-]{36}$/);
      const users = await database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM users`,
      );
      expect(users.rows[0]?.count).toBe('1');

      const secondUserId = await database.createUser('Another Holder');
      const usersAfter = await database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM users`,
      );
      expect(usersAfter.rows[0]?.count).toBe('2');
      expect(secondUserId).not.toBe(database.userId);
    } finally {
      await database.drop();
    }
  }, 30_000);

  it('truncate() with no argument wipes data tables but preserves users', async () => {
    const database = await createTestDatabase('personalfi_testkit_truncate_all');
    try {
      await database.db.execute(sql`
        INSERT INTO feature_flags (user_id, key, enabled)
        VALUES (${database.userId}::uuid, 'module.investments', true)
      `);
      const before = await database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM feature_flags`,
      );
      expect(before.rows[0]?.count).toBe('1');

      await database.truncate();

      const after = await database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM feature_flags`,
      );
      expect(after.rows[0]?.count).toBe('0');

      // The seeded holder survives: every other row's user_id depends on it for
      // the lifetime of this TestDatabase.
      const users = await database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM users`,
      );
      expect(users.rows[0]?.count).toBe('1');
    } finally {
      await database.drop();
    }
  }, 30_000);

  it('truncate(tables) scopes the wipe to exactly the tables named', async () => {
    const database = await createTestDatabase('personalfi_testkit_truncate_scoped');
    try {
      await database.db.execute(sql`
        INSERT INTO feature_flags (user_id, key, enabled)
        VALUES (${database.userId}::uuid, 'module.investments', true)
      `);

      // Naming a table that was never touched must not error and must not
      // disturb the one that was.
      await database.truncate(['schedules']);
      const flags = await database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM feature_flags`,
      );
      expect(flags.rows[0]?.count).toBe('1');

      await database.truncate(['feature_flags']);
      const flagsAfter = await database.db.execute<{ count: string }>(
        sql`SELECT count(*)::text AS count FROM feature_flags`,
      );
      expect(flagsAfter.rows[0]?.count).toBe('0');
    } finally {
      await database.drop();
    }
  }, 30_000);

  it('close() leaves the database in place; drop() removes it', async () => {
    const name = 'personalfi_testkit_close';
    const database = await createTestDatabase(name);
    const { url, userId } = database;
    await database.close();

    // close() ended the pool but not the database: a fresh connection still
    // finds the seeded row.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT id FROM users WHERE id = $1', [userId]);
      expect(rows).toHaveLength(1);
    } finally {
      await client.end();
    }

    const admin = new pg.Client({ connectionString: ADMIN_URL });
    await admin.connect();
    try {
      const before = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      expect(before.rows).toHaveLength(1);
    } finally {
      await admin.end();
    }

    await database.drop();

    const admin2 = new pg.Client({ connectionString: ADMIN_URL });
    await admin2.connect();
    try {
      const after = await admin2.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
      expect(after.rows).toHaveLength(0);
    } finally {
      await admin2.end();
    }
  }, 30_000);
});
