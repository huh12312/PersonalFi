# SPDX-License-Identifier: MIT
# PersonalFi task runner. `just --list` for the full set.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

# Local dev database. Loopback only, port 5433 so it cannot collide with a
# system Postgres.
export DATABASE_URL := env_var_or_default("DATABASE_URL", "postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev")
export SECRETS_DIR := env_var_or_default("SECRETS_DIR", justfile_directory() / "secrets")

_default:
    @just --list

# Install workspace dependencies exactly as the lockfile says.
install:
    pnpm install --frozen-lockfile

# Everything CI runs, in CI's order.
check: typecheck lint test

typecheck:
    pnpm run typecheck

# ESLint (including the import-boundary rule), the schema-ownership check, and formatting.
lint:
    pnpm run lint

format:
    pnpm run format

test:
    pnpm run test

# Unit tests only; needs no database.
test-unit:
    pnpm exec vitest run --project kernel --project config --project api --project platform

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

# Grep every compose file for privileged/network_mode:host/pid:host/a mounted
# Docker socket (P0-6). Wired into CI as the `compose-hardening` job.
compose-lint:
    bash scripts/compose-hardening-check.sh

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
    openssl rand -hex 32 > "${SECRETS_DIR}/pg_password"
    printf 'postgres://personalfi:%s@db:5432/personalfi\n' \
      "$(cat "${SECRETS_DIR}/pg_password")" > "${SECRETS_DIR}/database_url"
    # Parse it back before trusting it: a URL-unsafe password should never
    # reach this point given the hex alphabet above, but a broken
    # database_url is exactly the class of bug this recipe exists to
    # prevent, so it checks its own output rather than assuming.
    node -e "new URL(require('node:fs').readFileSync(process.argv[1], 'utf8').trim())" \
      "${SECRETS_DIR}/database_url"
    chmod 0444 "${SECRETS_DIR}/pg_password" "${SECRETS_DIR}/database_url"
    echo "wrote ${SECRETS_DIR}/pg_password and ${SECRETS_DIR}/database_url"

