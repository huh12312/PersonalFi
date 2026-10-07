-- SPDX-License-Identifier: MIT
-- 0039_app_role: CF-18 / G-01 and G-25 (WP 9.11; docs/evidence/phase-9/
-- wp9.10-security-review.md §5, docs/evidence/phase-9/wp9.11-security-fixes.md).
--
-- G-01: api, worker, migrator and backup all connected as `personalfi`, the
-- cluster's bootstrap SUPERUSER (CREATEROLE, CREATEDB, BYPASSRLS) and owner of
-- every table. A SQL injection or a compromised dependency in the serving
-- process was therefore `COPY ... TO PROGRAM`, `ALTER TABLE ... DISABLE
-- TRIGGER` and `pg_read_server_files` away from the host.
--
-- This creates `personalfi_app`: NOLOGIN, no superuser, no CREATEDB,
-- CREATEROLE, REPLICATION or BYPASSRLS, with DML only (SELECT, INSERT, UPDATE,
-- DELETE on every table; USAGE, SELECT, UPDATE on every sequence) and default
-- privileges so every table a later migration creates is granted the same.
-- It owns nothing and may CREATE nothing. The migrator keeps DDL: it still
-- connects as the owner (`migrator_database_url` when the operator has split
-- the secrets, else `database_url`). The api and worker start every pooled
-- connection as this role (`apps/api/src/db-role.ts`: the startup option
-- `-c role=personalfi_app`), which is the stopgap until the operator splits
-- the secrets -- it stops accidental DDL and the injection path above; it does
-- not stop a deliberate `SET ROLE NONE` while the login is still the superuser.
--
-- Everything lives in `personalfi_app_grants()`, which this migration calls
-- once and the api and worker call at every boot (idempotent), because
-- neither the role nor the grants survive the paths a restore takes:
--   * `restore.sh` runs `pg_restore --no-owner --no-privileges`, so a restored
--     database carries no GRANT and no default ACL at all;
--   * a role is cluster-wide and is never in a database dump, so a restore into
--     a fresh cluster (the restore drill, 9.4's cross-boundary restore) has no
--     `personalfi_app` -- and this migration, already in the restored
--     `schema_migrations`, will not run again.
-- SECURITY DEFINER, so in split mode (login = `personalfi_app`) the call still
-- re-grants as the owner; it takes no argument, names fixed objects only and
-- pins `search_path`, so calling it can only (re)grant what the app role is
-- meant to hold. Concurrent callers (api and worker booting together; parallel
-- test databases on one cluster) are serialised by an advisory lock and by the
-- `duplicate_object` catch on the cluster-wide CREATE ROLE.
--
-- G-25 (part): `security_events` becomes append-only. The app role loses
-- UPDATE, DELETE and TRUNCATE on it, and a trigger refuses every UPDATE and
-- DELETE for every role -- except the one UPDATE the schema itself performs,
-- `user_id` set to NULL by `ON DELETE SET NULL` when a user row goes. (A
-- superuser can still disable the trigger; with G-01 the serving process is
-- no longer one.) `schema_migrations` is read-only to the app role.
--
-- Expand-only: a role, grants, one function and one trigger; no table, column
-- or row is created or changed, and no object a higher-numbered migration
-- creates is referenced, so it applies on the live soak install and in any
-- order against 0040. Functions name only `pg_catalog` callees (the F-94-6
-- rule, `restore-search-path.test.ts`).
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.

CREATE OR REPLACE FUNCTION public.personalfi_app_grants()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  -- One caller at a time per database: two concurrent GRANTs on one object
  -- fail with "tuple concurrently updated".
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('personalfi_app_grants'));

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'personalfi_app') THEN
    BEGIN
      CREATE ROLE personalfi_app
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- created by a concurrent caller in another database of this cluster
    END;
  END IF;

  -- The app role never holds these, whoever widened it by hand. (LOGIN and a
  -- password are the operator's, for the split; they are left alone.)
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
    WHERE rolname = 'personalfi_app'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
  ) THEN
    ALTER ROLE personalfi_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;

  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
  GRANT USAGE ON SCHEMA public TO personalfi_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO personalfi_app;
  GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO personalfi_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO personalfi_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO personalfi_app;

  -- Read-only to the serving process: the migration ledger and the audit trail.
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.schema_migrations FROM personalfi_app;
  REVOKE UPDATE, DELETE, TRUNCATE ON public.security_events FROM personalfi_app;
END
$fn$;

REVOKE ALL ON FUNCTION public.personalfi_app_grants() FROM PUBLIC;

SELECT public.personalfi_app_grants();

GRANT EXECUTE ON FUNCTION public.personalfi_app_grants() TO personalfi_app;

-- G-25: append-only audit trail.
CREATE OR REPLACE FUNCTION public.security_events_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.user_id IS NOT NULL
     AND NEW.user_id IS NULL
     AND (NEW.id, NEW.occurred_at, NEW.kind, NEW.outcome, NEW.detail, NEW.ip,
          NEW.user_agent_hash, NEW.correlation_id)
         IS NOT DISTINCT FROM
         (OLD.id, OLD.occurred_at, OLD.kind, OLD.outcome, OLD.detail, OLD.ip,
          OLD.user_agent_hash, OLD.correlation_id)
  THEN
    -- `ON DELETE SET NULL` from `users`: the event outlives its user.
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'security_events is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;

CREATE TRIGGER security_events_append_only
  BEFORE UPDATE OR DELETE ON security_events
  FOR EACH ROW EXECUTE FUNCTION public.security_events_append_only();
