#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# The unattended-upgrade test (WP 9.4; docs/plan/09-phase-9-dispatch.md §3):
# install v0.1 cold, load it through its own API, then reach HEAD by the
# documented upgrade alone — as a direct jump and as a chain through every
# gate commit — and prove migrations, data, keyring, passkey, TOTP and backups
# across the boundary. README.md in this directory is the operator's page.
#
#   bash scripts/upgrade-test/run.sh --path direct            # W0 -> HEAD
#   bash scripts/upgrade-test/run.sh --path chain             # W0 -> W1 -> ... -> HEAD
#   bash scripts/upgrade-test/run.sh --path s1-no-placeholders # sabotage S1 (expect red)
#   bash scripts/upgrade-test/run.sh --path s2-no-premigrate  # sabotage S2 (expect red)
#   bash scripts/upgrade-test/run.sh --path s3-no-newer-check # sabotage S3 (expect red)
#   ... --run NAME        project pf-upgrade-NAME (default: the path)
#   ... --from STEP       re-run from STEP (state files after it are dropped)
#   ... --keep            leave the stack and $WORK in place at the end
#   ... --ci              direct path only: skip the CF-2 rollback suite (it
#                         builds HEAD+1, a sabotaged HEAD and W5), so a runner
#                         builds exactly two image sets, W0 and HEAD
#   ... --teardown        down -v this run's projects and delete its $WORK, then exit
#
# Resumable: every step writes $RUN_DIR/state/<step>.done; a re-run skips
# completed steps, so a killed run continues from the last completed one.
# Long runs are meant to be detached (setsid nohup … > log) and polled.
#
# Never touches a project that is not pf-upgrade-* (lib.sh's assert_project),
# binds only 127.0.0.1:${PROXY_HTTPS_PORT:-8451}/${PROXY_HTTP_PORT:-8452}, and
# tags images pf-upgrade/<svc>:<sha>. Test-only secrets live under $WORK.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO_ROOT/scripts/upgrade-test"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

PATH_KIND="direct"
RUN=""
FROM=""
KEEP=0
CI_MODE=0
TEARDOWN_ONLY=0
WORK="${WORK:-/tmp/wp94/work}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --path) shift; PATH_KIND="$1" ;;
    --run) shift; RUN="$1" ;;
    --from) shift; FROM="$1" ;;
    --work) shift; WORK="$1" ;;
    --keep) KEEP=1 ;;
    --ci) CI_MODE=1 ;;
    --teardown) TEARDOWN_ONLY=1 ;;
    -h | --help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument $1" ;;
  esac
  shift
