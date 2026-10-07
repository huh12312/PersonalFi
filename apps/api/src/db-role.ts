// SPDX-License-Identifier: MIT
/**
 * The serving processes' database role (WP 9.11, CF-18 / G-01).
 *
 * Until WP 9.11 the api and worker connected as `personalfi`, the cluster's
 * bootstrap SUPERUSER and the owner of every table (WP 9.10's probe:
 * `rolsuper/createrole/createdb/bypassrls = t`). Migration
 * `0039_app_role.sql` creates `personalfi_app` — DML only, owns nothing, may
 * create nothing — and this module makes every pooled connection the api and
 * the worker open start as that role:
 *
 * - **`appRoleDatabaseUrl`** adds the libpq startup option
 *   `-c role=personalfi_app` to the connection string, so the role is set by
 *   the server before the first query of every connection — no `connect`
 *   hook, no window, and `RESET ROLE` returns to it rather than to the login.
 *   This is the stopgap for an install whose `database_url` still logs in as
 *   the owner. It stops accidental DDL and the injection path to `COPY ... TO
 *   PROGRAM`; it does not stop a deliberate `SET ROLE NONE`, which only the
 *   split does: `database_url` logging in as `personalfi_app`, and the
 *   optional `migrator_database_url` secret carrying the owner for the
 *   migrator alone (RUNBOOK text handed to WP 9.12).
 * - **`ensureAppRole`** calls 0039's `personalfi_app_grants()` once at boot,
 *   over the *login* URL (never the role-switched one, which cannot connect
 *   if the role does not exist yet). A restore drops both the grants
 *   (`pg_restore --no-privileges`) and, into a fresh cluster, the role itself
 *   (roles are not in a database dump); this puts them back before the pool
 *   opens. Idempotent and serialised in SQL; never logs the URL.
 *
 * `apps/api/test/db/app-role.test.ts` connects exactly as `main.ts` and
 * `worker.ts` do (this module, `@core/db`'s `createPool`) and asserts that the
 * connection can read and write rows but cannot CREATE, ALTER, DROP,
 * TRUNCATE, create a role or run `COPY ... TO PROGRAM`.
 */
import pg from 'pg';

export const APP_DATABASE_ROLE = 'personalfi_app';

const ROLE_OPTION = `-c role=${APP_DATABASE_ROLE}`;

/**
 * The connection string every pooled api/worker connection uses: the login
 * URL with the startup option that makes the session's role `personalfi_app`.
 * An operator-supplied `options` parameter is kept; the role option is added
 * after it (the last `-c role` wins).
 */
export function appRoleDatabaseUrl(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  const existing = url.searchParams.get('options');
  const options =
    existing === null || existing.trim() === '' ? ROLE_OPTION : `${existing} ${ROLE_OPTION}`;
  url.searchParams.set('options', options);
  return url.toString();
}

export type EnsureAppRoleResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * Re-assert the app role and its grants (0039's `personalfi_app_grants()`),
 * over the login URL. Never throws: the caller logs a failure and boots on, so
 * `/ready` — not a crash loop — says what is wrong.
 */
export async function ensureAppRole(databaseUrl: string): Promise<EnsureAppRoleResult> {
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'personalfi-ensure-app-role',
    statement_timeout: 30_000,
  });
  try {
    await client.connect();
    await client.query('SELECT public.personalfi_app_grants()');
    return { ok: true };
  } catch (error) {
    // The message, never the URL: pg's errors do not carry the connection string.
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end().catch(() => undefined);
  }
}
