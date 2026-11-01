#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# A local build must never carry a published release's name (WP 12.3).
#
# compose.yml names every PersonalFi image the way release.yml publishes it,
# `${REGISTRY:-ghcr.io/huh12312}/personalfi-<image>:${PERSONALFI_VERSION:-dev}`,
# so the name a verified pull arrives under is the name compose runs. The
# other side of that coin: `docker compose build` with PERSONALFI_VERSION set
# to a release (say 0.10.0) under a publishing registry would tag bytes built
# from whatever is checked out as `ghcr.io/huh12312/personalfi-api:0.10.0` —
# a local image posing as the signed release, which a later `up --no-build`
# would run without anything having verified it. `just build` and `just
# upgrade`'s build path run this first and refuse that, by name.
#
# Refused: an image under ghcr.io/huh12312, masterhuh or docker.io/masterhuh
# named personalfi-<anything> whose tag has a published shape: x.y.z, x.y,
# `latest` or `sha-<7 hex>`. Allowed: anything else — `dev` (the default), a
# 40-hex commit (the production pin), another REGISTRY (`personalfi`, the
# upgrade test's `pf-upgrade`).
#
#   bash scripts/build-name-guard.sh <image ref>...
#   bash scripts/build-name-guard.sh --self-test
set -euo pipefail

PUBLISHING='^(ghcr\.io/huh12312|masterhuh|docker\.io/masterhuh|index\.docker\.io/masterhuh)/personalfi-[a-z0-9-]+$'
PUBLISHED_TAG='^([0-9]+\.[0-9]+(\.[0-9]+)?|latest|sha-[0-9a-f]{7})$'

# 0 if building <ref> would pose as a published image.
poses_as_release() {
  local ref="$1" name tag
  case "$ref" in
    *@*) return 1 ;; # a digest reference is never built
  esac
  name="${ref%:*}"
  tag="${ref##*:}"
  [ "$name" != "$ref" ] || tag="latest" # no tag means :latest
  [[ "$name" =~ $PUBLISHING ]] && [[ "$tag" =~ $PUBLISHED_TAG ]]
}

guard() {
  local bad=() ref
  for ref in "$@"; do
    if poses_as_release "$ref"; then bad+=("$ref"); fi
  done
  if [ "${#bad[@]}" -gt 0 ]; then
    echo "build-name-guard: REFUSED: a local build would carry a published release's name:" >&2
    printf '  - %s\n' "${bad[@]}" >&2
    echo "  Install a release with \`just install-release <x.y.z>\` (verified pull), or build under another tag" >&2
    echo "  (unset PERSONALFI_VERSION for \`dev\`, or a commit SHA) or another REGISTRY (for example \`personalfi\`)." >&2
    return 1
  fi
}

self_test() {
  local fails=0 ref
  for ref in ghcr.io/huh12312/personalfi-api:0.10.0 masterhuh/personalfi-proxy:0.10 \
    docker.io/masterhuh/personalfi-backup:latest ghcr.io/huh12312/personalfi-api:sha-53413c4 \
    ghcr.io/huh12312/personalfi-api; do
    if poses_as_release "$ref"; then echo "build-name-guard: self-test refuses ${ref} — ok"; else
      echo "build-name-guard: SELF-TEST FAILED: ${ref} was allowed" >&2
      fails=$((fails + 1))
    fi
  done
  for ref in ghcr.io/huh12312/personalfi-api:dev "ghcr.io/huh12312/personalfi-api:$(printf 'a%.0s' {1..40})" \
    personalfi/personalfi-api:0.10.0 pf-upgrade/personalfi-proxy:53413c4-wp94 127.0.0.1:5001/personalfi-api:0.10.0 \
    ghcr.io/huh12312/personalfi-api@sha256:0000000000000000000000000000000000000000000000000000000000000000; do
    if poses_as_release "$ref"; then
      echo "build-name-guard: SELF-TEST FAILED: ${ref} was refused" >&2
      fails=$((fails + 1))
    else echo "build-name-guard: self-test allows ${ref} — ok"; fi
  done
  [ "$fails" -eq 0 ] || { echo "build-name-guard: SELF-TEST FAILED (${fails})" >&2; return 1; }
  echo "build-name-guard: SELF-TEST PASS"
}

if [ "${1:-}" = "--self-test" ]; then self_test; else guard "$@"; fi