# Build the api/worker/migrator, backup, and proxy images.
build:
    docker compose build

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
# Spins up a throwaway Postgres container on the *existing* backend network,
# decrypts and pg_restores the newest backup into it via the backup image's
# own restore.sh, boots a throwaway api container against it, hits /ready,
# and compares row counts against the live `db` service. Everything it
# creates is torn down on exit (`trap ... EXIT`), pass or fail. Writes
# docs/evidence/ops/restore-drill-<date>.md.
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
    EVIDENCE="$ROOT/docs/evidence/ops/restore-drill-${DATE%%T*}.md"
    PG_DIGEST="postgres:18.6-alpine3.24@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2"
    DRILL_DB="restore-drill-db-$$"
    DRILL_API="restore-drill-api-$$"

    BACKUPS_VOLUME="$(docker volume ls --filter label=com.docker.compose.volume=backups --format '{{{{.Name}}' | head -1)"
    BACKEND_NETWORK="$(docker network ls --filter label=com.docker.compose.network=backend --format '{{{{.Name}}' | head -1)"
    if [ -z "$BACKUPS_VOLUME" ] || [ -z "$BACKEND_NETWORK" ]; then
      echo "restore-drill: backend network or backups volume not found — run 'docker compose up' (or 'create') at least once first" >&2
      exit 1
    fi

    SCRATCH_SECRETS="$(mktemp -d)"
    cleanup() {
      docker rm -f "$DRILL_DB" "$DRILL_API" >/dev/null 2>&1 || true
      rm -rf "$SCRATCH_SECRETS"
    }
    trap cleanup EXIT

    echo "restore-drill: starting scratch db ($DRILL_DB on $BACKEND_NETWORK) ..."
    docker run -d --name "$DRILL_DB" --network "$BACKEND_NETWORK" --network-alias restore-drill-db \
      -e POSTGRES_USER=personalfi -e POSTGRES_DB=personalfi_restore_drill \
      -e POSTGRES_PASSWORD_FILE=/run/secrets/pg_password \
      -v "$ROOT/secrets/pg_password:/run/secrets/pg_password:ro" \
      "$PG_DIGEST" >/dev/null

    echo -n "restore-drill: waiting for scratch db to accept connections "
    for _ in $(seq 1 30); do
      if docker exec "$DRILL_DB" pg_isready -U personalfi -d personalfi_restore_drill >/dev/null 2>&1; then
        echo "ok"; break
      fi
      echo -n "."; sleep 1
    done

    LATEST_BACKUP="$(docker run --rm -v "$BACKUPS_VOLUME:/backups:ro" alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b \
      sh -c "ls -1t /backups/personalfi-*.dump.age 2>/dev/null | head -1")"
    if [ -z "$LATEST_BACKUP" ]; then
      echo "restore-drill: no backup found in the backups volume — run 'just backup' first" >&2
      exit 1
    fi
    echo "restore-drill: restoring $LATEST_BACKUP"

    docker run --rm --network "$BACKEND_NETWORK" \
      -v "$BACKUPS_VOLUME:/backups:ro" \
      -v "$AGE_IDENTITY_FILE:/run/age_identity:ro" \
      -v "$ROOT/secrets/pg_password:/run/secrets/pg_password:ro" \
      -e PGHOST=restore-drill-db -e PGUSER=personalfi -e PGDATABASE=personalfi_restore_drill \
      -e PGPASSWORD_FILE=/run/secrets/pg_password -e AGE_IDENTITY_FILE=/run/age_identity \
      "${REGISTRY:-personalfi}/backup:${PERSONALFI_VERSION:-dev}" /usr/local/bin/restore.sh "$LATEST_BACKUP"

    RESTORED_TABLES="$(docker exec "$DRILL_DB" psql -U personalfi -d personalfi_restore_drill -tAc \
      "select count(*) from information_schema.tables where table_schema = 'public'")"
    RESTORED_MIGRATIONS="$(docker exec "$DRILL_DB" psql -U personalfi -d personalfi_restore_drill -tAc \
      "select coalesce(max(id), '(none)') from schema_migrations" 2>/dev/null || echo '(schema_migrations not present)')"

    LIVE_DB_CONTAINER="$(docker ps --filter label=com.docker.compose.service=db --format '{{{{.Names}}' | head -1)"
    if [ -n "$LIVE_DB_CONTAINER" ]; then
      LIVE_TABLES="$(docker exec "$LIVE_DB_CONTAINER" psql -U personalfi -d personalfi -tAc \
        "select count(*) from information_schema.tables where table_schema = 'public'")"
      LIVE_MIGRATIONS="$(docker exec "$LIVE_DB_CONTAINER" psql -U personalfi -d personalfi -tAc \
        "select coalesce(max(id), '(none)') from schema_migrations" 2>/dev/null || echo '(schema_migrations not present)')"
    else
      LIVE_TABLES="(live db service not running — could not compare)"
      LIVE_MIGRATIONS="(live db service not running — could not compare)"
    fi

    API_READY="skipped"
    if [ -n "${SKIP_API_BOOT:-}" ]; then
      API_READY="skipped (SKIP_API_BOOT set)"
    else
      echo "restore-drill: booting a throwaway api container against the restored db ..."
      # A scratch database_url pointed at the drill db, not the real one —
      # generated here rather than read from ./secrets, which never has (and
      # must never have) a URL for a database this script just created.
      printf 'postgres://personalfi:%s@restore-drill-db:5432/personalfi_restore_drill\n' \
        "$(cat "$ROOT/secrets/pg_password")" > "$SCRATCH_SECRETS/database_url"
      docker run -d --name "$DRILL_API" --network "$BACKEND_NETWORK" --user 10001:10001 \
        -e ROLE=api -e NODE_ENV=production -e HTTP_HOST=0.0.0.0 -e HTTP_PORT=8080 \
        -e SECRETS_DIR=/run/secrets \
        -v "$SCRATCH_SECRETS/database_url:/run/secrets/database_url:ro" \
        -v "$ROOT/secrets/master_key:/run/secrets/master_key:ro" \
        "${REGISTRY:-personalfi}/api:${PERSONALFI_VERSION:-dev}" >/dev/null 2>&1 || true
      sleep 5
      if docker exec "$DRILL_API" node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        API_READY="pass (200 from /ready)"
      else
        API_READY="fail or skipped — see docker logs $DRILL_API; not necessarily an infra defect, see evidence notes"
      fi
    fi

    mkdir -p "$ROOT/docs/evidence/ops"
    {
      echo "# Restore drill — $DATE"
      echo
      echo "- Backup restored: \`$LATEST_BACKUP\`"
      echo "- Restored db table count: $RESTORED_TABLES"
      echo "- Restored db schema_migrations max id: $RESTORED_MIGRATIONS"
      echo "- Live db table count: $LIVE_TABLES"
      echo "- Live db schema_migrations max id: $LIVE_MIGRATIONS"
      echo "- API /ready against restored db: $API_READY"
    } | tee "$EVIDENCE"
    echo "restore-drill: wrote $EVIDENCE"

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
    pnpm exec node apps/api/src/bin/bootstrap-user.ts "${args[@]}"

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