done
RUN="${RUN:-$PATH_KIND}"
[[ "$RUN" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "--run must be lowercase alphanumerics and dashes"
PROJECT="pf-upgrade-${RUN}"
assert_project "$PROJECT"

RUN_DIR="$WORK/runs/$RUN"
INSTALL="$RUN_DIR/install"
STATE="$RUN_DIR/state"
AUTH_DIR="$RUN_DIR/auth"
FACTS_FILE="$RUN_DIR/facts.json"
REPORT="$RUN_DIR/report.md"
mkdir -p "$STATE" "$WORK/src"
mkdir -p -m 0700 "$AUTH_DIR"
export REPO_ROOT AUTH_DIR FACTS_FILE PROXY_HTTPS_PORT PROXY_HTTP_PORT
export PUBLIC_HOST_TEST

report() { echo "$*" | tee -a "$REPORT"; }

# The commit this run tests as HEAD: resolved once, kept for resumes.
if [ -s "$RUN_DIR/head.sha" ]; then
  HEAD_SHA="$(cat "$RUN_DIR/head.sha")"
else
  HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  echo "$HEAD_SHA" >"$RUN_DIR/head.sha"
fi
export HEAD_SHA

# ------------------------------------------------------------- teardown

teardown_project() {
  local project="$1" dir="$2"
  assert_project "$project"
  if docker compose ls -a --format json 2>/dev/null | grep -q "\"Name\":\"${project}\""; then
    log "teardown: down -v ${project} (created by this harness)"
    docker compose -p "$project" --project-directory "$dir" down -v --remove-orphans >/dev/null 2>&1 || true
  fi
  docker rm -f "${project}-fwd" >/dev/null 2>&1 || true
}

if [ "$TEARDOWN_ONLY" -eq 1 ]; then
  teardown_project "${PROJECT}" "$INSTALL"
  teardown_project "${PROJECT}-r" "$RUN_DIR/install-r"
  rm -rf "$RUN_DIR"
  log "teardown: removed $RUN_DIR (test-only secrets included)"
  exit 0
fi

# --from: drop this step's and every later step's state.
if [ -n "$FROM" ]; then
  found=0
  for f in $(ls "$STATE" 2>/dev/null | sort); do
    [ "${f%.done}" = "$FROM" ] && found=1
    [ "$found" -eq 1 ] && rm -f "$STATE/$f"
  done
  log "--from ${FROM}: state from that step on cleared"
fi

# step <name> <function> [args]: run once; record completion.
step() {
  local name="$1"
  shift
  if [ -e "$STATE/$name.done" ]; then
    log "step ${name}: already done ($(cat "$STATE/$name.done")) — skipping"
    return 0
  fi
  log "step ${name}: start"
  "$@"
  echo "$(ts) load $(loadavg)" >"$STATE/$name.done"
  log "step ${name}: done"
}

# ---------------------------------------------------------- environment

# The operator's .env: the era's own .env.example, plus this test's bind,
# ports, host, project and image registry. Never edited after install —
# `git pull` does not touch .env, and neither does the upgrade.
write_env() {
  cp "$INSTALL/.env.example" "$INSTALL/.env"
  cat >>"$INSTALL/.env" <<EOF

# --- WP 9.4 upgrade test (pf-upgrade-${RUN}) ---
COMPOSE_PROJECT_NAME=${PROJECT}
REGISTRY=${REGISTRY_TEST}
BIND_ADDRESS=127.0.0.1
PROXY_HTTPS_PORT=${PROXY_HTTPS_PORT}
PROXY_HTTP_PORT=${PROXY_HTTP_PORT}
PUBLIC_HOST=${PUBLIC_HOST_TEST}
EXTRA_ALLOWED_ORIGINS=${ORIGIN}
EOF
}

# Run a recipe or command in the install, as the operator would: in the
# checkout, with the project and image version in the environment.
in_install() {
  local version="$1"
  shift
  (
    cd "$INSTALL"
    export COMPOSE_PROJECT_NAME="$PROJECT" REGISTRY="$REGISTRY_TEST" PERSONALFI_VERSION="$version"
    "$@"
  )
}

driver() {
  local running="$1"
  shift
  RUNNING="$running" DIRECT_PORT="${DIRECT_PORT:-}" timeout 900 node "$HERE/driver.mjs" "$@"
}

record_timing() {
  # record_timing <label> <seconds> <extra>
  report "| timing | $1 | $2 s | load $(loadavg) | $3 |"
}

# ----------------------------------------------------------------- W0

install_w0() {
  host_check
  prepare_tree W0 "$WORK/src/$(version_tag W0)"
  rm -rf "$INSTALL"
  mkdir -p "$INSTALL"
  cp -a "$WORK/src/$(version_tag W0)/." "$INSTALL/"
  write_env
  local v
  v="$(version_tag W0)"
  # W0's RUNBOOK "First install", step 2, as written for that version.
  in_install "$v" just gen-pg-secrets >/dev/null
  in_install "$v" just gen-master-key >/dev/null
  in_install "$v" timeout 1800 just build >"$RUN_DIR/w0-build.log" 2>&1 || die "W0 build failed (see $RUN_DIR/w0-build.log)"
  docker run --rm --entrypoint age-keygen "${REGISTRY_TEST}/backup:${v}" >"$AUTH_DIR/age-identity.txt" 2>/dev/null
  chmod 0600 "$AUTH_DIR/age-identity.txt"
  grep '^# public key:' "$AUTH_DIR/age-identity.txt" | cut -d' ' -f4 >"$INSTALL/secrets/age_recipient"
  chmod 444 "$INSTALL/secrets/age_recipient"
  echo "placeholder" >"$INSTALL/secrets/b2_key_id"
  echo "placeholder" >"$INSTALL/secrets/b2_application_key"
  chmod 444 "$INSTALL/secrets/b2_key_id" "$INSTALL/secrets/b2_application_key"
  report "- W0 secrets per W0's RUNBOOK: $(ls "$INSTALL/secrets" | tr '\n' ' ')(age identity kept in \$WORK only)"
  # Step 4: `just build && just up`.
  local t0 t1
  t0="$(now)"
  in_install "$v" timeout 600 just up >"$RUN_DIR/w0-up.log" 2>&1 || die "W0 up failed (see $RUN_DIR/w0-up.log)"
  wait_ready_http /ready 300 || die "W0 never became ready"
  t1="$(now)"
  record_timing "W0 cold install: just up -> /ready 200" "$(elapsed "$t0" "$t1")" "W0 $(version_tag W0)"
  # Step 7: the account holder. The token is a secret: kept in $AUTH_DIR only.
  in_install "$v" just bootstrap-user name="WP94 Holder" timezone="America/New_York" \
    >"$AUTH_DIR/bootstrap.out" 2>"$RUN_DIR/bootstrap.err" || die "bootstrap-user failed (see $RUN_DIR/bootstrap.err)"
  chmod 0600 "$AUTH_DIR/bootstrap.out"
  sed -n 's/.*register#token=\([A-Za-z0-9_-]*\).*/\1/p' "$AUTH_DIR/bootstrap.out" | head -1 >"$AUTH_DIR/token"
  chmod 0600 "$AUTH_DIR/token"
  [ -s "$AUTH_DIR/token" ] || die "no enrolment token in bootstrap-user's output"
  grep -v -i 'token\|register#' "$AUTH_DIR/bootstrap.out" | sed 's/^/    bootstrap: /' | tee -a "$REPORT" >/dev/null
  driver W0 register "$AUTH_DIR/token" | tee -a "$RUN_DIR/driver.log"
  rm -f "$AUTH_DIR/token"
}

load_w0() {
  driver W0 enrol-factors >>"$RUN_DIR/driver.log"
  report "- W0 loaded through W0's API: passkey (CDP virtual authenticator), TOTP enrolment, 10 recovery codes"
}

# A backup taken at W0 by W0's own documented command (`just backup`).
backup_w0() {
  in_install "$(version_tag W0)" just backup >"$RUN_DIR/w0-backup.log" 2>&1 || die "W0 just backup failed"
  local f
  f="$(sed -n 's#^backup: wrote /backups/\(personalfi-[^ ]*\.dump\.age\).*#\1#p' "$RUN_DIR/w0-backup.log" | tail -1)"
  [ -n "$f" ] || die "W0 backup: no file name in its output"
  echo "$f" >"$RUN_DIR/w0-backup.name"
  report "- W0 backup by W0's \`just backup\`: \`$f\`"
}

# ------------------------------------------------------------- checks

# After every upgrade: (i), (ii)+(iii) via the driver, (v), and the
# pre-migration-backup check. (vi) is recorded by the hop itself.
verify_at() {
  local wp="$1" project="${2:-$PROJECT}" dir="${3:-$INSTALL}" scope="${4:-}"
  local out="$RUN_DIR/check-${wp}-${project}"
  local i_res v_res rc=0
  i_res="$(check_migrations "$project" "$dir" "$out")" || rc=1
  report "| ${wp} | (i) | ${i_res} |"
  if VERIFY_FACTS="$scope" driver "$wp" verify >"$out.verify" 2>&1; then :; else rc=1; fi
  while IFS= read -r line; do report "| ${wp} | ${line%%:*} | ${line#*: } |"; done <"$out.verify"
  sleep "${SETTLE_SECONDS:-20}"
  v_res="$(restart_counts "$project" "$dir")"
  if [[ "$v_res" == "api=0 worker=0" ]]; then
    report "| ${wp} | (v) RestartCount | ${v_res} |"
  elif [[ "$wp" == W[0-5] ]]; then
    # An era's own defect, not the upgrade's, fixed in a later era and absent
    # at HEAD: W0's worker exits while idle before an account holder exists
    # (G3-1, fixed by the Phase 3 gate's C-1); W0's and W1's worker has
    # `memory: 512M` against a 1 GiB Argon2id KEK, so once a holder exists it
    # is OOM-killed at every boot (W2's compose raised it to 1536M).
    report "| ${wp} | (v) RestartCount | ${v_res} — historical, that era's own worker (W0: G3-1, no holder yet; W0/W1 with a holder: 512 MiB limit < 1 GiB KEK, cgroup OOM — see the evidence's §5); not counted |"
  else
    report "| ${wp} | (v) RestartCount | **${v_res}** |"
    rc=1
  fi
  return "$rc"
}

# The CF-3 check: some backup on the volume is older than the first migration
# this hop applied, and its marker names what was pending.
check_premigrate_backup() {
  local wp="$1" before_max="$2"
  local first_new
  first_new="$(psql_db "$PROJECT" "$INSTALL" \
    "SELECT to_char(min(applied_at) AT TIME ZONE 'UTC', 'YYYYMMDD\"T\"HH24MISS\"Z\"') FROM schema_migrations WHERE version > '${before_max}'")"
  if [ -z "$first_new" ]; then
    report "| ${wp} | pre-migration backup | n/a (no migration applied by this hop) |"
    return 0
  fi
  local listing older
  listing="$(docker run --rm -v "${PROJECT}_backups:/b:ro" alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b \
    sh -c 'ls -1 /b')"
  older="$(printf '%s\n' "$listing" | sed -n 's/^personalfi-\([0-9T]*Z\)\.dump\.age$/\1/p' | awk -v f="$first_new" '$1 < f' | sort | tail -1)"
  if [ -z "$older" ]; then
    report "| ${wp} | pre-migration backup | **FAIL: no backup older than the first new migration (applied ${first_new})** |"
    return 1
  fi
  local marker
  marker="$(printf '%s\n' "$listing" | grep -x "personalfi-${older}.pre-migrate" || true)"
  report "| ${wp} | pre-migration backup | pass: personalfi-${older}.dump.age precedes the first new migration (${first_new})${marker:+; marker present}$([ -z "$marker" ] && echo '; no marker (not taken by pre-migrate-backup)') |"
  echo "personalfi-${older}.dump.age" >"$RUN_DIR/premigrate-${wp}.name"
}

max_applied() { psql_db "$PROJECT" "$INSTALL" "SELECT coalesce(max(version), '0000') FROM schema_migrations"; }

# ---------------------------------------------------------------- hops

# A hop to an era waypoint (W1..W5): that era's documented upgrade, verbatim
# (RUNBOOK "Upgrade" is identical from W0 to W5): git pull; just build;
# just backup; docker compose up -d --wait. A failure is recorded with its
# exact error; the only remediation applied is HEAD's own fix for it, and it
# is counted as an extra step.
# Compose's words for a declared secret file that is not on disk: a warning
# per secret at create time, then the daemon's refusal of the bind mount.
SECRET_MISSING_RE='secret file [^ ]+ does not exist|bind source path does not exist: [^ ]*/secrets/|secret.*(not found|no such file)'

# extra_step <hop> <finding> <exact error> <what was done>: an era hop that
# needed more than its documented upgrade. A finding, never silent.
extra_step() {
  printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" >>"$RUN_DIR/extra-steps.tsv"
  report "  - **extra step at the ${1} hop (${2})**: ${4}"
}

# Before a hop replaces them: the outgoing era's worker log and every
# consumer's offset, kept under $RUN_DIR (the containers are recreated by the
# hop, and with them the only copy of that era's log).
save_era_state() {
  local to="$1"
  dc "$PROJECT" "$INSTALL" logs --no-log-prefix worker >"$RUN_DIR/before-${to}-worker.log" 2>&1 || true
  psql_db "$PROJECT" "$INSTALL" "SELECT consumer_name || ' ' || status || ' last_seq=' || last_seq || coalesce(' failed_seq=' || failed_seq, '') FROM event_consumer_offsets ORDER BY 1" \
    >"$RUN_DIR/before-${to}-consumers.txt" 2>&1 || true
  psql_db "$PROJECT" "$INSTALL" "SELECT 'max_seq=' || coalesce(max(seq)::text, 'none') FROM domain_events" >>"$RUN_DIR/before-${to}-consumers.txt" 2>&1 || true
  report "- state before the ${to} hop: consumers \`$(tr '\n' ';' <"$RUN_DIR/before-${to}-consumers.txt" | cut -c1-400)\` (worker log kept: before-${to}-worker.log)"
}

hop_era() {
  local wp="$1" v before t0 t1 extra=0
  v="$(version_tag "$wp")"
  save_era_state "$wp"
  host_check
  before="$(max_applied)"
  prepare_tree "$wp" "$WORK/src/$v"
  replace_tree "$INSTALL" "$WORK/src/$v"
  in_install "$v" timeout 1800 just build >"$RUN_DIR/hop-$wp-build.log" 2>&1 || die "$wp: just build failed"
  in_install "$v" just backup >"$RUN_DIR/hop-$wp-backup.log" 2>&1 || report "- ${wp}: \`just backup\` (on the old stack) failed: $(tail -1 "$RUN_DIR/hop-$wp-backup.log")"
  t0="$(now)"
  if ! in_install "$v" docker compose up -d --wait --wait-timeout 900 >"$RUN_DIR/hop-$wp-up.log" 2>&1; then
    local err missing
    err="$(grep -m1 -E 'Error response from daemon|^Error|error' "$RUN_DIR/hop-$wp-up.log" || true)"
    missing="$(grep -oE 'secret file [^ ]+ does not exist' "$RUN_DIR/hop-$wp-up.log" | awk '{print $3}' | sed "s/^${PROJECT}_//" | sort -u | paste -sd' ' || true)"
    report "- **${wp} hop: the era's documented upgrade FAILED** (\`docker compose up -d --wait\`): \`${err}\`${missing:+ — Compose warned \`secret file ${PROJECT}_<name> does not exist\` for: ${missing}}"
    if grep -q 'container .*-backup-1 is unhealthy' "$RUN_DIR/hop-$wp-up.log" &&
      ! grep -v 'backup-1 is unhealthy' "$RUN_DIR/hop-$wp-up.log" | grep -qiE 'is unhealthy|exited \(|dependency failed|secret'; then
      report "  - historical: only \`backup\` reported unhealthy (that era's backup.sh carries F-94-1's pipefail race); every other service up — no extra step taken"
    elif grep -qE "$SECRET_MISSING_RE" "$RUN_DIR/hop-$wp-up.log"; then
      # F-94-2: CF-4 at an era boundary. The era declared file secrets the
      # install never had, and its documented upgrade had no step to create
      # them. The minimal remediation is HEAD's own CF-4 fix, run against the
      # era's compose project; counted, logged, never silent.
      extra_step "$wp" "F-94-2" "${err}" "HEAD's \`scripts/secrets-placeholders.sh --project-dir <install>\` (CF-4's fix, against ${wp}'s compose.yml), then \`docker compose up -d --wait\` again"
      bash "$REPO_ROOT/scripts/secrets-placeholders.sh" --project-dir "$INSTALL" 2>&1 | sed 's/^/    /' | tee -a "$REPORT"
      extra=1
      t0="$(now)"
      in_install "$v" docker compose up -d --wait --wait-timeout 900 >>"$RUN_DIR/hop-$wp-up.log" 2>&1 || die "$wp: up failed even after placeholders (see $RUN_DIR/hop-$wp-up.log)"
    else
      die "$wp: up failed (see $RUN_DIR/hop-$wp-up.log)"
    fi
  fi
  wait_ready_http "$( [ "$wp" = W1 ] && echo /ready || echo /api/ready )" 300 || die "$wp never became ready"
  t1="$(now)"
  record_timing "${wp}: up -d --wait -> /ready 200" "$(elapsed "$t0" "$t1")" "extra steps: ${extra}; migrations ${before} -> $(max_applied)"
  check_premigrate_backup "$wp" "$before" || true
}

# The hop to HEAD: replace the tree, `just upgrade`, nothing else.
hop_head() {
  local wp="${1:-HEAD}" v before t0 t1
  local logf="$RUN_DIR/hop-${wp}${SABOTAGE:+-$SABOTAGE}-upgrade.log"
  v="$(version_tag "$wp")"
  save_era_state "$wp"
  host_check
  before="$(max_applied)"
  prepare_tree "$wp" "$WORK/src/$v" | tee -a "$REPORT"
  if [ -n "${SABOTAGE:-}" ]; then apply_sabotage "$SABOTAGE" "$WORK/src/$v"; fi
  replace_tree "$INSTALL" "$WORK/src/$v"
  t0="$(now)"
  # (vi) measured directly, beside `up --wait`'s figure: from the recipe's
  # `up -d --wait` line, until the OLD api container is gone and the proxy's
  # /api/ready answers 200 from the new one. `up --wait` itself waits for the
  # api healthcheck, whose 30 s interval floors that figure.
  local old_api poll_out="$RUN_DIR/ready-poll-${wp}${SABOTAGE:+-$SABOTAGE}"
  old_api="$(dc "$PROJECT" "$INSTALL" ps -q api 2>/dev/null | head -1)"
  rm -f "$poll_out"
  (
    for _ in $(seq 1 3000); do grep -q '^upgrade: up -d --wait' "$logf" 2>/dev/null && break; sleep 0.2; done
    s="$(now)"
    # Ready means: a NEW api container (not the one the hop started with)
    # answers /api/ready through the proxy, 200, with the readiness JSON and
    # `"migrations":"current"`. A bare 200 is not enough: an older era's
    # Caddy answers unknown paths with the SPA's index.html, 200. ("degraded"
    # is still ready to serve; the hop's own log says why.) Bounded by time.
    local deadline=$(($(date +%s) + 600))
    while [ "$(date +%s)" -lt "$deadline" ]; do
      cur="$(dc "$PROJECT" "$INSTALL" ps -q api 2>/dev/null | head -1)"
      if [ -n "$cur" ] && [ "$cur" != "$old_api" ]; then
        b="$(curl -sk --max-time 2 -w '\n%{http_code}' --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready" || true)"
        case "$b" in *'"migrations":"current"'*$'\n'200) echo "$(elapsed "$s" "$(now)") $(loadavg)" >"$poll_out"; exit 0 ;; esac
      fi
      sleep 0.2
    done
  ) &
  local poller=$!
  if ! in_install "$v" timeout 2400 just upgrade >"$logf" 2>&1; then
    kill "$poller" 2>/dev/null || true
    report "- **${wp}: \`just upgrade\` FAILED** (${logf##*/}): \`$(grep -E '^upgrade: FAILED|^secrets-placeholders: REFUSED|^pre-migrate: FAILED|database_newer|secret .* file|^Error|^error' "$logf" | head -4 | tr '\n' ' ')\`"
    return 1
  fi
  t1="$(now)"
  local utr
  utr="$(sed -n 's/^upgrade: up-to-ready \([0-9]*\) s.*/\1/p' "$logf" | tail -1)"
  record_timing "${wp}: \`just upgrade\` total (build included)" "$(elapsed "$t0" "$t1")" "migrations ${before} -> $(max_applied)"
  record_timing "${wp}: up-to-ready inside \`just upgrade\` (up --wait; floored by the api healthcheck's 30 s interval)" "${utr:-?}" "09 §5.3 budget < 20 s"
  wait "$poller" 2>/dev/null || true
  if [ -s "$poll_out" ]; then
    record_timing "${wp}: up -> a new api's /api/ready {status: ready}, polled every 0.2 s (pre-migration backup + migrations + boot)" "$(cut -d' ' -f1 "$poll_out")" "load at ready $(cut -d' ' -f2- "$poll_out")"
  fi
  # (vi) broken down: when each one-shot ran and when the new api started,
  # from the containers' own clocks (seconds after the first of them started).
  local pm mg ap
  pm="$(dc "$PROJECT" "$INSTALL" ps -a -q pre-migrate-backup 2>/dev/null | head -1)"
  mg="$(dc "$PROJECT" "$INSTALL" ps -a -q migrator 2>/dev/null | head -1)"
  ap="$(dc "$PROJECT" "$INSTALL" ps -q api 2>/dev/null | head -1)"
  if [ -n "$pm" ] && [ -n "$mg" ] && [ -n "$ap" ]; then
    report "| timing | ${wp}: stages (s after pre-migrate-backup started) | $(node -e '
      const [pmS, pmF, mgS, mgF, apS] = process.argv.slice(1).map((t) => Date.parse(t));
      const r = (t) => ((t - pmS) / 1000).toFixed(1);
      console.log(`pre-migrate-backup ${r(pmF)} → migrator ${r(mgS)}–${r(mgF)} → api started ${r(apS)}`);
    ' "$(docker inspect -f '{{.State.StartedAt}}' "$pm")" "$(docker inspect -f '{{.State.FinishedAt}}' "$pm")" \
      "$(docker inspect -f '{{.State.StartedAt}}' "$mg")" "$(docker inspect -f '{{.State.FinishedAt}}' "$mg")" \
      "$(docker inspect -f '{{.State.StartedAt}}' "$ap")") | the api's own boot (KEK derivation) follows |"
  fi
  grep -E '^upgrade: (pre-migrate|/ready|api |worker |WARNING)|^secrets-placeholders' "$logf" | sed 's/^/    /' | tee -a "$REPORT" >/dev/null
  if grep -q '^upgrade: WARNING' "$logf"; then
    report "| ${wp} | readiness | **$(grep -m1 '^upgrade: WARNING' "$logf" | sed 's/^upgrade: //')** |"
  fi
  check_premigrate_backup "$wp" "$before"
}

