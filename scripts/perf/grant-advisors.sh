#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# WP 9.9 (e): give every builtin advisor on the scratch stack `pf-perf` the standing
# scopes it requests, through the real routes (`GET /advisors/:id/scopes`, then
# `PUT /advisors/:id/grants`, step-up fresh session, CSRF pair), so that the
# nightly `insights.run_all` does real work instead of refusing 40 times for want
# of consent — the state of an install whose holder has used the advisors screen.
#
#   bash scripts/perf/grant-advisors.sh [--session /tmp/wp99/session.cookie]
#
# Needs a live (fresh) session cookie: `node scripts/perf/load-scale.ts --session-only …`.
set -euo pipefail
SESSION=/tmp/wp99/session.cookie
PORT=8461
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session) shift; SESSION="$1" ;;
    --port) shift; PORT="$1" ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
HOST=personalfi.lan
BASE="https://${HOST}:${PORT}/api"
COOKIE="$(cat "$SESSION")"
CSRF="wp99-csrf-$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 40)"
call() { curl -sk --resolve "${HOST}:${PORT}:127.0.0.1" -H "cookie: ${COOKIE}; __Host-pfi_csrf=${CSRF}" \
  -H "x-csrf-token: ${CSRF}" -H "origin: https://${HOST}:${PORT}" -H 'sec-fetch-site: same-origin' "$@"; }
ok=0; fail=0
for id in $(docker exec pf-perf-db-1 psql -U personalfi -d personalfi -X -qtA -c "select advisor_id from advisors where kind = 'builtin' order by 1"); do
  scopes=$(call "${BASE}/advisors/${id}/scopes" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(JSON.stringify((j.scopes??[]).filter(x=>x.requested).map(x=>x.scope)))})' 2>/dev/null || echo '[]')
  code=$(call -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' --data "{\"scopes\":${scopes}}" "${BASE}/advisors/${id}/grants")
  if [ "$code" = "200" ]; then ok=$((ok + 1)); else fail=$((fail + 1)); echo "grant ${id}: HTTP ${code} (scopes ${scopes})"; fi
done
echo "grant-advisors: ${ok} advisors granted, ${fail} refused"
echo "standing grants now: $(docker exec pf-perf-db-1 psql -U personalfi -d personalfi -X -qtA -c 'select count(*) from snapshot_grants' 2>&1 | head -1)"
