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
set -euo pipefail

BACKUP_HOUR_UTC="${BACKUP_HOUR_UTC:-2}"
STATUS_FILE="${BACKUP_STATUS_FILE:-/tmp/backup-status}"
export BACKUP_STATUS_FILE="${STATUS_FILE}"

status() {
  printf '%s %s %s\n' "$1" "$(date -u +%s)" "$2" >"${STATUS_FILE}"
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
# finishes, the honest answer to "is there a fresh backup?" is no.
status starting "no backup has completed since this container started"

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