apply_sabotage() {
  local what="$1" tree="$2"
  case "$what" in
    s1-no-placeholders)
      # S1: `just upgrade` without its placeholder step.
      # The recipe lives in upgrade.just, which the justfile imports (or, in
      # a tree from before that wiring, in the justfile itself).
      local f
      for f in "$tree/scripts/upgrade-test/upgrade.just" "$tree/justfile"; do
        sed -i 's|^    bash scripts/secrets-placeholders.sh$|    true # SABOTAGE-WP94-S1|' "$f"
      done
      cat "$tree/justfile" "$tree/scripts/upgrade-test/upgrade.just" | grep -q 'SABOTAGE-WP94-S1' || die "S1 anchor not found"
      ;;
    s2-no-premigrate)
      # S2: the pre-migration backup disabled (the one-shot does nothing).
      sed -i "s|^    command: \['/usr/local/bin/pre-migrate.sh'\]|    command: ['true'] # SABOTAGE-WP94-S2|" "$tree/compose.yml"
      grep -q 'SABOTAGE-WP94-S2' "$tree/compose.yml" || die "S2 anchor not found"
      ;;
    *) die "unknown sabotage $what" ;;
  esac
  report "- **SABOTAGE ${what} applied to the test tree only** ($(date -u +%H:%MZ))"
}

