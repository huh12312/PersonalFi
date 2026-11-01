#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Verify a published release's images before they run (P1-5, CF-19, WP 9.10
# gap G-21; WP 9.11; WP 12.3). `release.yml` signs every image keyless with
# cosign (GitHub OIDC -> Fulcio -> Rekor) on both registries and attests SLSA
# provenance in GitHub's attestation store. This checks, for each of the three
# images (api, backup, proxy):
#
#   1. resolves `<source>/personalfi-<image>:<release>` to a DIGEST once, and
#      from then on uses only the digest (a tag can move; a digest cannot);
#   2. `cosign verify`: the signature's certificate must name THIS repository's
#      `release.yml` at `refs/tags/v<release>`, issued by GitHub Actions' OIDC
#      issuer — and, with --commit, the workflow must have run at that exact
#      commit (`--certificate-github-workflow-sha`), which ties the image to the
#      source tree the operator has checked out;
#   3. `gh attestation verify`: the SLSA provenance for that digest must exist
#      and be signed for this repository. Needs `gh`, logged in. Without it the
#      check is SKIPPED with a warning (the signature in 2 still binds each
#      digest to release.yml at v<release>); --strict refuses instead.
#
# Every image must pass before anything is pulled; otherwise the exit is 1 and
# nothing is pulled. With --pull each image is then pulled BY DIGEST, and the
# release tag is pulled after it: the tag must resolve to the digest that was
# verified, or it is removed again and the exit is 1. The name that arrives is
# the published name, `<source>/personalfi-<image>:<release>`, which is the
# name compose.yml runs when REGISTRY=<source> and PERSONALFI_VERSION=<release>
# (WP 12.3: one name per image; nothing is re-tagged), so `docker compose up
# --no-build --pull never` starts exactly the bytes that were verified.
#
#   bash scripts/verify-release.sh --release 0.10.0                      # GHCR, the canonical copy
#   bash scripts/verify-release.sh --release 0.10.0 --source masterhuh   # the Docker Hub mirror
#   bash scripts/verify-release.sh --release 0.10.0 --commit <sha> --pull [--strict]
#   bash scripts/verify-release.sh --self-test     # needs the network; a known-good and a known-bad image
#
# --source: `ghcr.io/huh12312` (default) or `docker.io/masterhuh` (`masterhuh`
# is accepted for it); any other registry/namespace is read the same way and
# must still carry release.yml's signature to pass. --release must be x.y.z:
# `latest` and `x.y` move with every release and name no single commit.
#
# Tools: `cosign` v3 (or Docker, which runs the pinned cosign v3 image below),
# `docker buildx` to resolve a tag, `gh` (optional, see 3). Prints references
# and digests only; writes nothing but the pulled images.
set -euo pipefail

# cosign v3.1.4 (2026-10-20), by digest. v3, because release.yml signs with
# cosign v3 (cosign-installer v4.1.2's default, v3.0.6), whose `sign` writes
# the new Sigstore bundle as an OCI referrer; cosign v2's `verify` defaults to
# the legacy signature tag and reports "no signatures found" for exactly those
# signatures (WP 12.2 §6; WP 12.3 shows it against a real v3-signed image).
# v3.1.4 rather than the signer's v3.0.6 because v3.1.3 fixed a HIGH
# verification bypass (GHSA-fx35-mq7g-6g98) on the verifying side.
COSIGN_IMAGE="ghcr.io/sigstore/cosign/cosign:v3.1.4@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d"
GITHUB_OIDC_ISSUER="https://token.actions.githubusercontent.com"
IMAGES=(api backup proxy)
CANONICAL_SOURCES=("ghcr.io/huh12312" "docker.io/masterhuh")

OWNER="huh12312"
REPO="PersonalFi"
SOURCE="ghcr.io/huh12312"
RELEASE=""
COMMIT=""
PULL=0
STRICT=0

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

# 0 when `gh` is on PATH and logged in (the attestation API needs a token).
gh_ready() {
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1
}

# verify_attestation <ref@digest> <owner/repo> -> 0 verified, 1 not
verify_attestation() {
  local ref="$1" repo="$2"
  gh attestation verify "oci://${ref}" --repo "$repo" >/dev/null 2>"${TMP}/gh.err"
}

resolve_digest() {
  local tagged="$1"
  docker buildx imagetools inspect "$tagged" --format '{{json .Manifest.Digest}}' 2>/dev/null | tr -d '"'
}

