<!-- SPDX-License-Identifier: MIT -->

# Phase 0 gate remediation 2 — CI coverage, backup verification, CSP drift, config validation

Scope: the nine findings from the Phase 0 re-gate's sub-audits (HIGH: CI test
coverage, the backup byte-floor false rejection; MEDIUM: the proxy image's
missing `check-sw-precache.ts` step, the CSP e2e test server's drifted policy,
the lost theme-toggle smoke test; LOW: `TRUST_PROXY` documentation, the
compose-hardening gate's bind-mount/named-volume rules, a pre-push guard for
the `.gitleaksignore` true positive, and `AUTH_RP_ID`/`SESSION_COOKIE_SECURE`
boot validation).

Every claim below is a command run against this working tree, with its real
output. Repo `/home/chris/Projects/PersonalFi`, branch `main`. Docker 29.7.2,
Docker Compose v5.5.1, Node v26.8.1, Postgres 18.6-alpine.

---

## Summary

| #   | Finding                                                               | Status | Proof |
| --- | --------------------------------------------------------------------- | ------ | ----- |
| 1   | CI never ran `*-db`/`web` vitest projects or Playwright               | Fixed  | §1    |
| 2   | proxy image skipped `check-sw-precache.ts`                            | Fixed  | §2    |
| 3   | CSP e2e test server sent 4 directives, not the full policy            | Fixed  | §3    |
| 4   | smoke suite lost the theme-toggle browser test                        | Fixed  | §4    |
| 5   | `TRUST_PROXY` undocumented in `.env.example`                          | Fixed  | §5    |
| 6   | compose-hardening gate missed sensitive bind paths + volume ownership | Fixed  | §6    |
| 7   | no pre-push guard against pushing the pinned true-positive history    | Fixed  | §7    |
| 8   | `AUTH_RP_ID`/`SESSION_COOKIE_SECURE` under-validated at boot          | Fixed  | §8    |
| 9   | backup byte floor rejected a genuinely valid fresh-install dump       | Fixed  | §9    |

Nothing deferred.

---

## 1. CI never ran the `*-db` vitest projects, the `web` project, or Playwright

`vitest.config.ts` defines 13 root-config projects. Before this fix, CI's
`test` job ran only `kernel`, `config`, `api`, and `migration-test` ran only
`db` — `platform`, `testkit`, `seed`, `secretbox`, `identity` (no database
needed) and `platform-db`, `secretbox-db`, `identity-db`, `api-db` (need
Postgres) never ran in CI at all. `apps/web` has its own vitest config (`web`
project) and its own Playwright config (`chromium`, `csp` projects), neither
of which any CI job touched.

**Project → job map** (also recorded as a comment block at the top of
`.github/workflows/ci.yml`):

| Job              | Vitest/Playwright projects                                                        | Needs Postgres          |
| ---------------- | --------------------------------------------------------------------------------- | ----------------------- |
| `test`           | `kernel`, `config`, `api`, `platform`, `testkit`, `seed`, `secretbox`, `identity` | No                      |
| `migration-test` | `db`, `platform-db`, `secretbox-db`, `identity-db`, `api-db`                      | Yes (service container) |
| `web`            | `web` (vitest); `chromium` + `csp` (Playwright)                                   | No                      |

Verified every project name vitest knows appears in exactly one job:

```
$ pnpm exec vitest list --project kernel --project config --project db \
    --project platform --project platform-db --project testkit --project seed \
    --project secretbox --project secretbox-db --project identity \
    --project identity-db --project api --project api-db --filesOnly
```

lists all 13 projects' files; cross-referenced against the two `pnpm exec
vitest run --project ...` command lines in `ci.yml` (`test` and
`migration-test` jobs) — every name appears exactly once, none twice, none
missing.

Local proof, run against this working tree (no DATABASE_URL — reproduces the
`test` job exactly):

```
$ pnpm exec vitest run --project kernel --project config --project api \
    --project platform --project testkit --project seed --project secretbox \
    --project identity
 Test Files  27 passed (27)
      Tests  263 passed | 4 skipped (267)
```

With `DATABASE_URL` set (reproduces `migration-test`):

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run --project db --project platform-db --project secretbox-db \
    --project identity-db --project api-db
 Test Files  16 passed (16)
      Tests  207 passed (207)
   Duration  45.27s
```

`web` job reproduced locally (`apps/web`):