# ------------------------------------------------- (iv) the restore checks

# A restore check that fails is a finding, not the end of the run: say why,
# remove the fresh project, bring the main stack back, and let the caller flag.
restore_abort() {
  local label="$1" why="$2" rp="${PROJECT}-r" rdir="$RUN_DIR/install-r"
  report "| iv-${label} | restore | **FAIL: ${why}**: \`$(grep -m2 -E '^pg_restore: error|ERROR:|^restore: (FAIL|refus)' "$RUN_DIR/restore-$label.log" | tr '\n' ' ' | cut -c1-400)\` |"
  teardown_project "$rp" "$rdir"
  rm -rf "$rdir"
  dc "$PROJECT" "$INSTALL" start >/dev/null 2>&1 || true
  in_install "$(version_tag HEAD)" docker compose up -d --wait --wait-timeout 600 >/dev/null 2>&1 || true
  wait_ready_http /api/ready 300 || die "main stack did not come back after the failed restore check"
  return 1
}

# restore_into_fresh <label> <backup file on ${PROJECT}_backups> <facts scope>
# RUNBOOK "Restore", into a fresh project pf-upgrade-<run>-r on HEAD, then
# `docker compose up -d --wait` (HEAD's pre-migrate + migrator), then checks
# (i)–(iii) against it. The main stack is stopped meanwhile (one stack at a time).
restore_into_fresh() {
  local label="$1" file="$2" scope="$3"
  local rp="${PROJECT}-r" rdir="$RUN_DIR/install-r" v
  v="$(version_tag HEAD)"
  teardown_project "$rp" "$rdir"
  rm -rf "$rdir"
  cp -a "$INSTALL" "$rdir"
  sed -i "s/^COMPOSE_PROJECT_NAME=.*/COMPOSE_PROJECT_NAME=${rp}/" "$rdir/.env"
  dc "$PROJECT" "$INSTALL" stop >/dev/null 2>&1
  host_check
  (cd "$rdir" && COMPOSE_PROJECT_NAME="$rp" REGISTRY="$REGISTRY_TEST" PERSONALFI_VERSION="$v" \
    docker compose -p "$rp" create >/dev/null 2>&1)
  (cd "$rdir" && COMPOSE_PROJECT_NAME="$rp" REGISTRY="$REGISTRY_TEST" PERSONALFI_VERSION="$v" \
    docker compose -p "$rp" up -d --wait db >/dev/null 2>&1) || die "restore $label: fresh db did not start"
  docker run --rm -v "${PROJECT}_backups:/from:ro" -v "${rp}_backups:/to" \
    alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b \
    sh -c "cp -p /from/$file /to/ && chown 10002:10002 /to/$file"
  # RUNBOOK "Restore": the identity, world-readable only for the run, from outside the project.
  local idd
  idd="$(mktemp -d "$RUN_DIR/age-XXXX")"
  cp "$AUTH_DIR/age-identity.txt" "$idd/id" && chmod 0755 "$idd" && chmod 0644 "$idd/id"
  local t0 t1
  t0="$(now)"
  if ! (cd "$rdir" && COMPOSE_PROJECT_NAME="$rp" REGISTRY="$REGISTRY_TEST" PERSONALFI_VERSION="$v" \
    docker compose -p "$rp" run --rm --no-deps \
    -v "$idd/id:/run/age_identity:ro" -e AGE_IDENTITY_FILE=/run/age_identity -e FORCE_RESTORE=1 \
    backup /usr/local/bin/restore.sh "/backups/$file") >"$RUN_DIR/restore-$label.log" 2>&1; then
    rm -rf "$idd"
    restore_abort "$label" "restore.sh failed (see restore-$label.log)"
    return 1
  fi
  rm -rf "$idd"
  (cd "$rdir" && COMPOSE_PROJECT_NAME="$rp" REGISTRY="$REGISTRY_TEST" PERSONALFI_VERSION="$v" \
    docker compose -p "$rp" up -d --wait --wait-timeout 900) >>"$RUN_DIR/restore-$label.log" 2>&1 ||
    { restore_abort "$label" "up after restore failed (see restore-$label.log)"; return 1; }
  wait_ready_http /api/ready 300 || { restore_abort "$label" "never ready after restore"; return 1; }
  t1="$(now)"
  record_timing "(iv) ${label}: restore.sh + up -d --wait -> /ready" "$(elapsed "$t0" "$t1")" "backup ${file}"
  local rc=0
  verify_at "iv-${label}" "$rp" "$rdir" "$scope" || rc=1
  # The restore drill's own assertions, against the project it restored.
  local rt lt
  rt="$(dc "$rp" "$rdir" exec -T db psql -U personalfi -d personalfi -tAc "select count(*) from information_schema.tables where table_schema='public'")"
  report "| iv-${label} | drill: tables | restored+migrated ${rt} |"
  echo "$rt" >"$RUN_DIR/restore-$label.tables"
  teardown_project "$rp" "$rdir"
  rm -rf "$rdir"
  dc "$PROJECT" "$INSTALL" start >/dev/null 2>&1
  in_install "$(version_tag HEAD)" docker compose up -d --wait --wait-timeout 600 >/dev/null 2>&1 || true
  wait_ready_http /api/ready 300 || die "main stack did not come back after the restore check"
  lt="$(psql_db "$PROJECT" "$INSTALL" "select count(*) from information_schema.tables where table_schema='public'")"
  report "| iv-${label} | drill: tables live vs restored | live ${lt}, restored ${rt} — $([ "$lt" = "$rt" ] && echo equal || echo '**DIFFER**') |"
  [ "$lt" = "$rt" ] || rc=1
  return "$rc"
}

