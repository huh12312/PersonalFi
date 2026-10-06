#!/bin/sh
# SPDX-License-Identifier: MIT
#
# The automatic pre-migration backup (CF-3, docs/plan/09-phase-9-dispatch.md
# §2b; WP 9.4; 09 §5.7: "automatic and mandatory"). The `pre-migrate-backup`
# one-shot in compose.yml runs this on every `docker compose up`, between `db`
# becoming healthy and `migrator` starting — `migrator` depends on it
# `service_completed_successfully`, so:
#
#   * migrations pending against a NON-EMPTY schema  -> one full backup.sh run
#     (pg_dump, structural verification, age encryption, atomic rename — the
#     same artifact the nightly loop writes, restorable by restore.sh and the
#     restore drill), then a `.pre-migrate` marker beside it naming what was
#     applied and what is about to be. Any failure exits non-zero and the
#     migrator never starts: no migration ever runs without a backup first;
#   * nothing pending                                 -> exit 0, no backup;
#   * a fresh database (no schema_migrations, or none applied) -> exit 0: there
#     is nothing yet to protect, and backup.sh's own structural guard would
#     (correctly) refuse an empty dump;
#   * the migration list cannot be read               -> back up anyway. Unsure
#     means "take the backup", never "skip it".
#
# Before this, `backup` started only after `migrator` completed, so the first
# backup after an upgrade was of the *migrated* database, and RUNBOOK left the
# pre-upgrade backup to a manual `just backup`.
#
# "Pending" is computed exactly as `packages/db/src/migrate.ts` computes it:
# set membership — every `NNNN_name.sql` on disk whose version is not in
# `schema_migrations` — never a maximum-version comparison (Phase 9's
# migrations land on production out of number order). The list on disk is the
# checkout's own `packages/db/migrations`, bind-mounted read-only at
# MIGRATIONS_DIR; `just upgrade` builds the migrator's image from that same
# checkout, so the two agree. (If an operator pins PERSONALFI_VERSION to an
# image built from a different checkout, the two can disagree — RUNBOOK
# "Upgrade" says not to; WP 9.4's evidence records it as a residual.)
#
# Local only: RCLONE_REMOTE is deliberately not passed to this service, so it
# needs no B2 credential; the nightly `backup` service's push is unchanged.
# Like backup.sh, this container holds only the age RECIPIENT (public key) and
# can produce a backup it cannot itself decrypt.
#
# Does not depend on `ops_backup_runs` (WP 9.1): this runs against every older
# schema, where that table does not exist; backup.sh's insert is best-effort.
set -euo pipefail
# No `grep -q` at the end of a pipe in this file: under pipefail, `grep -q`
# exits at its first match and the writer dies of SIGPIPE once the input
# exceeds the pipe buffer, which reads as "no match" (WP 9.4 found exactly that
# in backup.sh's schema_migrations check). `grep … >/dev/null` reads it all.

: "${PGHOST:?PGHOST is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGDATABASE:?PGDATABASE is required}"
: "${PGPASSWORD_FILE:?PGPASSWORD_FILE is required}"
: "${AGE_RECIPIENTS_FILE:?AGE_RECIPIENTS_FILE is required}"

MIGRATIONS_DIR="${MIGRATIONS_DIR:-/migrations}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
export BACKUP_DIR
# Its own status file: this is not the nightly loop's, and the `backup`
# service's healthcheck must not read a one-shot's outcome as its own.
export BACKUP_STATUS_FILE="${PRE_MIGRATE_STATUS_FILE:-/tmp/pre-migrate-status}"
CONNECT_ATTEMPTS="${PRE_MIGRATE_CONNECT_ATTEMPTS:-30}"

log() { echo "pre-migrate: $*"; }

export PGPASSWORD
PGPASSWORD="$(cat "${PGPASSWORD_FILE}")"

