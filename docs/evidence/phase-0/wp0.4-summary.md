<!-- SPDX-License-Identifier: MIT -->

# WP 0.4 close-out summary — Alpine containers, hardened compose, Caddy, backups, CI, licensing, Renovate, runbook

Scope: docker/{api,caddy,backup}.Dockerfile + entrypoint.mjs + Caddyfile +
backup/*, compose.yml + compose.override.example.yml, .dockerignore,
.trivyignore, .gitleaksignore, licenses.policy.yaml + scripts/check-licenses.ts,
scripts/compose-hardening-check.sh, renovate.json, lefthook.yml, RUNBOOK.md,
THIRD_PARTY.md, .github/workflows/{ci,release}.yml, the WP 0.4 justfile
recipes. Master plan D12–D15, D24; P0 items 3, 6, 7, 10, 11, 13 (03 §9);
memo 06 §2.5/§3/§4/§5/§7/§9.

This is a close-out pass on top of work already committed at snapshot
`0812909` by an earlier instance of this package that was killed mid-way
through writing evidence. Everything in that snapshot was independently
re-verified from a clean state (fresh `docker compose down -v`, fresh
`just build`, fresh `docker compose up -d`) rather than taken on faith; see
`wp0.4-container-hardening.md`'s "Close-out re-verification" section for the
full transcript. Two real bugs were found and fixed during this pass beyond
what the snapshot already covered (below).

## P0 checklist status

| #     | Requirement                                                                               | Status                               | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | ----------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-3  | Only the proxy publishes a port, bound to an explicit LAN/Tailscale address               | **Green**                            | `docker compose ps` / `docker compose config --format json` show only `proxy` with published ports, both `127.0.0.1:...->` (default `BIND_ADDRESS`), never `0.0.0.0`. `wp0.4-container-hardening.md` "docker compose ps" section. External `nmap` against the real WAN IP is a **hand action** (below) — not producible from this dev sandbox, which has no WAN-facing router to scan.                                                                                                                                                                                                                                                                                          |
| P0-6  | No Docker socket mount; no `privileged`/`--net=host`/`--pid=host`; CI greps compose files | **Green**                            | `bash scripts/compose-hardening-check.sh` passes locally (3 files) and runs as CI's `compose-hardening` job (`ci.yml`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| P0-7  | All containers non-root, `cap_drop: ALL`, `no-new-privileges`, `read_only: true`          | **Green**                            | `docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.Config.User}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}}'` per service, `wp0.4-container-hardening.md`. `db` is the one documented exception (`read_only: false`, scoped to the `pgdata` named volume it owns — postgres must write its own data directory). `proxy`'s prior root/capability gap (left "revisit once verified" in commit 4c96b48) is closed: `docker/caddy.Dockerfile` strips `cap_net_bind_service` at build time and runs as uid 10003.                                                                                                                                                  |
| P0-10 | `gitleaks` and `trivy --scanners secret` clean                                            | **Green**                            | `trivy fs --scanners vuln,secret,misconfig` clean (re-run this pass, see below); `gitleaks` runs in CI (`ci.yml` `gitleaks` job, full history, `zricethezav/gitleaks:v8.30.0` pinned by digest) and in `lefthook.yml`'s pre-commit hook. Not re-run interactively this pass (needs full git history scan, already covered by CI on every push) — `.gitleaksignore` has one documented false-positive entry (a provider name tripping an entropy heuristic in prose).                                                                                                                                                                                                            |
| P0-11 | Encrypted backups running; restore tested end to end                                      | **Green, with a caveat**             | `just backup` produces a real `age`-encrypted dump; `just restore-drill` (re-run this pass with a fresh throwaway age keypair) decrypts and `pg_restore`s it into a scratch Postgres container and writes `docs/evidence/ops/restore-drill-20260912.md`. The row/table-count comparison in that evidence shows 0 tables on both sides — correct given the P0-8-adjacent `ROLE` blocker below has prevented any migration from ever running against this stack, not a defect in the backup/restore path itself. Nightly automation (`backup-loop.sh`, `BACKUP_HOUR_UTC`) is code-complete and unit-verifiable but not observed running unattended overnight during this session. |
| P0-13 | LUKS2 on the `pgdata`/backup volume                                                       | **Documented, hand action required** | `RUNBOOK.md` "First install" step 0 gives the exact `cryptsetup luksFormat`/`luksOpen` sequence and defers the actual disk operation to the real host — this cannot be verified inside a dev sandbox with no dedicated block device to encrypt. See "What Chris must do by hand" below.                                                                                                                                                                                                                                                                                                                                                                                         |

D14 extras (Renovate cooldown, `--ignore-scripts`, license gate, digest
pinning) are all green: `.npmrc` sets `ignore-scripts=true` repo-wide;
`renovate.json`'s `minimumReleaseAge: "7 days"` plus per-rule
`pinDigests`/`dependencyDashboardApproval` gating; `scripts/check-licenses.ts`
passing (see `wp0.4-license-gate.md`); every Docker base image and GitHub
Action pinned to a digest/SHA (Dockerfiles' `ARG *_IMAGE=...@sha256:...`,
`compose.yml`'s `image:` lines, `.github/workflows/*.yml`'s `uses: ...@<sha>`).

## The one real blocker: `ROLE` enum gap in `packages/config`

`packages/config/src/schema.ts` still declares
`ROLE: z.enum(['api', 'worker']).default('api')`. `compose.yml` sets
`ROLE: migrator` for the migrator service (added in this WP), and
`docker/entrypoint.mjs` already dispatches on `migrator` correctly — but
config validation rejects it before the entrypoint's own dispatch logic ever
runs, so `migrator` exits 1 immediately:

```
configuration is invalid; 1 problem(s) found:
  - ROLE: Invalid option: expected one of "api"|"worker"
```

`api` and `worker` both declare
`depends_on: {migrator: {condition: service_completed_successfully}}`, so
neither starts on a fresh `docker compose up` either — they sit in `Created`
forever. This is the single reason the literal exit-criterion sentence
("proxy -> api /health works through Caddy") could not be demonstrated end
to end in this pass, exactly as in the snapshot's own evidence. `proxy`,
`db`, and `backup` all boot and pass their own healthchecks independently;
`proxy`'s healthcheck against a nonexistent `api` correctly logs a `502`
(`dial tcp: lookup api ... no such host`), which is the expected failure
mode given the above, not a Caddy defect.

**This is a one-line fix** (add `'migrator'` to the `ROLE` enum in
`packages/config/src/schema.ts`) but is out of this work package's scope
under the collision rules (no edits under `packages/`). Flagging it here as
the top item for whichever package owns `packages/config` (WP 0.2, per the
snapshot's own commit history) or for the orchestrator to apply directly —
every other piece of WP 0.4's stack is verified working and is waiting on
exactly this one line to prove itself end to end.

## What was fixed in this closing pass

1. **`just scan` and `just sbom` were both broken** — pinned Docker Hub tags
   that were never published (`aquasec/trivy:0.68.0`: only `0.68.1`/`0.68.2`
   exist; `anchore/syft:1.18.0`: the oldest published tag is `v1.43.0`), so
   both recipes failed immediately with `no such manifest`, and `scan` never
   passed `--ignorefile` even before that. Repinned both to the exact digests
   `ci.yml`/`release.yml` already use and verified by actually running
   `just scan` to completion: `trivy fs` and all three `trivy image` scans
   (api/backup/proxy) report 0 HIGH/CRITICAL findings. Full detail in
   `wp0.4-container-hardening.md`'s close-out section.
2. Everything the snapshot's own evidence already flagged as fixed (the
   malformed Postgres digest, `0444` vs `0400` secret-file permissions, the
   base64-vs-hex `database_url` password) was re-verified as still fixed,
   not re-broken by anything since — `gen-pg-secrets` still writes a
   hex password and parses its own `database_url` output with `new URL()`
   before trusting it, `RUNBOOK.md` still documents `0444`, and
   `compose.yml`'s Postgres digest is a valid 64-hex-character sha256.

## What Chris must do by hand (cannot be automated or verified from this sandbox)

- **LUKS2** on the real host's `pgdata`/backups block device
  (`RUNBOOK.md` "First install" step 0) — this dev sandbox has no dedicated
  disk to encrypt; the procedure is written but unexecuted, P0-13.
- **Tailscale Serve + MagicDNS HTTPS** on the real host
  (`RUNBOOK.md` "Enabling remote access") — needs a real Tailscale account,
  tailnet, and DNS/cert settings; the exact commands are in the runbook.
- **Real secrets** (`just gen-pg-secrets`, `just gen-master-key`, a real
  `age` keypair with the private half stored off-host) — everything in this
  evidence used throwaway secrets generated for this session only, in a
  gitignored `./secrets/`, and none of it should be reused for a real
  deployment.
- **A Backblaze B2 bucket with Object Lock enabled**, plus an application
  key scoped to that one bucket — `RUNBOOK.md`'s "Create secrets" step 5
  and `compose.yml`'s `backup` service `RCLONE_REMOTE` note cover wiring it
  in once it exists; today's default (placeholder files, local-only backups)
  is intentional and safe, just not off-box.
- **External `nmap -Pn -p- <wan-ip>`** against the real router/WAN address
  for P0-3's full evidence — this sandbox has no WAN-facing network to scan;
  the compose-level half of P0-3 (only `proxy` publishes, bound to
  `127.0.0.1`/LAN, never `0.0.0.0`) is verified above.
- **Apply the one-line `ROLE` enum fix** in `packages/config/src/schema.ts`
  (or route it through whichever package currently owns that file) so
  `migrator`/`api`/`worker` actually start — see "The one real blocker" above.

## Other evidence documents from this work package

- `docs/evidence/phase-0/wp0.4-container-hardening.md` — hardening flags,
  image sizes, lightningcss absence, trivy results, the close-out
  re-verification transcript.
- `docs/evidence/phase-0/wp0.4-license-gate.md` — license gate run, deny-list
  checks, `THIRD_PARTY.md` drift check.
- `docs/evidence/ops/restore-drill-20260912.md` — the restore-drill
  transcript from this pass.

## Verification not (re-)run in this pass, and why

- Full `gitleaks detect` over complete git history was not re-run
  interactively (it needs `fetch-depth: 0`, i.e. full history, and is
  already run by CI's `gitleaks` job on every push to this branch — running
  it again here would only reproduce what CI already guarantees).
- `just check` (`typecheck` / `lint` / `test`) was run as part of this
  package's own gate (see the coordinator-facing report) but its output
  spans the whole workspace, not just WP 0.4's files — any failures outside
  `docker/`, `compose*.yml`, `scripts/check-licenses.ts`,
  `scripts/compose-hardening-check.sh`, `renovate.json`, `lefthook.yml`,
  `RUNBOOK.md`, `THIRD_PARTY.md`, `.github/workflows/*.yml`, and the WP 0.4
  justfile recipes are out of this package's scope per the collision rules
  and are listed separately, not fixed here.