head_backup_drill() {
  local f
  dc "$PROJECT" "$INSTALL" exec -T backup /usr/local/bin/backup.sh >"$RUN_DIR/head-backup.log" 2>&1 || die "HEAD backup failed"
  f="$(sed -n 's#^backup: wrote /backups/\(personalfi-[^ ]*\.dump\.age\).*#\1#p' "$RUN_DIR/head-backup.log" | tail -1)"
  report "- HEAD backup (\`just backup\`'s command): \`$f\`"
  restore_into_fresh "head-drill" "$f" "" || flag "(iv) the HEAD backup restore drill"
}

# ------------------------------------------------------- CF-2 at the stack

rollback_suite() {
  local plus1 headv w5
  plus1="$(version_tag HEAD+1)"
  headv="$(version_tag HEAD)"
  w5="$(version_tag W5)"
  report ""
  report "#### CF-2 at the stack: HEAD+1 -> rollback"
  hop_head HEAD+1 || die "HEAD+1 upgrade failed"
  report "| HEAD+1 | applied | $(psql_db "$PROJECT" "$INSTALL" "select string_agg(version, ',' order by version) from schema_migrations where version > '0034'") |"
  local premig
  premig="$(cat "$RUN_DIR/premigrate-HEAD+1.name" 2>/dev/null || true)"

  # (a) The old RUNBOOK advice, literally: pin PERSONALFI_VERSION to the prior image.
  local out="$RUN_DIR/rollback-pin.log"
  if in_install "$headv" docker compose up -d --wait --wait-timeout 300 >"$out" 2>&1; then
    report "| rollback (a) pin prior image | **up succeeded — an older binary came up on a newer schema** |"
  else
    report "| rollback (a) pin prior image | refused: up failed; migrator: \`$(dc "$PROJECT" "$INSTALL" logs --no-log-prefix migrator 2>&1 | grep -o 'migration.database_newer[^.]*' | head -1)\` |"
  fi
  report "| rollback (a) | after the refusal: api $(dc "$PROJECT" "$INSTALL" ps -a --format '{{.Image}} {{.State}}' api 2>/dev/null | head -1 || echo absent); /api/ready $(curl -sk -o /dev/null -w '%{http_code}' --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready") (compose had already replaced the old containers: a refused rollback leaves the app down, never serving the wrong schema) |"

  # (b) The api alone, skipping the migrator: /ready must not be 200.
  in_install "$headv" docker compose up -d --no-deps --force-recreate api >"$RUN_DIR/rollback-api.log" 2>&1 || true
  sleep 25
  local code logline
  code="$(dc "$PROJECT" "$INSTALL" exec -T api node -e "fetch('http://127.0.0.1:8080/ready').then(r=>{console.log(r.status)}).catch(e=>console.log('ERR '+e.message))" 2>/dev/null || echo exec-failed)"
  logline="$(dc "$PROJECT" "$INSTALL" logs --no-log-prefix api 2>&1 | grep -o 'migration.database_newer[^"]*' | head -1)"
  report "| rollback (b) HEAD api alone on HEAD+1's schema | /ready ${code}; log names: \`${logline:-<not found>}\` |"

  # (c) Sabotage S3: the check removed -> the same rollback serves.
  report "- **SABOTAGE s3-no-newer-check**: HEAD's migrate.ts with refuseDatabaseNewer short-circuited, built as pf-upgrade/*:$(version_tag HEAD-nocheck) ($(date -u +%H:%MZ))"
  prepare_tree HEAD-nocheck "$WORK/src/$(version_tag HEAD-nocheck)" >/dev/null
  (cd "$WORK/src/$(version_tag HEAD-nocheck)" && REGISTRY="$REGISTRY_TEST" PERSONALFI_VERSION="$(version_tag HEAD-nocheck)" \
    timeout 1200 docker compose -p "$PROJECT" build) >"$RUN_DIR/build-nocheck.log" 2>&1 || die "nocheck build failed"
  if in_install "$(version_tag HEAD-nocheck)" docker compose up -d --wait --wait-timeout 300 >"$RUN_DIR/rollback-nocheck.log" 2>&1; then
    report "| S3 (check removed) pinned rollback | **up succeeded; /api/ready $(curl -sk -o /dev/null -w '%{http_code}' --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready") — the older binary serves HEAD+1's schema (RED, as expected)** |"
  else
    report "| S3 (check removed) pinned rollback | up failed — sabotage NOT observed red |"
  fi

  # (d) W5's own image and tree (no check at all): the CF-2 finding as shipped.
  prepare_tree W5 "$WORK/src/$w5" >/dev/null
  replace_tree "$INSTALL" "$WORK/src/$w5"
  if in_install "$w5" docker compose up -d --wait --wait-timeout 300 >"$RUN_DIR/rollback-w5.log" 2>&1; then
    report "| CF-2 as shipped: W5's tree and image on HEAD+1's schema | **up succeeded; /api/ready $(curl -sk -o /dev/null -w '%{http_code}' --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready") — W5 serves a schema it does not know (CF-2 red)** |"
  else
    report "| CF-2 as shipped: W5 on HEAD+1's schema | up --wait failed ($(grep -o 'container [^ ]* is unhealthy' "$RUN_DIR/rollback-w5.log" | head -1)); migrator: \`$(dc "$PROJECT" "$INSTALL" logs --no-log-prefix migrator 2>&1 | tail -1)\`; api $(dc "$PROJECT" "$INSTALL" ps -a --format '{{.Image}} {{.State}}' api | head -1); /api/ready **$(curl -sk -o /dev/null -w '%{http_code}' --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready")** |"
  fi

  # (e) The new RUNBOOK rollback: restore the pre-migration backup, then `just upgrade` at HEAD.
  report "#### The documented rollback: restore the pre-migration backup (\`${premig}\`)"
  prepare_tree HEAD "$WORK/src/$headv" >/dev/null
  replace_tree "$INSTALL" "$WORK/src/$headv"
  dc "$PROJECT" "$INSTALL" stop api worker proxy backup >/dev/null 2>&1 || true
  local idd
  idd="$(mktemp -d "$RUN_DIR/age-XXXX")"
  cp "$AUTH_DIR/age-identity.txt" "$idd/id" && chmod 0755 "$idd" && chmod 0644 "$idd/id"
  in_install "$headv" docker compose run --rm --no-deps \
    -v "$idd/id:/run/age_identity:ro" -e AGE_IDENTITY_FILE=/run/age_identity -e FORCE_RESTORE=1 \
    backup /usr/local/bin/restore.sh "/backups/${premig}" >"$RUN_DIR/rollback-restore.log" 2>&1 ||
    { rm -rf "$idd"; die "rollback restore failed (see $RUN_DIR/rollback-restore.log)"; }
  rm -rf "$idd"
  local t0 t1
  t0="$(now)"
  in_install "$headv" timeout 2400 just upgrade >"$RUN_DIR/rollback-upgrade.log" 2>&1 || die "just upgrade after the rollback restore failed"
  t1="$(now)"
  record_timing "rollback: restore pre-migration backup, then just upgrade" "$(elapsed "$t0" "$t1")" "from ${premig}"
  report "| rollback (e) | schema after: $(psql_db "$PROJECT" "$INSTALL" "select count(*) || ' applied, max ' || max(version) || ', 0099 present: ' || bool_or(version='0099') from schema_migrations") |"
  verify_at "HEAD-after-rollback" || true
}

