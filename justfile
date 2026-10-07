# SPDX-License-Identifier: MIT
# PersonalFi task runner. `just --list` for the full set.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Local dev database. Loopback only, port 5433 so it cannot collide with a
# system Postgres.
export DATABASE_URL := env_var_or_default("DATABASE_URL", "postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev")
export SECRETS_DIR := env_var_or_default("SECRETS_DIR", justfile_directory() / "secrets")

# WP 9.4 (09 §4 batch 9): `just upgrade` — the one documented upgrade step
# (RUNBOOK "Upgrade"). The recipe body is the package's own file.
import 'scripts/upgrade-test/upgrade.just'

# WP 9.4 (CF-4). Never overwrites; refuses a missing required secret; `just upgrade` runs it.
# Create every optional secret compose.yml declares, empty, if it is missing
secrets-placeholders *args:
    bash scripts/secrets-placeholders.sh {{args}}

# WP 9.4. path: direct | chain | s1-no-placeholders | s2-no-premigrate | s3-no-newer-check
# The unattended-upgrade test: v0.1 installed cold, then this checkout by `just upgrade` alone
upgrade-test path="direct" *args="":
    bash scripts/upgrade-test/run.sh --path {{path}} {{args}}

_default:
    @just --list

# Install workspace dependencies exactly as the lockfile says.
install:
    pnpm install --frozen-lockfile

# Typecheck, lint, unit+integration tests. Fast, and NOT the full pipeline —
# `just verify` is. A green `just check` was being read as a green CI run all
# through Phase 0 while CI was red at HEAD (the gate review's process finding),
# so the two names now mean different things on purpose.
check: typecheck lint check-proxy-routes test
    # WP 2.12 (docs/plan/02-phase-2-dispatch.md §5 item 5): the mechanical
    # version of "every new vitest project is in ci.yml the day it is
    # created," which has now caught a real gap twice by hand (Phase 0's
    # gate, then Phase 1's own quality pass) before this check existed.
    # Static, no database, no build — same shape as check-proxy-routes above,
    # kept inline here rather than as its own recipe since only this line is
    # this work package's to edit.
    node scripts/check-ci-projects.ts

# gate-security-review.md F-4/C-1b: the control whose absence let F-4 ship —
# nothing compared docker/Caddyfile's proxied prefixes to
# packages/contracts/openapi/openapi.json's actual routes. Grouped with `lint`
# conceptually (a static, no-database, no-build check over checked-in files)
# but kept as its own recipe rather than folded into `pnpm run lint` so it
# needs no package.json edit to wire up; `check` above runs it directly.
check-proxy-routes:
    node scripts/check-proxy-routes.ts

# Everything CI will run, locally, in CI's order. A green `just verify` is the
# claim "the pipeline will be green"; nothing else in this file is.
#
# Runs the same pinned container digests CI runs — gitleaks, trivy — so this
# needs docker and a network on first use, and takes minutes rather than
# seconds. That is the price of the claim.
#
# gate-security-review-2.md R-4: this recipe used to stop at `check`, which
# never covered the `web` CI job (apps/web's own vitest project, `pnpm
# --filter @app/web build`, and both Playwright projects) — a green `just
# verify` predicted a pipeline that could still fail in CI on exactly those.
# `just check`'s `test` step already runs the web vitest project (root
# package.json's `test` script chains `pnpm --filter @app/web test`), so it
# is not repeated here; the build and Playwright projects were the actual gap.
verify: check
    @echo "=== verify: web build (strip-sourcemaps, sw-precache check, csp static check) ==="
    pnpm --filter @app/web build
    @echo "=== verify: playwright (smoke + csp) ==="
    just playwright-check
    @echo "=== verify: gitleaks (full history, CI's pinned digest) ==="
    docker run --rm -v "{{justfile_directory()}}:/repo" -w /repo \
      {{GITLEAKS_IMAGE}} detect --source . --redact --exit-code 1 -i .gitleaksignore
    @echo "=== verify: no remote may exist while .gitleaksignore still allowlists the c7846dc true positive ==="
    bash scripts/check-history-rewrite-before-push.sh
    @echo "=== verify: license gate + THIRD_PARTY.md drift ==="
    node scripts/check-licenses.ts
    git diff --exit-code -- THIRD_PARTY.md
    @echo "=== verify: compose hardening (self-test, then the real files) ==="
    just hardening-check
    @echo "=== verify: .trivyignore has no expired suppressions ==="
    just trivyignore-check
    @echo "=== verify: trivy filesystem scan ==="
    # --skip-dirs node_modules: vuln detection reads pnpm-lock.yaml at the root,
    # so this drops nothing from the dependency scan; it stops misconfig from
    # grading Dockerfiles that ship *inside* third-party packages (the `plaid`
    # SDK carries one) which we never build. Our own docker/*.Dockerfile stay in.
    docker run --rm -v "{{justfile_directory()}}:/repo" {{TRIVY_IMAGE}} \
      fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL --ignore-unfixed \
        --skip-dirs node_modules --ignorefile /repo/.trivyignore --exit-code 1 /repo
    @echo "=== verify: PASS (this is the run that predicts CI) ==="

# Same digest CI's `gitleaks` job pins.
GITLEAKS_IMAGE := "zricethezav/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9"

# Both Playwright projects (`chromium` = smoke.spec.ts, `csp` = csp.spec.ts).
# gate-security-review-2.md R-4: `just verify` did not run these at all, so it
# could go green while CI's `web` job failed on either one. CI's job installs
# chromium itself (`playwright install --with-deps chromium`); this recipe
# deliberately does NOT — a `just verify` that silently installed a browser on
# your behalf on first run would be quietly slower the first time and quietly
# hide a real gap the rest of the time (someone whose local Playwright install
# broke would never find out from a green `verify`). If chromium is missing,
# fail with an explicit next step instead of either skipping or auto-fixing.
playwright-check:
    #!/usr/bin/env bash
    set -euo pipefail
    output="$(mktemp)"
    trap 'rm -f "$output"' EXIT
    if ! pnpm --filter @app/web exec playwright test 2>&1 | tee "$output"; then
      if grep -q "Executable doesn't exist" "$output"; then
        echo "::error::Playwright's chromium browser is not installed. Run: pnpm --filter @app/web exec playwright install --with-deps chromium — then re-run 'just verify'." >&2
      fi
      exit 1
    fi

