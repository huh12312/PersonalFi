#!/bin/sh
# SPDX-License-Identifier: MIT
#
# Default command for the compose `backup` service: run backup.sh once at
# startup, then sleep until the next configured hour (UTC, 02:00 by default)
# every day. This keeps `docker compose up -d` self-sufficient — no host cron
# or systemd timer required — while `just backup` / `docker compose run --rm
# backup /usr/local/bin/backup.sh` remain available for an on-demand run.
set -eu

BACKUP_HOUR_UTC="${BACKUP_HOUR_UTC:-2}"

echo "backup-loop: starting; nightly run at ${BACKUP_HOUR_UTC}:00 UTC"

/usr/local/bin/backup.sh || echo "backup-loop: initial backup failed (continuing loop)" >&2

while true; do
  now_epoch="$(date -u +%s)"
  now_hour="$(date -u +%H | sed 's/^0*//')"
  [ -z "${now_hour}" ] && now_hour=0
  today_target="$(date -u -d "today ${BACKUP_HOUR_UTC}:00" +%s 2>/dev/null || true)"
  if [ -z "${today_target}" ]; then
    # busybox date has no -d; fall back to a fixed-interval sleep.
    sleep 3600
    if [ "${now_hour}" -eq "${BACKUP_HOUR_UTC}" ]; then
      /usr/local/bin/backup.sh || echo "backup-loop: backup failed (continuing loop)" >&2
    fi
    continue
  fi
  if [ "${today_target}" -le "${now_epoch}" ]; then
    today_target="$((today_target + 86400))"
  fi
  sleep_seconds="$((today_target - now_epoch))"
  echo "backup-loop: sleeping ${sleep_seconds}s until next run"
  sleep "${sleep_seconds}"
  /usr/local/bin/backup.sh || echo "backup-loop: backup failed (continuing loop)" >&2
done
