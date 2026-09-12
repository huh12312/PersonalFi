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
# Writes its transcript to docs/evidence/phase-0/.
drill-worker-restart:
    pnpm exec node scripts/wp03-worker-restart-drill.ts
