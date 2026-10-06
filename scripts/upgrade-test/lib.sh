#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Shared helpers for the unattended-upgrade harness (WP 9.4). Sourced by
# run.sh; never run on its own. See scripts/upgrade-test/README.md.
#
# Every `docker compose` call here names its project with `-p` (09 §3 rule 6),
# and every project this harness creates is called `pf-upgrade-<run>[-r]`. The
# only `down -v` in this file refuses any other name.

# shellcheck disable=SC2034  # variables consumed by run.sh

WAYPOINTS=(W0 W1 W2 W3 W4 W5 HEAD)
declare -A WAYPOINT_SHA=(
  [W0]=d04669e [W1]=2e67648 [W2]=d3a51a0 [W3]=6391428 [W4]=d0dcf70 [W5]=f24160f
)

PROXY_HTTPS_PORT="${PROXY_HTTPS_PORT:-8451}"
PROXY_HTTP_PORT="${PROXY_HTTP_PORT:-8452}"
PUBLIC_HOST_TEST="personalfi.lan"
ORIGIN="https://${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}"
REGISTRY_TEST="pf-upgrade"

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
now() { date +%s.%N; }
loadavg() { cut -d' ' -f1-3 /proc/loadavg; }
elapsed() { awk -v a="$1" -v b="$2" 'BEGIN { printf "%.1f", b - a }'; }

log() { echo "[$(ts)] $*"; }
die() {
  echo "[$(ts)] FATAL: $*" >&2
  exit 1
}

# Refuse anything that is not ours, before it can do damage.
assert_project() {
  case "$1" in
    pf-upgrade-[a-z0-9]*) ;;
    *) die "refusing to act on compose project '$1' (only pf-upgrade-* is ours)" ;;
  esac
  [ "$1" != "personalfi-prod" ] || die "refusing personalfi-prod"
}

# dc <project> <install dir> <compose args...>
dc() {
  local project="$1" dir="$2"
  shift 2
  assert_project "$project"
  docker compose -p "$project" --project-directory "$dir" "$@"
}

# The tree a waypoint ships. HEAD is `git archive $HEAD_SHA` (HEAD when the
# run started, pinned in $RUN_DIR/head.sha so a commit landing mid-run or a
# resume never splits one run across two commits) plus this package's
# wholly-owned files from the working tree (uncommitted until the orchestrator
# lands them) — never another package's uncommitted edits. The two files this
# package owns only a block or a section of (compose.yml, RUNBOOK.md) come from
# HEAD as committed: another package's in-flight edit to them must not ride
# into the test (a working-tree difference is logged, not copied).
WP94_OWNED_PATHS=(
  scripts/upgrade-test
  scripts/secrets-placeholders.sh
  packages/db/src/migrate.ts
  packages/db/test/migrate-newer.test.ts
  docker/backup/pre-migrate.sh
  docker/backup.Dockerfile
  docker/api.Dockerfile
  scripts/compose-hardening-check.sh
  scripts/fixtures/compose-hostile.yml
  .github/workflows/upgrade-test.yml
)
WP94_SHARED_PATHS=(compose.yml RUNBOOK.md)

