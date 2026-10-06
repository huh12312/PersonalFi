<!-- SPDX-License-Identifier: MIT -->

# WP 9.4 — Unattended upgrade from v0.1: the test and its fixes

_Started 2026-10-05 17:32Z at `3f414ec` on `main`. Written incrementally; sections marked IN PROGRESS are
not yet claims._

Spec: `docs/plan/09-phase-9-dispatch.md` §3 "WP 9.4"; findings CF-2…CF-5 (§2b).

## 0. Status

IN PROGRESS.

## 1. Log (append-only, UTC)

- 17:32Z — read the plan (§1, §2b, §3 preamble and WP 9.4, §4 batches 4/6/9, §5 risks 3–4), RUNBOOK
  Upgrade/Restore/Restore drill, `migrate.ts`, `compose.yml`, `backup.sh`, `compose-hardening-check.sh`,
  the workflows, the Phase 5 gate §3.1–3.2. Host: 8 cores, 22 GB, load 2.21/4.12/3.68; no `pf-upgrade-*`
  project exists; `personalfi-prod` not touched or listed.
- 17:35Z — waypoint trees extracted with `git archive <sha> | tar -x` into `/tmp/wp94/work/src/<sha>` (W0–W5).
  Every era tags images `${REGISTRY:-personalfi}/<svc>:${PERSONALFI_VERSION:-dev}`, so `REGISTRY=pf-upgrade`
  plus `PERSONALFI_VERSION=<sha>` yields `pf-upgrade/<svc>:<sha>` with no per-waypoint image override.
  Every era has `PROXY_HTTPS_PORT`/`PROXY_HTTP_PORT` and `EXTRA_ALLOWED_ORIGINS`. Declared file secrets:
  W0/W1 6, W2 10 (+`plaid_*` ×3, `advisor_token_secret`), W3–HEAD 17 (+7 provider keys) — CF-4's arithmetic
  confirmed from the trees.
- 17:36Z — **CF-2 red.** `packages/db/test/migrate-newer.test.ts` written first and run against the
  unmodified `migrate.ts`: `× a database holding a migration this binary lacks refuses to migrate and /ready
  stays false, named` and `× newer is an applied version absent on disk, never a larger number`, both
  `expected a MigrationError refusal; the call resolved instead` (the older binary migrated nothing and, in
  the second, _applied 0003 and 0005_ over a database holding 0004). 2 failed | 2 passed — the out-of-order
  and fresh-database tests pass before the fix, as they must (they guard against an over-eager fix).
- 17:38Z — **CF-2 green.** `refuseDatabaseNewer` in `migrate.ts`, called in `runMigrations` (before the
  `--dry-run` return) and in `pendingMigrations` (outside its "table missing" `try`): code
  `migration.database_newer`, message names every unknown `<version>_<name>`. 4/4 passed; with the shared
  `migrate.test.ts` 14/14.
- 17:39Z — **Sabotage S-CF2-max** (recorded as it happened): `refuseDatabaseNewer` rewritten to flag only
  `row.version > max(files)`. Result: `× newer is an applied version absent on disk, never a larger number`
  (`the call resolved instead`) — 1 failed | 3 passed. **Red first try.** Restored at once; `grep -c SABOTAGE`
  → 0; 14/14 green again.
- 17:47Z — **CF-4 fix written** (red is observed through the harness at the direct jump, §4): 
  `scripts/secrets-placeholders.sh` — declared set computed from `docker compose config --format json`
  (every profile, override included); `REQUIRED=(database_url pg_password master_key age_recipient)` refused
  by name when missing **or empty**, before anything is written; every other declared file secret created
  empty `0444` only if nothing (not even a dangling symlink) exists at its path, under `noclobber`; each
  secrets directory set to `0700`. `--self-test` PASS (4 cases). vitest wrapper
  `scripts/upgrade-test/secrets-placeholders.test.ts` (project `scripts`, 2/2): the self-test, and a
  structural cross-check — REQUIRED ⊆ declared, and every declared non-REQUIRED secret is either backup-only
  (`b2_*`) or `requiredForRoles: []` in `@core/config`'s `SECRET_SPECS` (so a future secret the app requires
  cannot be silently placeholdered).
- 17:48Z — **Sabotage S-CF4-required**: `is_required` made to `return 1`. `--self-test` → `SELF-TEST FAILED:
  case 3: a missing required secret was not refused` / `master_key was invented` / `an optional placeholder
  was written despite the refusal` (4 assertions), rc=1. **Red first try.** Restored from copy; `grep -c
  SABOTAGE` → 0; PASS.