is_digest() { [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]]; }

# `masterhuh` is the Docker Hub mirror's short name; everything else as given,
# without a trailing slash.
normalise_source() {
  local s="${1%/}"
  case "$s" in
    masterhuh) s="docker.io/masterhuh" ;;
  esac
  printf '%s' "$s"
}

image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }

run() {
  [ -n "$RELEASE" ] || die "FAIL: --release x.y.z is required (the tag without its v)"
  [[ "$RELEASE" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    die "REFUSED: --release '${RELEASE}' is not x.y.z ('latest' and 'x.y' move with every release and name no single commit: pin a version)"
  [ -z "$COMMIT" ] || [[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "FAIL: --commit must be a 40-hex commit SHA"
  SOURCE="$(normalise_source "$SOURCE")"
  [[ "$SOURCE" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] ||
    die "FAIL: --source '${SOURCE}' is not a registry[/namespace] (for example ghcr.io/huh12312 or docker.io/masterhuh)"
  local known=0 c
  for c in "${CANONICAL_SOURCES[@]}"; do [ "$c" = "$SOURCE" ] && known=1; done
  [ "$known" -eq 1 ] ||
    say "note: ${SOURCE} is not one of this project's registries (${CANONICAL_SOURCES[*]}); its images pass only with release.yml's signature"

  local attest=1
  if ! gh_ready; then
    if [ "$STRICT" -eq 1 ]; then
      die "REFUSED (--strict): \`gh\` is not on PATH or not logged in, so the provenance attestation cannot be checked; nothing was resolved or pulled"
    fi
    attest=0
    say "WARNING: \`gh\` is not on PATH or not logged in: the provenance-attestation check is SKIPPED. The cosign signature still binds each digest to release.yml at v${RELEASE}. Install gh and \`gh auth login\`, or pass --strict to refuse without it."
  fi

  local identity
  identity="https://github.com/${OWNER}/${REPO}/.github/workflows/release.yml@refs/tags/v${RELEASE}"

  local verified=() image repo tagged digest ref failed=0
  for image in "${IMAGES[@]}"; do
    repo="${SOURCE}/personalfi-${image}"
    tagged="${repo}:${RELEASE}"
    digest="$(resolve_digest "$tagged" || true)"
    if ! is_digest "$digest"; then
      say "FAIL ${image}: could not resolve ${tagged} to a digest"
      failed=1
      continue
    fi
    ref="${repo}@${digest}"
    if ! verify_signature "$ref" "$identity" "$GITHUB_OIDC_ISSUER" "$COMMIT"; then
      say "FAIL ${image}: cosign verify refused ${ref}: $(tail -1 "${TMP}/cosign.err")"
      failed=1
      continue
    fi
    if [ "$attest" -eq 1 ] && ! verify_attestation "$ref" "${OWNER}/${REPO}"; then
      say "FAIL ${image}: gh attestation verify refused ${ref}: $(tail -1 "${TMP}/gh.err")"
      failed=1
      continue
    fi
    say "OK ${image}: ${ref} (signed by ${identity}${COMMIT:+ at ${COMMIT}}; provenance $([ "$attest" -eq 1 ] && echo attested || echo 'NOT checked: gh unavailable'))"
    verified+=("${image}=${ref}")
  done
  [ "$failed" -eq 0 ] || die "REFUSED: not every image verified; nothing was pulled"

  if [ "$PULL" -eq 1 ]; then
    local entry want got
    for entry in "${verified[@]}"; do
      image="${entry%%=*}"
      ref="${entry#*=}"
      repo="${ref%@*}"
      tagged="${repo}:${RELEASE}"
      # The verified bytes first, by digest; then the release tag, which gives
      # them the published name compose runs. A tag that moved in between
      # names other bytes: refuse, and take that name away again.
      docker pull --quiet "$ref" >/dev/null || die "FAIL ${image}: docker pull ${ref} failed"
      docker pull --quiet "$tagged" >/dev/null || die "FAIL ${image}: docker pull ${tagged} failed"
      want="$(image_id "$ref")"
      got="$(image_id "$tagged")"
      if [ -z "$want" ] || [ "$want" != "$got" ]; then
        docker image rm "$tagged" >/dev/null 2>&1 || true
        die "REFUSED ${image}: ${tagged} no longer names the verified ${ref} (image ${got:-none} != ${want:-none}); the tag was removed again"
      fi
      say "pulled ${ref} as ${tagged}"
    done
  fi
  say "PASS: ${#verified[@]} image(s) verified for v${RELEASE} from ${SOURCE}$([ "$attest" -eq 1 ] || echo ' (attestations not checked)')"
}

# The positive control is a public image signed the way release.yml signs:
# keyless, by a GitHub Actions workflow (OIDC issuer token.actions…), with
# cosign v3's new bundle format stored as an OCI referrer — trivy v0.74.0, the
# scanner this repository already pins by this digest (ci.yml, the justfile),
# signed by aquasecurity/trivy's reusable-release.yaml at refs/tags/v0.74.0.
# cosign v2's default reports "no signatures found" for it, which is why the
# pin above is v3. Then an unsigned image (the Alpine base this repo pins),
# and the signed one against the WRONG identity and the wrong commit. The
# verifier must accept the first and refuse the rest; without the positive
# control a broken verifier (no network, wrong flags, a v2 cosign) would
# "refuse" everything and pass.
self_test() {
  local known_good="docker.io/aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969"
  local known_good_identity="https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v0.74.0"
  local known_bad="docker.io/library/alpine@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6"
  local ours="https://github.com/${OWNER}/${REPO}/.github/workflows/release.yml@refs/tags/v0.0.0"
  local fails=0

  if verify_signature "$known_good" "$known_good_identity" "$GITHUB_OIDC_ISSUER"; then
    say "self-test case 1: a GitHub-workflow keyless signature (cosign v3 bundle) with its own identity verifies — ok"
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
    say "self-test case 3 FAILED: a signature by another workflow verified as this repository's release"
    fails=$((fails + 1))
  else
    say "self-test case 3: a valid signature with the wrong identity is refused — ok"
  fi
  if verify_signature "$known_good" "$known_good_identity" "$GITHUB_OIDC_ISSUER" "0000000000000000000000000000000000000000"; then
    say "self-test case 4 FAILED: a signature made at another commit passed the --commit check"
    fails=$((fails + 1))
  else
    say "self-test case 4: the right identity at the wrong commit is refused — ok"
  fi
  if gh_ready; then
    if verify_attestation "$known_bad" "${OWNER}/${REPO}"; then
      say "self-test case 5 FAILED: the known-bad digest has an attestation for ${OWNER}/${REPO}"
      fails=$((fails + 1))
    else
      say "self-test case 5: no provenance attestation for the known-bad digest — refused — ok"
    fi
  else
    say "self-test case 5: skipped — \`gh\` is not on PATH or not logged in (the attestation half is optional; --strict requires it)"
  fi
  # Argument refusals, offline.
  if (RELEASE="" run) >/dev/null 2>&1; then
    say "self-test case 6 FAILED: ran without --release"
    fails=$((fails + 1))
  else
    say "self-test case 6: no --release is refused — ok"
  fi
  local floating
  for floating in latest 0.10 v0.10.0; do
    if (RELEASE="$floating" run) >/dev/null 2>&1; then
      say "self-test case 7 FAILED: --release ${floating} was accepted"
      fails=$((fails + 1))
    else
      say "self-test case 7: --release ${floating} is refused — ok"
    fi
  done
  if (
    gh_ready() { return 1; }
    RELEASE=0.10.0 STRICT=1 run
  ) >/dev/null 2>&1; then
    say "self-test case 8 FAILED: --strict ran without gh"
    fails=$((fails + 1))
  else
    say "self-test case 8: --strict without gh is refused — ok"
  fi
  if (RELEASE=0.10.0 SOURCE='ghcr.io/x;y' run) >/dev/null 2>&1; then
    say "self-test case 9 FAILED: a malformed --source was accepted"
    fails=$((fails + 1))
  else
    say "self-test case 9: a malformed --source is refused — ok"
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
    --source) SOURCE="${2:-}"; shift ;;
    --commit) COMMIT="${2:-}"; shift ;;
    --owner) OWNER="${2:-}"; shift ;;
    --repo) REPO="${2:-}"; shift ;;
    --pull) PULL=1 ;;
    --strict) STRICT=1 ;;
    --registry | --version)
      die "$1 was removed in v0.10.0 (WP 12.3): a pulled image keeps its published name, which is compose's when REGISTRY=<source> and PERSONALFI_VERSION=<release>; use --source"
      ;;
    -h | --help) sed -n '3,43p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
  shift
done

if [ "$MODE" = self-test ]; then self_test; else run; fi