# prepare_tree <waypoint> <dest>
prepare_tree() {
  local wp="$1" dest="$2" sha
  rm -rf "$dest"
  mkdir -p "$dest"
  if [ "$wp" = "HEAD" ] || [ "$wp" = "HEAD+1" ] || [ "$wp" = "HEAD-nocheck" ]; then
    git -C "$REPO_ROOT" archive "${HEAD_SHA:?HEAD_SHA unset}" | tar -x -C "$dest"
    local p
    for p in "${WP94_OWNED_PATHS[@]}"; do
      [ -e "$REPO_ROOT/$p" ] || continue
      rm -rf "${dest:?}/$p"
      mkdir -p "$(dirname "$dest/$p")"
      cp -a "$REPO_ROOT/$p" "$dest/$p"
    done
    for p in "${WP94_SHARED_PATHS[@]}"; do
      if ! git -C "$REPO_ROOT" diff --quiet "$HEAD_SHA" -- "$p" 2>/dev/null; then
        log "note: the working tree's $p differs from ${HEAD_SHA:0:7} (a shared file); the test tree uses the commit's"
      fi
    done
    # `just upgrade`: the justfile imports upgrade.just since d950bf2 (09 §4
    # batch 9, wired by the orchestrator). Only a tree without the import and
    # without a recipe of its own gets the text appended, and says so.
    if grep -qE "^import +['\"]scripts/upgrade-test/upgrade\.just['\"]" "$dest/justfile"; then
      :
    elif ! grep -q '^upgrade:' "$dest/justfile"; then
      printf '\n' >>"$dest/justfile"
      cat "$REPO_ROOT/scripts/upgrade-test/upgrade.just" >>"$dest/justfile"
      log "WIRING PENDING: HEAD's justfile has no 'upgrade' recipe; appended scripts/upgrade-test/upgrade.just to the test tree"
    fi
    # F-94-1 (WP 9.4's evidence §5): backup.sh's schema_migrations check is
    # `printf … | grep -qE …` under pipefail — a false refusal whenever the TOC
    # outgrows the pipe buffer and the match comes early (SIGPIPE, exit 141).
    # backup.sh is WP 9.1's this wave; until the one-line fix lands, the test
    # tree carries it, and says so. Detected by the exact buggy text, so the
    # day the fix lands this does nothing.
    if node -e '
      const fs = require("node:fs");
      const p = process.argv[1];
      const bad = "| grep -qE \x27TABLE[[:space:]]+public[[:space:]]+schema_migrations([[:space:]]|$)\x27; then";
      const good = "| grep -E \x27TABLE[[:space:]]+public[[:space:]]+schema_migrations([[:space:]]|$)\x27 >/dev/null; then";
      const src = fs.readFileSync(p, "utf8");
      if (!src.includes(bad)) process.exit(1);
      fs.writeFileSync(p, src.replace(bad, good));
    ' "$dest/docker/backup/backup.sh"; then
      log "WIRING PENDING (F-94-1, backup.sh is WP 9.1's): the test tree's backup.sh carries the one-line pipefail fix"
    else
      log "F-94-1: HEAD's backup.sh no longer carries the \`printf | grep -qE\` schema_migrations check; no patch applied"
    fi
    if [ "$wp" = "HEAD+1" ]; then
      # A release one migration newer than HEAD: the database it leaves behind
      # is what an older binary must refuse (CF-2).
      cat >"$dest/packages/db/migrations/0099_wp94_upgrade_test_future.sql" <<'SQL'
-- WP 9.4 harness only: never committed. Stands for "the next release's migration".
CREATE TABLE wp94_future_probe (id INTEGER PRIMARY KEY);
SQL
    fi
    if [ "$wp" = "HEAD-nocheck" ]; then
      # Sabotage S3: the newer-database check removed from HEAD's migrate.ts.
      node -e '
        const fs = require("node:fs");
        const p = process.argv[1];
        const src = fs.readFileSync(p, "utf8");
        const out = src.replace("  if (unknown.length === 0) return;", "  return; // SABOTAGE-WP94-S3\n  if (unknown.length === 0) return;");
        if (out === src) { console.error("sabotage anchor not found"); process.exit(1); }
        fs.writeFileSync(p, out);
      ' "$dest/packages/db/src/migrate.ts"
    fi
  else
    local s="${WAYPOINT_SHA[$wp]:-}"
    [ -n "$s" ] || die "unknown waypoint $wp"
    git -C "$REPO_ROOT" archive "$s" | tar -x -C "$dest"
  fi
}

