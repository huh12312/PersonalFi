#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Verify a published release's images before they run (P1-5, CF-19, WP 9.10
# gap G-21; WP 9.11). `release.yml` signs every image keyless with cosign
# (GitHub OIDC -> Fulcio -> Rekor) and attests SLSA provenance in GitHub's
# attestation store; until now nothing ever checked either. This does, for
# each of the three images (api, backup, proxy):
#
#   1. resolves `ghcr.io/<owner>/personalfi-<image>:<release>` to a DIGEST once,
#      and from then on uses only the digest (a tag can move; a digest cannot);
#   2. `cosign verify`: the signature's certificate must name THIS repository's
#      `release.yml` at `refs/tags/v<release>`, issued by GitHub Actions' OIDC
#      issuer — and, with --commit, the workflow must have run at that exact
#      commit (`--certificate-github-workflow-sha`), which ties the image to the
#      source tree the operator has checked out;
#   3. `gh attestation verify`: the SLSA provenance for that digest must exist
#      and be signed for this repository.
#
# Both must pass for every image, or nothing is pulled and the exit is 1.
# With --pull it then pulls each image BY DIGEST and tags it locally as
# `<registry>/<image>:<version>` — the names compose.yml runs — so `docker
# compose up --no-build` starts exactly the bytes that were verified.
#
#   bash scripts/verify-release.sh --release 0.9.0 [--commit <sha>] [--owner huh12312] [--repo PersonalFi]
#   bash scripts/verify-release.sh --release 0.9.0 --commit <sha> --pull --registry personalfi --version <sha>
#   bash scripts/verify-release.sh --self-test     # needs the network; proves a known-bad digest is refused
#
# Tools: `cosign` (or Docker, which runs the pinned cosign image below), `gh`
# (logged in: the attestation API needs a token), `docker buildx` to resolve
# a tag. Prints references and digests only; writes nothing but the local tags.
set -euo pipefail

COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign:v2.6.1@sha256:68839b7f13dac5a6744a5d8818e984dd39183374e37855c19e14d623d9bc9037"
GITHUB_OIDC_ISSUER="https://token.actions.githubusercontent.com"
IMAGES=(api backup proxy)

OWNER="huh12312"
REPO="PersonalFi"
RELEASE=""
COMMIT=""
PULL=0
LOCAL_REGISTRY="${REGISTRY:-personalfi}"
LOCAL_VERSION="${PERSONALFI_VERSION:-}"

say() { echo "verify-release: $*"; }
die() {
  echo "verify-release: $*" >&2
  exit 1
}

cosign_cmd() {
  if command -v cosign >/dev/null 2>&1; then
    cosign "$@"
  else
    command -v docker >/dev/null 2>&1 || die "FAIL: neither \`cosign\` nor \`docker\` is on PATH"
    docker run --rm "$COSIGN_IMAGE" "$@"
  fi
}

# verify_signature <ref@digest> <identity> <issuer> [workflow sha] -> 0 verified, 1 not
verify_signature() {
  local ref="$1" identity="$2" issuer="$3" sha="${4:-}"
  local args=(verify --certificate-identity "$identity" --certificate-oidc-issuer "$issuer")
  [ -z "$sha" ] || args+=(--certificate-github-workflow-sha "$sha")
  cosign_cmd "${args[@]}" "$ref" >/dev/null 2>"${TMP}/cosign.err"
}

# verify_attestation <ref@digest> <owner/repo> -> 0 verified, 1 not
verify_attestation() {
  local ref="$1" repo="$2"
  command -v gh >/dev/null 2>&1 || die "FAIL: \`gh\` is not on PATH (needed for the provenance attestation)"
  gh attestation verify "oci://${ref}" --repo "$repo" >/dev/null 2>"${TMP}/gh.err"
}

resolve_digest() {
  local tagged="$1"
  docker buildx imagetools inspect "$tagged" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"'
}

is_digest() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }

run() {
  [ -n "$RELEASE" ] || die "FAIL: --release x.y.z is required (the tag without its v)"
  [[ "$RELEASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "FAIL: --release ${RELEASE} is not x.y.z"
  [ -z "$COMMIT" ] || [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "FAIL: --commit must be a 40-hex commit SHA"
  if [ "$PULL" -eq 1 ]; then
    [[ "$LOCAL_VERSION" =~ ^[0-9a-f]{40}$ ]] ||
      die "FAIL: --pull tags the verified images as <registry>/<image>:<version>; --version (or PERSONALFI_VERSION) must be a 40-hex SHA"
    [ -n "$COMMIT" ] || die "FAIL: --pull needs --commit: the images must be tied to the checked-out source"
  fi
  local owner_lower identity
  owner_lower="$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')"
  identity="https://github.com/${OWNER}/${REPO}/.github/workflows/release.yml@refs/tags/v${RELEASE}"

  local verified=() image tagged digest ref failed=0
  for image in "${IMAGES[@]}"; do
    tagged="ghcr.io/${owner_lower}/personalfi-${image}:${RELEASE}"
    digest="$(resolve_digest "$tagged" || true)"
    if ! is_digest "$digest"; then
      say "FAIL ${image}: could not resolve ${tagged} to a digest"
      failed=1
      continue
    fi
    ref="ghcr.io/${owner_lower}/personalfi-${image}@${digest}"
    if ! verify_signature "$ref" "$identity" "$GITHUB_OIDC_ISSUER" "$COMMIT"; then
      say "FAIL ${image}: cosign verify refused ${ref}: $(tail -1 "${TMP}/cosign.err")"
      failed=1
      continue
    fi
    if ! verify_attestation "$ref" "${OWNER}/${REPO}"; then
      say "FAIL ${image}: gh attestation verify refused ${ref}: $(tail -1 "${TMP}/gh.err")"
      failed=1
      continue
    fi
    say "OK ${image}: ${ref} (signed by ${identity}${COMMIT:+ at ${COMMIT}}; provenance attested)"
    verified+=("${image}=${ref}")
  done
  [ "$failed" -eq 0 ] || die "REFUSED: not every image verified; nothing was pulled"

  if [ "$PULL" -eq 1 ]; then
    local entry
    for entry in "${verified[@]}"; do
      image="${entry%%=*}"
      ref="${entry#*=}"
      docker pull --quiet "$ref" >/dev/null
      docker tag "$ref" "${LOCAL_REGISTRY}/${image}:${LOCAL_VERSION}"
      say "pulled ${ref} -> ${LOCAL_REGISTRY}/${image}:${LOCAL_VERSION}"
    done
  fi
  say "PASS: ${#verified[@]} image(s) verified for v${RELEASE}"
}

# A signed image with a known identity (cosign's own release), an unsigned one
# (the Alpine base this repo pins), and the signed one checked against the
# WRONG identity. The verifier must accept the first and refuse the other two;
# the attestation check must refuse the unsigned digest. Without the positive
# control a broken verifier (no network, wrong flags) would "refuse" everything
# and pass.
self_test() {
  local known_good="ghcr.io/sigstore/cosign/cosign@sha256:68839b7f13dac5a6744a5d8818e984dd39183374e37855c19e14d623d9bc9037"
  local known_good_identity="keyless@projectsigstore.iam.gserviceaccount.com"
  local known_good_issuer="https://accounts.google.com"
  local known_bad="docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
  local ours="https://github.com/${OWNER}/${REPO}/.github/workflows/release.yml@refs/tags/v0.0.0"
  local fails=0

  if verify_signature "$known_good" "$known_good_identity" "$known_good_issuer"; then
    say "self-test case 1: a signed image with its own identity verifies — ok"
  else
    say "self-test case 1 FAILED: the positive control did not verify: $(tail -1 "${TMP}/cosign.err")"
    fails=$((fails + 1))
  fi
  if verify_signature "$known_bad" "$ours" "$GITHUB_OIDC_ISSUER"; then
    say "self-test case 2 FAILED: an UNSIGNED digest verified"
    fails=$((fails + 1))
  else
    say "self-test case 2: the unsigned known-bad digest is refused — ok ($(tail -1 "${TMP}/cosign.err"))"
  fi
  if verify_signature "$known_good" "$ours" "$GITHUB_OIDC_ISSUER"; then
    say "self-test case 3 FAILED: a signature by someone else verified as this repository's release"
    fails=$((fails + 1))
  else
    say "self-test case 3: a valid signature with the wrong identity is refused — ok"
  fi
  if verify_attestation "$known_bad" "${OWNER}/${REPO}"; then
    say "self-test case 4 FAILED: the known-bad digest has an attestation for ${OWNER}/${REPO}"
    fails=$((fails + 1))
  else
    say "self-test case 4: no provenance attestation for the known-bad digest — refused — ok"
  fi
  # Argument refusals, offline.
  if (RELEASE="" run) >/dev/null 2>&1; then
    say "self-test case 5 FAILED: ran without --release"
    fails=$((fails + 1))
  else
    say "self-test case 5: no --release is refused — ok"
  fi
  if (RELEASE=0.9.0 PULL=1 LOCAL_VERSION=dev run) >/dev/null 2>&1; then
    say "self-test case 6 FAILED: --pull accepted the floating tag 'dev' as the local version"
    fails=$((fails + 1))
  else
    say "self-test case 6: --pull with a non-SHA version is refused — ok"
  fi
  [ "$fails" -eq 0 ] || die "SELF-TEST FAILED (${fails} case(s))"
  say "SELF-TEST PASS"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

MODE=run
while [ $# -gt 0 ]; do
  case "$1" in
    --self-test) MODE=self-test ;;
    --release) RELEASE="${2:-}"; shift ;;
    --commit) COMMIT="${2:-}"; shift ;;
    --owner) OWNER="${2:-}"; shift ;;
    --repo) REPO="${2:-}"; shift ;;
    --pull) PULL=1 ;;
    --registry) LOCAL_REGISTRY="${2:-}"; shift ;;
    --version) LOCAL_VERSION="${2:-}"; shift ;;
    -h | --help) sed -n '3,33p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [ "$MODE" = self-test ]; then self_test; else run; fi