# The same expiry sweep CI's `trivy-fs` job runs before scanning: a suppression
# is a snooze, and a snooze that never rings is a decision nobody made.
trivyignore-check:
    #!/usr/bin/env bash
    set -euo pipefail
    today="$(date -u +%Y-%m-%d)"
    expired=0
    while IFS= read -r line; do
      [[ "$line" =~ \#\#[[:space:]]*expires:[[:space:]]*([0-9]{4}-[0-9]{2}-[0-9]{2}) ]] || continue
      expiry="${BASH_REMATCH[1]}"
      if [[ "$expiry" < "$today" ]]; then
        echo "::error::.trivyignore entry expired on $expiry: $line" >&2
        expired=1
      fi
    done < .trivyignore
    exit "$expired"

typecheck:
    pnpm run typecheck

# ESLint (including the import-boundary rule), the schema-ownership check, formatting,
# and 08 §6.5's numeric-boundary rule (WP 3.14: no `number` at a money or quantity
# boundary; self-tests against scripts/fixtures/numeric-*.ts before it reads the tree).
lint:
    pnpm run lint
    node scripts/check-numeric-boundaries.ts

format:
    pnpm run format

test:
    pnpm run test

# Unit tests only; needs no database. Every root-config vitest project except
# the `*-db`/`db` ones — see the project -> job map in .github/workflows/ci.yml.
test-unit:
    pnpm exec vitest run --project kernel --project config --project api \
      --project platform --project testkit --project seed --project secretbox \
      --project identity

# Start the dev database and wait for it to accept connections.
db-up:
    docker compose -f compose.dev.yml up -d --wait
    @echo "postgres ready on 127.0.0.1:5433 (db personalfi_dev, user personalfi)"

# Stop the dev database. The volume survives.
db-down:
    docker compose -f compose.dev.yml down

# Stop the dev database and destroy its data.
db-reset:
    docker compose -f compose.dev.yml down -v

db-logs:
    docker compose -f compose.dev.yml logs -f db

psql:
    docker compose -f compose.dev.yml exec db psql -U personalfi -d personalfi_dev

# Apply every pending migration under an advisory lock.
migrate:
    pnpm run migrate

# Show what `just migrate` would apply, changing nothing.
migrate-status:
    pnpm exec node packages/db/src/cli/migrate.ts --dry-run

# Scaffold the next migration with the right name and header.
migrate-new name:
    #!/usr/bin/env bash
    set -euo pipefail
    dir="{{justfile_directory()}}/packages/db/migrations"
    last=$(ls "$dir" | grep -oE '^[0-9]{4}' | sort -n | tail -1)
    next=$(printf '%04d' $((10#$last + 1)))
    file="$dir/${next}_{{name}}.sql"
    cat > "$file" <<HEADER
    -- SPDX-License-Identifier: MIT
    -- ${next}_{{name}}
    --
    -- Forward-only. Immutable once merged: the runner checksums this file.
    -- Destructive changes use expand -> backfill -> contract across releases.
    HEADER
    echo "created $file"

# Print summary counts for the deterministic demo-seed generator (@core/seed).
# `seed=N` picks the PRNG seed (default 1); the dataset itself is never written
# to disk by this recipe — pass `--out=DIR` yourself via the CLI for that.
seed-stats seed="1":
    pnpm exec node packages/seed/src/cli.ts --seed={{seed}} --stats

# Regenerate the checked-in OpenAPI document from the live route schemas.
openapi:
    pnpm run openapi

# Run the API against the dev database.
dev:
    LOG_PRETTY=true pnpm run dev:api

# Run the background worker: consumer pump, job runners, scheduler.
# Same image and same code as the API in production; only ROLE differs (WP 0.4).
worker:
    ROLE=worker LOG_PRETTY=true pnpm run dev:worker

# Phase 0 exit criterion: kill a worker mid-job and prove the restart resumes it.
#
# Spawns two real worker processes against a scratch database, SIGKILLs the one
# holding the job, and asserts the survivor reaps the stale claim and completes
# the work exactly once. Needs `just db-up`. The transcript it prints is what
# docs/evidence/phase-0/wp0.3-worker-restart-drill.md records.
drill-worker-restart:
    pnpm exec vitest run worker-restart --project platform-db \
      --reporter=verbose --disable-console-intercept=true

# ---------------------------------------------------------------------------
# Production stack (WP 0.4; compose.yml, docker/*). `just db-up`/`db-down`
# above are the *dev* database only — these target the hardened stack.
# ---------------------------------------------------------------------------

# The P0-6/P0-7 compose gate: it checks ITSELF against a deliberately hostile
# fixture first, then checks every real compose file. Both halves, in that
# order, because the gate this replaced passed a privileged, host-networked,
# Docker-socket-mounting service and nobody found out for a month.
#
# Wired into CI as the `compose-hardening` job, into `just verify`, and into
# the lefthook pre-commit hook.
#
# gate-security-review.md §8.11 D-4: the compose-file gate above never checked
# whether the *host secret files* it declares are actually readable by the
# uid that will consume them — that gap is what let harden-secrets' hand-
# written secret list rot (N-1) with nothing red until `docker compose up`
# crash-looped on EACCES. check-secret-ownership.sh is the computed version:
# it derives the expected owner/mode from compose.yml's own `secrets:`/`user:`
# declarations rather than a second hand-written list.
check-secret-ownership:
    bash scripts/check-secret-ownership.sh --self-test
    bash scripts/check-secret-ownership.sh

hardening-check:
    bash scripts/compose-hardening-check.sh --self-test
    bash scripts/compose-hardening-check.sh
    just check-secret-ownership

# Old name, kept so existing hooks/docs/muscle memory keep working.
compose-lint: hardening-check

# Generate Postgres's bootstrap password and the matching database_url secret
# (RUNBOOK.md "Create secrets" step 1-2). Hex, not base64: `postgres://` is a
# URL, and a base64 password can contain `/`, `+`, or `=`, any of which
# either breaks URL parsing outright or silently changes what the URL means
# (a `/` reads as a path separator, not part of the password) — this is a
# real bug that broke `just dev` for the whole team once already. Hex is
# alphanumeric-only, so it is never ambiguous inside a URL and never needs
# percent-encoding in the first place. Refuses to overwrite an existing
# `pg_password`, same as `gen-master-key`.
gen-pg-secrets:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "${SECRETS_DIR}"
    if [[ -e "${SECRETS_DIR}/pg_password" ]]; then
      echo "refusing to overwrite ${SECRETS_DIR}/pg_password" >&2
      exit 1
    fi
    umask 077
    # The confidentiality boundary is this directory, not the file modes
    # inside it (see the mode note below and compose.yml's `secrets:` header):
    # 0700 means only you and root can traverse into it at all. Enforced, not
    # assumed — `mkdir -p` leaves a pre-existing directory's mode alone.
    chmod 0700 "${SECRETS_DIR}"
    openssl rand -hex 32 > "${SECRETS_DIR}/pg_password"
    printf 'postgres://personalfi:%s@db:5432/personalfi\n' \
      "$(cat "${SECRETS_DIR}/pg_password")" > "${SECRETS_DIR}/database_url"
    # Parse it back before trusting it: a URL-unsafe password should never
    # reach this point given the hex alphabet above, but a broken
    # database_url is exactly the class of bug this recipe exists to
    # prevent, so it checks its own output rather than assuming.
    node -e "new URL(require('node:fs').readFileSync(process.argv[1], 'utf8').trim())" \
      "${SECRETS_DIR}/database_url"
    # 0444 by default, 0400 via `just harden-secrets`. Measured, not assumed:
    # compose's file-secret provider bind-mounts the host file and preserves
    # its uid/gid/mode verbatim — `uid`/`gid`/`mode` in the compose long syntax
    # are Swarm-only and `docker compose up` ignores them (verified on Compose
    # v5.5.1: a 0644 host file declared `mode: 0400, uid: 10001` appeared
    # inside a container running as 10001 as `-rw-r--r-- 1 1000 1000`). db runs
    # as uid 70, api/worker/migrator as 10001, backup as 10002, and none of
    # them is the uid that ran `just`, so 0400-owned-by-you means every one of
    # them fails to read its own secret. `just harden-secrets` does the one
    # thing that actually produces 0400 *inside* the container: chown to the
    # consuming uid on the host, which does pass through.
    chmod 0444 "${SECRETS_DIR}/pg_password" "${SECRETS_DIR}/database_url"
    echo "wrote ${SECRETS_DIR}/pg_password and ${SECRETS_DIR}/database_url"
    echo "run 'just harden-secrets' (needs sudo) to take them to 0400 owned by the consuming uid"

# Build the api/worker/migrator, backup, and proxy images.
build:
    docker compose build

# gate-security-review.md C-1c: the api image's Dockerfile fix (docker/api.Dockerfile,
# F-1) is proven by `apps/api/test/gate-image-closure.test.ts`, but that test
# self-skips whenever the named image doesn't exist — and nothing in `just
# check`/`just verify` ever builds one, which is exactly how F-1 (the image
# hadn't booted since WP 1.2) went unnoticed for a full phase. Deliberately
# NOT folded into `just verify`: that recipe already documents its own
# docker/network cost budget (gitleaks, trivy) and a full `docker compose
# build` is minutes more on top for a check relevant only when
# docker/api.Dockerfile or apps/api's production dependency closure changed.
# `docker compose build api` names the image `${REGISTRY:-personalfi}/api:${PERSONALFI_VERSION:-dev}`
# — the test's own default when `PERSONALFI_API_IMAGE` is unset — so a plain
# local run needs no env var. Run this before a push that touches either of
# those; see RUNBOOK.md's pre-push list.
verify-images:
    docker compose build api
    pnpm exec vitest run apps/api/test/gate-image-closure.test.ts

# Extract Caddy's internal-CA root certificate so it can be imported into a
# browser/OS trust store (RUNBOOK.md "Trust the internal CA"). Needs the
# `proxy` service to have started at least once (that's when Caddy generates it).
trust-ca:
    docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./personalfi-ca.crt
    @echo "wrote ./personalfi-ca.crt — import it into your OS/browser trust store (see RUNBOOK.md)"

# Bring the hardened production stack up. Needs ./secrets/* to exist first
# (see RUNBOOK.md "First install" — there is deliberately no `secrets-init`
# target that writes real secrets for you to run unattended).
up:
    docker compose up -d

down:
    docker compose down

logs:
    docker compose logs -f

# Trigger an out-of-band encrypted backup right now, on top of the nightly one
# backup-loop.sh already runs inside the `backup` service.
backup:
    docker compose exec backup /usr/local/bin/backup.sh

# Prove the newest backup actually restores (D24, 06 §4.2; master plan P0-11).
#
# Spins up a throwaway Postgres container on the *existing* backend network,
# decrypts and pg_restores the newest backup into it via the backup image's own
# restore.sh, boots a throwaway api container against it, hits /ready, compares
# the restored table count against the live `db` service — and then ASSERTS on
# all of it. Everything it creates is torn down on exit (`trap ... EXIT`), pass
# or fail. Writes docs/evidence/ops/restore-drill-<date>.md with a verdict.
#
# H-5: this recipe used to gather exactly these numbers and never compare them.
# The committed evidence artifact read "Restored db table count: 0 / Live db
# table count: 0 / /ready: fail" and the recipe exited 0 — the only control
# capable of catching a silently-empty backup (H-2) was structurally incapable
# of failing. Every number below is now an assertion:
#
#   * the restored table count is > 0 (a restore of nothing is not a restore),
#   * it equals the live table count,
#   * schema_migrations agrees on both sides,
#   * /ready returns 200 against the restored database,
#   * any failure writes FAIL into the evidence file and exits non-zero.
#
# Preconditions: `docker compose up` (or at least `create`) has run at least
# once, so the `backend` network and `backups` volume exist and are
# discoverable by their compose labels; AGE_IDENTITY_FILE points at the
# private half of the age keypair (never present in the compose project
# itself — see docker/backup/backup.sh's header).
restore-drill:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${AGE_IDENTITY_FILE:?set AGE_IDENTITY_FILE to the age private key (RUNBOOK.md 'Restore')}"
    ROOT="{{justfile_directory()}}"
    DATE="$(date -u +%Y%m%dT%H%M%SZ)"
    EVIDENCE="${DRILL_EVIDENCE_DIR:-$ROOT/docs/evidence/ops}/restore-drill-${DATE%%T*}.md"
    PG_DIGEST="postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2"
    ALPINE_DIGEST="alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b"
    DRILL_DB="restore-drill-db-$$"
    DRILL_API="restore-drill-api-$$"

    # WP 9.1: a host can carry several compose projects (production, the dev stack, scratch
    # projects), and each has a `backups` volume, a `backend` network and a `db` service. The
    # lookups below used to take `head -1` of whatever matched -- on such a host that could
    # restore, compare against, and WRITE the verdict into the wrong project's database.
    # Scope every lookup to ONE project (COMPOSE_PROJECT_NAME), and refuse when it is unset
    # and the answer is ambiguous. DRILL_SECRETS_DIR / DRILL_EVIDENCE_DIR (defaults:
    # ./secrets, docs/evidence/ops) let a scratch project be drilled without touching either.
    SCOPE=()
    if [ -n "${COMPOSE_PROJECT_NAME:-}" ]; then
      SCOPE=(--filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME")
    fi
    SECRETS_HOST="${DRILL_SECRETS_DIR:-$ROOT/secrets}"
    one_of() {
      local what="$1" list="$2" n
      n="$(printf '%s\n' "$list" | grep -c . || true)"
      if [ "$n" -gt 1 ]; then
        echo "restore-drill: $n candidate $what ($(printf '%s' "$list" | tr '\n' ' ')); set COMPOSE_PROJECT_NAME to the project being drilled" >&2
        exit 1
      fi
      printf '%s' "$list"
    }
    BACKUPS_VOLUME="$(one_of volumes "$(docker volume ls "${SCOPE[@]}" --filter label=com.docker.compose.volume=backups --format '{{{{.Name}}')")"
    BACKEND_NETWORK="$(one_of networks "$(docker network ls "${SCOPE[@]}" --filter label=com.docker.compose.network=backend --format '{{{{.Name}}')")"
    if [ -z "$BACKUPS_VOLUME" ] || [ -z "$BACKEND_NETWORK" ]; then
      echo "restore-drill: backend network or backups volume not found — run 'docker compose up' (or 'create') at least once first" >&2
      exit 1
    fi

    SCRATCH_SECRETS="$(mktemp -d)"
    FAILURES=()
    cleanup() {
      docker rm -f "$DRILL_DB" "$DRILL_API" >/dev/null 2>&1 || true
      rm -rf "$SCRATCH_SECRETS"
    }
    trap cleanup EXIT
    fail() { FAILURES+=("$1"); echo "restore-drill: ASSERTION FAILED: $1" >&2; }

    # Read the password through a container running as root rather than with
    # `cat` on the host: after `just harden-secrets` the host file is 0440
    # owned by uid 70, which the operator deliberately cannot read.
    PG_PASSWORD="$(docker run --rm --user 0:0 -v "$SECRETS_HOST/pg_password:/s:ro" "$ALPINE_DIGEST" cat /s)"

    # Same problem, same solution, for the age identity — and this one bit
    # during a real drill (gate-security-review-2.md, §2.7). The backup image
    # runs as uid 10002, so bind-mounting the operator's private key straight
    # into the container fails on a *correctly* permissioned key:
    #
    #   age: error: reading "/run/age_identity": failed to open file:
    #   open /run/age_identity: permission denied
    #
    # An age identity kept at 0600 and owned by the operator is the RUNBOOK's
    # own instruction ("keep the private half OUTSIDE this repo and this
    # host"), so the drill rejected exactly the key custody it asks for, and
    # the only way to run it was to `chmod 0644` a private key — during a
    # disaster, on a box you are already unsure about. Copy it through a root
    # container into the scratch dir instead, world-readable only inside a
    # `mktemp -d` that the EXIT trap deletes.
    docker run --rm --user 0:0 -v "$AGE_IDENTITY_FILE:/s:ro" "$ALPINE_DIGEST" cat /s \
      > "$SCRATCH_SECRETS/age_identity"
    chmod 0444 "$SCRATCH_SECRETS/age_identity"
    if [ ! -s "$SCRATCH_SECRETS/age_identity" ]; then
      echo "restore-drill: AGE_IDENTITY_FILE ($AGE_IDENTITY_FILE) is empty or unreadable" >&2
      exit 1
    fi

    echo "restore-drill: starting scratch db ($DRILL_DB on $BACKEND_NETWORK) ..."
    docker run -d --name "$DRILL_DB" --network "$BACKEND_NETWORK" --network-alias restore-drill-db \
      -e POSTGRES_USER=personalfi -e POSTGRES_DB=personalfi_restore_drill \
      -e POSTGRES_PASSWORD="$PG_PASSWORD" \
      "$PG_DIGEST" >/dev/null

    echo -n "restore-drill: waiting for scratch db to accept connections "
    DB_UP=0
    for _ in $(seq 1 60); do
      if docker exec "$DRILL_DB" pg_isready -U personalfi -d personalfi_restore_drill >/dev/null 2>&1; then
        echo "ok"; DB_UP=1; break
      fi
      echo -n "."; sleep 1
    done
    [ "$DB_UP" -eq 1 ] || { echo; fail "scratch database never accepted connections"; }

    LATEST_BACKUP="$(docker run --rm -v "$BACKUPS_VOLUME:/backups:ro" "$ALPINE_DIGEST" \
      sh -c "ls -1t /backups/personalfi-*.dump.age 2>/dev/null | head -1")"
    if [ -z "$LATEST_BACKUP" ]; then
      echo "restore-drill: no backup found in the backups volume — run 'just backup' first" >&2
      exit 1
    fi
    BACKUP_BYTES="$(docker run --rm -v "$BACKUPS_VOLUME:/backups:ro" "$ALPINE_DIGEST" \
      sh -c "wc -c < '$LATEST_BACKUP'" | tr -d ' ')"
    echo "restore-drill: restoring $LATEST_BACKUP ($BACKUP_BYTES bytes)"

    printf '%s' "$PG_PASSWORD" > "$SCRATCH_SECRETS/pg_password"
    RESTORE_OK=1
    # WP 9.1 (CF-17, D24, migration 0036_ops_status.sql): the clock for the
    # measured half of the RTO 1 h budget (master plan §3.4) — "restore
    # started" to "the restored database answered /ready" — started here,
    # read back below once that answer (pass or fail) is known.
    RESTORE_STARTED_AT="$(date -u +%s)"
    docker run --rm --network "$BACKEND_NETWORK" \
      -v "$BACKUPS_VOLUME:/backups:ro" \
      -v "$SCRATCH_SECRETS/age_identity:/run/age_identity:ro" \
      -v "$SCRATCH_SECRETS/pg_password:/run/secrets/pg_password:ro" \
      -e PGHOST=restore-drill-db -e PGUSER=personalfi -e PGDATABASE=personalfi_restore_drill \
      -e PGPASSWORD_FILE=/run/secrets/pg_password -e AGE_IDENTITY_FILE=/run/age_identity \
      "${REGISTRY:-personalfi}/backup:${PERSONALFI_VERSION:-dev}" /usr/local/bin/restore.sh "$LATEST_BACKUP" \
      || { RESTORE_OK=0; fail "restore.sh exited non-zero"; }

    q() { docker exec "$1" psql -U personalfi -d "$2" -tAc "$3" 2>/dev/null | tr -d '[:space:]'; }

    RESTORED_TABLES="$(q "$DRILL_DB" personalfi_restore_drill "select count(*) from information_schema.tables where table_schema = 'public'" || echo 0)"
    RESTORED_TABLES="${RESTORED_TABLES:-0}"
    RESTORED_MIGRATIONS="$(q "$DRILL_DB" personalfi_restore_drill "select coalesce(max(version), '(none)') from schema_migrations" || echo '(schema_migrations not present)')"
    RESTORED_MIGRATIONS="${RESTORED_MIGRATIONS:-(schema_migrations not present)}"

    LIVE_DB_CONTAINER="$(one_of 'live db containers' "$(docker ps "${SCOPE[@]}" --filter label=com.docker.compose.service=db --format '{{{{.Names}}')")"
    if [ -n "$LIVE_DB_CONTAINER" ]; then
      LIVE_TABLES="$(q "$LIVE_DB_CONTAINER" personalfi "select count(*) from information_schema.tables where table_schema = 'public'" || echo 0)"
      LIVE_TABLES="${LIVE_TABLES:-0}"
      LIVE_MIGRATIONS="$(q "$LIVE_DB_CONTAINER" personalfi "select coalesce(max(version), '(none)') from schema_migrations" || echo '(schema_migrations not present)')"
      LIVE_MIGRATIONS="${LIVE_MIGRATIONS:-(schema_migrations not present)}"
    else
      LIVE_TABLES="n/a"
      LIVE_MIGRATIONS="n/a"
      fail "the live db service is not running, so the restore could not be compared against it"
    fi

    # Assertion 1: a restore of nothing is not a restore. This is the one that
    # catches an empty/failed backup, which is exactly what H-2 produced.
    if ! [[ "$RESTORED_TABLES" =~ ^[0-9]+$ ]] || [ "$RESTORED_TABLES" -lt 1 ]; then
      fail "restored table count is '$RESTORED_TABLES'; expected a positive integer"
    fi
    # Assertion 2: same schema on both sides.
    if [[ "$LIVE_TABLES" =~ ^[0-9]+$ ]] && [ "$RESTORED_TABLES" != "$LIVE_TABLES" ]; then
      fail "restored table count ($RESTORED_TABLES) != live table count ($LIVE_TABLES)"
    fi
    if [ "$LIVE_MIGRATIONS" != "n/a" ] && [ "$RESTORED_MIGRATIONS" != "$LIVE_MIGRATIONS" ]; then
      fail "restored schema_migrations max id ($RESTORED_MIGRATIONS) != live ($LIVE_MIGRATIONS)"
    fi

    # Assertion 3: the application can actually serve the restored database.
    API_READY="skipped"
    if [ -n "${SKIP_API_BOOT:-}" ]; then
      API_READY="skipped (SKIP_API_BOOT set)"
      fail "SKIP_API_BOOT was set, so /ready was never proven against the restored database"
    else
      echo "restore-drill: booting a throwaway api container against the restored db ..."
      # A scratch database_url pointed at the drill db, not the real one —
      # generated here rather than read from ./secrets, which never has (and
      # must never have) a URL for a database this script just created.
      printf 'postgres://personalfi:%s@restore-drill-db:5432/personalfi_restore_drill\n' \
        "$PG_PASSWORD" > "$SCRATCH_SECRETS/database_url"
      docker run -d --name "$DRILL_API" --network "$BACKEND_NETWORK" --user 10001:10001 \
        --memory 1536m \
        -e ROLE=api -e NODE_ENV=production -e HTTP_HOST=0.0.0.0 -e HTTP_PORT=8080 \
        -e SECRETS_DIR=/run/secrets \
        -e LOG_LEVEL="${LOG_LEVEL:-info}" \
        -e BASE_URL="https://${PUBLIC_HOST:-personalfi.lan}" \
        -e AUTH_RP_ID="${PUBLIC_HOST:-personalfi.lan}" \
        -e AUTH_ALLOWED_ORIGINS="https://${PUBLIC_HOST:-personalfi.lan}" \
        -v "$SCRATCH_SECRETS/database_url:/run/secrets/database_url:ro" \
        -v "$SECRETS_HOST/master_key:/run/secrets/master_key:ro" \
        "${REGISTRY:-personalfi}/api:${PERSONALFI_VERSION:-dev}" >/dev/null
      API_READY="fail"
      for _ in $(seq 1 30); do
        if docker exec "$DRILL_API" node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
          API_READY="pass (200 from /ready)"; break
        fi
        sleep 2
      done
      if [ "$API_READY" = "fail" ]; then
        API_READY="fail (no 200 from /ready within 60s)"
        fail "/ready never returned 200 against the restored database"
        docker logs "$DRILL_API" 2>&1 | tail -20 | sed 's/^/    api: /' >&2 || true
      fi
    fi

    if [ "${#FAILURES[@]}" -eq 0 ]; then VERDICT="PASS"; else VERDICT="FAIL"; fi

    RTO_SECONDS=$(( $(date -u +%s) - RESTORE_STARTED_AT ))

    # WP 9.1 (CF-17, D24, migration 0036_ops_status.sql): the verdict this
    # recipe just computed, written into the *live* database — never the
    # throwaway $DRILL_DB this recipe is about to tear down — so
    # `GET /ops/backup-status` can answer "when did the drill last pass?"
    # without reading this file's own evidence markdown. Best-effort, same
    # written contract as `docker/backup/backup.sh`'s own insert: a drill run
    # against a live db that predates migration 0036 (or against one whose
    # `db` service was not up at all, `LIVE_DB_CONTAINER` empty) must not
    # turn a real, already-computed verdict into a recipe failure.
    if [ -n "$LIVE_DB_CONTAINER" ]; then
      DRILL_VERDICT_SQL="$(printf '%s' "$VERDICT" | tr '[:upper:]' '[:lower:]')"
      if ! DRILL_INSERT_ERROR="$(docker exec "$LIVE_DB_CONTAINER" psql -U personalfi -d personalfi \
          -v ON_ERROR_STOP=1 -q -tAc \
          "INSERT INTO ops_restore_drills
             (id, verdict, ran_at, restored_table_count, live_table_count, max_migration, rto_seconds)
           VALUES (gen_random_uuid(), '$DRILL_VERDICT_SQL', now(),
                   ${RESTORED_TABLES:-0}, ${LIVE_TABLES:-0}, '$RESTORED_MIGRATIONS', $RTO_SECONDS)" 2>&1)"; then
        echo "restore-drill: ops_restore_drills insert skipped (best-effort; see justfile's restore-drill recipe): $DRILL_INSERT_ERROR" >&2
      fi
    else
      echo "restore-drill: no live db container found; ops_restore_drills not written" >&2
    fi

    mkdir -p "$(dirname "$EVIDENCE")"
    {
      echo "# Restore drill — $DATE"
      echo
      echo "**Verdict: $VERDICT**"
      echo
      echo "- Backup restored: \`$LATEST_BACKUP\` ($BACKUP_BYTES encrypted bytes)"
      echo "- Restored db table count: $RESTORED_TABLES"
      echo "- Restored db schema_migrations max id: $RESTORED_MIGRATIONS"
      echo "- Live db table count: $LIVE_TABLES"
      echo "- Live db schema_migrations max id: $LIVE_MIGRATIONS"
      echo "- API /ready against restored db: $API_READY"
      echo
      if [ "$VERDICT" = "PASS" ]; then
        echo "All assertions held: restored tables > 0, restored == live, schema_migrations agree,"
        echo "and the API served /ready from the restored database. \`just restore-drill\` exited 0."
      else
        # The blank line before the list is load-bearing: without it prettier
        # reformats this file, and `just lint` (so `just check`, so `just
        # verify`) goes red — on the *failure* path, i.e. exactly when the
        # drill has something to tell you. Found by the second security gate.
        echo "Assertions that failed:"
        echo
        for f in "${FAILURES[@]}"; do echo "- $f"; done
        echo
        echo "\`just restore-drill\` exited non-zero."
      fi
    } | tee "$EVIDENCE"
    echo "restore-drill: wrote $EVIDENCE"
    [ "$VERDICT" = "PASS" ] || exit 1

# ---------------------------------------------------------------------------
# Supply chain (WP 0.4; D14/D15). Each of these runs a pinned tool via its own
# container — nothing here needs a host install of trivy/syft.
# ---------------------------------------------------------------------------

# Filesystem scan (deps + secrets + misconfig) and an image scan of every
# image this repo builds. HIGH/CRITICAL only, unfixed CVEs ignored (06 §5.5);
# suppress a specific finding in .trivyignore with an expiry and a reason.
#
# Same trivy digest as CI's `trivy-fs`/`docker-build-scan` jobs (WP 0.4 close-out
# fix: this recipe previously pinned the floating tag `aquasec/trivy:0.68.0`,
# which was never a real published tag — `0.68.1`/`0.68.2` exist, `0.68.0` does
# not — so `just scan` failed outright with "no such manifest" before it ever
# ran a scan. Also previously passed no `--ignorefile`, which would have failed
# on the very suppressions .trivyignore documents as expected findings.
TRIVY_IMAGE := "aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"

scan:
    docker run --rm -v "{{justfile_directory()}}:/repo" {{TRIVY_IMAGE}} \
      fs --scanners vuln,secret,misconfig --severity HIGH,CRITICAL --ignore-unfixed \
        --ignorefile /repo/.trivyignore --exit-code 1 /repo
    just build
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "{{justfile_directory()}}:/repo" {{TRIVY_IMAGE}} \
      image --severity HIGH,CRITICAL --ignore-unfixed --ignorefile /repo/.trivyignore --exit-code 1 personalfi/api:dev
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "{{justfile_directory()}}:/repo" {{TRIVY_IMAGE}} \
      image --severity HIGH,CRITICAL --ignore-unfixed --ignorefile /repo/.trivyignore --exit-code 1 personalfi/backup:dev
    docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "{{justfile_directory()}}:/repo" {{TRIVY_IMAGE}} \
      image --severity HIGH,CRITICAL --ignore-unfixed --ignorefile /repo/.trivyignore --exit-code 1 personalfi/proxy:dev

# SPDX + CycloneDX SBOMs for every image this repo builds (06 §5.4/§7.2 — the
# syft SBOM is the output of record; THIRD_PARTY.md is generated separately by
# `just licenses` from the npm dependency tree, which is the finer-grained of
# the two for the license gate specifically).
#
# Same syft digest as CI's `docker-build-scan`/release.yml jobs (WP 0.4
# close-out fix: this recipe previously pinned `anchore/syft:1.18.0`, which
# was never a real published tag — the oldest tag on Docker Hub today is
# `v1.43.0` — so `just sbom` failed outright with "no such manifest").
SYFT_IMAGE := "anchore/syft:v1.51.1@sha256:95fe0835e5bebc6f8b1f8acef68d47d63d594ef4c0f25c097ff853b23cbac74c"

sbom:
    #!/usr/bin/env bash
    set -euo pipefail
    just build
    mkdir -p docs/evidence/sbom
    for image in api backup proxy; do
      docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
        -v "{{justfile_directory()}}/docs/evidence/sbom:/out" \
        {{SYFT_IMAGE}} "personalfi/${image}:dev" \
        -o "spdx-json=/out/${image}.spdx.json" -o "cyclonedx-json=/out/${image}.cdx.json"
    done
    echo "sbom: wrote docs/evidence/sbom/{api,backup,proxy}.{spdx,cdx}.json"

# Regenerate THIRD_PARTY.md from the npm dependency tree and fail the build on
# a license-policy violation (licenses.policy.yaml: deny list, denyPackages,
# or UNKNOWN in the runtime tree).
licenses:
    node scripts/check-licenses.ts

# Create the single account holder and print a one-time passkey-enrolment link.
#
# The only way in on a box with no credentials (D21, P0-4). It also derives the
# KEK, so a missing or wrong `secrets/master_key` fails here, in front of an
# operator, instead of at 03:15 during a sync. Pass reissue=true to mint a fresh
# link for an account that already exists — the recovery path for losing every
# passkey and every recovery code.
#
#   just bootstrap-user name="Chris" timezone="America/Los_Angeles"
#   just bootstrap-user "Chris" "America/Los_Angeles"
bootstrap-user name="" timezone="UTC" reissue="false":
    #!/usr/bin/env bash
    set -euo pipefail
    # `just` recipe parameters are positional, so `just bootstrap-user name="Chris"`
    # passes the literal string `name=Chris`. CONVENTIONS.md spells this repo's
    # recipes in the `key=value` form, and silently creating an account holder
    # called "name=Chris" — in a single-user app that then refuses to create a
    # second — is a bad enough failure to be worth twelve lines of bash.
    #
    # Two passes: unprefixed slots keep their positional meaning, then any
    # `key=value` slot overrides by name, whichever position it arrived in.
    slots=({{ quote(name) }} {{ quote(timezone) }} {{ quote(reissue) }})
    keys=(name timezone reissue)
    name=""; timezone="UTC"; reissue="false"
    for i in 0 1 2; do
      case "${slots[$i]}" in
        name=*|timezone=*|reissue=*|'') ;;
        *) printf -v "${keys[$i]}" '%s' "${slots[$i]}" ;;
      esac
    done
    for slot in "${slots[@]}"; do
      case "$slot" in
        name=*)     name="${slot#name=}" ;;
        timezone=*) timezone="${slot#timezone=}" ;;
        reissue=*)  reissue="${slot#reissue=}" ;;
      esac
    done
    args=(--timezone="$timezone")
    if [[ -n "$name" ]]; then args+=(--name="$name"); fi
    if [[ "$reissue" == "true" ]]; then args+=(--reissue); fi

    # WHERE this runs is the whole point (gate-security-review-2.md, P0-4).
    #
    # RUNBOOK.md step 7 says to run this after `just up`, and it used to run on
    # the HOST unconditionally. On a production box that cannot work: the
    # `database_url` secret is `postgres://...@db:5432/...`, `db` is a
    # compose-internal DNS name, and P0-3 requires that no service except the
    # proxy publish a port — so the host has no route to Postgres by design.
    # The documented first-install path died with `getaddrinfo ENOTFOUND db`,
    # which meant no account holder, no enrolment token, and no way into a
    # fresh install at all.
    #
    # So: if the stack is up, run it *inside* the api container, which already
    # has the network, the secrets and this exact script baked in. Otherwise
    # fall back to the host, which is what `just dev` against `just db-up`
    # needs. The fallback is the dev path, not the production one.
    if docker compose ps --status running --services 2>/dev/null | grep -qx api; then
      echo "bootstrap-user: running inside the api container (the stack is up)" >&2
      docker compose exec -T api node /app/apps/api/src/bin/bootstrap-user.ts "${args[@]}"
    else
      echo "bootstrap-user: the stack is not running; using the local dev database" >&2
      pnpm exec node apps/api/src/bin/bootstrap-user.ts "${args[@]}"
    fi

# Resume a stopped event consumer (one /ready lists under outbox.failedConsumers), e.g. `just consumer-resume budgeting.actuals@v1`
consumer-resume name:
    #!/usr/bin/env bash
    set -euo pipefail
    # WP 9.11 (G-23 / F-94-5): the operator path back for a dead-lettered
    # consumer, which used to be SQL. It retries the SAME event — nothing is
    # skipped — so fix the cause it prints first. Inside the api container when
    # the stack is up (the database is not reachable from the host by design),
    # else against the local dev database — the same shape as bootstrap-user.
    if docker compose ps --status running --services 2>/dev/null | grep -qx api; then
      docker compose exec -T api node /app/apps/api/src/bin/consumer-resume.ts {{ quote(name) }}
    else
      pnpm exec node apps/api/src/bin/consumer-resume.ts {{ quote(name) }}
    fi

# Generate a high-entropy KEK passphrase into secrets/master_key (mode 0400).
# Never an env var: env leaks into `docker inspect` and /proc/<pid>/environ (P0-2).
gen-master-key:
    #!/usr/bin/env bash
    set -euo pipefail
    mkdir -p "${SECRETS_DIR}"
    if [[ -e "${SECRETS_DIR}/master_key" ]]; then
      echo "refusing to overwrite ${SECRETS_DIR}/master_key" >&2
      echo "losing this passphrase means re-linking every provider (D5 scope rule)" >&2
      exit 1
    fi
    umask 077
    node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))' \
      > "${SECRETS_DIR}/master_key"
    # 0444, not 0400: Docker Compose's file-secret provider preserves this
    # file's own uid/mode verbatim inside every container that mounts it
    # rather than remapping to that service's runtime user (no per-service
    # uid/gid/mode override outside Swarm mode), and api/worker/migrator run
    # as uid 10001 — not whichever uid ran `just`. 0400 here means the
    # container can never read its own KEK. The actual confidentiality
    # boundary is SECRETS_DIR's own 0700, which only you and root can even
    # traverse into; 0444 on the file inside it does not weaken that
    # (compose.yml's secrets header has the same note).
    chmod 0444 "${SECRETS_DIR}/master_key"
    echo "wrote ${SECRETS_DIR}/master_key — back it up somewhere that is not this host"
    echo "run 'just harden-secrets' (needs sudo) to take it to 0400 owned by uid 10001"