# ------------------------------------------- S3 through the harness, alone

# Sabotage S3 as its own path. The spec's words are "the newer-DB check
# removed -> W5's image serves HEAD's schema". W5's image predates CF-2 and has
# no check to remove, so the claim the sabotage tests is the general one: the
# previous release's binary, on the schema the next release left behind. With
# CF-2 landed, HEAD plays "the previous release" and HEAD+1 "the next":
#   control  HEAD's image pinned on HEAD+1's schema       -> refused (green)
#   S3       the same with refuseDatabaseNewer removed    -> serves  (red)
#   literal  W5's tree and image on HEAD+1's schema       -> serves  (CF-2 as found)
s3_suite() {
  local headv nocheck w5 code
  headv="$(version_tag HEAD)"
  nocheck="$(version_tag HEAD-nocheck)"
  w5="$(version_tag W5)"
  report "| S3 | schema before: $(psql_db "$PROJECT" "$INSTALL" "select count(*) || ' applied, 0099 present: ' || bool_or(version='0099') from schema_migrations") |"

  if in_install "$headv" docker compose up -d --wait --wait-timeout 300 >"$RUN_DIR/s3-control.log" 2>&1; then
    flag "S3 control: HEAD's image (check present) came up on HEAD+1's schema"
  else
    report "| S3 control: HEAD's image (check present) pinned on HEAD+1's schema | refused; migrator: \`$(dc "$PROJECT" "$INSTALL" logs --no-log-prefix migrator 2>&1 | grep -o 'migration.database_newer[^—]*' | head -1)\`; /api/ready $(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready") |"
  fi

  report "- **SABOTAGE s3-no-newer-check applied** ($(date -u +%H:%MZ)): the test tree's \`packages/db/src/migrate.ts\` gets \`return; // SABOTAGE-WP94-S3\` before \`if (unknown.length === 0) return;\` in \`refuseDatabaseNewer\`; built as pf-upgrade/*:${nocheck}"
  prepare_tree HEAD-nocheck "$WORK/src/$nocheck" >/dev/null
  report "| S3 | \`grep -c SABOTAGE-WP94-S3\`: test tree $(grep -c 'SABOTAGE-WP94-S3' "$WORK/src/$nocheck/packages/db/src/migrate.ts"), the real tree $(grep -c 'SABOTAGE-WP94-S3' "$REPO_ROOT/packages/db/src/migrate.ts" || true) |"
  (cd "$WORK/src/$nocheck" && REGISTRY="$REGISTRY_TEST" PERSONALFI_VERSION="$nocheck" \
    timeout 1200 docker compose -p "$PROJECT" build) >"$RUN_DIR/build-nocheck.log" 2>&1 || die "nocheck build failed (see $RUN_DIR/build-nocheck.log)"
  if in_install "$nocheck" docker compose up -d --wait --wait-timeout 300 >"$RUN_DIR/s3-nocheck.log" 2>&1; then
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready")"
    report "| S3 sabotaged: the check removed, pinned on HEAD+1's schema | **up succeeded; /api/ready ${code} — the previous release's binary serves the next release's schema (RED, as the exit test expects)** |"
    [ "$code" = "200" ] || flag "S3: up succeeded but /api/ready ${code}"
  else
    flag "S3: with the check removed the pinned rollback still failed — sabotage NOT observed red"
  fi

  prepare_tree W5 "$WORK/src/$w5" >/dev/null
  replace_tree "$INSTALL" "$WORK/src/$w5"
  if in_install "$w5" docker compose up -d --wait --wait-timeout 300 >"$RUN_DIR/s3-w5.log" 2>&1; then
    report "| S3 literal: W5's tree and image on HEAD+1's schema | up succeeded; /api/ready $(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready") — W5 has no check (CF-2 as found); the protection starts with the release that carries CF-2 |"
  else
    report "| S3 literal: W5's tree and image on HEAD+1's schema | up --wait failed ($(grep -o 'container [^ ]* is unhealthy' "$RUN_DIR/s3-w5.log" | head -1)); /api/ready $(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/api/ready") |"
  fi
}