# The version tag a waypoint's images carry: pf-upgrade/<svc>:<tag>.
version_tag() {
  case "$1" in
    HEAD) echo "${HEAD_SHA:0:7}-wp94" ;;
    HEAD+1) echo "${HEAD_SHA:0:7}-wp94-plus1" ;;
    HEAD-nocheck) echo "${HEAD_SHA:0:7}-wp94-nocheck" ;;
    HEAD-pristine) echo "${HEAD_SHA:0:7}" ;;
    *) echo "${WAYPOINT_SHA[$1]}" ;;
  esac
}

# "git pull": replace every tracked file, keep what the operator owns
# (secrets/, .env, any compose.override.yml they wrote). Exactly what a pull
# between two commits does to an untouched checkout.
replace_tree() {
  local install="$1" src="$2"
  [ -d "$install" ] || die "replace_tree: $install missing"
  find "$install" -mindepth 1 -maxdepth 1 \
    ! -name secrets ! -name .env ! -name compose.override.yml -exec rm -rf {} +
  (cd "$src" && tar -cf - .) | (cd "$install" && tar -xf -)
}

host_check() {
  log "host: load $(loadavg); $(free -g | awk '/^Mem:/ { print "mem used " $3 "G / avail " $7 "G" }')"
  local others
  others="$(docker ps --format '{{.Names}}' | grep -c '^pf-upgrade-' || true)"
  log "host: ${others} pf-upgrade container(s) running before this step"
}

# Wait until GET <url> answers 200 through the proxy, or give up.
wait_ready_http() {
  local path="$1" limit="${2:-180}" start code
  start="$(date +%s)"
  while :; do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 \
      --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}${path}" || true)"
    [ "$code" = "200" ] && return 0
    [ $(($(date +%s) - start)) -lt "$limit" ] || {
      log "wait_ready_http: ${path} still ${code} after ${limit}s"
      return 1
    }
    sleep 1
  done
}

restart_counts() {
  local project="$1" dir="$2" svc id
  for svc in api worker; do
    id="$(dc "$project" "$dir" ps -q "$svc" 2>/dev/null | head -1)"
    if [ -z "$id" ]; then
      echo "$svc=absent"
    else
      echo "$svc=$(docker inspect -f '{{.RestartCount}}' "$id")"
    fi
  done | paste -sd' '
}

psql_db() {
  local project="$1" dir="$2" sql="$3"
  dc "$project" "$dir" exec -T db psql -U personalfi -d personalfi -X -tA -v ON_ERROR_STOP=1 -c "$sql"
}

# Check (i): schema_migrations == the files on disk, checksum for checksum,
# none extra. Checksum as migrate.ts computes it (CRLF normalised, sha256).
check_migrations() {
  local project="$1" dir="$2" out="$3"
  local db_rows disk_rows
  db_rows="$(psql_db "$project" "$dir" "SELECT version || ' ' || name || ' ' || checksum FROM schema_migrations ORDER BY version")" || return 1
  disk_rows="$(node -e '
    const fs = require("node:fs"); const path = require("node:path"); const crypto = require("node:crypto");
    const dir = process.argv[1];
    for (const f of fs.readdirSync(dir).filter((e) => e.endsWith(".sql")).sort()) {
      const m = /^(\d{4})_([a-z0-9_]+)\.sql$/.exec(f); if (!m) continue;
      const sql = fs.readFileSync(path.join(dir, f), "utf8").replaceAll("\r\n", "\n");
      console.log(`${m[1]} ${m[2]} ${crypto.createHash("sha256").update(sql, "utf8").digest("hex")}`);
    }' "$dir/packages/db/migrations")"
  printf '%s\n' "$db_rows" >"$out.db"
  printf '%s\n' "$disk_rows" >"$out.disk"
  if diff -u "$out.disk" "$out.db" >"$out.diff"; then
    echo "pass $(grep -c . "$out.db") applied == $(grep -c . "$out.disk") on disk, checksums equal, none extra (max $(tail -1 "$out.db" | cut -d' ' -f1))"
    return 0
  fi
  echo "FAIL schema_migrations differs from disk: $(grep -c '^[-+][0-9]' "$out.diff") line(s) — see $out.diff"
  return 1
}
