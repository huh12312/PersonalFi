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
    } as unknown as pg.Pool;
    await endPool(fakePool, 1_000);
    expect(ended).toBe(true);
  });

  it('gives up after timeoutMs rather than hanging on a client an advisory lease still holds', async () => {
    // pool.end() never resolves while a client is checked out — this is the
    // exact shape of a test that threw before releasing one.
    const fakePool = { end: () => new Promise<void>(() => undefined) } as unknown as pg.Pool;
    const startedAt = Date.now();
    await endPool(fakePool, 50);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('swallows a pool.end() rejection rather than propagating it', async () => {
    const fakePool = {
      end: async () => {
        throw new Error('boom');
      },
    } as unknown as pg.Pool;
    await expect(endPool(fakePool, 1_000)).resolves.toBeUndefined();
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
