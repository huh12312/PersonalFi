#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# The weekly soak report, run the way the orchestrator runs it
# (docs/plan/09-phase-9-dispatch.md §3 "WP 9.1" part 3; RUNBOOK "Production
# install and the real-use soak"). Never run by an agent against `personalfi-prod`
# (Phase 9 rule 5): the report is the orchestrator's alone, and reads aggregates only.
#
# `docker/api.Dockerfile` deletes `scripts/` from the image, so the report is not
# shipped by the build. This wrapper bind-mounts the ONE file `report.ts` (and the
# clock file), read-only, into a throwaway `api` container of the production
# project -- the image's own `packages/` resolve its relative imports, and its own
# `database_url` secret is the connection -- and runs it with `--entrypoint node`
# (the image's entrypoint is tini + the ROLE dispatcher). The container's rootfs is
# read-only and uid 10001 cannot write the checkout, so the report goes to STDOUT and
# this script writes the file, atomically, only when the report succeeded.
#
# Usage, from the production clone (`~/personalfi-prod`):
#
#   COMPOSE_PROJECT_NAME=personalfi-prod PERSONALFI_VERSION=<40-hex sha> \
#     bash scripts/soak/run-report.sh [--as-of 2026-11-09T12:00:00Z] [--label TEXT]
#
#   -> docs/evidence/phase-9/soak/week-<ISO week of the as-of>.md
#
# Environment: SOAK_EVIDENCE_DIR (default <clone>/docs/evidence/phase-9/soak) is where the weekly
# file is written and clock.md read; SOAK_CLOCK_FILE overrides the clock path alone.
#
# Refuses (check-isolation.sh) unless the project is `personalfi-prod`, the version
# a 40-hex SHA, and the directory is not the agent/gate checkout.
#
# `--scratch`: for walking the procedure against a prod-like SCRATCH project
# (WP 9.1's `pf-prodlike`). The project must match ^pf-[a-z0-9-]+$ -- `personalfi`
# and `personalfi-prod` are refused in this mode -- and the output goes to the path
# in SOAK_SCRATCH_OUT (default: stdout), never into docs/evidence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRATCH=0
PASSTHROUGH=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scratch) SCRATCH=1 ;;
    *) PASSTHROUGH+=("$1") ;;
  esac
  shift
done

PROJECT="${COMPOSE_PROJECT_NAME:-}"
VERSION="${PERSONALFI_VERSION:-}"

if [ "${SCRATCH}" -eq 1 ]; then
  if ! [[ "${PROJECT}" =~ ^pf-[a-z0-9-]+$ ]]; then
    echo "run-report: --scratch needs COMPOSE_PROJECT_NAME matching ^pf-[a-z0-9-]+\$ (got '${PROJECT}')" >&2
    exit 1
  fi
else
  bash "${ROOT}/scripts/soak/check-isolation.sh" "${PROJECT}" "${VERSION}" "${ROOT}"
fi

# The production clone is pinned to a SHA and is not where evidence is committed: point these
# at the dev checkout's `docs/evidence/phase-9/soak` (where Chris's attestations are pushed from
# and the weekly files are committed) and the report reads the clock there and writes there.
SOAK_DIR="${SOAK_EVIDENCE_DIR:-${ROOT}/docs/evidence/phase-9/soak}"
CLOCK="${SOAK_CLOCK_FILE:-${SOAK_DIR}/clock.md}"
[ -f "${CLOCK}" ] || { echo "run-report: ${CLOCK} does not exist (the day-one attestation lives there)" >&2; exit 1; }

TMP="$(mktemp)"
trap 'rm -f "${TMP}"' EXIT

docker compose -p "${PROJECT}" -f "${ROOT}/compose.yml" run --rm -T --no-deps \
  --entrypoint node \
  -v "${ROOT}/scripts/soak/report.ts:/app/scripts/soak/report.ts:ro" \
  -v "${CLOCK}:/soak/clock.md:ro" \
  api /app/scripts/soak/report.ts --clock /soak/clock.md --out - "${PASSTHROUGH[@]}" >"${TMP}"

if [ ! -s "${TMP}" ]; then
  echo "run-report: the report is empty; nothing written" >&2
  exit 1
fi

if [ "${SCRATCH}" -eq 1 ]; then
  if [ -n "${SOAK_SCRATCH_OUT:-}" ]; then
    cp "${TMP}" "${SOAK_SCRATCH_OUT}"
    echo "run-report: scratch report -> ${SOAK_SCRATCH_OUT}" >&2
  else
    cat "${TMP}"
  fi
  exit 0
fi

# The file name is the ISO week of the report's own as-of, which the header names.
WEEK="$(grep -m1 -oE '^# Soak report -- [0-9]{4}-W[0-9]{2}' "${TMP}" | grep -oE '[0-9]{4}-W[0-9]{2}')"
OUT="${SOAK_DIR}/week-${WEEK}.md"
mv "${TMP}" "${OUT}"
chmod 0644 "${OUT}"
echo "run-report: wrote ${OUT}" >&2