```
$ pnpm --filter @app/web test          # Test Files 8 passed (8), Tests 35 passed (35)
$ pnpm --filter @app/web build         # runs gen, vite build, check-sw-precache.ts, check-csp.ts — all OK
$ pnpm exec playwright test --project chromium   # 3 passed
$ pnpm exec playwright test --project csp        # 2 passed
```

`migration-test`'s timeout was raised 15 → 25 minutes to give the four
additional `*-db` projects room; the local run above took 45s against a warm
Postgres, well inside the new budget once CI's Postgres-service startup is
added.

Files: `.github/workflows/ci.yml`.

---

## 2. `docker/caddy.Dockerfile`'s web-build stage skipped `check-sw-precache.ts`

The stage ran `vite build` and `check-csp.ts` but never
`scripts/check-sw-precache.ts` — the check that the dev-only kitchen-sink
route's chunk stays excluded from the service worker's precache manifest on
the artifact this image actually ships, not just in a local `pnpm run build`.

Fix: added `pnpm --filter '@app/web' exec node scripts/check-sw-precache.ts`
to the build chain, between `vite build` and `check-csp.ts` (matching
`apps/web/package.json`'s own `build` script order).

Proof — rebuilt the proxy image:

```
$ docker compose build proxy
...
#15 11.57 mode      injectManifest
#15 11.57 precache  50 entries (1202.88 KiB)
#15 11.57 files generated
#15 11.57   dist/sw.js
#15 12.03 OK — dist/sw.js's precache manifest excludes the dev kitchen-sink chunk.
#15 12.20 OK — 1 HTML file(s) under dist/ have no inline <script> or style=.
 Image personalfi/proxy:dev Built
```

Both checks run and pass; the build succeeds end to end.

Files: `docker/caddy.Dockerfile`.

---

## 3. CSP e2e test server sent 4 directives, not the full production policy

`apps/web/e2e/csp-static-server.mjs` hard-coded
`script-src 'self'; style-src-elem 'self'; style-src-attr 'unsafe-inline'; connect-src 'self'`
— a subset that had already drifted from `docker/Caddyfile`'s actual policy
(missing `default-src`, `img-src`, `font-src`, `worker-src`, `manifest-src`,
`object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'`,
`form-action 'self'`). The `csp` Playwright project was proving the app
survives a _weaker_ policy than production ships.

Fix: the server now reads `docker/Caddyfile` at runtime and parses the
`Content-Security-Policy "..."` line out of the `(security_headers)` snippet
with a regex, so the two cannot drift apart again — change the Caddyfile and
the test server picks it up on its next run, no separate edit. Docstrings in
both `csp-static-server.mjs` and `csp.spec.ts` updated to describe this
instead of naming a fixed directive list.

Proof — ran the `csp` Playwright project against the _parsed, full_ policy:

```
$ pnpm --filter @app/web exec playwright test --project csp
  ✓  1 [csp] › e2e/csp.spec.ts:59:1 › the toast, warning, and update-prompt code paths all render under CSP (798ms)
  ✓  2 [csp] › e2e/csp.spec.ts:45:1 › the kitchen sink renders a toast and a dialog with zero CSP violations (868ms)
  2 passed (14.0s)
```

Zero `securitypolicyviolation` events under the real, full policy (11
directives vs. the previous 4).

Files: `apps/web/e2e/csp-static-server.mjs`, `apps/web/e2e/csp.spec.ts`.

---

## 4. Smoke suite lost the theme-toggle browser test

The pre-auth-guard version of `smoke.spec.ts` asserted the theme toggle
flipped `data-theme` on `<html>` at `/`. Once `/_app`'s `beforeLoad` guard
started bouncing an unauthenticated visitor to `/login`, `/` no longer
rendered `TopBar` (the toggle's only home), and the test was dropped rather
than moved — a real regression in browser coverage with no vitest equivalent
(happy-dom cannot prove a real click flips a real attribute).

Chose the "add a minimal control to the login screen" option over routing
through the dev-only kitchen-sink page: the kitchen-sink route only renders
both themes side by side for visual comparison, it has no interactive toggle,
so it could not exercise the actual toggle behavior the original test proved.
A real login-screen control is also a small, defensible UX improvement on its
own (an unauthenticated visitor can pick light/dark before signing in,
instead of being stuck with whatever `prefers-color-scheme` guessed).

Fix: added a minimal `ThemeToggle` button to `LoginScreen`'s
`AuthScreenFrame` (`apps/web/src/features/auth/LoginScreen.tsx`), reusing the
same `useThemePreference`/`useResolvedTheme` hooks and persisted store
`TopBar` uses, so the two stay in sync. Restored the test in
`smoke.spec.ts` against `/login`.

Proof:

```
$ pnpm --filter @app/web exec playwright test --project chromium
  ✓  1 [chromium] › e2e/smoke.spec.ts:50:1 › the theme toggle on the login screen flips data-theme on <html> (1.4s)
  ✓  2 [chromium] › e2e/smoke.spec.ts:28:1 › the login screen switches to the recovery-code fallback (1.5s)
  ✓  3 [chromium] › e2e/smoke.spec.ts:19:1 › an unauthenticated visitor is redirected to /login (2.7s)
  3 passed (16.4s)
```

`apps/web`'s vitest suite re-run to confirm the `LoginScreen` change broke
nothing: `Test Files 8 passed (8)`, `Tests 35 passed (35)`. `pnpm run
typecheck` clean.

Files: `apps/web/src/features/auth/LoginScreen.tsx`, `apps/web/e2e/smoke.spec.ts`.

---

## 5. `TRUST_PROXY` undocumented in `.env.example`

Added, with the hop-count semantics from `packages/config/src/schema.ts`
(each increment removes exactly that many entries from the right of
`X-Forwarded-For` before trusting what remains; `0` disables forwarded-header
parsing; default `1` matches this repo's own one-Caddy-hop topology).

Files: `.env.example`.

---

## 6. compose-hardening gate: sensitive bind paths and named-volume ownership

Two gaps: (a) a _read-only_ bind mount under `/run`, `/var/run`, `/proc`,
`/sys`, or `/dev` still lets a container connect to a socket, open a device,
or read host process/kernel state through it — `:ro` only blocks writes
through the filesystem interface, not what the opened object itself allows —
and the gate only caught this for filenames matching a container-runtime
socket regex; (b) `WRITABLE_NAMED_VOLUMES` was keyed by volume name alone, so
once a name like `pgdata` was allow-listed, _any_ service could mount it
writable, not just `db`.

Fix (`scripts/compose-hardening-check.sh`):

- New rule `sensitive-host-path-bind-mount`: any bind mount whose source is,
  or is under, `/run`, `/var/run`, `/proc`, `/sys`, `/dev` is flagged
  regardless of `read_only`.
- `WRITABLE_NAMED_VOLUMES` is now keyed `"<volume>:<service>"`. A writable
  mount of a documented volume by a service other than its documented owner
  is a new rule, `writable-volume-wrong-service`, distinct from
  `writable-named-volume` (an undocumented volume name entirely).
- `EXPECTED_RULES` extended from 17 to 19.
- `scripts/fixtures/compose-hostile.yml` extended: `hostile-capabilities` now
  also bind-mounts `/proc:/host-proc:ro` (sensitive path, read-only — must
  still fire); `hostile-ports` now also mounts the real `pgdata` volume
  writable under a service that is not `db`.

Proof:

```
$ bash scripts/compose-hardening-check.sh --self-test
  fixture triggered 19 distinct rule(s): cap-add container-runtime-socket devices
  host-cgroup host-ipc host-network host-pid host-userns missing-cap-drop-all
  missing-no-new-privileges missing-read-only port-bind-address privileged
  root-user security-opt-unconfined sensitive-host-path-bind-mount
  writable-bind-mount writable-named-volume writable-volume-wrong-service
compose-hardening-check: SELF-TEST PASS (all 19 rules fire on a hostile file)

$ bash scripts/compose-hardening-check.sh
  compose.dev.yml: 1 service(s), 0 violation(s), 1 documented exception(s)
  compose.override.example.yml: template with no active services (nothing to check)
  compose.yml: 9 service(s), 0 violation(s), 1 documented exception(s)
compose-hardening-check: PASS (3 file(s) checked: compose.dev.yml compose.override.example.yml compose.yml)
```

Real compose files pass cleanly with zero violations; the hostile fixture
still fails on all 19 (was 17) rules, including both new ones.

Files: `scripts/compose-hardening-check.sh`, `scripts/fixtures/compose-hostile.yml`.

---

## 7. No pre-push guard against publishing the pinned `.gitleaksignore` true positive

`.gitleaksignore` carries two TRUE-POSITIVE fingerprints (commit `c7846dc`,
`docs/evidence/phase-0/wp0.2-summary.md`) for a live bootstrap enrolment
token that reached history before it was ever redeemed. The file's own header
states this is tolerable _only_ because "there is no remote — nothing has
ever been pushed — so the history is local and can still be rewritten
cheaply." Nothing previously enforced that condition.

Fix: `scripts/check-history-rewrite-before-push.sh` — fails (message
`rewrite history with git filter-repo before first push`) exactly when
`git remote` is non-empty and both pinned fingerprint lines are still present
in `.gitleaksignore`; no-ops (exit 0) when there is no remote. Wired into
`just verify` and into a new `pre-push` block in `lefthook.yml`.

Proof:

```
$ git remote
                                            # (empty)
$ bash scripts/check-history-rewrite-before-push.sh
check-history-rewrite-before-push: no remote configured — nothing to check
$ echo $?
0

$ git remote add tmp https://example.invalid/x.git
$ bash scripts/check-history-rewrite-before-push.sh
check-history-rewrite-before-push: FAIL: a git remote is configured and .gitleaksignore
  still allowlists the c7846dc6282f6ae7156e56b36f47a8de14d969aa true-positive fingerprints for docs/evidence/phase-0/wp0.2-summary.md
  (a live bootstrap enrolment token reachable in history — see that file's header).
  rewrite history with git filter-repo before first push
$ echo $?
1

$ git remote remove tmp
$ bash scripts/check-history-rewrite-before-push.sh
check-history-rewrite-before-push: no remote configured — nothing to check
```

Remote removed afterwards; `git remote` confirmed empty again before moving
on.

Files: `scripts/check-history-rewrite-before-push.sh` (new), `justfile`,
`lefthook.yml`.

---

## 8. `AUTH_RP_ID`/`SESSION_COOKIE_SECURE` under-validated at boot

Two gaps in `packages/config/src/load.ts`:

- `AUTH_RP_ID` was only checked against a fixed loopback-host set
  (`localhost`, `127.0.0.1`, …) in production. A bare label that is not a
  loopback host but is also not a registrable domain — `lan`, `com`, or any
  other single-label value — passed silently. None of these can ever
  register a WebAuthn credential (no dot means it cannot be the effective
  domain of any real origin), so this is the same P0-4 failure mode
  (silent-and-wrong) the existing checks target, just not fully covered.
- `SESSION_COOKIE_SECURE=false` (which exists only for a plain-HTTP
  integration test harness) had no production gate at all — left set, the
  session cookie would ride along on plain HTTP the moment TLS termination
  was ever bypassed or misconfigured.

Fix:

- New `BARE_SUFFIX_RP_IDS` denylist (`lan`, `local`, `localdomain`,
  `localhost`, `internal`, `home`, `test`, `invalid`, `com`, `net`, `org`,
  `io`, `dev`, `app`, `co`) plus a "must contain a dot" check, applied in
  production, as an `else if` alongside the existing loopback-default check
  (so `localhost` still reports its original, more specific message rather
  than two).
- `SESSION_COOKIE_SECURE=false` in production now throws a `ConfigError`
  naming the setting.

Proof — new/extended cases in `packages/config/src/load.test.ts`, all
passing:

```
$ pnpm exec vitest run --project config
 Test Files  2 passed (2)
      Tests  54 passed (54)
```

Cases added: `AUTH_RP_ID` of `lan`/`com`/`localhost` rejected in production
(`it.each`), an arbitrary single-label id (`nas`) also rejected, a bare label
still accepted outside production (`lan` in `NODE_ENV=test`, unchanged
behavior); `SESSION_COOKIE_SECURE` defaults `true` and boots in production,
`SESSION_COOKIE_SECURE=false` throws in production naming the key, and
`SESSION_COOKIE_SECURE=false` still works outside production (the test
harness's own use case).

Re-ran the broader api/identity suites (which set `AUTH_RP_ID` to various
production-like and non-production values) to confirm no regression:

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run --project api --project api-db --project identity --project identity-db
 Test Files  15 passed (15)
      Tests  178 passed (178)
```

Files: `packages/config/src/load.ts`, `packages/config/src/load.test.ts`.

---

## 9. Backup byte floor rejected a genuinely valid fresh-install dump

`docker/backup/backup.sh` refused to promote any `pg_dump -Fc` output under
`MIN_DUMP_BYTES` (1024) _before_ ever looking at the archive's structure. On
a fresh install — migrations applied, at most a handful of rows, no other
data yet — a real dump can legitimately be small. Dump size tracks how much
_data_ exists, not whether the archive is valid, so it was the wrong thing to
gate promotion on; a new install's first nights are exactly the state this
would misfire against, turning a correct backup into a false "unhealthy"
that would then (on a real 30-day cycle) risk pruning being reached with no
verified backup ever having been produced.

Investigated whether the reported 840-byte dump was genuinely tiny-but-valid
or truncated: built and booted the full production stack
(`docker compose up -d`, throwaway secrets already present under
`./secrets/` from prior local setup — never real credentials, never
committed) against a freshly-created database with only the three shipped
migrations applied (`personalfi-migrator-1` logged `applied 0001_initial`,
`0002_identity`, `0003_platform`; `migrations complete: 3 applied, 0 already
present`) and no user data. A `pg_dump -Fc` of that exact state produced a
**65,910-byte**, 154-object archive — comfortably over the old 1024-byte
floor. So the floor was not what the specific number quoted would have
tripped in this schema's current shape; regardless, gating on size at all is
the wrong control for a database whose data volume legitimately varies from
"empty" to "years of transactions," and the fix removes that dependency
entirely rather than tune the constant.

Fix: replaced the byte-floor gate with a purely structural one. Order is now:
`pg_dump` must exit 0 (unchanged) → `pg_restore --list` must parse the
archive (unchanged, previously secondary, now the only size-independent
gate) → the parsed table of contents must have at least `MIN_TOC_ENTRIES`
(default 10; our schema has ~154 once every migration is applied, so 10 is
comfortably below "any real dump" and comfortably above "a near-empty stub")
→ the TOC must name the `schema_migrations` table specifically, proof this is
a dump of _our_ schema and not, say, an empty or unrelated database. Byte
count is still logged for operators but no longer gates promotion.
`RUNBOOK.md`'s "what successful means" section and `MIN_DUMP_BYTES` →
`MIN_TOC_ENTRIES` renamed throughout.

Proof — booted the real production stack with throwaway secrets, ran the
backup by hand against the fresh, migrations-only database, and confirmed
success and a healthy container:

```
$ docker compose up -d --build
 ... personalfi-migrator-1: applied 0001_initial, 0002_identity, 0003_platform
 ... Container personalfi-backup-1  Up (health: starting)

$ docker compose exec backup /usr/local/bin/backup.sh
backup: dumping personalfi@db ...
backup: verified 65910 bytes, 154 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20260913T114413Z.dump.age (66126 bytes)
backup: pruning entries older than 30 day(s) locally
backup: RCLONE_REMOTE not set; local-only backup (see RUNBOOK.md to enable B2)
backup: complete

$ docker compose exec backup /usr/local/bin/healthcheck.sh; echo "exit: $?"
healthy: last backup 1s ago: /backups/personalfi-20260913T114413Z.dump.age (65910 plaintext bytes, 154 objects)
exit: 0

$ docker compose ps backup
personalfi-backup-1   personalfi/backup:dev   ...   Up 18 seconds (healthy)
```

Sabotage-tested both edge cases the structural gate exists to catch, so the
check is proven to fail closed, not just proven to pass:

```
# truncated archive (first 200 bytes of a real dump)
$ pg_restore --list /tmp/truncated.dump
pg_restore: error: could not read from input file: end of file
# -> backup.sh's own `if ! TOC=$(pg_restore --list ...)` branch fires, exits 1

# a real dump of an unrelated, schema-less database (plain "postgres")
$ pg_restore --list /tmp/other.dump | grep -c schema_migrations
0
# -> backup.sh's schema_migrations grep fails, exits 1
```

Torn down afterwards:

```
$ docker compose down -v
 ... (removed all containers, networks; volumes pgdata/backups/caddy_data/caddy_config removed)
```

(One unrelated orphaned container from an earlier, already-completed session
— `stupefied_wiles`, a `personalfi/api:dev` migrator container left running
8+ hours, part of the same `personalfi` compose project but not part of this
run — was blocking `personalfi_backend`'s network removal; it held no unique
data (the schema lives in the `pgdata` volume, already removed by this same
`down -v`) and was removed so cleanup could complete.)

Files: `docker/backup/backup.sh`, `RUNBOOK.md`.

---

## Verification

- `just verify` (typecheck, lint, full test suite including every `*-db`
  project, gitleaks, license gate, hardening self-test + sweep, `.trivyignore`
  expiry, trivy fs): see the run captured for this remediation.
- Both Playwright projects (`chromium`, `csp`) green — §3, §4 above.
- `docker compose build proxy` succeeds with `check-sw-precache.ts` in the
  chain — §2.
- `docker compose down -v` run after the §9 stack boot; no stack left running
  from this remediation (the separate `just db-up` dev Postgres, used for the
  vitest `*-db` projects throughout, is left running as it was found).
