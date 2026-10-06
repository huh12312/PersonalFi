-- SPDX-License-Identifier: MIT
-- 0036_ops_status: backup and restore-drill status, made visible in the app
-- (CF-17, D24, 09 §5.7; docs/plan/09-phase-9-dispatch.md §3 "WP 9.1"). The
-- status D24 asked for has lived only in the backup container's own
-- `/tmp/backup-status` file since Phase 0 -- unreadable by the api, unreadable
-- by the holder, and gone the moment the container restarts. These two
-- tables are the durable record `docker/backup/backup.sh` and the
-- `restore-drill` recipe now write one row to per attempt, and
-- `GET /ops/backup-status` reads back.
--
-- Forward-only. Immutable once merged: the runner records a SHA-256 of this
-- file and refuses to start if it ever changes.
--
-- References nothing but what this file creates -- no foreign key to `users`
-- or to any context's table. Both tables are install-wide, not user-scoped:
-- a backup or a restore drill is a property of the *deployment*, not of any
-- one account holder (D6's own test for `user_id` does not apply -- there is
-- exactly one install-wide fact here, same footing as `config_snapshots` and
-- `job_runs`, both already owned by this package). Phase 9's own rule (09 §4
-- wiring batch 5, carried from 05 §4): no Phase 9 migration references an
-- object a higher-numbered one creates, and this is true of 0036 against
-- 0035/0037+ by construction -- it references nothing outside itself.
--
-- Expand-only, as every Phase 9 migration must be (09 §4 "Every Phase 9
-- migration is expand-only -- no contract steps on a live soak"): both
-- statements below are plain `CREATE TABLE`, nothing is altered or dropped.
--
-- ---------------------------------------------------------------------------
-- ops_backup_runs -- one row per `docker/backup/backup.sh` attempt
-- ---------------------------------------------------------------------------
--
-- `backup.sh`'s own header (Phase 0 gate H-2, Phase 0 re-gate finding 9)
-- already treats every exit path as load-bearing: a dump that silently wrote
-- nothing used to report `ok`. This table is that same discipline, durable:
-- `status` names whether the attempt is promotable, `plaintext_bytes` and
-- `toc_entries` are NULL exactly when the run never got far enough to know
-- them (a `pg_dump` failure knows neither; a `pg_restore --list` rejection
-- knows bytes but not a trustworthy entry count), and `reason` is always a
-- short operator-facing sentence -- the same string `backup.sh` already
-- prints to stderr or writes to its status file, never a value read from the
-- account holder's own data.
--
-- The insert is best-effort from `backup.sh`'s side (WP 9.4's pre-migration
-- backup runs against schemas older than this migration, and must not fail
-- the backup it is reporting on just because the reporting table does not
-- exist yet) -- that contract is written in `backup.sh`'s own comment, not
-- enforced here.

CREATE TABLE ops_backup_runs (
  id              UUID         PRIMARY KEY,
  status          TEXT         NOT NULL CHECK (status IN ('ok', 'fail')),
  finished_at     TIMESTAMPTZ  NOT NULL,
  -- NULL when the run never produced a plaintext dump to measure (pg_dump
  -- itself failed) or never verified one (see toc_entries below).
  plaintext_bytes BIGINT       CHECK (plaintext_bytes IS NULL OR plaintext_bytes >= 0),
  -- NULL when the run never reached `pg_restore --list` (pg_dump failed) or
  -- that step itself rejected the archive as unparsable. A low-but-known
  -- entry count (the archive parsed, but had too few objects or no
  -- `schema_migrations`) is still recorded, status 'fail'.
  toc_entries     INTEGER      CHECK (toc_entries IS NULL OR toc_entries >= 0),
  -- A short operator-facing sentence: `backup.sh`'s own status-file message
  -- (e.g. "wrote .../personalfi-....dump.age (66346 bytes)" or "pg_dump
  -- failed; nothing written, nothing pruned"). Never a value drawn from the
  -- account holder's own rows -- it is the script's own narration of itself.
  reason          TEXT         NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- "The newest successful backup, never a newer failed one" (the route's own
-- exit test) reads this index: newest-first, filtered to status = 'ok'.
CREATE INDEX ops_backup_runs_ok_finished_idx
  ON ops_backup_runs (finished_at DESC)
  WHERE status = 'ok';

COMMENT ON TABLE ops_backup_runs IS
  'One row per docker/backup/backup.sh attempt (CF-17, D24). Install-wide, never user-scoped. The insert from backup.sh is best-effort against a schema that may predate this migration (WP 9.4''s pre-migration backup).';
COMMENT ON COLUMN ops_backup_runs.status IS
  'ok: the dump was verified restorable (pg_restore --list, schema_migrations present, promoted to .dump.age). fail: any earlier exit.';
COMMENT ON COLUMN ops_backup_runs.plaintext_bytes IS
  'Size of the plaintext pg_dump, in bytes. NULL when pg_dump itself failed.';
COMMENT ON COLUMN ops_backup_runs.toc_entries IS
  'Objects pg_restore --list enumerated in the archive''s table of contents. NULL when the run never reached that check.';
COMMENT ON COLUMN ops_backup_runs.reason IS
  'A short operator-facing sentence from backup.sh itself -- never a value drawn from the account holder''s own data.';

-- ---------------------------------------------------------------------------
-- ops_restore_drills -- one row per `just restore-drill` run
-- ---------------------------------------------------------------------------
--
-- The recipe already computes every one of these numbers and already
-- asserts against them (RUNBOOK.md "Restore drill", H-5: a drill that
-- collects the numbers and never compares them is "structurally incapable
-- of failing"). This table is the same verdict, written down instead of
-- only printed to the terminal and a markdown file under
-- `docs/evidence/ops/`, so `GET /ops/backup-status` can answer "when did the
-- drill last pass?" without shelling out.

CREATE TABLE ops_restore_drills (
  id                    UUID         PRIMARY KEY,
  verdict               TEXT         NOT NULL CHECK (verdict IN ('pass', 'fail')),
  ran_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  restored_table_count  INTEGER      NOT NULL CHECK (restored_table_count >= 0),
  live_table_count      INTEGER      NOT NULL CHECK (live_table_count >= 0),
  -- schema_migrations.version on the restored side, e.g. '0034'. Text, not
  -- an integer: the house convention is a zero-padded four-digit string
  -- (packages/db/src/migrate.ts), and "(none)" is a legitimate value on a
  -- restore with no migrations applied at all.
  max_migration         TEXT         NOT NULL,
  rto_seconds           INTEGER      NOT NULL CHECK (rto_seconds >= 0),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX ops_restore_drills_ran_at_idx
  ON ops_restore_drills (ran_at DESC);

COMMENT ON TABLE ops_restore_drills IS
  'One row per just restore-drill run (CF-17, D24, RUNBOOK "Restore drill"). Install-wide, never user-scoped.';
COMMENT ON COLUMN ops_restore_drills.verdict IS
  'pass: restored table count > 0, equals the live count, schema_migrations agree, and /ready served 200 from the restored database. fail: any assertion missed.';
COMMENT ON COLUMN ops_restore_drills.rto_seconds IS
  'Wall-clock seconds from "restore started" to "the restored database answered /ready" -- the measured half of the RTO 1 h budget (master plan §3.4).';