- 17:55Z — **CF-3 written** (red/green observed through the harness, §4): `docker/backup/pre-migrate.sh`
  (copied into the backup image by `docker/backup.Dockerfile`), the `pre-migrate-backup` one-shot in
  `compose.yml` (backup image, user `10002:10002`, `read_only`, `cap_drop: [ALL]`, `no-new-privileges`,
  `restart: 'no'`, `backend` only, secrets `pg_password` + `age_recipient` only, `backups` rw, the checkout's
  `packages/db/migrations` bind-mounted `:ro`, no B2 credential, image HEALTHCHECK disabled) and
  `migrator.depends_on.pre-migrate-backup: service_completed_successfully`. "Pending" = set membership,
  as `migrate.ts`. Fresh DB → no backup; nothing pending → no backup; unreadable migration list → backup
  anyway; backup failure → exit 1 → no migrator.
- 17:56Z — the unmodified hardening check, run on the new `compose.yml`, refused it first:
  `FAIL compose.yml: pre-migrate-backup: writable-volume-wrong-service … owned by backup` — the existing
  rule working. The check learned the service: `backups:pre-migrate-backup` in `WRITABLE_NAMED_VOLUMES`, and
  a new rule `migrator-missing-pre-migrate-backup` (a file defining `migrator` must define
  `pre-migrate-backup` and wait on it `service_completed_successfully`). Hostile fixture: a
  `pre-migrate-backup` as root, `read_only: false`, `cap_add`, no `cap_drop`/`no-new-privileges`, writable
  `pgdata`; a `migrator` waiting `service_started`. `--self-test` PASS: 31 rules, 21 service:rule pairs
  including all seven new ones. Real check PASS (11 services). `check-secret-ownership.sh --self-test` PASS
  (the new service adds no consumer uid: 10002 already reads both its secrets).
- 17:57Z — **Sabotage S-CF3-graph**: `compose.yml` `migrator.depends_on.pre-migrate-backup` →
  `service_started`. Real check → `FAIL compose.yml: migrator: migrator-missing-pre-migrate-backup:
  depends_on pre-migrate-backup is "service_started"; …`. **Red first try.** Restored from copy; `grep -c
  SABOTAGE` → 0; PASS.
- 17:52Z — research (three read-only agents over the W1–W5 trees) changed the data table in four places, each
  a finding about what those versions' own APIs can do (§5): W1's Caddy proxies only `/auth/*`, `/health`,
  `/ready` (its data API is reachable only inside the compose network); W1 has no rule or category API;
  W2 cannot create an insight through its API (no grant route; `POST /advisors/run` 503s without a non-empty
  `advisor_token_secret`); W3 has no route that adds a holding to a manual account; W4's projection needs a
  net-worth snapshot written only by the 04:00 job; W5's Brief has no trigger but the schedule.
- 17:53–17:59Z — the harness written (`scripts/upgrade-test/{run.sh,lib.sh,driver.mjs,upgrade.just}`); all
  seven image sets built detached as `pf-upgrade/{api,proxy,backup}:<sha>` (HEAD = `3f414ec-wp94`: `git
  archive HEAD` + this package's owned files from the working tree + `upgrade.just` appended while the
  justfile wiring is pending), 44–66 s each from cache, load 4–8.5 (other agents active).
