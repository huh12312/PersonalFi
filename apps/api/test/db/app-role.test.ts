// SPDX-License-Identifier: MIT
/**
 * WP 9.11, CF-18 / G-01 (Medium): the serving processes' database connection
 * cannot change the schema.
 *
 * WP 9.10's probe found api, worker, migrator and backup all logging in as
 * `personalfi` — the cluster's bootstrap SUPERUSER and the owner of all 101
 * tables. This connects **exactly as `main.ts` and `worker.ts` do**
 * (`appRoleDatabaseUrl` + `@core/db`'s `createPool`, after `ensureAppRole`)
 * to a scratch database migrated through 0039, from the same superuser login
 * the shipped `database_url` uses, and asserts:
 *
 * - it is not a superuser and it is `personalfi_app`;
 * - it can still do the app's work: SELECT, INSERT, UPDATE, DELETE on an
 *   ordinary table, and read `schema_migrations` (what `/ready` needs);
 * - it **cannot** CREATE TABLE, ALTER TABLE, DROP TABLE, TRUNCATE, CREATE
 *   ROLE, `COPY … TO PROGRAM`, or write the migration ledger;
 * - `RESET ROLE` returns to the app role, not to the login;
 * - after a restore-shaped loss of every grant (`pg_restore --no-privileges`),
 *   `ensureAppRole` puts them back;
 * - G-25: `security_events` is append-only — no UPDATE or DELETE, for the app
 *   role or the owner — except `ON DELETE SET NULL` when a user goes.
 */
import { createPool } from '@core/db';
import { newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_DATABASE_ROLE, appRoleDatabaseUrl, ensureAppRole } from '../../src/db-role.ts';

const describeWithDb = process.env['DATABASE_URL'] === undefined ? describe.skip : describe;

