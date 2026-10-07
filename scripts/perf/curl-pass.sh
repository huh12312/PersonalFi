#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# WP 9.9 (a), the curl-timed pass through Caddy: the four transaction-list
# scenarios of apps/api/test/db/transactions-http-perf.test.ts against the
# scratch stack `pf-perf`, through the real proxy (TLS, HTTP/2 negotiation,
# `handle_path /api/*`), with a session cookie minted by load-scale.ts.
# Plus the dashboard's own four requests, concurrently (09 §5.3, informational).
#
#   bash scripts/perf/curl-pass.sh [--session /tmp/wp99/session.cookie] [--samples 40] [--out FILE]
#
# `curl -w %{time_total}` per request (connection reused is NOT assumed: each
# call is a fresh curl, so TLS setup is in the number — the first request a
# browser makes; a warm browser connection is faster). Prints p50/p95/max and the
# load average beside each row (09 §3 rule 4).
set -euo pipefail
# bc is not installed on this host; awk does the arithmetic.
calc() { awk "BEGIN { printf \"%.6f\\n\", $1 }"; }

SESSION=/tmp/wp99/session.cookie
SAMPLES=40
OUT=/tmp/wp99/curl-pass.txt
PORT=8461
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session) shift; SESSION="$1" ;;
    --samples) shift; SAMPLES="$1" ;;
    --out) shift; OUT="$1" ;;
    --port) shift; PORT="$1" ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
HOST=personalfi.lan
BASE="https://${HOST}:${PORT}/api"
COOKIE="$(cat "$SESSION")"
load() { cut -d' ' -f1-3 /proc/loadavg; }
c() { curl -sk --resolve "${HOST}:${PORT}:127.0.0.1" -H "cookie: ${COOKIE}" "$@"; }
timed() { c -o /dev/null -w '%{time_total}\n' "$1"; }

pct() { # pct <file of seconds> -> "p50 p95 max" in ms
  sort -n "$1" | awk '{ v[NR] = $1 * 1000 } END { i50 = int(NR * 0.5) + 1; i95 = int(NR * 0.95) + 1; if (i95 > NR) i95 = NR; printf "p50=%.1fms p95=%.1fms max=%.1fms n=%d", v[i50], v[i95], v[NR], NR }'
}

row() { # row <label> <path>
  local label="$1" path="$2" f
  f=$(mktemp)
  for _ in 1 2 3; do timed "${BASE}${path}" >/dev/null; done # warm-ups
  for _ in $(seq 1 "$SAMPLES"); do timed "${BASE}${path}" >>"$f"; done
  echo "curl via Caddy :${PORT}  ${label}: $(pct "$f")  load $(load)" | tee -a "$OUT"
  rm -f "$f"
}

echo "# curl pass $(date -u +%FT%TZ), load at start $(load), ${SAMPLES} samples per row" | tee "$OUT"
code=$(c -o /dev/null -w '%{http_code}' "${BASE}/transactions?limit=1")
[ "$code" = "200" ] || { echo "GET /transactions answered $code through Caddy; is the session fresh?" | tee -a "$OUT"; exit 1; }
aggregate() {
  local s e
  s=$(date +%s.%N)
  for path in "/net-worth/series?from=2026-07-08&to=2026-10-06" "/insights?statuses=pending_review" "/insights/brief/current" "/ops/backup-status"; do
    c -o /dev/null "${BASE}${path}" &
  done
  wait
  e=$(date +%s.%N)
  calc "$e - $s"
}
first=$(aggregate)
echo "curl via Caddy :${PORT}  dashboard aggregate, FIRST call this run (cold if run straight after a boot): $(printf '%.1f' "$(calc "$first * 1000")")ms  load $(load)" | tee -a "$OUT"
count=$(c "${BASE}/transactions?limit=1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).summary.count))')
echo "# summary.count through Caddy: ${count}" | tee -a "$OUT"

# The deep cursor: walk the real cursor 80 pages down.
cursor=""
for _ in $(seq 1 80); do
  q="limit=50"; [ -n "$cursor" ] && q="${q}&cursor=${cursor}"
  cursor=$(c "${BASE}/transactions?${q}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(encodeURIComponent(JSON.parse(s).nextCursor ?? "")))')
  [ -n "$cursor" ] || break
done
acct=$(c "${BASE}/accounts" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=j.items??j.accounts??j;console.log(a[0].id)})')

row "first page" "/transactions?limit=50"
row "deep keyset page (~4,000 rows)" "/transactions?limit=50&cursor=${cursor}"
row "account + year filter" "/transactions?limit=50&accountIds=${acct}&from=2025-01-01&to=2025-12-31"
row "search, common (coffee)" "/transactions?limit=50&q=coffee"
row "search, rare (planet)" "/transactions?limit=50&q=planet"

# The dashboard's four requests, concurrently, wall time of the slowest. The very
# first aggregate after a boot is reported on its own (JIT, prepared statements,
# a cold buffer pool: the first dashboard load of the day), then 3 warm-ups, then
# the sampled rows.
f=$(mktemp)
for _ in 1 2 3; do aggregate >/dev/null; done
for _ in $(seq 1 "$SAMPLES"); do aggregate >>"$f"; done
echo "curl via Caddy :${PORT}  dashboard aggregate (net-worth 90d + insights feed + brief + backup-status, concurrent, warm): $(pct "$f")  load $(load)" | tee -a "$OUT"
rm -f "$f"
