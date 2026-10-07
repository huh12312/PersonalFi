#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# WP 9.9 (e): sample the memory of every container in the scratch project
# `pf-perf` from its cgroup (v2), and summarise. No `docker stats` (it samples at
# 1-2 s and hides the peak). Containers are re-discovered on every pass, so a
# sampler started before `docker compose up -d` follows the stack as it appears
# (the boot peak), and one started on a running stack follows a restart.
#
#   bash scripts/perf/sample-rss.sh --seconds 600 --interval 2 --label idle --out /tmp/wp99/rss-idle.csv
#
# Per sample, per container: memory.current (what the cgroup is charged: anon +
# page cache + kernel) and `anon` from memory.stat (the resident set a process
# actually holds: RSS, the number §3.4's "RAM" is about). The summary prints the
# whole-project total at its maximum and mean, per-container maxima, and each
# cgroup's own `memory.peak` since the container started (read at the end, so a
# spike between two samples is not lost). The load average is printed at start
# and end (09 §3 rule 4).
#
# Refuses to sample anything outside `pf-perf`.
set -euo pipefail

SECONDS_TOTAL=60
INTERVAL=2
LABEL=sample
OUT=/tmp/wp99/rss.csv
SUMMARIZE_ONLY=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --seconds) shift; SECONDS_TOTAL="$1" ;;
    --interval) shift; INTERVAL="$1" ;;
    --label) shift; LABEL="$1" ;;
    --out) shift; OUT="$1" ;;
    --summarize-only) shift; SUMMARIZE_ONLY="$1" ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
load() { cut -d' ' -f1-3 /proc/loadavg; }

declare -A NAME FULL
discover() {
  local id full svc
  FULL=()
  while read -r full; do
    [ -n "$full" ] || continue
    if [ -z "${NAME[$full]:-}" ]; then
      svc=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$full" 2>/dev/null || true)
      [ -n "$svc" ] && NAME[$full]="$svc"
    fi
    [ -n "${NAME[$full]:-}" ] && FULL[$full]=1
  done < <(docker ps -q --no-trunc --filter "label=com.docker.compose.project=pf-perf")
}
cg() { echo "/sys/fs/cgroup/system.slice/docker-$1.scope"; }

if [ -z "$SUMMARIZE_ONLY" ]; then
echo "# $LABEL: $(date -u +%FT%TZ) for ${SECONDS_TOTAL}s every ${INTERVAL}s; load at start $(load)" | tee "$OUT"
echo "epoch,service,current_bytes,anon_bytes" >>"$OUT"
end=$(( $(date +%s) + SECONDS_TOTAL ))
declare -A PEAK
while [ "$(date +%s)" -lt "$end" ]; do
  discover
  ts=$(date +%s.%N)
  for full in "${!FULL[@]}"; do
    dir=$(cg "$full")
    cur=$(cat "$dir/memory.current" 2>/dev/null) || continue
    anon=$(awk '$1=="anon"{print $2}' "$dir/memory.stat" 2>/dev/null || echo 0)
    echo "$ts,${NAME[$full]},$cur,$anon" >>"$OUT"
    pk=$(cat "$dir/memory.peak" 2>/dev/null || echo 0)
    PEAK[${NAME[$full]}]=$pk
  done
  sleep "$INTERVAL"
done
echo "# load at end $(load)" | tee -a "$OUT"
for svc in "${!PEAK[@]}"; do echo "# peak,${svc},${PEAK[$svc]}" >>"$OUT"; done

fi
[ -z "$SUMMARIZE_ONLY" ] || OUT="$SUMMARIZE_ONLY"
awk -F, -v label="$LABEL" '
  /^#/ { if ($1 == "# peak") peak[$2] = $3; next }
  $1 == "epoch" { next }
  {
    t = $1; svc = $2; cur[t, svc] = $3; an[t, svc] = $4; times[t] = 1; svcs[svc] = 1
    if ($3 > maxcur[svc]) maxcur[svc] = $3
    if ($4 > maxanon[svc]) maxanon[svc] = $4
    sumanon[svc] += $4; n[svc]++
  }
  END {
    for (t in times) {
      tc = 0; ta = 0
      for (s in svcs) { tc += cur[t, s]; ta += an[t, s] }
      if (tc > totmaxc) totmaxc = tc
      if (ta > totmaxa) totmaxa = ta
      totc += tc; tota += ta; samples++
    }
    printf "SUMMARY %s: %d samples\n", label, samples
    printf "  whole project, max  : current %7.1f MiB   anon (RSS) %7.1f MiB\n", totmaxc / 1048576, totmaxa / 1048576
    printf "  whole project, mean : current %7.1f MiB   anon (RSS) %7.1f MiB\n", totc / samples / 1048576, tota / samples / 1048576
    for (s in svcs)
      printf "  %-18s max current %7.1f MiB  max anon %7.1f MiB  mean anon %7.1f MiB  cgroup peak %7.1f MiB\n", s, maxcur[s] / 1048576, maxanon[s] / 1048576, sumanon[s] / n[s] / 1048576, peak[s] / 1048576
  }' "$OUT" | tee -a "$OUT.summary"
