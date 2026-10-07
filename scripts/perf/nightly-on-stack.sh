#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# WP 9.9 (e): memory through one nightly chain, in the REAL worker process of the
# scratch stack `pf-perf`. The schedules are made due by hand and fired in cron
# order (03:15 sync, 04:00 net worth, 04:15 insights, 04:30 projection refresh),
# each waiting for the queue to drain, exactly as `apps/api/test/db/nightly-perf.test.ts`
# does in-process. The sync leg has nothing to sync here (no provider can be
# called from a scratch stack), so the stage times are for the work over the
# 50k-row ledger; the eight-connection sync is timed by the vitest test.
#
#   bash scripts/perf/nightly-on-stack.sh [--out /tmp/wp99/final/nightly-stack.txt]
#
# The 03:15 sync is jittered +/-20 minutes (08 §3.7: `jitter_seconds` 1200 on the
# schedule row), a deliberate delay and not work; the script zeroes the jitter on the
# rows it fires, as `nightly-perf.test.ts` does with `random: () => 0`. (The first
# run of this script waited on a job whose `run_after` was nine minutes out.)
#
# Memory is sampled from the cgroups every second (scripts/perf/sample-rss.sh)
# from before the first stage until the queue is empty again, and summarised.
# `docker exec <db> psql` runs here, inside a script; it is not a tool call.
set -euo pipefail
# bc is not installed on this host; awk does the arithmetic.
calc() { awk "BEGIN { printf \"%.6f\\n\", $1 }"; }
OUT=/tmp/wp99/final/nightly-stack.txt
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) shift; OUT="$1" ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB=pf-perf-db-1
sql() { docker exec "$DB" psql -U personalfi -d personalfi -X -qtA -c "$1"; }
load() { cut -d' ' -f1-3 /proc/loadavg; }
now() { date +%s.%N; }

quiet_queue() { # wait until no job is pending/running for 3 consecutive seconds
  local ok=0
  while [ "$ok" -lt 3 ]; do
    if [ "$(sql "select count(*) from jobs where status in ('pending','running')")" = "0" ]; then ok=$((ok + 1)); else ok=0; fi
    sleep 1
  done
}

stage() { # stage <label> <schedule name>
  local label="$1" name="$2" s e
  s=$(now)
  [ "$(sql "update schedules set next_run_at = now() - interval '1 minute', jitter_seconds = 0 where name = '$name' returning 1")" = "1" ] ||
    { echo "no schedule named $name"; return 1; }
  sleep 31 # the worker's scheduler ticks every SCHEDULER_INTERVAL_MS (30 s)
  quiet_queue
  e=$(now)
  printf '%-52s %7.1f s (includes up to 30 s waiting for the scheduler tick)  load %s\n' "$label" "$(calc "$e - $s")" "$(load)"
}

{
  echo "# nightly chain on pf-perf's real worker, $(date -u +%FT%TZ), load at start $(load)"
  echo "# ledger: $(sql "select count(*) from transactions") transactions"
  sql "delete from jobs where status = 'pending' and kind in ('connections.sync_all', 'planning.net_worth_snapshot', 'insights.run_all', 'planning.projection_refresh')" >/dev/null
  bash "$HERE/sample-rss.sh" --seconds 480 --interval 1 --label nightly-chain --out "$OUT.rss.csv" >/dev/null 2>&1 &
  SAMPLER=$!
  sleep 3
  T0=$(now)
  stage "03:15 connections.nightly_sync (sync_all)" connections.nightly_sync
  stage "04:00 planning.net_worth_snapshot" planning.net_worth_snapshot
  stage "04:15 insights.nightly (insights.run_all)" insights.nightly
  stage "04:30 planning.projection_refresh" planning.projection_refresh
  T1=$(now)
  printf 'chain total (wall, including 4 x ~30 s scheduler waits): %.1f s\n' "$(calc "$T1 - $T0")"
  echo "# handler work by kind (job_runs):"
  sql "select kind || ' runs=' || count(*) || ' work_s=' || round(coalesce(sum(r.duration_ms),0)/1000.0, 2)
         from job_runs r join jobs j on j.id = r.job_id where r.started_at >= now() - interval '15 minutes' group by kind order by kind"
  sql "select 'jobs by status: ' || string_agg(status || '=' || n, ' ') from (select status, count(*) n from jobs group by 1) t"
  # The sampler runs out its 480 s (so its cgroup peaks are recorded) and prints its own summary.
  wait "$SAMPLER" 2>/dev/null || true
  cat "$OUT.rss.csv.summary"
} | tee "$OUT"