describeWithDb('G-01: the api/worker connection is the DML-only app role', () => {
  let database: TestDatabase;
  let app: pg.Pool;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp911_app_role');
    // The shipped boot sequence (main.ts / worker.ts), over the login URL.
    const ensured = await ensureAppRole(database.url);
    expect(ensured).toEqual({ ok: true });
    app = createPool({ databaseUrl: appRoleDatabaseUrl(database.url), max: 2 });
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await database?.drop();
  }, 30_000);

  async function refusal(sqlText: string): Promise<string> {
    try {
      await app.query(sqlText);
    } catch (error) {
      return (error as { code?: string }).code ?? 'error';
    }
    return 'succeeded';
  }

  it('is personalfi_app, not a superuser', async () => {
    const { rows } = await app.query<{ current_user: string; rolsuper: boolean }>(
      `SELECT current_user, r.rolsuper FROM pg_roles r WHERE r.rolname = current_user`,
    );
    expect(rows[0]?.current_user).toBe(APP_DATABASE_ROLE);
    expect(rows[0]?.rolsuper).toBe(false);
  }, 30_000);

  it('can still read and write rows, and read the migration ledger /ready needs', async () => {
    const { rows } = await app.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM schema_migrations',
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(30);
    const id = newId();
    await app.query(`INSERT INTO users (id, display_name) VALUES ($1, 'Role Probe')`, [id]);
    await app.query(`UPDATE users SET display_name = 'Role Probe 2' WHERE id = $1`, [id]);
    const read = await app.query<{ display_name: string }>(
      'SELECT display_name FROM users WHERE id = $1',
      [id],
    );
    expect(read.rows[0]?.display_name).toBe('Role Probe 2');
    await app.query('DELETE FROM users WHERE id = $1', [id]);
  }, 30_000);

  it('holds DML only: owns no table, and no TRUNCATE, REFERENCES or TRIGGER on any', async () => {
    const { rows } = await app.query<{ name: string; why: string }>(`
      SELECT c.relname AS name,
             concat_ws(',',
               CASE WHEN pg_has_role(current_user, c.relowner, 'USAGE') THEN 'owner' END,
               CASE WHEN has_table_privilege(c.oid, 'TRUNCATE') THEN 'truncate' END,
               CASE WHEN has_table_privilege(c.oid, 'REFERENCES') THEN 'references' END,
               CASE WHEN has_table_privilege(c.oid, 'TRIGGER') THEN 'trigger' END) AS why
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')`);
    const tables = rows.length;
    expect(tables).toBeGreaterThan(90);
    expect(rows.filter((row) => row.why !== '')).toEqual([]);
  }, 30_000);

  it('cannot CREATE TABLE, ALTER, DROP or TRUNCATE', async () => {
    expect(await refusal('TRUNCATE auth_attempts')).toBe('42501');
    expect(await refusal('CREATE TABLE wp911_probe (x int)')).toBe('42501');
    expect(await refusal('ALTER TABLE users ADD COLUMN wp911_probe int')).toBe('42501');
    expect(await refusal('ALTER TABLE security_events DISABLE TRIGGER ALL')).toBe('42501');
    expect(await refusal('DROP TABLE users')).toBe('42501');
    expect(await refusal('TRUNCATE users CASCADE')).toBe('42501');
    expect(await refusal('CREATE INDEX wp911_probe_idx ON users (display_name)')).toBe('42501');
  }, 30_000);

  it('cannot create a role, write the migration ledger, or reach the host', async () => {
    expect(await refusal('CREATE ROLE wp911_probe')).toBe('42501');
    expect(
      await refusal(`INSERT INTO schema_migrations (version, name, checksum, execution_ms)
                     VALUES ('9999', 'forged', 'x', 0)`),
    ).toBe('42501');
    expect(await refusal(`DELETE FROM schema_migrations WHERE version = '0001'`)).toBe('42501');
    expect(await refusal(`COPY (SELECT 1) TO PROGRAM 'true'`)).toBe('42501');
    expect(await refusal(`SELECT pg_read_file('/etc/hostname')`)).toBe('42501');
  }, 30_000);

  it('RESET ROLE returns to the app role, not to the login', async () => {
    const client = await app.connect();
    try {
      await client.query('RESET ROLE');
      const { rows } = await client.query<{ current_user: string }>('SELECT current_user');
      expect(rows[0]?.current_user).toBe(APP_DATABASE_ROLE);
    } finally {
      client.release();
    }
  }, 30_000);

  it('ensureAppRole restores the grants a pg_restore --no-privileges leaves out', async () => {
    // What a restore leaves behind: no grant on any table.
    await database.pool.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${APP_DATABASE_ROLE}`,
    );
    expect(await refusal('SELECT 1 FROM users LIMIT 1')).toBe('42501');
    expect(await ensureAppRole(database.url)).toEqual({ ok: true });
    expect(await refusal('SELECT 1 FROM users LIMIT 1')).toBe('succeeded');
    // And still not the ledger or the audit trail.
    expect(await refusal(`DELETE FROM schema_migrations WHERE version = '0001'`)).toBe('42501');
  }, 30_000);
});

describeWithDb('G-25: security_events is append-only', () => {
  let database: TestDatabase;
  let app: pg.Pool;

  beforeAll(async () => {
    database = await createTestDatabase('personalfi_wp911_append_only');
    expect(await ensureAppRole(database.url)).toEqual({ ok: true });
    app = createPool({ databaseUrl: appRoleDatabaseUrl(database.url), max: 2 });
  }, 60_000);

  afterAll(async () => {
    await app?.end();
    await database?.drop();
  }, 30_000);

  async function insertEvent(userId: string | null): Promise<string> {
    const id = newId();
    await app.query(
      `INSERT INTO security_events (id, user_id, kind, outcome) VALUES ($1, $2, 'auth.login', 'success')`,
      [id, userId],
    );
    return id;
  }

  it('the app role can append but not rewrite or erase', async () => {
    const id = await insertEvent(database.userId);
    for (const statement of [
      `UPDATE security_events SET outcome = 'failure' WHERE id = '${id}'`,
      `DELETE FROM security_events WHERE id = '${id}'`,
      'TRUNCATE security_events',
    ]) {
      await expect(app.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
  }, 30_000);

  it('the owner cannot rewrite or erase a row either — only the trigger decides', async () => {
    const id = await insertEvent(database.userId);
    await expect(
      database.pool.query(`UPDATE security_events SET kind = 'forged' WHERE id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      database.pool.query('DELETE FROM security_events WHERE id = $1', [id]),
    ).rejects.toThrow(/append-only/);
  }, 30_000);

  it('a user can still be deleted: ON DELETE SET NULL is the one permitted update', async () => {
    const gone = await database.createUser('Leaving Holder');
    const id = await insertEvent(gone);
    await database.pool.query('DELETE FROM users WHERE id = $1', [gone]);
    const { rows } = await database.pool.query<{ user_id: string | null; kind: string }>(
      'SELECT user_id, kind FROM security_events WHERE id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ user_id: null, kind: 'auth.login' });
  }, 30_000);
});
