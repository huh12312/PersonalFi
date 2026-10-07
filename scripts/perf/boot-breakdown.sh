#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# WP 9.9 (g): where the cold start goes. Takes the scratch stack `pf-perf` down
# (never `-v`: the database and keyring stay), brings it up again the way a host
# reboot does (`docker compose up -d`), and writes a timeline from three
# independent clocks:
#
#   * the host: when `up -d` was issued, when the api's own /ready first answered
#     200 (polled at the container's bridge address, 100 ms), when it first
#     answered through Caddy;
#   * Docker's event stream (`docker events --since/--until`): every container's
#     create / start / die / health_status, to the nanosecond;
#   * the containers' own log timestamps (`docker logs --timestamps`): the
#     migrator's "migrations complete", the api's KEK budget line and "Server
#     listening", the worker's "key custody: unlocked".
#
#   bash scripts/perf/boot-breakdown.sh [--install /tmp/wp99/install] [--out /tmp/wp99/boot-1.txt]
#
# Refuses any project that is not `pf-perf`. Prints the load average before and
# after; a number taken at a 1-minute load of 3 or more is informational (09 §3 rule 4).
set -euo pipefail
# bc is not installed on this host; awk does the arithmetic.
calc() { awk "BEGIN { printf \"%.6f\\n\", $1 }"; }

INSTALL=/tmp/wp99/install
OUT=/tmp/wp99/boot-breakdown.txt
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) shift; INSTALL="$1" ;;
    --out) shift; OUT="$1" ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT=pf-perf
cd "$INSTALL"
# shellcheck disable=SC1091
set -a; . ./.env; set +a
[ "${COMPOSE_PROJECT_NAME:-}" = "$PROJECT" ] || { echo "refusing: COMPOSE_PROJECT_NAME is not $PROJECT" >&2; exit 2; }
HTTPS_PORT="${PROXY_HTTPS_PORT:-8461}"
dc() { docker compose -p "$PROJECT" "$@"; }
now() { date +%s.%N; }
load() { cut -d' ' -f1-3 /proc/loadavg; }

echo "boot-breakdown: $(date -u +%FT%TZ) load before: $(load); other containers: $(docker ps --format '{{.Names}}' | grep -vc '^pf-perf-' || true)" | tee "$OUT"
dc down >/dev/null 2>&1
rm -f "$OUT.rss.csv" "$OUT.rss.csv.summary"
sleep 2

T0=$(now)
T0_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
READY_FILE=$(mktemp)
(
  # The api's own readiness, at its bridge address (no Caddy, no healthcheck).
  api_ready=""; caddy_ready=""
  while [ -z "$api_ready" ] || [ -z "$caddy_ready" ]; do
    if [ -z "$api_ready" ]; then
      ip=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "${PROJECT}-api-1" 2>/dev/null | tr ' ' '\n' | grep -m1 '^[0-9]' || true)
      if [ -n "$ip" ] && [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 "http://$ip:8080/ready" || true)" = "200" ]; then
        api_ready=$(now); echo "api_ready $api_ready" >>"$READY_FILE"
      fi
    fi
    if [ -z "$caddy_ready" ] && [ "$(curl -sk -o /dev/null -w '%{http_code}' --max-time 1 --resolve "personalfi.lan:${HTTPS_PORT}:127.0.0.1" "https://personalfi.lan:${HTTPS_PORT}/api/ready" || true)" = "200" ]; then
      caddy_ready=$(now); echo "caddy_ready $caddy_ready" >>"$READY_FILE"
    fi
    sleep 0.1
    [ "$(calc "(($(now) - $T0) > 240)")" = "1.000000" ] && break
  done
) &
POLLER=$!

# The whole-stack memory through the boot (the Argon2id windows of api and worker),
# from the cgroups, sampled every 0.25 s across the same interval.
bash "$HERE/sample-rss.sh" --seconds 75 --interval 0.25 --label boot --out "$OUT.rss.csv" >/dev/null 2>&1 &
SAMPLER=$!
dc up -d >"$OUT.up" 2>&1 || true
T_UP=$(now)
wait "$POLLER" || true
wait "$SAMPLER" || true
T_END_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)

{
  echo "up -d returned after $(calc "$T_UP - $T0" | xargs printf '%.2f') s"
  while read -r label ts; do
    printf '%s at +%.2f s from the up -d call\n' "$label" "$(calc "$ts - $T0")"
  done <"$READY_FILE"
  echo "load after: $(load)"
  echo
  echo "== whole-stack memory through the boot (cgroups, 0.25 s) =="
  cat "$OUT.rss.csv.summary" 2>/dev/null || echo "(no sampler summary)"
  echo
  echo "== docker events (container, action, seconds from the up -d call) =="
  docker events --since "$T0_ISO" --until "$T_END_ISO" \
    --filter "label=com.docker.compose.project=$PROJECT" --filter type=container \
    --format '{{.TimeNano}} {{.Actor.Attributes.name}} {{.Action}}' 2>/dev/null |
    awk -v t0="$T0" '$3 ~ /^(create|start|die|health_status)/ { printf "%+8.2f  %-22s %s %s\n", ($1/1e9) - t0, $2, $3, $4 }' | sort -n
  echo
  echo "== container log lines that mark phases (UTC, container-side clock) =="
  for c in pre-migrate-backup migrator api worker; do
    docker logs --timestamps "${PROJECT}-${c}-1" 2>&1 |
      grep -E 'migrations complete|applied 00|Server listening at http://127|KEK derivation|key custody|backup: wrote|pre-migrate|worker ready|configuration loaded' |
      cut -c1-170 | sed "s/^/${c}: /" | head -8
  done
} | tee -a "$OUT"
rm -f "$READY_FILE"