# The chain's ledger of extra steps: every era hop that needed more than its
# documented upgrade, and the HEAD hop, which never gets one.
summarize_extra_steps() {
  report ""
  report "#### Extra steps by hop (any is a finding; the HEAD hop runs \`just upgrade\` alone and is never remediated)"
  report "| hop | finding | exact error | extra step |"
  report "| --- | --- | --- | --- |"
  local n=0
  if [ -s "$RUN_DIR/extra-steps.tsv" ]; then
    while IFS=$'\t' read -r hop finding err what; do
      report "| ${hop} | ${finding} | \`${err}\` | ${what} |"
      n=$((n + 1))
    done <"$RUN_DIR/extra-steps.tsv"
  fi
  report "| HEAD | — | — | none: \`just upgrade\` alone (step 21) |"
  report "- era hops with an extra step: ${n}; HEAD hop: 0"
}

# --------------------------------------------------------- W4: CF-5 probe

probe_returns_cache() {
  local where="$1"
  local own
  own="$(docker run --rm -v "${PROJECT}_returns_cache:/v:ro" alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b stat -c '%u:%g %a' /v 2>&1 || echo 'no volume')"
  local write
  write="$(dc "$PROJECT" "$INSTALL" run --rm --no-deps -T --entrypoint node worker -e \
    "try{require('node:fs').writeFileSync('/var/lib/personalfi/returns/.wp94-probe','x');require('node:fs').unlinkSync('/var/lib/personalfi/returns/.wp94-probe');console.log('writable by 10001')}catch(e){console.log(e.code+' '+e.message)}" 2>&1 | tail -1)"
  report "| CF-5 ${where} | returns_cache root ${own}; worker (10001) write: ${write} |"
}

# ------------------------------------------------------ the other steps

FAILURES="$RUN_DIR/failures"
flag() {
  echo "$(ts) $*" >>"$FAILURES"
  report "- **FAILED: $***"
}
verify_or_flag() { verify_at "$@" || flag "checks at $1"; }

# S1 (also CF-4's red): `just upgrade` without the placeholder step.
sabotage_s1() {
  if SABOTAGE=s1-no-placeholders hop_head HEAD; then
    flag "S1: just upgrade succeeded with the placeholder step removed — sabotage NOT observed red"
    return 0
  fi
  local err code
  err="$(grep -m1 -E 'Error response from daemon|bind source path does not exist|secret.*(not found|no such file)' "$RUN_DIR/hop-HEAD-s1-no-placeholders-upgrade.log" || true)"
  local missing
  missing="$(grep -oE 'secret file [^ ]+ does not exist' "$RUN_DIR/hop-HEAD-s1-no-placeholders-upgrade.log" | awk '{print $3}' | sed "s/^${PROJECT}_//" | sort -u | paste -sd' ' || true)"
  report "| S1 | Compose: \`secret file ${PROJECT}_<name> does not exist\` for: ${missing:-<none>} |"
  report "| S1 | red as expected: \`${err:-<no secret error line; see hop-HEAD-upgrade.log>}\` |"
  code="$(curl -sk -o /dev/null -w '%{http_code}' --resolve "${PUBLIC_HOST_TEST}:${PROXY_HTTPS_PORT}:127.0.0.1" "${ORIGIN}/ready")"
  report "| S1 | after the failed upgrade the old W0 stack still answers /ready ${code}; restarts $(restart_counts "$PROJECT" "$INSTALL") |"
  grep -qE "$SECRET_MISSING_RE" "$RUN_DIR/hop-HEAD-s1-no-placeholders-upgrade.log" ||
    flag "S1 failed, but not on a missing secret file"
  # The sabotaged tree is replaced by the next hop's prepare/replace.
}

hop_head_s2() {
  if SABOTAGE=s2-no-premigrate hop_head HEAD; then
    flag "S2: a pre-migration backup was found with pre-migrate disabled — sabotage NOT observed red"
  else
    report "| S2 | red as expected: no backup older than the first new migration |"
  fi
}

# W1's Caddy proxies /auth, /health and /ready only (its F-4, fixed at W2), so
# W1's own data API is reached through a loopback forwarder to api:8080 on
# the project's backend network. Instrument only: not part of any upgrade.
start_forwarder() {
  docker rm -f "${PROJECT}-fwd" >/dev/null 2>&1 || true
  docker run -d --name "${PROJECT}-fwd" --network "${PROJECT}_backend" \
    -p 127.0.0.1:8453:8453 --user 10001:10001 --read-only --cap-drop ALL \
    --security-opt no-new-privileges --memory 128m --entrypoint node \
    "${REGISTRY_TEST}/api:$(version_tag W1)" -e \
    "const net=require('node:net');net.createServer((c)=>{const u=net.connect(8080,'api');c.pipe(u);u.pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy());}).listen(8453,'0.0.0.0')" >/dev/null
  sleep 2
}
stop_forwarder() { docker rm -f "${PROJECT}-fwd" >/dev/null 2>&1 || true; }

# The two schedule shortenings — the only SQL this harness writes, both to
# `schedules.next_run_at`, never to data: the cron literals have no config key
# (the Phase 5 gate did the same for the Brief).
shorten_schedule() {
  local name="$1" rows
  # jitter_seconds too: the scheduler adds up to that many seconds to the job's
  # run_after (600 s on the snapshot schedule: chain attempt 5 saw run_after
  # 9 m 48 s after the claim). Both columns are timing metadata; no data.
  rows="$(psql_db "$PROJECT" "$INSTALL" "UPDATE schedules SET next_run_at = now(), jitter_seconds = 0 WHERE name = '${name}' RETURNING name" | grep -c . || true)"
  report "- instrument: \`UPDATE schedules SET next_run_at = now(), jitter_seconds = 0 WHERE name = '${name}'\` at $(date -u +%H:%M:%SZ) — ${rows} row(s) (timing only; no data written)"
  [ "$rows" != "0" ] || report "  - **no schedule named ${name} exists yet** (registered at worker boot only when its module is on)"
}

