#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Production isolation guard (CF-20, CF-21; docs/plan/09-phase-9-dispatch.md
# §3 "WP 9.1"). Run before any command that could touch the production
# install's compose project, so a mistake that would otherwise destroy
# Chris's real data refuses before it starts, rather than after.
#
# Two findings, read in the code at `1417b36`, are what this guards against:
#
#   * CF-20: images are tagged `personalfi/api:${PERSONALFI_VERSION:-dev}`,
#     and every gate or agent `docker compose build` overwrites `:dev`. A
#     production stack running on `:dev` comes back up on unreviewed code at
#     its next `up` -- so production must pin a real commit SHA, never the
#     floating tag.
#   * CF-21: `compose.yml` has no top-level `name:`, so the compose project
#     is the *directory name* by default. A production install cloned into
#     this same checkout (or run with the dev checkout as its working
#     directory) would collide with whatever project name a gate or agent's
#     `down -v` targets -- so production must run from its own directory,
#     under its own project name, never this one.
#
# Three things are checked, independently, and every violation is named --
# not just the first:
#
#   1. the compose project is exactly `personalfi-prod` (09 §6 Q1's default);
#   2. the version is a 40-hex commit SHA, never the floating tag `dev`
#      (09 §6 Q1: `PERSONALFI_VERSION=<sha>`; 09 §4 wiring batch 4: "W-A:
#      PERSONALFI_VERSION documented as required non-dev for production");
#   3. the working directory is not this repository's own checkout -- the
#      tree an agent or a gate runs `docker compose … down -v` against
#      (Phase 5 gate §3.2; CF-21) -- so production is provably a *separate*
#      clone, never this one.
#
# Usage:
#
#   bash scripts/soak/check-isolation.sh [project] [version] [dir]
#   bash scripts/soak/check-isolation.sh --self-test
#
# Every argument falls back to an environment variable a real `docker
# compose` invocation already has set (`COMPOSE_PROJECT_NAME`,
# `PERSONALFI_VERSION`), then to a hostile default the first time it is run
# at all, so a caller that forgets to set either env var fails this check
# rather than silently passing. `dir` falls back to the current working
# directory, which is what `docker compose` itself resolves a project's
# files relative to.
#
# `PERSONALFI_DEV_CHECKOUT` overrides the known agent/gate checkout this
# script refuses to run production commands from. The default is this exact
# host's path, because this is a single-operator install on one named host
# (09 §6 Q1) -- not a guess, the literal directory every Phase 0-9 agent and
# gate has run `docker compose … down -v` against.
set -euo pipefail

DEFAULT_DEV_CHECKOUT="/home/chris/Projects/PersonalFi"
DEV_CHECKOUT="${PERSONALFI_DEV_CHECKOUT:-${DEFAULT_DEV_CHECKOUT}}"

# `realpath -m`: resolves symlinks and `..` without requiring the path to
# exist (a `--self-test` fixture directory under `mktemp -d` always exists,
# but there is no reason to require that of every caller).
resolve() {
  realpath -m "$1" 2>/dev/null || printf '%s' "$1"
}

# `check_isolation <project> <version> <dir>` -- prints one `REFUSED: …` line
# per violation to stderr and returns non-zero if any fired; otherwise prints
# one confirmation line to stdout and returns 0. Never `exit`s itself, so
# `--self-test` can call it repeatedly in one process.
check_isolation() {
  local project="$1" version="$2" dir="$3"
  local -a reasons=()

  if [ "${project}" != "personalfi-prod" ]; then
    reasons+=("the compose project is '${project}', not 'personalfi-prod' (CF-21)")
  fi

  if ! [[ "${version}" =~ ^[0-9a-f]{40}$ ]]; then
    reasons+=("PERSONALFI_VERSION is '${version}', not a 40-hex commit SHA (CF-20; 'dev' is never production)")
  fi

  local resolved_dir resolved_dev
  resolved_dir="$(resolve "${dir}")"
  resolved_dev="$(resolve "${DEV_CHECKOUT}")"
  if [ "${resolved_dir}" = "${resolved_dev}" ]; then
    reasons+=("the working directory (${resolved_dir}) is the agent/gate checkout (${resolved_dev}); production must be its own clone (CF-21)")
  fi

  if [ "${#reasons[@]}" -gt 0 ]; then
    echo "check-isolation: REFUSED" >&2
    for reason in "${reasons[@]}"; do
      echo "  - ${reason}" >&2
    done
    return 1
  fi

  echo "check-isolation: ok (project=${project}, version=${version}, dir=${resolved_dir})"
  return 0
}

self_test() {
  echo "check-isolation: --self-test" >&2
  local failures=0
  local scratch
  scratch="$(mktemp -d)"
  local fake_sha="0123456789abcdef0123456789abcdef01234567"

  # 1. The dev/gate project name is refused, even with every other input good.
  if check_isolation "personalfi" "${fake_sha}" "${scratch}" >/dev/null 2>&1; then
    echo "check-isolation: SELF-TEST FAILED: project 'personalfi' was not refused" >&2
    failures=$((failures + 1))
  else
    echo "check-isolation: self-test 1/4 ok -- project 'personalfi' refused" >&2
  fi

  # 2. The floating tag 'dev' is refused, even with every other input good.
  if check_isolation "personalfi-prod" "dev" "${scratch}" >/dev/null 2>&1; then
    echo "check-isolation: SELF-TEST FAILED: version 'dev' was not refused" >&2
    failures=$((failures + 1))
  else
    echo "check-isolation: self-test 2/4 ok -- version 'dev' refused" >&2
  fi

  # 3. This checkout's own directory is refused, even with every other input
  # good. Run from inside the real checkout (DEV_CHECKOUT itself, or this
  # script's own repository if the override was not set), so the assertion
  # is against the real directory an agent/gate actually works in, not a
  # synthetic stand-in.
  local this_repo
  this_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  if check_isolation "personalfi-prod" "${fake_sha}" "${this_repo}" >/dev/null 2>&1; then
    echo "check-isolation: SELF-TEST FAILED: this checkout's directory (${this_repo}) was not refused" >&2
    failures=$((failures + 1))
  else
    echo "check-isolation: self-test 3/4 ok -- this checkout's directory refused" >&2
  fi

  # 4. The converse: every input good is accepted. Without this, self-tests
  # 1-3 could pass by refusing everything unconditionally.
  if check_isolation "personalfi-prod" "${fake_sha}" "${scratch}" >/dev/null 2>&1; then
    echo "check-isolation: self-test 4/4 ok -- a genuinely isolated invocation is accepted" >&2
  else
    echo "check-isolation: SELF-TEST FAILED: a genuinely isolated invocation was refused" >&2
    failures=$((failures + 1))
  fi

  rm -rf "${scratch}"

  if [ "${failures}" -gt 0 ]; then
    echo "check-isolation: --self-test FAILED (${failures} assertion(s))" >&2
    return 1
  fi
  echo "check-isolation: --self-test PASSED (4/4)" >&2
  return 0
}

main() {
  if [ "${1:-}" = "--self-test" ]; then
    self_test
    return $?
  fi

  local project version dir
  project="${1:-${COMPOSE_PROJECT_NAME:-}}"
  version="${2:-${PERSONALFI_VERSION:-}}"
  dir="${3:-$(pwd)}"
  check_isolation "${project}" "${version}" "${dir}"
}

main "$@"