# The 0400 posture packages/config/src/schema.ts and .env.example document
# (M-2), done the only way that actually reaches the container.
#
# Compose ignores `mode:`/`uid:` on file secrets outside Swarm — it bind-mounts
# the host file and the container sees the host's own uid/gid/mode. So the way
# to get `-r-------- 1 10001 10001 /run/secrets/master_key` is to make the HOST
# file exactly that. Which needs root, once, and is therefore a deliberate
# operator action rather than something `gen-*` does behind your back: after
# this runs you can no longer `cat ./secrets/master_key` without sudo either,
# which is the point.
#
# uid map (must match compose.yml): db 70, api/worker/migrator 10001, backup 10002.
harden-secrets:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "${SECRETS_DIR}"
    sudo chmod 0700 .
    # database_url, master_key, the three plaid_* secrets, and
    # advisor_token_secret are read by api/worker/migrator (10001). Keep this
    # list in step with compose.yml's `secrets:` on those services —
    # gate-security-review.md §8.2 N-1 / §8.11 D-4: the plaid_* secrets landed
    # in C-3, were mounted on api and worker, and were never added here, so
    # 0400-owned-by-you (what an operator gets from following RUNBOOK.md
    # "Create secrets" step 6 literally) made both api and worker crash-loop
    # on EACCES the moment Plaid was enabled. advisor_token_secret
    # (docs/evidence/phase-2/wp2.w-wiring.md) is added here for the same
    # reason, the same day it lands in compose.yml, not after. scripts/
    # check-secret-ownership.sh is the computed check that would catch this
    # list rotting again the way the image-prune delete set and the
    # Caddyfile's proxied prefixes both rotted before it.
    #
    # Phase 3 (docs/evidence/phase-3/wp3.w-wiring.md) adds seven more to the
    # same 10001 group, all on api+worker and none on migrator: WP 3.4's four
    # market-data provider keys, WP 3.5's CDP pair and WP 3.6's Etherscan key.
    # Added here in the same edit that adds them to compose.yml, which is the
    # whole lesson of N-1 — the plaid_* secrets were mounted for a release
    # before anyone noticed this list had not grown with them.
    for f in database_url migrator_database_url master_key plaid_client_id plaid_secret plaid_env advisor_token_secret \
             tiingo_api_key fred_api_key coingecko_api_key openfigi_api_key \
             coinbase_key_name coinbase_private_key etherscan_api_key; do
      [[ -e "$f" ]] || continue
      sudo chown 10001:10001 "$f" && sudo chmod 0400 "$f"
    done
    # pg_password is read by postgres itself (70) AND by the backup container
    # (10002), so it is the one file that genuinely needs a group: owner 70,
    # group 10002, 0440. Not 0400 — postgres refuses a secret it cannot read.
    if [[ -e pg_password ]]; then
      sudo chown 70:10002 pg_password && sudo chmod 0440 pg_password
    fi
    # age_recipient is a PUBLIC key, and — since WP 4.12b, C-5 — is now read
    # by both api (10001, GET /export?encrypt=true) and backup (10002,
    # docker/backup/backup.sh). Same shape as pg_password above: two
    # consuming uids means owner:group, not a second owner, and 0440 rather
    # than 0400. scripts/check-secret-ownership.sh derives and checks this
    # from compose.yml directly, so this line rotting again the way it did
    # for the plaid_* secrets (N-1) would be caught there even if this
    # comment is not read.
    if [[ -e age_recipient ]]; then
      sudo chown 10001:10002 age_recipient && sudo chmod 0440 age_recipient
    fi
    # b2 files are read by backup (10002) alone.
    for f in b2_key_id b2_application_key; do
      [[ -e "$f" ]] || continue
      sudo chown 10002:10002 "$f" && sudo chmod 0400 "$f"
    done
    ls -l
    echo "secrets hardened; 'just gen-*' after this needs sudo too (that is the trade)"

# Weekly soak report (WP 9.1; 09 §4 batch 9). The orchestrator's alone (Phase 9
# rule 5): it reads aggregates only, through scripts/soak/report.ts inside a
# throwaway api container. Run from the production clone with
# COMPOSE_PROJECT_NAME=personalfi-prod PERSONALFI_VERSION=<sha>
# SOAK_EVIDENCE_DIR=<dev checkout>/docs/evidence/phase-9/soak (RUNBOOK
# "Production install and the real-use soak").

# Every skipIf in a perf test must name its reason (WP 9.9; CI prints the list)
check-perf-skips:
    node scripts/check-perf-skips.ts

# The docs drift check (WP 9.12): README, RUNBOOK and the release notes name only recipes, variables, secrets, paths and links the tree has
check-docs:
    node scripts/check-docs.ts

# Weekly soak report from the production clone (WP 9.1; orchestrator only)
soak-report *args:
    bash scripts/soak/run-report.sh {{args}}

# Install git hooks (lefthook). Not run at install time: install scripts are off.
hooks:
    pnpm exec lefthook install
