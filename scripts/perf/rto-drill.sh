#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# WP 9.9 (d): the measured half of RTO 1 h — a timed restore of a scale-seed
# database to `/ready`, on the scratch stack `pf-perf`: take one encrypted backup
# with the stack's own `backup.sh` (what `just backup` runs), then run the shipped
# `just restore-drill` (WP 9.1's recipe: decrypt, pg_restore into a throwaway
# Postgres, boot a throwaway api on the restored database, wait for 200 from
# /ready, compare table counts and migrations). Every output line is prefixed
# with the seconds since the drill began, so the stages can be read off.
#
#   bash scripts/perf/rto-drill.sh [--install /tmp/wp99/install] [--age-identity /tmp/wp99/age-identity.txt] [--out FILE]
#
# The recipe's own `rto_seconds` ("restore started" to "restored database answered
# /ready") is the number the product records in `ops_restore_drills`; the wall
# time here adds the scratch Postgres start. RPO is not measured here: it is the
# nightly cadence plus the 26 h staleness check, cited from WP 9.1's rows.
set -euo pipefail
# bc is not installed on this host; awk does the arithmetic.
calc() { awk "BEGIN { printf \"%.6f\\n\", $1 }"; }
INSTALL=/tmp/wp99/install
AGE=/tmp/wp99/age-identity.txt
OUT=/tmp/wp99/final/rto-drill.txt
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) shift; INSTALL="$1" ;;
    --age-identity) shift; AGE="$1" ;;
    --out) shift; OUT="$1" ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
cd "$INSTALL"
set -a; . ./.env; set +a
[ "${COMPOSE_PROJECT_NAME:-}" = "pf-perf" ] || { echo "refusing: not pf-perf" >&2; exit 2; }
load() { cut -d' ' -f1-3 /proc/loadavg; }
stamp() { local t0="$1" line; while IFS= read -r line; do printf '%7.1f  %s\n' "$(calc "$(date +%s.%N) - $t0")" "$line"; done; }

{
  echo "# RTO drill $(date -u +%FT%TZ) on pf-perf; load at start $(load)"
  echo "# database: $(docker exec pf-perf-db-1 psql -U personalfi -d personalfi -X -qtA -c "select count(*) from transactions") transactions, $(docker exec pf-perf-db-1 psql -U personalfi -d personalfi -X -qtA -c "select pg_size_pretty(pg_database_size('personalfi'))") on disk"
  T0=$(date +%s.%N)
  echo "== backup (backup.sh, as 'just backup' runs it) =="
  docker compose -p pf-perf exec -T backup /usr/local/bin/backup.sh 2>&1 | stamp "$T0"
  T1=$(date +%s.%N)
  printf 'backup wall time: %.1f s\n' "$(calc "$T1 - $T0")"
  echo "== just restore-drill =="
  AGE_IDENTITY_FILE="$AGE" DRILL_SECRETS_DIR="$INSTALL/secrets" DRILL_EVIDENCE_DIR=/tmp/wp99/drill-evidence \
    just restore-drill 2>&1 | stamp "$T1"
  T2=$(date +%s.%N)
  printf 'restore-drill wall time (scratch db start to verdict): %.1f s\n' "$(calc "$T2 - $T1")"
  echo "load at end: $(load)"
  echo "== the drill's own evidence =="
  sed -n 1,20p /tmp/wp99/drill-evidence/restore-drill-*.md 2>/dev/null | tail -14
  echo "== rto_seconds as recorded in ops_restore_drills =="
  docker exec pf-perf-db-1 psql -U personalfi -d personalfi -X -qtA -c "select verdict, rto_seconds, restored_table_count, live_table_count, max_migration from ops_restore_drills order by ran_at desc limit 1"
} 2>&1 | tee "$OUT"
