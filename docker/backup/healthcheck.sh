#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Container healthcheck for the `backup` service. Three questions, in order of
# how badly a "no" would be missed:
#
#   1. Is the loop still running at all?            (pgrep — the old check)
#   2. Did the last attempt succeed?                (status file, written by
#                                                    backup.sh / backup-loop.sh)
#   3. Was it recent enough to still be a backup?   (staleness)
#
# Only question 1 was ever asked, which is why the Phase 0 gate (H-2) could
# describe thirty consecutive silent failures with a green healthcheck the
# whole time. A backup system whose failure mode is invisible is not a backup
# system.
#
# Exit 0 = healthy. Any other exit = unhealthy; compose/docker will surface it
# in `docker compose ps` and `docker inspect .State.Health`.
set -eu

STATUS_FILE="${BACKUP_STATUS_FILE:-/tmp/backup-status}"
# 26h: the nightly cadence plus two hours of slack for a long dump or a clock
# skew. A backup older than that has missed a scheduled run.
MAX_AGE_SECONDS="${BACKUP_MAX_AGE_SECONDS:-93600}"
# Grace for the very first run after a container start: the initial backup is
# already in flight and has not finished yet. Deliberately short.
START_GRACE_SECONDS="${BACKUP_START_GRACE_SECONDS:-900}"

if ! pgrep -f backup-loop.sh >/dev/null 2>&1; then
  echo "unhealthy: backup-loop.sh is not running"
  exit 1
fi

if [ ! -r "${STATUS_FILE}" ]; then
  echo "unhealthy: no status file at ${STATUS_FILE} — no backup attempt has been recorded"
  exit 1
fi

read -r state stamp message <"${STATUS_FILE}" || {
  echo "unhealthy: status file is unreadable or empty"
  exit 1
}

now="$(date -u +%s)"
age="$((now - stamp))"

case "${state}" in
  ok)
    if [ "${age}" -gt "${MAX_AGE_SECONDS}" ]; then
      echo "unhealthy: last successful backup was ${age}s ago (limit ${MAX_AGE_SECONDS}s): ${message}"
      exit 1
    fi
    echo "healthy: last backup ${age}s ago: ${message}"
    ;;
  starting)
    if [ "${age}" -gt "${START_GRACE_SECONDS}" ]; then
      echo "unhealthy: still no completed backup ${age}s after start: ${message}"
      exit 1
    fi
    echo "starting: first backup in flight (${age}s): ${message}"
    ;;
  *)
    echo "unhealthy: last backup attempt reported '${state}' ${age}s ago: ${message}"
    exit 1
    ;;
esac