# What the scheduler and the job queue say about one scheduled job kind: the
# evidence for a "never happened", read by the harness (never by hand).
schedule_diagnostics() {
  local name="$1" kind="$2"
  report "  - diagnostics: schedule \`$(psql_db "$PROJECT" "$INSTALL" "SELECT coalesce(string_agg(name || ' enabled=' || enabled || ' next=' || coalesce(to_char(next_run_at AT TIME ZONE 'UTC','HH24:MI:SS'),'-') || ' last=' || coalesce(to_char(last_run_at AT TIME ZONE 'UTC','HH24:MI:SS'),'-'), '; '), 'none') FROM schedules WHERE name = '${name}'" 2>&1 | tr '\n' ' ')\`"
  report "  - diagnostics: jobs \`$(psql_db "$PROJECT" "$INSTALL" "SELECT coalesce(string_agg(status || ' attempts=' || attempts || ' run_after=' || to_char(run_after AT TIME ZONE 'UTC','HH24:MI:SS') || coalesce(' error=' || left(last_error::text, 200), ''), '; ' ORDER BY run_after), 'none') FROM jobs WHERE kind LIKE '${kind}'" 2>&1 | tr '\n' ' ')\`"
  report "  - diagnostics: worker log \`$(dc "$PROJECT" "$INSTALL" logs --no-log-prefix worker 2>&1 | grep -iE "brief|schedul|snapshot|net_worth" | tail -4 | cut -c1-240 | tr '\n' ' ')\`"
}

load_era() {
  local wp="$1" out
  case "$wp" in
    W1)
      start_forwarder
      out="$(DIRECT_PORT=8453 driver W1 load W1)" || { stop_forwarder; flag "load W1"; return 0; }
      stop_forwarder
      ;;
    W4)
      shorten_schedule planning.net_worth_snapshot
      out="$(driver W4 load W4)" || {
        schedule_diagnostics planning.net_worth_snapshot 'planning.%'
        flag "load W4"
        return 0
      }
      ;;
    W5)
      # The holder opts into insights the way RUNBOOK "Create secrets" step 7
      # says (a high-entropy value in the file), then restarts the two
      # processes that read it at boot. A configuration choice at W5, not an
      # upgrade step.
      chmod u+w "$INSTALL/secrets/advisor_token_secret" 2>/dev/null || true
      openssl rand -hex 32 >"$INSTALL/secrets/advisor_token_secret"
      chmod 0444 "$INSTALL/secrets/advisor_token_secret"
      in_install "$(version_tag W5)" docker compose restart api worker >/dev/null 2>&1
      wait_ready_http /api/ready 300 || die "W5 not ready after the insights opt-in restart"
      report "- W5: holder opted into insights (advisor_token_secret written; \`docker compose restart api worker\`)"
      out="$(driver W5 load W5)" || { flag "load W5"; return 0; }
      shorten_schedule insights.weekly_brief
      local brief
      if ! brief="$(driver W5 await-brief 480)"; then
        report "- W5 loaded through W5's API (before the Brief): \`$(echo "$out" | tr -d '\n' | cut -c1-600)\`"
        schedule_diagnostics insights.weekly_brief insights.brief
        flag "W5 Brief never published"
        return 0
      fi
      out="$out $brief"
      ;;
    *) out="$(driver "$wp" load "$wp")" || { flag "load $wp"; return 0; } ;;
  esac
  report "- ${wp} loaded through ${wp}'s API: \`$(echo "$out" | tr -d '\n' | cut -c1-600)\`"
}

restore_w0_premigrate() {
  local f
  f="$(cat "$RUN_DIR/premigrate-HEAD.name")"
  restore_into_fresh "w0-premigrate" "$f" "W0" || flag "(iv) W0 pre-migration backup restored into HEAD"
}
restore_w0_backup() {
  restore_into_fresh "w0-backup" "$(cat "$RUN_DIR/w0-backup.name")" "W0" || flag "(iv) W0 backup restored into HEAD"
}

recovery_code() {
  local out
  out="$(driver HEAD recovery-code)" || flag "a W0 recovery code at HEAD"
  report "| HEAD | (iii) a W0 recovery code | ${out} |"
}

# ------------------------------------------------------------- the paths

case "$PATH_KIND" in
  s1-no-placeholders)
    step 01-install-W0 install_w0
    step 02-load-W0 load_w0
    step 03-hop-HEAD-sabotaged sabotage_s1
    ;;
  direct)
    step 01-install-W0 install_w0
    step 02-load-W0 load_w0
    step 03-verify-W0 verify_or_flag W0
    step 05-hop-HEAD hop_head HEAD
    step 06-verify-HEAD verify_or_flag HEAD
    step 07-restore-W0-premigrate restore_w0_premigrate
    step 08-head-drill head_backup_drill
    if [ "$CI_MODE" -eq 1 ]; then
      log "--ci: step 09-rollback skipped (CF-2 is covered in CI by packages/db/test/migrate-newer.test.ts; the stack-level suite runs locally at each gate)"
    else
      step 09-rollback rollback_suite
    fi
    step 10-recovery-code recovery_code
    ;;
  chain)
    step 01-install-W0 install_w0
    step 02-load-W0 load_w0
    step 03-verify-W0 verify_or_flag W0
    step 04-backup-W0 backup_w0
    n=5
    for wp in W1 W2 W3 W4 W5; do
      step "$(printf '%02d' $n)-hop-$wp" hop_era "$wp"
      n=$((n + 1))
      if [ "$wp" = W4 ]; then step "$(printf '%02d' $n)-cf5-W4" probe_returns_cache "at W4"; n=$((n + 1)); fi
      step "$(printf '%02d' $n)-verify-$wp" verify_or_flag "$wp"
      n=$((n + 1))
      step "$(printf '%02d' $n)-load-$wp" load_era "$wp"
      n=$((n + 1))
    done
    step 21-hop-HEAD hop_head HEAD
    step 22-verify-HEAD verify_or_flag HEAD
    step 23-cf5-HEAD probe_returns_cache "at HEAD (after the chain)"
    step 24-restore-W0-backup restore_w0_backup
    step 25-head-drill head_backup_drill
    step 26-recovery-code recovery_code
    step 27-extra-steps summarize_extra_steps
    ;;
  s3-no-newer-check)
    step 01-install-W0 install_w0
    step 02-load-W0 load_w0
    step 03-hop-HEAD+1 hop_head HEAD+1
    step 04-s3 s3_suite
    ;;
  s2-no-premigrate)
    step 01-install-W0 install_w0
    step 02-load-W0 load_w0
    step 03-hop-HEAD-sabotaged hop_head_s2
    ;;
  *) die "unknown --path $PATH_KIND" ;;
esac

log "path ${PATH_KIND}: all steps complete; report: $REPORT"
if [ "$KEEP" -eq 0 ]; then
  teardown_project "$PROJECT" "$INSTALL"
  teardown_project "${PROJECT}-r" "$RUN_DIR/install-r"
  shred -u "$AUTH_DIR"/* 2>/dev/null || true
  rm -rf "$AUTH_DIR" "$INSTALL/secrets"
  log "torn down; test-only secrets under $AUTH_DIR and the install's secrets/ destroyed (report kept at $REPORT)"
fi
if [ -s "$FAILURES" ]; then
  log "RESULT: FAIL — $(wc -l <"$FAILURES") failed check(s):"
  sed 's/^/  /' "$FAILURES"
  exit 1
fi
log "RESULT: PASS"
