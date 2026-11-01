# 13 — Publishing PersonalFi images to Docker Hub: an assessment

**Status.** Assessment for Chris's review (2026-11-01). Nothing here is built. Where a sentence
states what the pipeline does today it was read from the tree at `1e668e0`; where it states what
Docker Hub does it comes from Docker's documentation and is marked _verify_ where the sources
disagreed.

**The ask.** "Publish my docker image on to the docker hub so we can start to use it for broader
community updates and installation. Assess what pipeline changes/etc are needed."

---

## 1. Where it stands

The pipeline already publishes images, just not to Docker Hub, and it has never completed a
publish.

| Piece                                                 | State today                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trigger                                               | `release.yml` runs on a tag push `v<major>.<minor>.<patch>` only (06 §5.1).                                                                                                                                                                                                                                                                                 |
| Gate                                                  | The unattended upgrade from v0.1 to the tagged commit (`upgrade-test.yml`, WP 9.4), then a trivy scan of the three freshly built images; build/sign/publish runs only if both pass.                                                                                                                                                                          |
| Registry                                              | GHCR only: `ghcr.io/<owner>/personalfi-{api,backup,proxy}:<version>` and `:latest`.                                                                                                                                                                                                                                                                         |
| Architectures                                         | `linux/amd64,linux/arm64` by buildx + QEMU in one build step (the workflow comments mark the split point for native arm64 runners).                                                                                                                                                                                                                          |
| Provenance                                            | `actions/attest-build-provenance` → SLSA provenance in GitHub's attestation store, pushed to the registry too; `cosign sign --yes` keyless (OIDC → Fulcio → Rekor); syft SBOMs (SPDX + CycloneDX) attached to the GitHub release. Both attestations are deliberate (06 §5.3).                                                                                   |
| Verification on the install side                      | `scripts/verify-release.sh` resolves the GHCR tag to a digest once, checks the cosign certificate identity (this repository's `release.yml` at `refs/tags/v<x>`, optionally the exact commit) and the GitHub attestation, and only then pulls by digest and tags locally; `PERSONALFI_PULL=1 PERSONALFI_RELEASE=x.y.z just upgrade` runs it and starts with `--no-build` (WP 9.11). |
| Default install                                       | Builds from the checkout (`just build` in README "Install"; `just upgrade` rebuilds). Pull mode exists but is the exception, documented under RUNBOOK "Upgrade".                                                                                                                                                                                             |
| Image names                                           | Three names for one image: built locally as `personalfi/api:<sha>` (compose: `${REGISTRY:-personalfi}/api:${PERSONALFI_VERSION:-dev}`), published as `ghcr.io/<owner>/personalfi-api:<version>`, re-tagged by the verifier to the local name.                                                                                                                 |
| Releases                                              | One tag exists, `v0.9.0` (2026-10-10). Its workflow failed twice: the first time on the billing hold, the re-run on 2026-10-28 because that commit's images carry zod and follow-redirects CVEs fixed seventeen days later. `gh release list` is empty. **No PersonalFi image has ever been published anywhere.**                                             |
| Version numbering                                     | Two schemes: git tags (semver, one so far) and `docs/RELEASE-NOTES.md`, which ladders a `v0.9.N` per work package (now v0.9.27, each saying "tag them in order"). The tree is at v0.9.27 by the notes and v0.9.0 by the tags.                                                                                                                                 |
| Vulnerability posture of the images                   | `.trivyignore` snoozes six Caddy-binary findings (Go stdlib, x/net, go-jose) to 2026-11-07 because no upstream `caddy:2-alpine` build clears them; the api image's follow-redirects finding is snoozed to 2026-11-02 pending a bump due tonight. Snoozes are a CI policy; they do not travel with a published image.                                            |
| Community files                                       | `LICENSE` (MIT), `THIRD_PARTY.md` (generated, license-gated), `README.md` with an install walkthrough, `RUNBOOK.md`. **No `SECURITY.md`, no `CONTRIBUTING.md`, no support matrix.**                                                                                                                                                                             |

The short version: the hard parts — multi-arch builds, signing, provenance, SBOMs, a verifier that
refuses unsigned bytes, an upgrade path proven from v0.1 — exist. What is missing is a second
registry target, an install path that starts from a pull rather than a build, a release that
actually completes, and the community-facing hygiene a public image implies.

---

## 2. What Docker Hub changes, specifically

1. **Pull limits apply to the puller, per IP, and anonymous pulls are tight.** Docker's newer
   documentation gives 10 pulls per hour per IP for anonymous use and 40 per hour for an
   authenticated free account; paid accounts are unlimited ([Docker docs revision][hub-limits];
   older material still says 100 per 6 hours, so _verify_ on the official page before writing
   numbers into the README). A cold PersonalFi install pulls three PersonalFi images plus
   `postgres`, `alpine` and, with the local-model profile, `ollama` — and a multi-arch pull counts
   once per architecture. That fits inside 10 but leaves nothing for a retry. GHCR has no such
   anonymous cap for public images. **Recommendation: keep GHCR canonical, mirror to Docker Hub,
   and tell community users to `docker login` or use the GHCR name if they hit `429`.**
2. **The image is scanned in public.** Docker Hub shows Docker Scout findings on the repository
   page. Our `.trivyignore` snoozes are invisible there: a community user sees six HIGH/CRITICAL
   findings in the proxy image on day one. A finance app cannot launch like that. The Caddy
   from-source build (xcaddy on a patched Go), queued since 2026-10-10 as the fallback, becomes a
   **prerequisite**, not a fallback.
3. **Credentials.** Docker Hub organization access tokens can be scoped to selected repositories
   with read or read/write permission; read/write can push but cannot delete the repository
   ([Docker access-token reference][hub-oat]). The token goes into GitHub Actions secrets and is
   used only by `docker/login-action` in the release job; nothing else in CI logs in. The Hub
   account itself needs 2FA and the token a rotation note in the RUNBOOK.
4. **Signatures and attestations per registry.** The image digest is the same on both registries
   when both tags are pushed from one buildx step (one manifest list), so `gh attestation verify`
   — which is keyed by digest and repository, not by registry — keeps working for the Hub copy.
   cosign signatures, however, are stored next to the image in each registry, so `cosign sign`
   runs once per registry reference. Whether Docker Hub serves the OCI 1.1 referrers API or falls
   back to the `sha256-<digest>` tag convention is not settled in the sources I could read
   ([cosign bundle spec][cosign-spec]); cosign handles both, but the first publish should _verify_
   that `cosign verify` and `gh attestation verify` both pass against the Hub reference, and the
   release job should assert it before the GitHub release is created.
5. **Tag immutability.** Docker Hub can mark tags immutable per repository (_verify_ the setting's
   current name on the Hub repository settings page). Turn it on for every version tag; `latest`
   and the minor-line tag (`0.10`) stay movable by design.
6. **The README on the Hub page** is separate from GitHub's. It is kept in step by a pinned action
   that pushes a short file (what the image is, the three image names, the verify command, the
   link to the install guide) on every release.

---

## 3. Pipeline changes (the `release.yml` half)

Each item is additive to the workflow as it stands.

1. **A second login and a second tag set in the same build step.** `docker/login-action` for
   `docker.io` (username + the scoped token) beside the GHCR login; the build step's `tags:` gains
   `docker.io/<namespace>/personalfi-<image>:<version>`, `:<major>.<minor>` and `:latest`. One
   build, one manifest list, one digest, pushed to both registries — the digest equality is what
   lets the verifier and the attestation work for both.
2. **Sign both references.** `cosign sign --yes` on the GHCR reference and on the Hub reference
   (same digest). `actions/attest-build-provenance` once more with the Hub `subject-name`
   (`push-to-registry: true` for both).
3. **Verify before the release is cut.** A step after signing runs `cosign verify` and
   `gh attestation verify` against **both** references by digest, with the same identity regexp
   the install-side verifier uses. The GitHub release job `needs:` it. This is the step that
   proves point 2.4 above every time rather than once.
4. **Protect the publishing job.** A GitHub environment (`release`) with Chris as the required
   reviewer on the `build-sign-publish` job, since a publish is outward-facing and irreversible
   (tags can be overwritten but the pull has happened). The upgrade-test gate stays automatic; the
   push waits for a click.
5. **Tag policy in one place.** `<major>.<minor>.<patch>`, `<major>.<minor>`, `latest`, and
   `sha-<7>` (the sha tag closes WP 9.11's note that pull mode cannot pin to a commit today). The
   verifier's `--release` resolves the first; `PERSONALFI_VERSION` pins the local name to the sha
   as it does now.
6. **Hub README sync and Scout.** The pinned description-sync action after a successful publish;
   Docker Scout left on (it is the community's scanner; our job is to have nothing for it to show).
7. **Renovate.** The Hub namespace is a new datasource for nothing — Renovate tracks the base
   images we consume, not the ones we publish — so no change, but the new action pins join the
   digest-pinning rule.

Not changed: the upgrade-test gate, the trivy image scan (it keeps `--ignorefile`, which is why
§5's prerequisites matter), multi-arch, SBOM generation, the keyless identity.

---

## 4. The install side (the half the community actually touches)

1. **One image name.** Today the same bytes have three names (§1). The published name should be
   the compose name: `image: ${REGISTRY:-ghcr.io/<owner>}/personalfi-<image>:${PERSONALFI_VERSION:-dev}`
   with `REGISTRY` defaulting to the canonical registry and the local build using the same form
   (`REGISTRY=personalfi` stays possible for source builds). The verifier's local re-tag step then
   disappears. This touches `compose.yml`, the three Dockerfiles' consumers, `verify-release.sh`,
   the upgrade recipe, the upgrade-test harness (it tags W0 and HEAD images) and every doc that
   names `personalfi/backup:dev` (README step 5 does).
2. **A pull-first quickstart.** README "Install" today is build-first (step 4 `just build`). The
   community path is: clone (for `compose.yml`, `justfile`, `.env.example` and the recipes — a
   tarball of the release is enough, no toolchain), write `.env` with `PERSONALFI_VERSION` set to
   the release and `REGISTRY` left at the default, `just gen-pg-secrets`, `just gen-master-key`, the
   age keypair (step 5 uses the published backup image by name), then
   `PERSONALFI_PULL=1 PERSONALFI_RELEASE=x.y.z just up` — which verifies, pulls by digest and
   starts. Build-from-source moves to a "Developers" section. `just upgrade` in pull mode is the
   community upgrade; the first-install path and the upgrade path must share the verifier call.
3. **The verifier learns the registry.** `verify-release.sh --source ghcr.io/<owner>|docker.io/<ns>`
   (default canonical), resolving the digest from whichever the user can reach, with the identity
   check unchanged. The RUNBOOK's "verify a release without upgrading" paragraph shows both.
4. **No toolchain on the host.** The pull path must not need `pnpm`, `node` or `just`'s dev
   recipes. `just` itself and `docker compose` are the floor; `cosign` runs from its pinned
   container if absent; `gh` is needed only for the attestation half — document the
   `--skip-attestation` trade-off or ship the attestation check through cosign's bundle so `gh` is
   optional (_decide_; recommendation: cosign bundle, `gh` optional).
5. **`latest` for a finance app.** Offer it (Docker users expect it) but the docs pin a version and
   the upgrade path refuses `PERSONALFI_RELEASE=latest` — the verifier needs a tag that maps to one
   commit.

---

## 5. Prerequisites before the first public image

In order; each is small except the first.

1. **Clear the proxy image's findings for real (WP 12.1, M).** Build Caddy with xcaddy on a Go
   that carries the stdlib fixes (1.26.9+/1.27.2+ for the four Go findings, 1.26.10/1.27.3 for the
   x509 one) with `golang.org/x/net ≥ 0.60.0` and `go-jose/v4 ≥ 4.1.6`, in `docker/caddy.Dockerfile`
   as a pinned builder stage; drop the six snoozes; the proxy image scans clean on every push. This
   also removes the 2026-11-07 cliff. (The alternative, waiting for upstream, has been "no build
   yet" for three weeks.)
2. **Bump follow-redirects** (due 2026-11-01 21:32 UTC when 1.16.2 clears `minimumReleaseAge`) and
   drop its snooze. Already scheduled.
3. **One version scheme.** Decide (§8) and reconcile: either tag the ladder's current number or
   start the first public line at `v0.10.0` and fold the `v0.9.N` entries into one "0.10.0" section
   with a "from the ladder" note. Release notes must then name manual steps per published version
   only.
4. **A release that completes.** Cut the tag on a green commit after 1–3 and watch
   `release.yml` through to `gh release list` showing it, with `verify-release.sh` green against
   both registries. This is the first proof the publishing path works at all; do it on GHCR first
   if the Hub credentials are not ready, then re-run with both.
5. **Community files.** `SECURITY.md` (how to report, what is in scope, the response commitment,
   the signing identity to verify images), `CONTRIBUTING.md` (the `just verify` gate, the
   conventions docs, the no-live-vendor rule for tests), a support matrix in the README (amd64 and
   arm64 Linux; Docker Compose v2.x; Postgres is the pinned image; Raspberry Pi 5 is arm64 and
   should be stated as tested or untested), and the Hub README.
6. **Hub account hygiene.** The namespace created, 2FA on, the three repositories created as
   public with immutable version tags, a repository-scoped read/write token stored as
   `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` GitHub secrets, and a rotation note in the RUNBOOK.

---

## 6. Risks

- **A public image is a support surface.** Issues will arrive from installs we cannot see. The
  readiness `modules` line (WP 11.8), the control-checks self-test and `just soak-report` are the
  diagnostics; the SECURITY.md and a `BUG_REPORT` issue template that asks for `/ready`'s body
  (it carries no secrets) keep triage short.
- **Rate limits bite at the worst time.** A cold install that fails at the fourth pull looks like
  a broken product. The GHCR-canonical choice and a `docker login` line in the quickstart address
  it.
- **`latest` drift.** A user on `latest` who upgrades across a release with a manual step misses
  the step. The verifier's refusal of `latest` and the per-version notes are the mitigation.
- **Secrets in the pipeline.** The Hub token is the first long-lived credential the release
  workflow holds (everything else is OIDC). Repository-scoped, write-only to three repositories,
  used by one job behind an environment with a reviewer.
- **Snoozes are invisible to users; Scout is not.** Covered by §5.1; the rule from here on is that
  a published image ships with no suppressed HIGH/CRITICAL finding.
- **arm64 is cross-built under QEMU** and has never run on real arm64 hardware in this project. The
  support matrix should say "built, not yet exercised" until someone runs the upgrade test on an
  arm64 host (a Raspberry Pi 5 is enough).

---

## 7. Packages

| #    | Package                                                                                                                                                                                                       | Depends on | Size |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| 12.1 | **Caddy from source** on a patched Go in `docker/caddy.Dockerfile`; the six snoozes retired; the proxy image scans clean. Built 2026-11-01: Caddy v2.11.6 on Go 1.26.10, x/net v0.60.0, go-jose/v4 v4.1.6; trivy 6 → 0; evidence `docs/evidence/phase-12/wp12.1-caddy-from-source.md`                                                                                       | —          | M    |
| 12.2 | **Dual-registry release**: Hub login, tags, signing and attestation for both references, the verify-before-release step, the `release` environment, the `sha-<7>` tag, the Hub README sync                    | 12.1       | M    |
| 12.3 | **One image name and the pull-first install**: compose naming unified, `verify-release.sh --source`, `gh` optional via the cosign bundle, README quickstart rewritten pull-first with build-from-source under Developers, the upgrade-test harness adjusted | 12.2       | M    |
| 12.4 | **Community files**: `SECURITY.md`, `CONTRIBUTING.md`, the support matrix, the issue template, the Hub README file                                                                                           | —          | S    |
| 12.5 | **The first published release**: version scheme reconciled, the tag cut, `release.yml` watched to completion, both registries verified with the install-side verifier from a clean host (the upgrade-test harness can be the clean host) | 12.1–12.4  | S    |

12.1 and 12.4 can run now, in parallel. 12.2 and 12.3 are code and docs; 12.5 is Chris's hand at
the tag and the environment approval.

---

## 8. Decisions for Chris

1. **Namespace and canonical registry.** The Docker Hub namespace (`<user>` or an organisation —
   an organisation allows scoped tokens and a second maintainer later; recommendation: an
   organisation named for the project). GHCR canonical with the Hub as the mirror (recommended,
   for the pull limits), or the Hub canonical.
2. **Version.** Tag the ladder (`v0.9.27`) or start the public line at `v0.10.0` and collapse the
   ladder (recommended: `v0.10.0`; the ladder was an internal device).
3. **The release environment reviewer.** You, on every publish (recommended), or automatic after
   the gate.
4. **`latest`.** Published and documented as "not for upgrades" (recommended), or not published.
5. **arm64.** Published as "built, not yet exercised" (recommended), or amd64-only until an arm64
   host has run the upgrade test.
6. **`gh` on the install host.** Optional via the cosign bundle (recommended) or required.

[hub-limits]: https://github.com/docker/docs/pull/21494/files
[hub-oat]: https://docs.docker.com/security/access-tokens/reference/
[cosign-spec]: https://github.com/sigstore/cosign/blob/main/specs/BUNDLE_SPEC.md

---

## 9. Addendum (2026-11-01): mirror the PantryRadar setup

Chris: "I have other repos like PantryRadar that use the docker setup tied to github. Mirror that."
Read from `huh12312/pantryradar`'s `docker-publish.yml`: trigger on a `v*` tag push, gated on the
repository's own CI and E2E reusable workflows, `docker/login-action` with the username
`masterhuh` in the workflow and the token in the `DOCKER_PAT` secret, tags by
`docker/metadata-action` (`{{version}}`, `{{major}}.{{minor}}`, `latest`), `docker/build-push-action`
with the GHA cache, one image `masterhuh/pantryradar`. Its compose file pulls
`masterhuh/pantryradar:latest`; the Hub repository was created by the first push (Docker Hub
creates a public repository under your namespace on first push).

What this settles for 12.2: the namespace is **`masterhuh`** (no `DOCKERHUB_NAMESPACE` variable),
the images are `masterhuh/personalfi-{api,backup,proxy}`, the secret is **`DOCKER_PAT`** (the same
token value, set on this repository by Chris), the username is written in the workflow as
PantryRadar does, the tag set comes from `docker/metadata-action` with the same three patterns plus
`sha-<7>`, and no Hub repository is created by hand. What stays from this document, because it is
what a finance app's images need beyond PantryRadar's: actions pinned by commit SHA (06 §5.1),
the upgrade-test gate, multi-arch, cosign and provenance per registry, the verify-before-release
step, the reviewed `release` environment, and the version policy of D32.
