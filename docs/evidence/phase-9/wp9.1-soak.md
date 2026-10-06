<!-- SPDX-License-Identifier: MIT -->

# WP 9.1 — The real-use soak: isolation, status, report, clock

_Finisher started 2026-10-06 04:21Z at `d950bf2` on `main` (the original agent was killed by the session limit on
2026-10-05 18:40Z; its snapshot is `a92fc5c`). Written incrementally; sections marked IN PROGRESS are not yet
claims._

Spec: `docs/plan/09-phase-9-dispatch.md` §3 "WP 9.1"; findings CF-17, CF-20, CF-21, D24, 09 §5.7; extra item F-94-1
(from `docs/evidence/phase-9/wp9.4-upgrade.md`).

## 0. Status

**DONE, pending the orchestrator's final `just check`** (the check's tail is appended to §9 after the report). Every part below has
evidence in §2–§3 and §8; open items and wiring are §5–§6.

## 1. Per-part table

| Part                | What                                                                                                                                                                   | State |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| (1) isolation       | `check-isolation.sh` + `--self-test` + `check-isolation.test.ts` (S5), `run-report.sh`, RUNBOOK section, walk on `pf-prodlike` (§8.1, §8.2, §8.8)                      | done  |
| (2) status          | migration 0036, `@core/platform` ops schema + reader, `backup.sh` insert (§8.3), `GET /ops/backup-status` (§8.4, S2–S4), dashboard line, `restore-drill` insert (§8.5) | done  |
| (3) report          | `scripts/soak/report.ts`, `soak-report.test.ts` (S1a/S1b), week-00 dry run, the container path (§8.6)                                                                  | done  |
| (4) criteria ledger | computed 1, 2, 9; judged 3–8, 10, 11 from `clock.md`; tests in `soak-report.test.ts`                                                                                   | done  |
| (5) clock           | `clock.md` template, `week-template.md`, clock test                                                                                                                    | done  |
| F-94-1              | `backup.sh` fixed, structural test red then green, reproduced and fixed on the shipped image (§8.7)                                                                    | done  |

## 2. Log (append-only, UTC)

- 04:21Z — read the plan (§3 preamble, WP 9.1, §4 batches 3/5/9 + migration rule), the 07 handoff §1/§3, every
  snapshot file. Host load 0.77/0.86/1.18 (`uptime`). `/tmp/wp91` created. No `pf-prodlike*` project exists.
  State found on disk: 0036 migration, platform ops schema + reader, route (registered at `d950bf2`), registry
  rows, `check-isolation.sh`, `report.ts` (931 lines, draft; its queries guessed column names and are re-derived
  from the real schema in this pass), `backup.sh` insert, `restore-drill` body. Known red: `just typecheck` on
  `scripts/soak/report.ts` (workspace package specifiers not resolvable from the root package).
- 04:24Z — **report.ts rewritten** (the snapshot's queries guessed column names; every one is re-derived from the
  migrated schema of a scratch database `personalfi_wp91_schema` — `0036` is the head). Changes of substance: every
  query takes one parameter `$1` (the as-of instant) and nothing calls `now()`, so a report is reproducible and the
  tests deterministic; the real `security_events` kinds (`auth.webauthn|totp|recovery_code.*`, `auth.locked_out`,
  `auth.step_up`); the real Brief tables (`advisory_briefs.iso_week`, `insight_feedback.reason_code`); "internal
  transfers inside spend totals" is computed as pairs of live spend rows in two accounts, equal and opposite, within 5
  days (the ledger's own `windowDays`), that the ledger did not flag `is_transfer`; one READ ONLY transaction; the
  select-list parser plus an output-column whitelist (`runSoakQueries`) plus the canary (`executeSoakQueries`) are three
  independent controls. Workspace code is reached by relative dynamic import inside `main()` only (the typecheck error
  on `@core/*`/`pg` specifiers is gone: `pnpm run typecheck` reports nothing for `scripts/soak/`).
- 04:28Z — **F-94-1, red.** `scripts/soak/backup-script-pipefail.test.ts` written first and run against the unfixed
  `backup.sh`: `AssertionError: grep -q at the end of a pipe under pipefail (F-94-1): expected ['docker/backup/backup.sh:156'] to deeply equal []` — 1 failed | 1 passed (the detector-unit test passes: it
  recognises `-q`, `-qE`, `-Eq`, `-E -q`, `--quiet` and ignores `>/dev/null`, comments and non-pipes). The first draft
  also flagged `docker/backup/backup-loop.sh:63` (`psql … | grep -q 1`): psql prints one line there, far below the
  pipe buffer, it cannot SIGPIPE, and the file is not mine, so the test is scoped to the two scripts that read a
  `pg_restore --list` TOC (the spec names exactly them); recorded as an observation in §6.
- 04:29Z — the bug itself, reproduced on the host's bash and GNU grep (`/tmp/wp91/f941.sh`, 190,941-byte TOC with the match on the first line, 200
  iterations, load 3.25): `grep -q`: **200 of 200 false refusals**; `grep … >/dev/null`: **0 of 200**.