q() { psql -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" -X -v ON_ERROR_STOP=1 -tAc "$1"; }

# `db` is healthy before this starts (depends_on), but pg_isready can pass a
# moment before the database accepts a login during first boot.
attempt=0
until q 'SELECT 1' >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "${attempt}" -ge "${CONNECT_ATTEMPTS}" ]; then
    echo "pre-migrate: FAILED: cannot connect to ${PGDATABASE}@${PGHOST} after ${attempt} attempts; the migrator will not run" >&2
    exit 1
  fi
  sleep 1
done

has_table="$(q "SELECT to_regclass('public.schema_migrations') IS NOT NULL")"
if [ "${has_table}" != "t" ]; then
  log "fresh database (no schema_migrations): nothing to protect yet; no backup taken"
  exit 0
fi
applied="$(q 'SELECT version FROM schema_migrations ORDER BY version')"
if [ -z "${applied}" ]; then
  log "no migration has ever been applied: nothing to protect yet; no backup taken"
  exit 0
fi
applied_count="$(printf '%s\n' "${applied}" | grep -c . || true)"
applied_max="$(printf '%s\n' "${applied}" | tail -1)"

reason=""
pending=""
if [ ! -d "${MIGRATIONS_DIR}" ] || [ ! -r "${MIGRATIONS_DIR}" ]; then
  reason="the migration list at ${MIGRATIONS_DIR} is not readable; backing up anyway"
else
  on_disk="$(ls -1 "${MIGRATIONS_DIR}" 2>/dev/null | grep -E '^[0-9]{4}_[a-z0-9_]+\.sql$' | sort || true)"
  if [ -z "${on_disk}" ]; then
    reason="no migration files found at ${MIGRATIONS_DIR}; backing up anyway"
  else
    for file in ${on_disk}; do
      version="$(printf '%s' "${file}" | cut -c1-4)"
      if ! printf '%s\n' "${applied}" | grep -x "${version}" >/dev/null; then
        pending="${pending}${pending:+ }${file%.sql}"
      fi
    done
    if [ -z "${pending}" ]; then
      log "schema current (${applied_count} applied, newest ${applied_max}); nothing pending, no backup needed"
      exit 0
    fi
    reason="pending against a schema with ${applied_count} applied (newest ${applied_max}): ${pending}"
  fi
fi

log "${reason}"
log "taking the pre-migration backup before the migrator may start"

before="$(ls -1 "${BACKUP_DIR}" 2>/dev/null | grep -E '^personalfi-.*\.dump\.age$' || true)"
if ! /usr/local/bin/backup.sh; then
  echo "pre-migrate: FAILED: the pre-migration backup did not complete; the migrator will NOT run (no migration without a backup first)" >&2
  exit 1
fi
after="$(ls -1 "${BACKUP_DIR}" 2>/dev/null | grep -E '^personalfi-.*\.dump\.age$' || true)"
new=""
for f in ${after}; do
  if ! printf '%s\n' "${before}" | grep -x "${f}" >/dev/null; then new="${f}"; fi
done
if [ -z "${new}" ]; then
  echo "pre-migrate: FAILED: backup.sh exited 0 but no new backup appeared in ${BACKUP_DIR}; the migrator will NOT run" >&2
  exit 1
fi

marker="${BACKUP_DIR}/${new%.dump.age}.pre-migrate"
{
  echo "taken_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "backup=${new}"
  echo "applied_count=${applied_count}"
  echo "applied_max=${applied_max}"
  echo "pending=${pending}"
  echo "reason=${reason}"
} >"${marker}.partial"
mv "${marker}.partial" "${marker}"

# Markers whose backup the nightly retention prune has since removed.
for m in "${BACKUP_DIR}"/personalfi-*.pre-migrate; do
  [ -e "${m}" ] || continue
  [ -e "${m%.pre-migrate}.dump.age" ] || rm -f "${m}"
done

log "complete: ${BACKUP_DIR}/${new} (marker ${marker##*/}); the migrator may start"