- 17:59Z — **direct jump launched** detached: `setsid nohup bash scripts/upgrade-test/run.sh --path direct
  --keep > /tmp/wp94/logs/direct.log`. W0 cold install per W0's RUNBOOK (`just gen-pg-secrets`, `just
  gen-master-key`, `just build`, age keypair from the W0 backup image, b2 placeholders, `just up`, `just
  bootstrap-user`): `just up` → `/ready` 200 in 16.4 s (load 7.13). Passkey enrolled through Caddy by a CDP
  virtual authenticator (`credentialCount 1, signedIn true`); TOTP enrolled and confirmed; 10 recovery codes;
  `kekVersion 1`. (i) at W0: 3 applied == 3 on disk, checksums equal.
- 18:00Z — **direct jump, attempt 1** (report kept at `/tmp/wp94/direct-attempt1-report.md`):
  - W0 (v): `worker=1`. Worker log: `no account holder yet; the worker will idle until one is enrolled`, exit ~30 s
    later, restarted. This is **G3-1** (Phase 3 gate C-1), W0's own defect; the harness now reports (v) at W0–W5
    as historical and fails it only at HEAD.
  - S1 inside the direct path: the sabotage sed used `#` as delimiter inside a `# SABOTAGE` replacement
    (`unknown option to 's'`) — harness bug, fixed. On the retry the sabotaged `just upgrade` failed, but its
    log was overwritten by the real hop before the line was captured; S1 moved to its own path (`--path
    s1-no-placeholders`) with its own log.
  - **The real hop: `just upgrade` alone, W0 → HEAD — green.** `secrets-placeholders: created 11 empty optional
    placeholder(s)`; pre-migration backup `personalfi-20261005T180309Z.dump.age` 2 s before the first new
    migration (marker present); 0003 → 0034; `/ready` 200; api 0 / worker 0 restarts; total 124.3 s (build
    included), **up-to-ready 31 s at load 7–8** (other agents building; > the 20 s budget, informational).
  - (i)–(iii), (v) at HEAD all pass; (iv) the pre-migration backup (W0 state) restored into a fresh project,
    migrated by HEAD: all pass, 97 tables = live; HEAD backup drill: all pass, 97 = 97.
  - CF-2 at the stack (HEAD → HEAD+1 → rollback): (a) the old RUNBOOK rollback, `PERSONALFI_VERSION` pinned
    to HEAD → **refused**: migrator `migration.database_newer: the database has applied
    0099_wp94_upgrade_test_future, which this binary does not carry …`; (b) HEAD's api alone on that schema →
    `/ready` **500**, log names the same; (c) **S3** (check short-circuited, rebuilt) → up succeeded, `/api/ready
    200` — **red as expected**. Also observed: after the refused pin, **no api was running** (`/api/ready` 000):
    Compose had already replaced the containers. The RUNBOOK sentence I had written ("the old api and worker
    keep serving" after a step-3 failure) was **wrong** and is corrected.
  - **F-94-1 found.** (d) W5-on-HEAD+1 and (e) the final `just upgrade` both failed `container …-backup-1 is
    unhealthy`. Cause, in `docker/backup/backup.sh:120`: `printf '%s\n' "${TOC}" | grep -qE
    'TABLE…schema_migrations…'` under `set -o pipefail`. `grep -q` exits at its first match; once the TOC
    exceeds the 64 KiB pipe buffer (978 entries here), `printf` dies of SIGPIPE (141) and pipefail turns a
    match into "did not find the schema_migrations table — refusing to promote it" — while the printed TOC
    lists `TABLE public schema_migrations`. Reproduced: 6 identical `backup.sh` runs on the same database → 1
    false refusal; in isolation in the backup image (75 KB TOC, match on line 1) **300/300 false refusals
    with `-q`, 0/300 without**. Consequences: random nightly-backup failures as a real install's TOC grows,
    any `up --wait` (so `just upgrade`) failing on `backup` unhealthy, and the CF-3 pre-migration backup
    (which calls backup.sh) refusing at random — fail-safe, but an upgrade outage. `backup.sh` is WP 9.1's
    this wave: exact diff under "Wiring for the orchestrator"; until it lands the harness applies it to its
    HEAD test tree only and logs `WIRING PENDING (F-94-1 …)`. `pre-migrate.sh` had the same `printf | grep -q`
    pattern (on short input, so not yet triggered) — fixed in my file.
- 18:19Z — attempt-1 project torn down (`run.sh --path direct --teardown`: `down -v pf-upgrade-direct`, 0
  `pf-upgrade-*` containers or volumes left). Sequence launched detached: direct → s1 → s2 → chain
  (`/tmp/wp94/sequence.sh`, logs `/tmp/wp94/logs/<path>.log`).
- 18:34Z — **direct jump, attempt 2: `RESULT: PASS`** (transcript §3). One harness slip: my scripted insertion
  of the `s1-no-placeholders` path landed in `apply_sabotage`'s `case` instead of the path `case`, so the
  sequence's S1 run exited `unknown --path`; fixed by atomic rename (the running S2 keeps its inode); S1 runs
  after the chain.
- 18:30Z — measurement note: up-to-ready reads 30–32 s at every hop, at load 2.6–4.4 as well as 7–8. The
  api's healthcheck is `interval: 30s` with no `start_interval`, so `up --wait` cannot see `healthy` before
  the first probe ~30 s in; the number measures the probe cadence, not readiness. A direct `/ready` poll is
  taken separately (§4).
- 18:35–18:37Z — **Sabotage S2 (pre-migrate disabled) — red first try, through the harness.** `run.sh --path
  s2-no-premigrate`: W0 cold install and load, then the HEAD tree with `pre-migrate-backup`'s command
  replaced by `['true']` (test tree only; `SABOTAGE-WP94-S2` marker), `just upgrade`. The upgrade itself
  succeeds (0003 → 0034) — which is the danger — and the verifier reports `**FAIL: no backup older than the
  first new migration (applied 20261005T183646Z)**`. (The `backup` service's own first backup runs only
  after the migrator, so it can never satisfy this check — CF-3 as found.) Restored: the sabotage lived only
  in the run's test tree, which the run deleted at teardown.