- 04:30Z — **F-94-1, green.** `backup.sh` line 156 is now `printf … | grep -E '…' >/dev/null` with a comment citing
  F-94-1 and the test; `sh -n` clean; `scripts/soak/backup-script-pipefail.test.ts` 2/2 passed.
- 04:36Z — `soak-report.test.ts` written (real api harness: a manual connection synced through the real orchestrator, so
  ledger rows arrive the way production's do; goals, Briefs, feedback, jobs, advisors, notifications, security events,
  backups and a drill by SQL). First run: 4/4 green after two seed errors of mine (a date that overflowed, and the
  report's parameter handling for queries that never mention `$1`). `ops-backup-status.test.ts` 3/3 green first run
  (fixed clock 2026-11-09T12:00Z; two holders; `h.stale` session; 401 without one).
- 04:40Z — sabotages S1a–S4 recorded in §3 (as they happened, each restored from a saved copy, `grep -c SABOTAGE` → 0
  after each).
- 04:44Z — `scripts/soak/check-isolation.sh --self-test` exists (4 checks: refuses project `personalfi`, version `dev`,
  this checkout's directory; accepts an isolated tuple) and passes (rc 0). `scripts/soak/check-isolation.test.ts` wraps
  it as a process (`scripts` project, 2/2): the self-test, every refusal by name, short/upper-case/empty versions, env
  fallbacks, and the acceptance run. Sabotage S5 in §3.
- 04:46Z — web: `apps/web/src/features/ops/{backup-status.ts,BackupStatusLine.tsx,BackupStatusLine.test.tsx}` and the one
  dashboard line (`BackupStatusLine` in `_app.index.tsx`). 8 unit tests; the whole web unit suite 66 files / 376 tests green;
  `tsc -b --noEmit` clean (`pnpm run gen` NOT run: orchestrator-only). `RUNBOOK` section "Production install and the real-use
  soak" added before "Master-key rotation" (nothing of "Upgrade" or "Advisor kill switches" touched). `justfile` `restore-drill`
  body made project-scoped (§4 item 8). `clock.md`, `week-template.md`, `week-00-dry-run.md` written under
  `docs/evidence/phase-9/soak/` (the dry run is produced by the test seed; its seed gained category assignments so
  `categorisation_30d` and `review_burden` are exercised with rows, not only empty).
- 04:45–04:58Z — the walk on `pf-prodlike` (§8): guard refusing/accepting; volumes before/after the victim's `down -v`; a real
  `backup.sh` row; `GET /ops/backup-status` through Caddy (401 without a session, 200 with); `just restore-drill` scoped to the
  project (and refusing when ambiguous); the weekly report through `run-report.sh --scratch` on the container path; F-94-1
  reproduced and fixed on the shipped image; teardown, `docker ps -a | grep pf-prodlike` empty.
- 05:00Z — `pnpm exec prettier --write` over everything touched; `pnpm run typecheck` clean; `eslint` clean on every file
  of this package (the only repo-wide eslint errors are 9.4's `scripts/upgrade-test/driver.mjs`); `--project api-db` (soak-report
  5 passed incl. the dry-run emitter, which skips unless `SOAK_DRYRUN_OUT` is set; ops-backup-status 3), `--project db` 14,
  `--project scripts` (this package's 4 of 17), `--project api` `evidence-hygiene` + `gate-image-closure` 6, web 376: green.

## 3. Sabotage log

| #   | Control                                                               | Sabotage                                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Restored                                                         |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| S1a | the canary (`soak-report.test.ts`)                                    | `ledger_pending` gained `max(t.user_note) AS memo_count` **before** the seed had a pending row               | **stayed green** for the canary (the query's `WHERE t.pending` excluded every planted memo, so `max()` returned NULL); only the structural test went red. **The control was weaker than claimed: a canary only guards the rows its seed reaches.** The seed then gained a pending canary row (`soak-pending`, 11+ days old at the as-of) and `ledger_pending` is asserted to read it.                                                                                             | at once, `grep -c SABOTAGE` → 0                                  |
| S1b | the canary, again                                                     | the same sabotage, now that the seed reaches it                                                              | **red, 3 of 4**: `the soak report contains no amount, name, memo or institution from the database` → `AssertionError: the report leaked CANARY-MEMO-ORCHID`; `every query … selects only aggregates and whitelisted dimensions` red (structural); `criterion 2 …` red (its closing canary assertion). The canary calls `executeSoakQueries`, which skips the parser and the output-column whitelist (`memo_count` is a legal output name), so the canary is a control of its own. | `cp` from the saved good copy; `grep -c SABOTAGE` → 0; 4/4 green |
| S2  | drill-age threshold (`ops-backup-status.test.ts`)                     | `DRILL_MAX_AGE_DAYS = 3650` in `packages/platform/src/ops-status.ts`                                         | **red first try**: `× a drill older than 35 days reads overdue` — `expected false to be true` (1 failed, 2 passed)                                                                                                                                                                                                                                                                                                                                                                | `cp` from the saved copy; `grep -c SABOTAGE` → 0                 |
| S3  | session guard on `GET /ops/backup-status`                             | `await guards.requireSession(request)` commented out in `apps/api/src/routes/ops.ts`                         | **red first try**: `× the route needs a session and returns nothing a user owns` — `expected 200 to be 401` (the real `app.ts` registration serves the route unauthenticated)                                                                                                                                                                                                                                                                                                     | restored; 0                                                      |
| S4  | "newest successful, never a newer failed one"                         | the `WHERE status = 'ok'` filter dropped from the newest-success query                                       | **red first try**: `× the status reports the newest successful backup …` — `expected '2026-11-09T11:00:00.000Z' to be '2026-11-09T02:00:00.000Z'` (the failure an hour ago reported as the backup)                                                                                                                                                                                                                                                                                | restored; 0                                                      |
| S5  | the isolation guard (`check-isolation.sh`, `check-isolation.test.ts`) | the working-directory comparison replaced by a constant that never matches (this checkout no longer refused) | **red first try, 2 of 2**: `SELF-TEST FAILED: this checkout's directory (/home/chris/Projects/PersonalFi) was not refused` and `expected 'check-isolation: REFUSED …' to contain 'is the agent/gate checkout'`                                                                                                                                                                                                                                                                    | `cp` from the saved copy; `grep -c SABOTAGE` → 0; 2/2 green      |

## 4. Decisions

1. **No workspace specifiers in `report.ts`.** The root `tsconfig` includes `scripts/**` but the root package depends on
   nothing in the workspace; like `scripts/advisor-eval.ts` the report reaches workspace code by relative path, and only
   inside `main()` by dynamic import (`packages/db/src/index.ts` for the pool, `packages/contexts/planning/src/index.ts` for
   the assumptions file's `asOf` dates). It has no `pg` import: a pool is anything with `connect()`. No dependency added.
2. **How the report runs "inside the prod `api` container".** `docker/api.Dockerfile` ends with `rm -rf scripts docs …`: the
   script is not in the image, while `packages/` (the `@app/api` closure, which includes `@core/db` and `@ctx/planning`) is.
   The Dockerfile is not mine, so nothing ships it; `scripts/soak/run-report.sh` bind-mounts the ONE file, read-only, into a
   throwaway `api` container (`--entrypoint node`, because the image's entrypoint is tini + the ROLE dispatcher), reads the
   container's own `database_url` secret, and writes the markdown to STDOUT (the rootfs is read-only and uid 10001 cannot
   write the checkout); the wrapper writes the file atomically only when the report succeeded. A Dockerfile line that would
   ship it is given in §5, optional. The same file runs from a checkout against `DATABASE_URL` (RUNBOOK).
3. **Every query takes `$1`, the as-of instant, and nothing calls `now()`**: a report is reproducible, a backfill week is
   `--as-of`, and the tests are deterministic. Every query runs in one `BEGIN TRANSACTION READ ONLY`.
4. **"Internal transfers inside spend totals" is computed, not read from a flag.** A pair of live spend rows (not pending,
   removed, superseded, excluded, or flagged `is_transfer`) in two different accounts, equal and opposite amounts, within
   5 days (the ledger's own `windowDays`), is a residual transfer the ledger did not pair. The amounts appear only in
   `WHERE`/`JOIN`, never in a select-list. Criterion 2 reads the most recent complete month with spend rows; zero pairs is
   `met on <first of the next month>`; one pair turns it back to `observing since` with the count in the note. A flagged pair
   or one the holder excluded does not count (tested). Caveat: two unrelated rows that happen to be equal and opposite also
   count: the figure is a prompt to look, and "met" needs it at zero.
5. **"Attestation".** `day_one`, `attest`, `fallback`, `outage_*` and `data_loss` rows are Chris attesting the week;
   `upgrade` and `criterion` rows are bookkeeping and do not clean a week. A week is a gap if it holds none. The report prints
   every ISO week from the anchor to the as-of week, so a gap in the middle of the soak is visible, not only the current one.
6. **Judged criteria** (3–8, 10, 11) come from `criterion` rows in `clock.md`, latest row per criterion winning; 1, 2 and 9
   are computed and cannot be overridden by a row. "met on D" is the as-of of the first weekly file that read it so (the
   earlier week files are the record); the report does not re-read its own history.
7. **A lower bound on the canary's reach.** S1a in §3: a canary guards only the rows its seed reaches. The seed plants a
   pending, a posted, a flagged-later and an excluded-later row, a goal, a Brief with its insight and feedback, a failed job,
   a quarantined advisor, a notification, security events (with a memo in `detail`), a backup and a drill, each carrying a
   canary string.
8. **`restore-drill` is now project-scoped (a real defect, found while pointing it at `pf-prodlike`).** It took `head -1`
   of every volume labelled `backups`, network labelled `backend` and container labelled service `db` on the host. On a host
   that carries `personalfi-dev` beside production that could restore from, compare against and WRITE its verdict into the
   wrong database. The lookups are now filtered by `COMPOSE_PROJECT_NAME` and **refuse when it is unset and the answer is
   ambiguous**; `DRILL_SECRETS_DIR` / `DRILL_EVIDENCE_DIR` redirect the two checkout paths. Defaults are unchanged on a
   single-project host.
9. **The dashboard line degrades to "Backup status unknown"** (quiet, muted, no error screen) when the route fails, is
   unmocked, or answers anything that is not the status shape (a dev server's SPA fallback answers `200 text/html`). It is
   typed locally with the generated `client` because the route is not in the generated SDK until the orchestrator's
   regeneration; it never calls `pnpm run gen`.
10. **`BACKUP_MAX_AGE_SECONDS`.** `backup/healthcheck.sh` reads it (default 93600 s = 26 h); the api container does not receive
    it, so the route's overdue flag uses the same 26 h default (`DEFAULT_BACKUP_MAX_AGE_SECONDS`). An operator who sets a
    different value for the `backup` service must set it for `api` as well: see §6.

## 5. Wiring for the orchestrator

1. **`justfile`: the one-line `soak-report` recipe** (09 §4 batch 9; the `restore-drill` body is mine and done):

   ```just
   # Weekly soak report (WP 9.1). The orchestrator's alone (Phase 9 rule 5). Run from the production clone with
   # COMPOSE_PROJECT_NAME=personalfi-prod PERSONALFI_VERSION=<sha> SOAK_EVIDENCE_DIR=<dev checkout>/docs/evidence/phase-9/soak.
   soak-report *args:
       bash scripts/soak/run-report.sh {{args}}
   ```

2. **`.env.example`: name the project.** `PERSONALFI_VERSION` is already documented as required non-`dev` for production
   (`faf42cc`). Add beside it, so the production clone's `.env` carries both rules the guard checks:

   ```bash
   # PRODUCTION: also set COMPOSE_PROJECT_NAME=personalfi-prod (the clone's own project, hence its own volumes).
   # COMPOSE_PROJECT_NAME=personalfi
   ```

3. **The regeneration.** `GET /ops/backup-status` (operationId `getOpsBackupStatus`, schema `OpsBackupStatus`) is not in the
   generated client yet; `just openapi` + `cd apps/web && pnpm run gen && pnpm run gen:check` will add it. The dashboard line
   (`apps/web/src/features/ops/`) types the response locally and goes through the generated `client`, so nothing breaks
   before or after; once regenerated, `useBackupStatusQuery` may be swapped for `getOpsBackupStatusOptions()` (optional).
   `check-proxy-routes` should pass `/api/ops/*` under the existing `handle_path /api/*` (09 §4 batch 8): the walk in §8
   fetched it through Caddy.

4. **`apps/web/e2e/support/mock-api.ts` (optional; orchestrator only).** The dashboard needs no mock to stay green: an
   unmocked `/api/ops/backup-status` falls through `route.continue()` to the Vite dev server's SPA fallback (`200 text/html`),
   which the component reads as "Backup status unknown" (unit-tested). For a deterministic dashboard screenshot, add beside
   the other `GET` handlers:

   ```ts
   if (path === '/api/ops/backup-status' && method === 'GET') {
     return route.fulfill(
       json({
         lastAttemptStatus: 'ok',
         lastAttemptAt: '2026-10-20T08:00:00.000Z',
         lastSuccessfulBackupAt: '2026-10-20T08:00:00.000Z',
         lastSuccessfulBackupAgeSeconds: 14_400,
         backupOverdue: false,
         lastDrillVerdict: 'pass',
         lastDrillAt: '2026-10-13T10:00:00.000Z',
         lastDrillAgeDays: 7,
         drillOverdue: false,
       }),
     );
   }
   ```

5. **`docker/api.Dockerfile` (optional, NOT recommended now).** The report runs without it (the wrapper mounts the file). If
   the orchestrator would rather ship it in the image, add one line after the `RUN rm -rf scripts docs …` step in the `deploy`
   stage, and drop the report's `-v …report.ts:/app/scripts/soak/report.ts:ro` mount from `run-report.sh`:

   ```dockerfile
   COPY scripts/soak/report.ts ./scripts/soak/report.ts
   ```

   It changes the image every user runs (and `gate-image-closure.test.ts`'s expectations) for a script only the orchestrator
   runs, so the mount is the default.

6. **Config note (batch 4).** `PERSONALFI_VERSION` required non-`dev` for production: done at `faf42cc` in `.env.example`
   and in RUNBOOK "Production install and the real-use soak"; `COMPOSE_PROJECT_NAME=personalfi-prod` is in the RUNBOOK and item 2.

7. **`compose.yml` (9.4's file): nothing required of it.** If `BACKUP_MAX_AGE_SECONDS` is ever overridden for `backup`, pass
   the same value to `api` so the dashboard's overdue flag agrees with the healthcheck (§6).

## 6. Open items

1. **`just soak-report`, `.env.example` `COMPOSE_PROJECT_NAME`, the OpenAPI/web regeneration** are the orchestrator's (§5).
2. **The guard gates only what calls it.** `check-isolation.sh` is called by `run-report.sh` and by hand (RUNBOOK). It does not
   gate `just upgrade`, `just restore-drill` or a bare `docker compose` in the production clone — those are 9.4's recipes and
   Chris's hands. Having `just upgrade` call it first when `COMPOSE_PROJECT_NAME` is `personalfi-prod` is a one-line addition for
   9.4's `upgrade.just`, not made here (not mine). The dev-checkout path it refuses is this host's literal path
   (`PERSONALFI_DEV_CHECKOUT` overrides); if the checkout moves, the third refusal moves with the variable.
3. **`BACKUP_MAX_AGE_SECONDS` is not passed to `api`.** `backup/healthcheck.sh` reads it (default 93600 s); the route uses the
   same 26 h default. If an operator overrides it for `backup`, `compose.yml`'s `api` environment needs the same value or the
   dashboard and the healthcheck will disagree. Not changed (compose.yml is 9.4's).
4. **The residual-transfer count is a prompt, not a verdict** (§4 item 4): it counts equal-and-opposite pairs in different
   accounts within 5 days that the ledger did not flag, so two unrelated rows can read as a pair. Criterion 2 needs it at zero;
   Chris judges a non-zero month.
5. **"met on D" is not carried forward by the report** (§4 item 6): each weekly file recomputes. The first file that reads a
   criterion met is the record of the date; there is no cross-week memory in the script. Adding one means the report reading its
   own earlier files, which was not asked.
6. **The assumptions file reads "Stale" in the walk**: `collectAsOfDates` over `loadAssumptions()` found the oldest cited
   `asOf` at 2025-12-31 (279 days at the as-of), newest 2026-09-24, so every weekly report will print the stale line until
   that node is re-cited. Whether a year-end constant should count is 05 §2's question, not the script's; it prints what the
   file says.
7. **`docker/backup/backup-loop.sh:63`** is `psql … | grep -q 1` under `pipefail`. psql prints one line, so it cannot SIGPIPE
   and it is not covered by F-94-1's test (scoped to the two scripts that read a TOC, as the brief says); it is not mine and
   is left alone. A comment citing F-94-1 there, or `>/dev/null`, would close the class.
8. **A new api process answers 503 `not_bootstrapped` until something calls `/auth/unlock-state`.** Seen in the walk: the api
   initialised before `bootstrap-user` created the user and kept that state until the SPA's first call. Existing behaviour
   (documented in `bootstrap-user.ts`'s header), recorded because it also bit the first curl of this walk.
9. **No performance number is claimed.** The walk's timings (drill RTO 32 s, build times) were taken at load 6–13 with other
   agents building images and are not believed (rule 4); they are printed with their load averages in §8 for orientation only.

## 8. The walk on the prod-like scratch project `pf-prodlike`

Everything below ran in the detached, resumable `/tmp/wp91/walk.sh` (log: `/tmp/wp91/walk.log`; state: its `--from`
argument), against the scratch Compose project **`pf-prodlike`** — `COMPOSE_PROJECT_NAME=pf-prodlike`, `-p pf-prodlike` on
every `docker compose`, `127.0.0.1:8441/8442`, `REGISTRY=pf-prodlike PERSONALFI_VERSION=faf42cce47f407a6b24d507ee764692d5b684f5e`
(HEAD when the stack was built), so the images are `pf-prodlike/{api,proxy,backup}:faf42cce…`, built from `git archive HEAD`
extracted into `/tmp/wp91/stack` plus this package's `docker/backup/backup.sh`, `justfile`, `scripts/soak/*` and `clock.md`. Its
secrets were generated into `/tmp/wp91/stack/secrets/` (`just gen-pg-secrets`, `just gen-master-key`, an age keypair from the
scratch backup image, `scripts/secrets-placeholders.sh` for the rest); the real `secrets/` was never read. Never touched:
project `personalfi`, `personalfi-prod` (none exists), `personalfi_*` volumes, `personalfi/*:dev`, `pf-upgrade-*`,
`personalfi-dev-db-1`. No prune of any kind. Host load average is printed with each step (other agents were building images:
**no timing here is believed**, rule 4).

### 8.1 The isolation guard refuses, then accepts (step 3)

```
--- project pf-prodlike, version <sha>, dir=/tmp/wp91/stack:
check-isolation: REFUSED
  - the compose project is 'pf-prodlike', not 'personalfi-prod' (CF-21)                              rc=1
--- project personalfi, version dev, dir=this checkout:
check-isolation: REFUSED
  - the compose project is 'personalfi', not 'personalfi-prod' (CF-21)
  - PERSONALFI_VERSION is 'dev', not a 40-hex commit SHA (CF-20; 'dev' is never production)
  - the working directory (/home/chris/Projects/PersonalFi) is the agent/gate checkout …; production must be its own clone (CF-21)   rc=1
--- project personalfi-prod, version <sha>, dir=/tmp/wp91/stack (a separate clone; nothing is created, the guard only reads its arguments):
check-isolation: ok (project=personalfi-prod, version=faf42cce…, dir=/tmp/wp91/stack)                rc=0
--- run-report.sh without --scratch on pf-prodlike: REFUSED (the same guard) rc=1
--- run-report.sh --scratch on `personalfi` and on `personalfi-prod`: "--scratch needs COMPOSE_PROJECT_NAME matching ^pf-[a-z0-9-]+$" rc=1, rc=1
```

### 8.2 `docker volume ls` before and after a gate-style `down -v` on a different project (steps 4, 12)

Before (step 4, 37 volumes host-wide; the guarded ones): `personalfi_dev_pgdata`, `personalfi_ollama_models`, plus 9.4's
`pf-upgrade-*`. After `pf-prodlike` was up (so it owns `pf-prodlike_{pgdata,backups,caddy_data,caddy_config,returns_cache}`), a
second scratch project **`pf-prodlike-victim`** (its own compose file, `/tmp/wp91/victim/compose.yml`, volumes `pgdata` and
`backups` — the names a gate's `down -v` targets) was created and then torn down the way a gate does:
`docker compose -p pf-prodlike-victim down -v`.

```
--- removed by the victim's down -v (volumes before vs after the victim's teardown):
pf-prodlike-victim_backups
pf-prodlike-victim_pgdata
--- every pf-prodlike_* volume present before the teardown is still present: none missing
--- personalfi_dev_pgdata and personalfi_ollama_models after:  both present
```

(The script's "added by the victim" listing in the log is against the step-4 snapshot, so it also lists `pf-prodlike_*` and
other agents' volumes created since; the two lines above are the load-bearing ones. `down -v` was run on
`pf-prodlike-victim` only — and never on `personalfi`.)

### 8.3 A real `backup.sh` run, and the row it wrote (step 7)

The `backup` service's own loop took the first backup as soon as `schema_migrations` existed (a row at 04:47:31Z); then
the shipped script, exec'd inside the scratch `backup` container:

```
backup: dumping personalfi@db ...
backup: verified 542032 bytes, 987 restorable object(s), schema_migrations present
backup: wrote /backups/personalfi-20261006T044753Z.dump.age (542360 bytes)
backup: complete                                                                   backup.sh rc=0
 status |          finished_at          | plaintext_bytes | toc_entries |                       reason
 ok     | 2026-10-06 04:47:31.698551+00 |          491506 |         987 | /backups/personalfi-20261006T044731Z.dump.age (491506 plaintext bytes, …
 ok     | 2026-10-06 04:47:53.905756+00 |          542032 |         987 | /backups/personalfi-20261006T044753Z.dump.age (542032 plaintext bytes, …
```

### 8.4 `GET /ops/backup-status` through Caddy, with and without a session (steps 6, 8, 10)

Through `https://personalfi.lan:8441/api/ops/backup-status` (`curl -sk --resolve personalfi.lan:8441:127.0.0.1`), on the real
`pf-prodlike/api` image behind the real `pf-prodlike/proxy`, so `handle_path /api/*` carries `/api/ops/*` (09 §4 batch 8's
`check-proxy-routes` question: it does). The bootstrap user was created with `bootstrap-user.ts` (enrolment link redacted from
the log). A browserless session: `/tmp/wp91/mint-session.ts`, run in a throwaway container of the same image, derives the KEK and
issues one session for that user through the shipped `SecurityRuntime` (a scratch helper, not committed; the token is never
printed).

```
(first call, api not yet re-initialised after bootstrap-user)  503 not_bootstrapped  <- §6 item 8; /auth/unlock-state fixes it
GET /auth/unlock-state                      -> 200 {"state":"unlocked","bootstrapped":true,…}
GET /api/ops/backup-status, no session      -> HTTP 401 {"code":"not_authenticated",…}
GET /api/ops/backup-status, session cookie  -> HTTP 200
  {"lastAttemptStatus":"ok","lastAttemptAt":"2026-10-06T04:47:53.905Z","lastSuccessfulBackupAt":"2026-10-06T04:47:53.905Z",
   "lastSuccessfulBackupAgeSeconds":36,"backupOverdue":false,"lastDrillVerdict":null,"lastDrillAt":null,"lastDrillAgeDays":null,
   "drillOverdue":true}                                  (the same 200 through the api's own port, no Caddy)
```

After the drill (8.5), the same call reads `"lastDrillVerdict":"pass","lastDrillAt":"2026-10-06T04:49:32.850Z",
"lastDrillAgeDays":0,"drillOverdue":false`.

### 8.5 `just restore-drill` against `pf-prodlike` (step 9)

Environment the recipe needs on a multi-project host: `COMPOSE_PROJECT_NAME=pf-prodlike` (it looks up the project's `backups`
volume, `backend` network and live `db` container by Compose label), `REGISTRY` and `PERSONALFI_VERSION` (the drill's api
image), `AGE_IDENTITY_FILE`, and — for a scratch project — `DRILL_SECRETS_DIR=/tmp/wp91/stack/secrets` and
`DRILL_EVIDENCE_DIR=/tmp/wp91/drill-evidence` (so neither `./secrets` nor `docs/evidence/ops` is touched). **Unset
`COMPOSE_PROJECT_NAME` on this host now refuses**:

```
restore-drill: 2 candidate volumes (pf-prodlike_backups pf-upgrade-s3-no-newer-check_backups); set COMPOSE_PROJECT_NAME to the project being drilled     rc=1
```

(Before this package's edit the recipe took `head -1` of those two and would have restored from, and compared against, whichever
Docker listed first: §4 item 8.) Scoped, it passed:

```
**Verdict: PASS**   Backup restored: /backups/personalfi-20261006T044753Z.dump.age (542360 encrypted bytes)
Restored db table count: 99 · schema_migrations max id: 0036  |  Live db table count: 99 · schema_migrations max id: 0036
API /ready against restored db: pass (200 from /ready)                                            drill rc=0
 verdict |            ran_at             | restored_table_count | live_table_count | max_migration | rto_seconds
 pass    | 2026-10-06 04:49:32.850192+00 |                   99 |               99 | 0036          |          32
```

(`rto_seconds` 32 at load ≈ 6–9 with other agents building: not a measurement.) The `ops_restore_drills` row is what the route read.

### 8.6 The weekly report through the wrapper, on the container path (step 11)

`COMPOSE_PROJECT_NAME=pf-prodlike SOAK_SCRATCH_OUT=… bash scripts/soak/run-report.sh --scratch --label "SCRATCH pf-prodlike walk -- not
real data" --as-of <now>` — the isolation refusal, the bind-mounted single file, `--entrypoint node`, the container's own
`database_url`, READ ONLY, stdout out, rc=0 (114 lines). Excerpts: `# Soak report -- 2026-W41`; "Not started -- no `day_one`
attestation" and the **GAP** line (no `clock.md` rows yet); `backup_attempts_by_week` `2026-W41 | ok | 2`; `backup_latest_ok` age 0 h;
`restore_drills_by_week` `2026-W41 | pass | 1`; `restore_drill_latest` `pass | 0`; the assumptions file read from inside the image
(oldest `asOf` 2025-12-31: §6 item 6). The output is under `/tmp/wp91/prodlike-report.md` and is not committed (the committed
dry run is `docs/evidence/phase-9/soak/week-00-dry-run.md`, from the test seed).

### 8.7 F-94-1 on the shipped image (steps 13, 14, and `/tmp/wp91/f941-image.sh`)

The structural test (`scripts/soak/backup-script-pipefail.test.ts`) is the permanent control; this is the pattern run for real.

- **Mechanism, in the image's own shell and grep** (busybox ash + BusyBox v1.37.0 `grep`, the `pf-prodlike/backup` image; a
  190,941-byte TOC with the match on its first line): `grep -qE` under `pipefail` — **100 of 100 false refusals**;
  `grep -E … >/dev/null` — **0 of 100**.
- **The unfixed `backup.sh` (`git show HEAD:docker/backup/backup.sh`) run against the real scratch database, ten times, on the
  shipped image.** At this database's honest TOC (74,167 bytes, `schema_migrations` late in the list so less than the pipe buffer
  remains after the match) it did **not** reproduce: ten runs promoted, ten rows `ok` — the bug needs the match to land with more
  than 64 KiB still unwritten, which is why it appears at random as a database grows. With 2,500 scratch tables added to the
  scratch database (TOC **562,446** bytes): the unfixed script **refused 10 of 10** ("did not find the schema_migrations table —
  refusing to promote it", `ops_backup_runs` `fail` ×10) and the fixed script **promoted 10 of 10** (`ok` ×10). The tables were
  dropped afterwards, in the scratch database.
- (My first detection loop counted refusals with `printf … | grep -q` on the captured output — the very pattern under test — and
  reported 0; the `ops_backup_runs` `fail` count of 10 was the truth and the loop was re-run with `[[ $out == *…* ]]`: both
  runs are in `/tmp/wp91/walk.log`.)

### 8.8 Teardown (step 15)

`docker compose -p pf-prodlike down -v` and `-p pf-prodlike-victim down -v` — the two projects this session created — and
`docker rmi` of the three `pf-prodlike/*:faf42cce…` images this session built; `/tmp/wp91` kept (secrets, age identity, logs).
Results are in the log excerpt below.

```
--- docker ps -a | grep pf-prodlike:                      (empty)
--- volumes / networks named pf-prodlike*:                (none) (none)
--- images pf-prodlike/*:                                 (none)
--- untouched: personalfi_dev_pgdata, personalfi_ollama_models, personalfi/{api,proxy}:dev, personalfi-dev-db-1 Up 13 days (healthy)
--- pf-upgrade-* volumes (9.4's): 5 still listed
```

Scratch databases: `personalfi_wp91_schema` (the schema reference) and one leftover harness database from a failed first seed run
of `soak-report.test.ts` were dropped; none remain (`pg_database … LIKE '%wp91%'` → 0).

## 9. Final check

(not yet run)

Run at 05:00–05:28Z against the working tree (this package's files plus the other two agents' in-flight work), load average
2–6 with other agents running tests (no number here is a measurement).

- `pnpm run typecheck` — **clean** (rc 0).
- `just check-proxy-routes` — **PASS**, `/api/*` covers every contract prefix.
- `just check` — rc 1 **at `lint`, on files that are not this package's**: `prettier --check` flags
  `docs/evidence/phase-9/wp9.4-upgrade.md` and `scripts/upgrade-test/driver.mjs`, and ESLint reports 11 errors, all in
  `scripts/upgrade-test/driver.mjs` (`no-console`, `no-undef 'document'`) — WP 9.4's, in flight. Everything of this package passes
  `prettier --check` and `eslint`; `lint:schema-ownership` ok (111 tables claimed, 98 defined); `check-numeric-boundaries` PASS
  (880 files, 0 violations).
- `just test` (`vitest run`, all 42 projects) — **3,366 passed, 12 skipped, 1 failed** (364 files): the one failure is
  `|api-db| investments-perf.test.ts › [slow] … holdings and allocation p95 < 200 ms on the seed`
  (`GET /holdings: expected 354.6 to be less than 200`), a latency budget measured at load 2–6 while other agents ran builds and
  tests — not believed (rule 4), not in this package's files. `&&` stopped `pnpm run test` there, so the web suite ran
  separately: **66 files / 376 tests passed**.
- This package's own: `--project api-db` soak-report 5 passed (+1 skipped emitter), ops-backup-status 3; `--project db` 14;
  `--project scripts` 4 files / 18; `evidence-hygiene` + `gate-image-closure` 6; web `features/ops` + `routes` 11.
- The orchestrator's `just check` after the other two packages land will go green only once `driver.mjs` and the 9.4 evidence file
  are formatted/linted; nothing of this package is in the way.
