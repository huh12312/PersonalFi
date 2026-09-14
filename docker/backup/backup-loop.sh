#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Default command for the compose `backup` service: run backup.sh once at
# startup, then once per day at the configured hour (UTC, 02:00 by default).
# This keeps `docker compose up -d` self-sufficient — no host cron or systemd
# timer required — while `just backup` / `docker compose exec backup
# /usr/local/bin/backup.sh` remain available for an on-demand run.
#
# H-2/H-5: this loop used to swallow every failure (`backup.sh || echo ...`)
# and the container healthcheck only asked whether *this script* was still
# running, so thirty consecutive failed backups looked identical to thirty
# successful ones from `docker compose ps`. It now records the outcome of every
# attempt in a status file that healthcheck.sh reads: a failed run, or a run
# that never happened, turns the container `unhealthy`.
#
# The loop still does not exit on a failed backup — a transient DB outage
# should not stop tomorrow's attempt — but "keep trying" and "stay quiet" are
# different things, and only the first one was ever wanted.
#
# R-13 (gate-security-review-2.md): a cold `docker compose up` used to run
# this startup backup before `migrator` had created any schema, so
# backup.sh's structural guard (>= MIN_TOC_ENTRIES restorable objects) correctly
# refused an empty dump and the container went `unhealthy` until the next
# nightly window — a real control firing on a startup-ordering bug. compose.yml
# now makes `backup` `depends_on: migrator: service_completed_successfully`,
# which removes the race in the normal `docker compose up` path. This wait is
# the second, defense-in-depth layer: anyone who starts or restarts `backup`
# alone (`--no-deps`, or `docker compose restart backup` after a schema wipe)
# bypasses that ordering, and this makes the same guarantee hold anyway.
set -euo pipefail

BACKUP_HOUR_UTC="${BACKUP_HOUR_UTC:-2}"
STATUS_FILE="${BACKUP_STATUS_FILE:-/tmp/backup-status}"
export BACKUP_STATUS_FILE="${STATUS_FILE}"
# How long to poll for `schema_migrations` before giving up and attempting the
# first backup anyway — at that point backup.sh's own guard is the honest
# fallback and will report a real failure rather than this script hanging
# forever on a database that will never migrate.
SCHEMA_WAIT_SECONDS="${BACKUP_SCHEMA_WAIT_SECONDS:-600}"
SCHEMA_WAIT_INTERVAL_SECONDS=5

status() {
  printf '%s %s %s\n' "$1" "$(date -u +%s)" "$2" >"${STATUS_FILE}"
}

# Polls the database for the `schema_migrations` table rather than assuming
# compose's `depends_on` already guaranteed it (see header). Uses the same
# PG* connection variables backup.sh requires; a missing one is a
# configuration error the existing `run_backup` -> backup.sh path will report
# clearly, so this only *requires* them when it can actually use them.
wait_for_schema() {
  if [ -z "${PGHOST:-}" ] || [ -z "${PGUSER:-}" ] || [ -z "${PGDATABASE:-}" ] || [ -z "${PGPASSWORD_FILE:-}" ]; then
    echo "backup-loop: PG* connection vars not fully set; skipping schema wait, backup.sh will report the real error" >&2
    return 0
  fi
  export PGPASSWORD
  PGPASSWORD="$(cat "${PGPASSWORD_FILE}")"
  waited=0
  while true; do
    if psql -h "${PGHOST}" -U "${PGUSER}" -d "${PGDATABASE}" -tAc \
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'" \
        2>/dev/null | grep -q 1; then
      echo "backup-loop: schema_migrations present after ${waited}s; proceeding with first backup"
      return 0
    fi
    if [ "${waited}" -ge "${SCHEMA_WAIT_SECONDS}" ]; then
      echo "backup-loop: schema_migrations still absent after ${SCHEMA_WAIT_SECONDS}s; attempting the first backup anyway (backup.sh's own structural guard will fail it loudly if the schema truly isn't there)" >&2
      return 0
    fi
    sleep "${SCHEMA_WAIT_INTERVAL_SECONDS}"
    waited="$((waited + SCHEMA_WAIT_INTERVAL_SECONDS))"
  done
}

run_backup() {
  if /usr/local/bin/backup.sh; then
    return 0
  fi
  rc=$?
  # backup.sh writes its own `fail` line from its EXIT trap; this covers the
  # case where it was killed before the trap ran (OOM, SIGKILL).
  if ! grep -q '^fail ' "${STATUS_FILE}" 2>/dev/null; then
    status fail "backup.sh exited ${rc} without writing a status line"
  fi
  echo "backup-loop: backup failed (exit ${rc}); container will report unhealthy until a run succeeds" >&2
  return 0
}

echo "backup-loop: starting; nightly run at ${BACKUP_HOUR_UTC}:00 UTC"
# Start from a known-bad state rather than a missing one: until the first run
# finishes, the honest answer to "is there a fresh backup?" is no. This state
# (and its timestamp) is what healthcheck.sh's START_GRACE_SECONDS window
# covers, so schema-wait time plus dump time both count against that grace,
# not against it separately.
status starting "no backup has completed since this container started"

wait_for_schema
run_backup

while true; do
  now_epoch="$(date -u +%s)"
  now_hour="$(date -u +%H | sed 's/^0*//')"
  [ -z "${now_hour}" ] && now_hour=0
  today_target="$(date -u -d "today ${BACKUP_HOUR_UTC}:00" +%s 2>/dev/null || true)"
  if [ -z "${today_target}" ]; then
    # busybox date has no -d; fall back to a fixed-interval sleep.
    sleep 3600
    if [ "${now_hour}" -eq "${BACKUP_HOUR_UTC}" ]; then
      run_backup
    fi
    continue
  fi
  if [ "${today_target}" -le "${now_epoch}" ]; then
    today_target="$((today_target + 86400))"
  fi
  sleep_seconds="$((today_target - now_epoch))"
  echo "backup-loop: sleeping ${sleep_seconds}s until next run"
  sleep "${sleep_seconds}"
  run_backup
done
