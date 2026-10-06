<!-- SPDX-License-Identifier: MIT -->

# WP 9.4 — Unattended upgrade from v0.1: the test and its fixes

_Started 2026-10-05 17:32Z at `3f414ec` on `main`. Written incrementally; sections marked IN PROGRESS are
not yet claims._

Spec: `docs/plan/09-phase-9-dispatch.md` §3 "WP 9.4"; findings CF-2…CF-5 (§2b).

## 0. Status

**Verdict (2026-10-06, finisher): the unattended upgrade from v0.1 works — with one HIGH finding outside
this package that blocks the chain's last check.**

- **Direct jump W0 (v0.1) → HEAD by `just upgrade` alone: PASS** — the full suite at `faf42cc` (§3: checks
  (i)–(vi), the cross-boundary restore, the HEAD drill, CF-2 at the stack and the documented rollback) and
  the CI mode at `430d453` (`--ci`, two image sets, 5 min). Zero extra steps.
- **Chain W0 → W1 → W2 → W3 → W4 → W5 → HEAD (`430d453`): every check green at every hop — (i) schema
  equals disk, (ii) every fact loaded at every era readable at HEAD, (iii) master key, KEK generation 1,
  W0's TOTP, W0's passkey and a W0 recovery code, (v) 0/0 from W2 on, (iv) the W0 backup restored into
  HEAD — except one: (iv) the HEAD backup drill is RED on F-94-6** (HIGH, a 0022 SQL function; §1, §5;
  the fix migration is written and tested, §9 item 5; the chain goes green the commit it lands). The
  HEAD hop needed **zero extra steps**; two era hops (W2, W3) needed one each — **F-94-2**, CF-4 at an era
  boundary, which `just upgrade` closes for every hop to HEAD.
- **Sabotages through the harness: S1, S2, S3 each red first try** (§6), plus S-CF2-max, S-CF4-required,
  S-CF3-graph and S-CF3-fixture.
- **Fixes: CF-2, CF-3, CF-4 closed; CF-5 verified at W4 and closed with no change needed.** F-94-1 landed in
  9.1 (`c35821a`).
- **Handed on:** F-94-6 (HIGH, migration), F-94-5 (MEDIUM, budgeting/platform), the card-identity and
  outbox-lag observations, and (vi) over 09 §5.3's 20 s — the api's own boot, not the upgrade (9.9).

Waypoint table §2; direct transcript §3; chain §4; findings §5; sabotages §6; S3 §7; CI §8; wiring §9;
open items §10; final check §11. §1 is the log as it happened, including the probes that found F-94-5,
F-94-6 and F-94-7.

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
- **2026-10-06 04:2xZ — finisher resumes** at `d950bf2` (the orchestrator's W-A wiring: `justfile` now
  `import 'scripts/upgrade-test/upgrade.just'`, so `just upgrade` exists in the real tree). Host load
  0.75/0.86/1.19 at resume, no model loaded, no other agent building yet.
- 04:2xZ — `just typecheck`'s error in this package's `secrets-placeholders.test.ts` (TS2345 at lines 77/85:
  `Map` inferred with the `SECRET_SPECS` file-name union as its key, then probed with names from `docker
compose config`) fixed by typing the map `Map<string, …>`: an unknown declared name must be a lookup miss
  and a failed expectation, not a type error. `tsc` reports no error in `scripts/upgrade-test/` (the
  remaining ones are `scripts/soak/report.ts`, WP 9.1's).
- 04:2xZ — **the stopped `pf-upgrade-chain` project inspected** before `down -v`. Containers: api/worker/
  proxy/backup on the W1 images (`pf-upgrade/*:2e67648`), the W2 migrator `Created` but never started (the W2
  `up` died at container creation). The W1 worker's `RestartCount` was **1886** over 9.5 h, and its log is
  1887 × `configuration loaded` and nothing else. **This is not G3-1** (the no-holder exit — a holder existed
  from W0's bootstrap on): the kernel journal shows **1888 `Memory cgroup out of memory: Killed process …
(node-MainThread) … UID:10001`** in the worker's cgroup (`docker-9bbcd50e…`) since 14:40 EDT. W0's and
  W1's `compose.yml` give the worker `memory: 512M` while the KEK is Argon2id at 1 GiB (`@core/config`
  production params), so once a holder exists the worker is OOM-killed deriving the KEK, before its first
  post-config log line flushes. W2's own `compose.yml` raised it to 1536M with the comment "crash loop;
  `regate-worker-boot.test.ts` now pins limit > KEK memory": **an era defect already fixed at W2**, and HEAD
  carries the fix (HEAD's worker (v) = 0 on the direct path). The harness's (v) note for W0–W5 now names both
  causes (W0: G3-1, no holder; W1: the 512 MiB worker OOM) instead of G3-1 alone.
- 04:22Z — `pf-upgrade-chain` torn down (`docker compose -p pf-upgrade-chain down -v`: 6 containers, 4
  volumes, 2 networks; a project this package created). Attempt-1 artefacts kept at
  `/tmp/wp94/reports/chain-attempt1/` (report, logs, checks; no secrets). The orchestrator's `faf42cc`
  (release.yml `needs: upgrade-test`; `.env.example`) landed at 04:22Z, so **HEAD under test from here is
  `faf42cc`** (it carries 9.1's migration 0036 and backup.sh row insert, and the `upgrade.just` import).
- 04:2xZ — harness changes before the re-runs (all in `scripts/upgrade-test/`):
  - `prepare_tree`: the `upgrade` recipe is appended **only** when the justfile neither imports
    `upgrade.just` nor defines `upgrade:` (the old test would have appended a duplicate recipe to an
    importing justfile, which `just` rejects). The F-94-1 patch stays conditional on the exact buggy text and
    now logs either way. `compose.yml` and `RUNBOOK.md` (owned by block/section only) now come from the
    commit, never the working tree, so another package's in-flight edit cannot ride into the test.
  - **HEAD is pinned per run** (`$RUN_DIR/head.sha`): a commit landing mid-chain, or a resume, can no longer
    split one run across two commits (the version tag and `git archive` were both resolved per call).
  - `hop_era`: Compose's real wording for a missing secret file is `secret file <project>_<name> does not
exist` then `bind source path does not exist: …/secrets/<name>`; the old match (`not found|no such
file`) missed it, which is why attempt 1 died `FATAL` instead of recording the finding and continuing.
    The era hop now records **F-94-2** with the exact daemon error and the missing names, applies the minimal
    extra step (HEAD's `secrets-placeholders.sh --project-dir <install>` against that era's compose), counts
    it in `extra-steps.tsv`, and goes on; the chain ends with a per-hop extra-step table. The HEAD hop is
    never remediated.
  - S1's anchor follows the recipe into `upgrade.just`; S1 is judged red only on a missing-secret error.
  - **New path `s3-no-newer-check`** (W0 → HEAD+1 by `just upgrade`, then a control, the sabotage, and the
    literal W5 row) — the S3 decision is in §7.
  - (vi): the `/api/ready` poller now requires a **new** api container and a `"status":"ready"` body. The
    first direct re-run printed `1.1 s`, which is not a measurement: the poller accepted any 200, and an
    older era's proxy answers unknown paths with the SPA (or the old api) — that number is discarded.
  - `--ci` (direct path only) skips the stack-level rollback suite, so a runner builds two image sets.
  - `driver.mjs`, era loads never yet executed (attempt 1 died before W2's), checked against each era's own
    route code: W4's projection answers `status: 'stale', run: null` until the shortened 04:00 snapshot job
    has run, so the load now polls up to 300 s instead of dereferencing `run.id`; W5's grants skip every
    scope whose definition says `requiresPerRunConsent: true` (three at W5), not just two named ones.
  - Timeouts declared on every `just build` (1800 s), `just up` (600 s), `just upgrade` (2400 s), era `up
--wait` (`--wait-timeout 900`) and the sabotage build (1200 s).
- 04:26Z — sequence launched detached (`/tmp/wp94/sequence2.sh`: direct → s1 → s3 → chain, one at a time on
  8451/8452, stopping if a path leaves containers). Load 1.16/1.03/1.15.
- 04:29Z — **direct jump at `faf42cc`: the hop.** `just upgrade` alone, 0003 → **0036**, 131.1 s total
  (build included, load 2.76), up-to-ready inside the recipe 29 s (the healthcheck floor); pre-migration
  backup `personalfi-20261006T042836Z.dump.age` 1 s before the first new migration, marker present; (i) 34
  == 34, (ii)/(iii) pass, (v) api 0 / worker 0.
- 04:42Z — **direct jump at `faf42cc`: `RESULT: PASS`** (report `/tmp/wp94/reports/direct-faf42cc.md`, full
  transcript in §3). (iv) the W0-state pre-migration backup restored into `pf-upgrade-direct-r` and migrated
  by HEAD passes (i)–(iii), 99 tables = live 99; the HEAD backup drill passes, 99 = 99. CF-2 at the stack
  re-observed at `faf42cc`: pinned rollback refused by name, HEAD's api alone `/ready` 500, the documented
  rollback (restore the pre-migration backup, `just upgrade`) back to 34 applied with 0099 gone, all checks
  pass, a W0 recovery code verifies at HEAD. Load rose to 5–7 from 04:35Z (another agent's build): timings
  from that window are marked.
- 04:44Z — **Sabotage S1 (placeholders removed) — RED first try, through its own path** (`run.sh --path
s1-no-placeholders`, report `/tmp/wp94/reports/s1.md`). W0 cold install and load, then the HEAD
  (`faf42cc`) tree with `bash scripts/secrets-placeholders.sh` replaced by `true # SABOTAGE-WP94-S1` in
  the **test tree's** `scripts/upgrade-test/upgrade.just` (the recipe the justfile imports), `just
upgrade`. Observed: `upgrade: FAILED to come up`; Compose warned `secret file
pf-upgrade-s1-no-placeholders_<name> does not exist` for all 11 optional secrets HEAD declares and W0 never
  had (advisor_token_secret coinbase_key_name coinbase_private_key coingecko_api_key etherscan_api_key
  fred_api_key openfigi_api_key plaid_client_id plaid_env plaid_secret tiingo_api_key), then the daemon:
  `Error response from daemon: invalid mount config for type "bind": bind source path does not exist:
…/install/secrets/plaid_env`. (The spec's `secret … file not found` is an older Compose's wording; this
  Compose says `does not exist` — same failure.) After the refusal the W0 stack still answered `/ready` 200. Restored: the sabotage existed only in the run's test tree, deleted at teardown; `grep -c SABOTAGE`
  over the real `justfile`, `upgrade.just`, `compose.yml`, `migrate.ts` → 0.
- 04:50Z — **Sabotage S3 (newer-DB check removed) — RED first try, through its own path** (`run.sh --path
s3-no-newer-check`, report `/tmp/wp94/reports/s3.md`). W0 cold install and load, `just upgrade` straight to
  HEAD+1 (`faf42cc` + `0099_wp94_upgrade_test_future`; 0003 → 0099, pre-migration backup present), then on
  that schema: **control** — HEAD's real image pinned → refused, migrator `migration.database_newer: the
database has applied 0099_wp94_upgrade_test_future, which this binary does not carry`, `/api/ready` 000;
  **sabotage** (04:48Z) — the test tree's `packages/db/src/migrate.ts` gets `return; // SABOTAGE-WP94-S3`
  ahead of `refuseDatabaseNewer`'s test, built as `pf-upgrade/*:faf42cc-wp94-nocheck`, pinned → **up
  succeeded, `/api/ready` 200: the previous release's binary serves the next release's schema** (red);
  **literal** — W5's tree and image on the same schema → up succeeded, `/api/ready` 200 (W5 has no check:
  CF-2 as found). `grep -c SABOTAGE-WP94-S3`: test tree 1, real `migrate.ts` 0; the test tree was deleted at
  teardown. Timings in this run (up-to-ready 78–83 s) were taken at load 6.4–9.6 (other agents' vitest and
  9.1's `pf-prodlike` build) and are **not** believed.
- 04:51Z — **Sabotage S-CF3-fixture** (the hardening exit test's own red, recorded as it happened): in
  `scripts/fixtures/compose-hostile.yml`, the hostile `pre-migrate-backup`'s `user: '0:0'` → `user:
'10002:10002' # SABOTAGE-WP94-HF`. `compose-hardening-check.sh --self-test` → `SELF-TEST FAILED: these
service:rule pairs did not fire: pre-migrate-backup:root-user`, rc=1. **Red first try.** Restored from
  copy; `grep -c SABOTAGE` → 0; `git diff HEAD -- scripts/fixtures/compose-hostile.yml` empty; self-test PASS
  (31 rules; 21 service:rule pairs, the summary line now naming the pre-migrate-backup and migrator cases it
  covers instead of "ollama sandbox" alone). Real check PASS (3 files; `compose.yml` 11 services, 0
  violations). `secrets-placeholders.sh --self-test` PASS.
- 04:50–05:24Z — **chain attempt 2 (a probe: it ran with the W2/W4/W5 driver gaps below unfixed)**,
  artefacts `/tmp/wp94/reports/chain-attempt2/`. W0 → W1 → W2 → W3 → W4 → W5 → HEAD (`faf42cc`) all reached;
  every hop's (i) passes, (iii) passes except one rate-limited TOTP at W5 (below), (v) 0/0 from W2 on.
  - **F-94-2 recorded and handled at two era hops, exactly as designed.** W2: `Error response from daemon:
invalid mount config for type "bind": bind source path does not exist:
…/install/secrets/plaid_secret`, Compose: `secret file pf-upgrade-chain_<name> does not exist` for
    advisor_token_secret plaid_client_id plaid_env plaid_secret → extra step (HEAD's
    `secrets-placeholders.sh --project-dir <install>`: created 4) → W2 up. W3: the same error on
    `…/secrets/tiingo_api_key`, missing coinbase_key_name coinbase_private_key coingecko_api_key
    etherscan_api_key fred_api_key openfigi_api_key tiingo_api_key → extra step (created 7) → W3 up. W1, W4,
    W5 and HEAD: 0 extra steps.
  - **CF-5 verified at W4, and not reproduced after the upgrade.** At W4 `returns_cache` is `0:0 755` and the
    worker (10001) gets `EACCES … open '/var/lib/personalfi/returns/.wp94-probe'` — CF-5 as predicted. After
    the chain, at HEAD: `10001:10001 755`, writable by 10001. Docker copies the image's mount-point
    ownership into a named volume mounted **empty**, and HEAD's `api.Dockerfile` (C-1) creates the directory
    `chown 10001:10001`; the W4 era could write nothing into it (EACCES), so it is still empty when HEAD
    first mounts it. The fix needs no root and no change to `docker/api.Dockerfile`. Residual: an operator
    who worked around the W4 EACCES by writing into the volume as root keeps a root-owned non-empty volume
    (RUNBOOK's existing note covers the manual repair).
  - **F-94-5 (MEDIUM, budgeting/platform — handed on): a consumer dead-lettered by ordinary data, with no
    operator path back.** At HEAD `/ready` answered **200 with `"status":"degraded"`**, `outbox.maxLagEvents
130`, `failedConsumers: ["budgeting.actuals@v1"]`. The offsets row (read by a detached diagnostic,
    `/tmp/wp94/tools/consumer-diag.sh`): `budgeting.actuals@v1 | failed | last_seq 0 | failed_seq 5 |
failed_count 5 | budgeting.actuals@v1 failed on event seq 5: on-budget accounts with no balance
observation: 01a10f8e-…, 01a10f8e-…, 01a10f8e-…. A budget that treats an unreported account as empty is
wrong by the size of that account.` Sequence: W1's CSV import creates three on-budget accounts with no
    balance (a CSV states none); at W2 the new consumer replays from seq 0, a no-op while no budget exists;
    the first `GET /budgets/current` **creates** the budget (`requireOrCreateBudget`) and then answers 409
    `budgeting.balance_unreported` — the budget row stays; the consumer's next attempt at seq 5 throws the
    same error, five times, and the pump dead-letters it (`pump.ts:374`, `status = 'failed'`), skipping it
    forever after (`pump.ts:257`). HEAD carries the same code paths (`routes/budgets.ts`
    `currentPeriodOf`, `budgeting/src/consumer.ts` "a budget that does not add up must stop"), so **a HEAD
    install that imports a CSV and opens the budget screen before reporting balances freezes budgeting
    actuals for good**. `replayConsumer`/`setConsumerStatus` exist in `@core/platform` but no route, CLI or
    recipe exposes them: recovery is hand SQL. Not this package's to fix (budgeting/platform). The chain's
    re-run reports the balances (W2's own way: an OFX statement) before the budget is first read.
  - **`just upgrade` passed that silently** — `/ready` 200 was its only test. Now (`upgrade.just`): a 200 whose
    status is not `ready` prints `upgrade: WARNING: /ready reports degraded; consumer(s) stopped at an event
they cannot handle: …` and the harness copies it into the hop's report row. It does not fail the upgrade
    (the state may predate it, and there is no operator tool to clear it).
  - **F-94-6 (HIGH, migrations — handed on): a backup of any install holding a plan scenario cannot be
    restored.** Step 25 (the HEAD backup drill) **FATAL**: `pg_restore: error: COPY failed for table
"plan_scenarios": ERROR: function plan_amount_json_is_well_formed(jsonb) does not exist … CONTEXT: SQL
function "plan_scenario_levers_are_well_formed" during inlining`; `errors ignored on restore: 1`;
    `restore.sh` refused. Cause: `pg_dump` archives restore with an empty `search_path`, and
    `0022_plan_projections.sql`'s `plan_scenario_levers_are_well_formed` (the CHECK
    `plan_scenarios_levers_are_deltas`) calls `plan_amount_json_is_well_formed` unqualified, with no `SET
search_path`. The planner inlines the SQL function when it plans the CHECK, so **one row of any shape**
    (a baseline with `levers` NULL included) breaks the COPY. The direct path, the S-paths and the monthly
    drill (`3f414ec`) passed only because their databases held no plan scenario. **Reproduced in isolation
    at HEAD's text** (`/tmp/wp94/f946-repro.sh`: a throwaway `postgres:18.6` container, `--network none`;
    0022's three functions verbatim, the CHECK verbatim, one row): `pg_restore exit 1`, `0 row(s) restored`;
    the same with the inner call written `public.plan_amount_json_is_well_formed(…)`: `pg_restore exit 0`,
    `1 row(s) restored`. It is the only function in `packages/db/migrations` whose body calls another user
    function (the other 14 call only `pg_catalog`). Fix (a migration; numbers are the orchestrator's — 0040
    is the spare): `CREATE OR REPLACE FUNCTION plan_scenario_levers_are_well_formed(levers JSONB) …` with the
    three inner calls schema-qualified `public.plan_amount_json_is_well_formed(…)` (keeps the function
    inlinable; `SET search_path` would also work but stops inlining). It must land before Chris saves a plan
    on the soak install, and the restore drill should hold a plan scenario from then on.
  - The W5 TOTP check met `HTTP 429 … Too many attempts. Try again in 151 seconds`: the limiter counts every
    verification and the chain verifies once per hop. The driver now waits out the stated time once and
    says so in the row. The W5 Brief never appeared in 480 s (the cause is not visible without the
    scheduler's rows; the harness now prints them on a miss). W2's and W4's loads failed (driver gaps, fixed:
    W2 reports balances by OFX statement first; W4 projects from today's open day with `asOf`), so this
    attempt's matrix lacks W2/W4/W5-Brief facts; the HEAD verify that did run passed (i), (ii) W0/W1/W3/W5,
    (iii), (v) 0/0, and (iv) the W0 backup restored into HEAD (99 = 99) — before F-94-6 stopped the HEAD
    drill.
- 05:3xZ — **F-94-6's proposed fix, tested** (`/tmp/wp94/f946-fixtest.sh`, throwaway `postgres:18.6`,
  `--network none`): 0022's functions as shipped, two rows (a baseline with `levers` NULL; a fork with
  `retire_age` and `annual_spending`, which exercises the inner call), then the proposed migration text
  (`/tmp/wp94/f946-fix-migration.sql`, §9 item 5) applied on top — as a live install would. The CHECK still
  refuses a bad lever (`violates check constraint "plan_scenarios_levers_are_deltas"`); `pg_dump -Fc` →
  `pg_restore` into a fresh database: **exit 0, 2 row(s) restored**.
- 05:27Z — chain attempt 3 launched detached (`PATHS=chain /tmp/wp94/sequence2.sh`), every fix above in
  place, HEAD pinned at `faf42cc`.
- 05:31Z — orchestrator note received: **F-94-1 landed in 9.1 (`c35821a`)** — `backup.sh`'s schema_migrations
  check no longer pipes into `grep -q`; `scripts/soak/backup-script-pipefail.test.ts` is its never-test.
  Confirmed the harness skips cleanly: `prepare_tree HEAD` at `430d453` logs `F-94-1: HEAD's backup.sh no
longer carries the \`printf | grep -qE\` schema_migrations check; no patch applied`, rc 0, and the test
tree's justfile holds no second `upgrade:`(it imports`upgrade.just`). The chain in flight stays pinned
at `faf42cc`(its`head.sha`), where the conditional patch still applies, and says so in its log.
9.1's `restore-drill`recipe now filters by`COMPOSE_PROJECT_NAME`: the harness never calls `just
  restore-drill`(README "Safety": it asserts the drill's checks against its own named`-r` project), so
  nothing to change.
- 05:31Z — `just check`'s lint findings in this package fixed: `driver.mjs` wrote with `console.*` (11 ×
  `no-console`), read `document` in the browser-side ceremony (`no-undef`), and kept an unused initial
  value (`no-useless-assignment`). Output now goes through two named helpers over
  `process.stdout`/`process.stderr` (the script's line protocol with the harness), `globalThis.document`
  in the page callback. `eslint scripts/upgrade-test/` → 0 errors. Replaced atomically (the chain invokes
  the driver per step).
- 05:27–05:34Z — **chain attempt 3** (artefacts `/tmp/wp94/reports/chain-attempt3/`): W0 → W1 → W2 → W3 → W4
  reached, F-94-2 recorded and bridged at W2 and W3 again, every hop's (i)/(iii)/(v) passing; the W2 load
  failed on a new era fact — **F-94-7 (LOW, historical): a W1 file-import connection can never take another
  file after the upgrade.** Staging the OFX statement onto W1's connection answered `409
connector.auth_required … The provider needs your attention (AUTH_REQUIRED). Reconnect the connection to
continue.` Cause: W2 made file staging durable (`packages/connectors/csv/src/connector.ts` `#sync` →
  `#hydrate` only `if (await durable.has(connectionId))`), and W1's staging was in memory only, so a
  W1-era connection has no durable rows and `#state` throws `AUTH_REQUIRED` — "this import has been
  disconnected; upload the file again". No W1 install exists outside tests; recorded, not carried. The
  failure came before any budget was read, so F-94-5 was not re-triggered. Stopped by hand at W4's verify
  (`kill` of this package's own `sequence2.sh`/`run.sh`; `--teardown`), because a fresh run reaches W4/W5
  as soon as this one would and attempt 3 could no longer carry W2's facts.
- 05:34Z — driver W2 load reworked to W2's own guidance: the statements again as OFX (carrying
  `LEDGERBAL`) on a **new** file-import connection, then the superseded W1 CSV accounts closed (`PATCH
/accounts/:id {closed: true}`; a closed account leaves the budget identity, its transactions stay
  readable — no transaction read filters on `closedAt` at W2, W5 or HEAD), and only then the budget. **Chain
  attempt 4 launched**, HEAD pinned at `430d453` (it carries 9.1's `c35821a`, so the F-94-1 patch is a
  no-op there), load 1.73/3.60/4.49.
- 05:37–05:42Z — **chain attempt 4** (`/tmp/wp94/reports/chain-attempt4/`, HEAD `430d453`): W2's load got
  past the balances and the account closing, then `GET /budgets/current` → `409
  budgeting.card_identity_violation … identity II failed for card 01a10fb8-…: owed 350.00 ≠ available 0.00
  - unfunded 0.00`, for the OFX card statement's −350.00. **Observation (handed on, not exercised further):**
the first period opens every card-payment line from carryover columns that only a roll writes, so a card
already owing when the budget is first opened seems to fail identity II; HEAD's `service.ts` has the same
shape (`owed = −workingBalance`against`available + unfunded`, opening from carryover). This package did
    not test it at HEAD; it matters for the soak (a real card carries a balance) and belongs to budgeting's
    owner. The budget had been created before the 409, so this run's actuals consumer would dead-letter too
    (F-94-5): stopped by hand, torn down. The W2 load now confirms the recurring series first (while W1's
    accounts are open), and uses a paid-off card statement (0.00).
- 05:42Z — **chain attempt 5 launched**, HEAD `430d453`, load 1.57/2.20/3.44.
- 05:42–05:57Z — **chain attempt 5** (HEAD `430d453`), a probe like 2–4 for the loads it reached:
  - W2's load: `no recurring candidates after 240 s`. A detached read of the offsets right after the W3
    hop showed every consumer at `last_seq 0` with `max_seq 9` — W1's events unconsumed when W2's era
    ended — while the W3 worker logged `categorised transactions` ×4 and `ran recurring detection` ×7
    within seconds of booting. W2's pump code and its module defaults are the same as W3's (5 s poll;
    `module.recurring`/`budgeting` `defaultEnabled: true`), so the cause is not in the code read; the W2
    worker's log was gone with its container. The harness now keeps every outgoing era's worker log and
    the consumer offsets before each hop (`before-<wp>-worker.log`, `before-<wp>-consumers.txt`, one line
    in the report), and the driver records a W2 miss and confirms the series at W3 instead.
  - W4's load: the shortening worked (`2 row(s)`), the scheduler claimed it at 05:52:07 — and queued the
    job `run_after 06:01:55`: the schedule's own `jitterSeconds: 10 * 60` (`planning/src/jobs.ts:145`),
    so no net-worth row existed within the 300 s poll (`409 planning.projection_no_balances … no net-worth
row for 2026-10-06`). The diagnostics printed exactly that. The shortening now also sets
    `jitter_seconds = 0` (timing metadata, logged) — very likely attempt 2's missing W5 Brief as well
    (180 s jitter plus the job inside 480 s).
- 05:58–06:06Z — attempt 5, continued (`/tmp/wp94/reports/chain-attempt5/`): **W5 loaded in full** — 40
  advisor grants, a run (2 insights inserted, 4 in the feed), a dismissal `NOT_ACTIONABLE` on
  `builtin.retirement.goal_pace`, and **a Brief published** (`2026-W41`, 0 items, 06:01:03Z, 2 min 41 s
  after the shortening). The **HEAD hop at load 1.65**: `just upgrade` alone, 0034 → 0036, F-94-1 patch not
  applied (`no patch applied` — 9.1's fix is in `430d453`), pre-migration backup 1 s before the first new
  migration, **(vi) `up --wait` 32 s, polled `/api/ready` from `up` 25.8 s** (pre-migration backup +
  migrations + api boot), (i) 34 = 34, (ii) W0/W1/W3/W5 facts intact incl. the Brief, (iii) all pass, (v)
  0/0, CF-5 writable at HEAD, a W0 recovery code verifies; (iv) the W0 backup restored into HEAD passes,
  99 = 99; **(iv) the HEAD backup drill FAILED on F-94-6** — `pg_restore: error: COPY failed for table
"plan_scenarios": ERROR: function plan_amount_json_is_well_formed(jsonb) does not exist` (W4's load had
  created the scenario before its projection timed out), recorded by the now non-fatal restore check, the
  run continuing. Extra steps: W2 1, W3 1 (F-94-2), HEAD 0. `RESULT: FAIL — 3 failed check(s)`: load W2,
  load W4 (both fixed since), the HEAD drill (F-94-6, not this package's to fix).
- 06:06Z — **chain attempt 6 launched** (the final one): HEAD `430d453`, load 1.08/1.28/1.71, every fix
  above in place.
- 06:06–06:23Z — **chain attempt 6** (`/tmp/wp94/reports/chain-attempt6/`, HEAD `430d453`): every era's
  load went through its own API for the first time — W2: the rule, the OFX statements on a new connection
  (balances 2500.00 / 10000.00 / 0.00), the three W1 CSV accounts closed, a budget line assigned 500.00;
  W2's recurring miss recorded (`no recurring candidate within 240 s`) and **the series confirmed at W3**
  (3 candidates); W4: scenario, goal, assumption override, **a deterministic projection computed from the
  open day** (`asOf 2026-10-06`, `balancesSealed false`, 11 s after the jitter-free shortening); W5: grants,
  run, dismissal, **Brief `2026-W41` published 29 s after the shortening**. Extra steps W2 1 / W3 1
  (F-94-2) / HEAD 0. HEAD hop at load 2.17: `just upgrade` 123.9 s with build; (vi) `up --wait` 30 s,
  polled `/api/ready` 24.1 s; **stage breakdown: pre-migrate-backup done 1.0 s → migrator 1.2–1.7 s → api
  container started 1.8 s** — the backup and the migrations cost under 2 s; the rest is the api's own boot
  (KEK derivation and onReady work). `RESULT: FAIL` on three checks: **ii.W4 at W5 and at HEAD — a harness
  bug**, the first time that check ran (W4's own verify precedes its load): `GET /plan/projections/:runId`
  answers the outcome `{status, run}` and the driver read `method` off the outcome ("run method
  undefined"); fixed. And **(iv) the HEAD drill — F-94-6** again, now with its cascade: `COPY failed for
table "plan_scenarios" … plan_amount_json_is_well_formed(jsonb) does not exist`, then `insert or update
on table "projection_runs"` fails its foreign key (the scenario row is missing).
  - W2's stalled consumers, with the evidence now kept: W2's worker log (`before-W3-worker.log`) shows all
    four consumers registered and `consumer pump started` at 06:09:27, then nothing in 4.5 min — no error;
    the offsets before the W3 hop read `last_seq 0` for all four with `max_seq 24`. Under W3's worker
    `categorization.assignments@v1` reached seq 8 and `recurring.detection@v1` 46 within seconds. W2's
    pump code is W3's; the cause is not found here. Historical (W2 era only), recorded, not chased further.
- 06:23Z — **chain attempt 7 launched** (final), then `run.sh --path direct --ci --run direct-ci`
  (`/tmp/wp94/sequence7.sh`), load 0.76/1.55/1.70.

## 2. The waypoint table

Chain attempt 7 (`/tmp/wp94/reports/chain-final.md`, 2026-10-06 06:23–06:41Z, HEAD `430d453`) for W0–W5
and the chain's HEAD; the direct jumps for the two HEAD rows below them. Images are
`pf-upgrade/{api,proxy,backup}:<tag>`. Era hops are each era's own documented upgrade (`just build`, `just
backup`, `docker compose up -d --wait`), so their up-to-ready is `up --wait` → `/ready` 200 and they have no
pre-migration backup of their own (the harness checks the one `just backup` took). HEAD hops are `just
upgrade` alone; "polled" is from its `up -d --wait` line to a new api's `/api/ready` 200 with
`migrations: current`. Load is the 1-min average at the measurement.

| Waypoint              | sha / tag      | Migrations after the hop | Extra steps      | Up-to-ready (s, load)                                                               | api / worker restarts           | (i)  | (ii) facts readable | (iii)                | (iv)                                                           | (v)        |
| --------------------- | -------------- | ------------------------ | ---------------- | ----------------------------------------------------------------------------------- | ------------------------------- | ---- | ------------------- | -------------------- | -------------------------------------------------------------- | ---------- |
| W0                    | `d04669e`      | 3 (max 0003)             | — (cold install) | 14.9 (`just up`, 2.13)                                                              | 0 / 1 (G3-1, historical)        | pass | W0                  | pass                 | W0 backup taken                                                | historical |
| W1                    | `2e67648`      | 7 (0007)                 | 0                | 20.1 (1.84)                                                                         | 0 / 1 (512 MiB OOM, historical) | pass | W0                  | pass                 | —                                                              | historical |
| W2                    | `d3a51a0`      | 12 (0012)                | **1 (F-94-2)**   | 19.3 (2.98)                                                                         | 0 / 0                           | pass | W0, W1              | pass                 | —                                                              | pass       |
| W3                    | `6391428`      | 19 (0019)                | **1 (F-94-2)**   | 29.3 (1.18)                                                                         | 0 / 0                           | pass | W0–W2               | pass                 | —                                                              | pass       |
| W4                    | `d0dcf70`      | 26 (0027)                | 0                | 29.5 (1.92)                                                                         | 0 / 0                           | pass | W0–W3               | pass                 | —                                                              | pass       |
| W5                    | `f24160f`      | 33 (0034)                | 0                | 27.2 (1.80)                                                                         | 0 / 0                           | pass | W0–W4               | pass                 | —                                                              | pass       |
| HEAD (chain)          | `430d453-wp94` | 34 (0036)                | **0**            | polled 28.7, `up --wait` 35 (2.33); stages: backup 0.9 → migrator 1.1–1.6 → api 2.1 | 0 / 0                           | pass | **W0–W5**           | pass + recovery code | W0 backup → HEAD pass (99 = 99); **HEAD drill FAIL (F-94-6)**  | pass       |
| HEAD (direct, `--ci`) | `430d453-wp94` | 0003 → 0036              | 0                | polled 23.0, `up --wait` 28 (1.18); stages: backup 0.5 → migrator 0.7–3.1 → api 4.0 | 0 / 0                           | pass | W0                  | pass + recovery code | W0 pre-migration backup → HEAD pass; HEAD drill pass (99 = 99) | pass       |
| HEAD (direct, full)   | `faf42cc-wp94` | 0003 → 0036              | 0                | `up --wait` 29 (2.76); the polled figure of that run is discarded (§1)              | 0 / 0                           | pass | W0                  | pass + recovery code | both pass (99 = 99); CF-2 rollback suite pass                  | pass       |

(vi), read across: 09 §5.3's 20 s is not met at any HEAD hop (23.0–28.7 s polled at load 1.2–2.3); the
stage breakdowns put the pre-migration backup plus every migration under 3.1 s and the api container's
start under 4.0 s, so the rest is the api's own boot. Era hops (19–30 s) predate the budget.

- 06:23–06:41Z — **chain attempt 7, the result** (`/tmp/wp94/reports/chain-final.md`; §2, §4): every
  era's load through its own API; every check at every hop green; HEAD hop `just upgrade` alone, 0 extra
  steps; `RESULT: FAIL — 1 failed check(s): (iv) the HEAD backup restore drill` (F-94-6, with its
  `projection_runs` foreign-key cascade). Observed at HEAD: `/ready` `status: ready` with `maxLagEvents
137` — `categorization.assignments@v1` at seq 8 since W3. HEAD's lag counts every event after a
  consumer's `last_seq` (`pump.ts`: `count(*) … WHERE e.seq > o.last_seq`), while a filtered consumer's
  offset advances only on its own event types, so a consumer whose types stop arriving shows "lag" that
  is not work; `health.ts` turns `degraded` above 1,000. Not exercised to 1,000 here; recorded as an
  observation for platform (§5).
- 06:41–06:47Z — **`run.sh --path direct --ci --run direct-ci` at `430d453`: `RESULT: PASS`**
  (`/tmp/wp94/reports/direct-ci.md`) — the CI mode itself, exercised: the rollback suite skipped with its
  reason logged, two image sets (W0 cached, HEAD `430d453-wp94`), (i)–(iii), (v), the W0 pre-migration
  backup restored into HEAD (99 = 99), the HEAD drill (99 = 99), a W0 recovery code. (vi) at load 1.18:
  polled 23.0 s, `up --wait` 28 s; stages: pre-migrate-backup done 0.5 s, migrator 0.7–3.1 s (31
  migrations), api container started 4.0 s. No `pf-upgrade-*` container left after the sequence.

## 3. The direct jump W0 → HEAD (`faf42cc`), transcript

`bash scripts/upgrade-test/run.sh --path direct`, 2026-10-06 04:26–04:42Z, `RESULT: PASS`. The harness's
own report (`/tmp/wp94/reports/direct-faf42cc.md`), the bootstrap banner removed (it carries nothing secret,
just noise). Between W0 and HEAD the install saw exactly: the tree replaced (`git pull`), `just upgrade`.
Rows `iv-w0-premigrate` are **the cross-boundary restore**: the backup the CF-3 one-shot took of the W0
database, restored into a fresh project (`pf-upgrade-direct-r`) by HEAD's `restore.sh`, migrated by HEAD's
pre-migrate + migrator, then (i)–(iii) and the restore drill's table count against it. Rows `iv-head-drill`
are a HEAD backup through the same drill. The earlier PASS at `3f414ec` (attempt 2, 2026-10-05) is kept at
`/tmp/wp94/reports/direct-20261005.md`.

```text
- W0 secrets per W0's RUNBOOK: age_recipient b2_application_key b2_key_id database_url master_key pg_password (age identity kept in $WORK only)
| timing | W0 cold install: just up -> /ready 200 | 14.8 s | load 3.17 1.57 1.33 | W0 d04669e |
- W0 loaded through W0's API: passkey (CDP virtual authenticator), TOTP enrolment, 10 recovery codes
| W0 | (i) | pass 3 applied == 3 on disk, checksums equal, none extra (max 0003) |
| W0 | pass iii.unlock | unlocked, KEK generation 1 (W0: 1) |
| W0 | pass iii.passkey | W0's passkey logged in (fresh session, user 01a10f76…) |
| W0 | pass iii.totp | a TOTP code from W0's secret verified (POST /auth/totp/verify 200) |
| W0 | pass ii.W0 | user, tz, 1 passkey (same id), TOTP enrolled, 10 recovery codes |
| W0 | (v) RestartCount | api=0 worker=1 — historical, that era's own worker (W0: G3-1, no holder yet; W0/W1 with a holder: 512 MiB limit < 1 GiB KEK, cgroup OOM — see the evidence's §5); not counted |
[2026-10-06T04:27:21Z] WIRING PENDING (F-94-1, backup.sh is WP 9.1's): the test tree's backup.sh carries the one-line pipefail fix
| timing | HEAD: `just upgrade` total (build included) | 131.1 s | load 2.76 2.30 1.66 | migrations 0003 -> 0036 |
| timing | HEAD: up-to-ready inside `just upgrade` (up --wait; floored by the api healthcheck's 30 s interval) | 29 s | load 2.76 2.30 1.66 | 09 §5.3 budget < 20 s |
| timing | HEAD: up -> new api's /api/ready 200, polled every 0.2 s (pre-migration backup + migrations + boot) | 1.1 s (DISCARDED: the old poller accepted any 200; see §1 04:2xZ) | load 2.76 2.30 1.66 | load at ready 5.18 2.51 1.68 |
    secrets-placeholders: created 11 empty optional placeholder(s): advisor_token_secret coinbase_key_name coinbase_private_key coingecko_api_key etherscan_api_key fred_api_key openfigi_api_key plaid_client_id plaid_env plaid_secret tiingo_api_key (2 already present, left untouched)
    upgrade: /ready 200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"0","maxLagEvents":0,"oldestUnprocessedAgeSeconds":null,"failedConsumers":[]}
    upgrade: pre-migrate: complete: /backups/personalfi-20261006T042836Z.dump.age (marker personalfi-20261006T042836Z.pre-migrate); the migrator may start
    upgrade: api running, restarts 0
    upgrade: worker running, restarts 0
| HEAD | pre-migration backup | pass: personalfi-20261006T042836Z.dump.age precedes the first new migration (20261006T042837Z); marker present |
| HEAD | (i) | pass 34 applied == 34 on disk, checksums equal, none extra (max 0036) |
| HEAD | pass iii.unlock | unlocked, KEK generation 1 (W0: 1) |
| HEAD | pass iii.passkey | W0's passkey logged in (fresh session, user 01a10f76…) |
| HEAD | pass iii.totp | a TOTP code from W0's secret verified (POST /auth/totp/verify 200) |
| HEAD | pass ii.W0 | user, tz, 1 passkey (same id), TOTP enrolled, 10 recovery codes |
| HEAD | (v) RestartCount | api=0 worker=0 |
| timing | (iv) w0-premigrate: restore.sh + up -d --wait -> /ready | 37.9 s | load 5.17 3.08 1.98 | backup personalfi-20261006T042836Z.dump.age |
| iv-w0-premigrate | (i) | pass 34 applied == 34 on disk, checksums equal, none extra (max 0036) |
| iv-w0-premigrate | pass iii.unlock | unlocked, KEK generation 1 (W0: 1) |
| iv-w0-premigrate | pass iii.passkey | W0's passkey logged in (fresh session, user 01a10f76…) |
| iv-w0-premigrate | pass iii.totp | a TOTP code from W0's secret verified (POST /auth/totp/verify 200) |
| iv-w0-premigrate | pass ii.W0 | user, tz, 1 passkey (same id), TOTP enrolled, 10 recovery codes |
| iv-w0-premigrate | (v) RestartCount | api=0 worker=0 |
| iv-w0-premigrate | drill: tables | restored+migrated 99 |
| iv-w0-premigrate | drill: tables live vs restored | live 99, restored 99 — equal |
- HEAD backup (`just backup`'s command): `personalfi-20261006T043134Z.dump.age`
| timing | (iv) head-drill: restore.sh + up -d --wait -> /ready | 35.5 s | load 3.10 2.91 2.03 | backup personalfi-20261006T043134Z.dump.age |
| iv-head-drill | (i) | pass 34 applied == 34 on disk, checksums equal, none extra (max 0036) |
| iv-head-drill | pass iii.unlock | unlocked, KEK generation 1 (W0: 1) |
| iv-head-drill | pass iii.passkey | W0's passkey logged in (fresh session, user 01a10f76…) |
| iv-head-drill | pass iii.totp | a TOTP code from W0's secret verified (POST /auth/totp/verify 200) |
| iv-head-drill | pass ii.W0 | user, tz, 1 passkey (same id), TOTP enrolled, 10 recovery codes |
| iv-head-drill | (v) RestartCount | api=0 worker=0 |
| iv-head-drill | drill: tables | restored+migrated 99 |
| iv-head-drill | drill: tables live vs restored | live 99, restored 99 — equal |

#### CF-2 at the stack: HEAD+1 -> rollback
[2026-10-06T04:33:28Z] WIRING PENDING (F-94-1, backup.sh is WP 9.1's): the test tree's backup.sh carries the one-line pipefail fix
| timing | HEAD+1: `just upgrade` total (build included) | 178.1 s | load 5.05 4.87 3.07 | migrations 0036 -> 0099 |
| timing | HEAD+1: up-to-ready inside `just upgrade` (up --wait; floored by the api healthcheck's 30 s interval) | 34 s | load 5.05 4.87 3.07 | 09 §5.3 budget < 20 s |
| timing | HEAD+1: up -> new api's /api/ready 200, polled every 0.2 s (pre-migration backup + migrations + boot) | 28.1 s | load 5.05 4.87 3.07 | load at ready 7.14 5.16 3.09 |
    secrets-placeholders: nothing to create (13 optional secret(s) already present, 4 required present)
    upgrade: /ready 200 {"status":"ready","database":"reachable","migrations":"current","outbox":{"maxSeq":"0","maxLagEvents":0,"oldestUnprocessedAgeSeconds":null,"failedConsumers":[]}
    upgrade: pre-migrate: complete: /backups/personalfi-20261006T043530Z.dump.age (marker personalfi-20261006T043530Z.pre-migrate); the migrator may start
    upgrade: api running, restarts 0
    upgrade: worker running, restarts 0
| HEAD+1 | pre-migration backup | pass: personalfi-20261006T043530Z.dump.age precedes the first new migration (20261006T043531Z); marker present |
| HEAD+1 | applied | 0036,0099 |
| rollback (a) pin prior image | refused: up failed; migrator: `migration.database_newer: the database has applied 0099_wp94_upgrade_test_future, which this binary does not carry — it was migrated by a newer release` |
| rollback (a) | after the refusal: api pf-upgrade/api:faf42cc-wp94 created; /api/ready 000 (compose had already replaced the old containers: a refused rollback leaves the app down, never serving the wrong schema) |
| rollback (b) HEAD api alone on HEAD+1's schema | /ready 500; log names: `migration.database_newer: the database has applied 0099_wp94_upgrade_test_future, which this binary does not carry — it was migrated by a newer release. Refusing to migrate or serve it: an older binary never runs against a newer schema. Run the release that applied it, or roll back by restoring the pre-migration backup (RUNBOOK.md \` |
- **SABOTAGE s3-no-newer-check**: HEAD's migrate.ts with refuseDatabaseNewer short-circuited, built as pf-upgrade/*:faf42cc-wp94-nocheck (04:37Z)
| S3 (check removed) pinned rollback | **up succeeded; /api/ready 200 — the older binary serves HEAD+1's schema (RED, as expected)** |
| CF-2 as shipped: W5's tree and image on HEAD+1's schema | **up succeeded; /api/ready 200 — W5 serves a schema it does not know (CF-2 red)** |
#### The documented rollback: restore the pre-migration backup (`personalfi-20261006T043530Z.dump.age`)
| timing | rollback: restore pre-migration backup, then just upgrade | 148.4 s | load 5.29 6.04 4.09 | from personalfi-20261006T043530Z.dump.age |
| rollback (e) | schema after: 34 applied, max 0036, 0099 present: false |
| HEAD-after-rollback | (i) | pass 34 applied == 34 on disk, checksums equal, none extra (max 0036) |
| HEAD-after-rollback | pass iii.unlock | unlocked, KEK generation 1 (W0: 1) |
| HEAD-after-rollback | pass iii.passkey | W0's passkey logged in (fresh session, user 01a10f76…) |
| HEAD-after-rollback | pass iii.totp | a TOTP code from W0's secret verified (POST /auth/totp/verify 200) |
| HEAD-after-rollback | pass ii.W0 | user, tz, 1 passkey (same id), TOTP enrolled, 10 recovery codes |
| HEAD-after-rollback | (v) RestartCount | api=0 worker=0 |
| HEAD | (iii) a W0 recovery code | {"status":200,"remainingCodes":9} |
```

## 4. The chain W0 → W1 → … → HEAD

`bash scripts/upgrade-test/run.sh --path chain`, seven attempts: 1 (2026-10-05) died at W2 on F-94-2
before the harness could record it; 2–6 were probes, each finding something the last could not reach (§1);
**7 is the result** (`/tmp/wp94/reports/chain-final.md`, `RESULT: FAIL — 1 failed check(s): (iv) the HEAD
backup restore drill`, i.e. F-94-6).

What each era loaded through its own API, and where it was read back (every row read back at every later
hop, and all of them at HEAD):

| Era | Loaded                                                                                                                                                             | Read back at HEAD                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| W0  | holder, passkey (CDP virtual authenticator), TOTP, 10 recovery codes                                                                                               | user, tz, the same credential id, TOTP enrolled, codes; W0's passkey logs in; a W0 TOTP and a W0 recovery code verify |
| W1  | 978 CSV rows of `generateDemoData(1)` in 3 files; a category override                                                                                              | count 978; the override and the spot amount on the same transaction                                                   |
| W2  | a rule; OFX statements on a new connection (balances); the W1 CSV accounts closed; a budget line assigned 500.00; recurring not loadable in W2's window (recorded) | the rule, the line and its 500.00                                                                                     |
| W3  | the recurring series confirmed (3 candidates); a manual investment account (balance 15,000.00); a watch-only wallet                                                | the series (confirmed), the account and balance, the wallet connection                                                |
| W4  | a baseline scenario, an emergency-fund goal, an assumption override (`capitalMarket.usEquity.expectedReturn` 0.0555), a deterministic projection from the open day | scenario, goal, override value, the run (deterministic)                                                               |
| W5  | 40 advisor grants, a run (3 inserted), a dismissal `NOT_ACTIONABLE`, a Brief `2026-W41`                                                                            | the dismissal and its reason count, the Brief by week                                                                 |

The per-hop extra-step ledger, as the harness wrote it:

| Hop  | Finding | Exact error                                                                                                                                                                                                                                                            | Extra step                                                                                                             |
| ---- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| W2   | F-94-2  | `Error response from daemon: invalid mount config for type "bind": bind source path does not exist: …/install/secrets/plaid_client_id` (Compose: `secret file pf-upgrade-chain_<name> does not exist` for advisor_token_secret plaid_client_id plaid_env plaid_secret) | HEAD's `scripts/secrets-placeholders.sh --project-dir <install>` (created 4), then `docker compose up -d --wait` again |
| W3   | F-94-2  | `… bind source path does not exist: …/install/secrets/coinbase_private_key` (7 names: coinbase_key_name coinbase_private_key coingecko_api_key etherscan_api_key fred_api_key openfigi_api_key tiingo_api_key)                                                         | the same (created 7)                                                                                                   |
| HEAD | —       | —                                                                                                                                                                                                                                                                      | none: `just upgrade` alone                                                                                             |

**F-94-2, the finding.** An era that declared new file secrets shipped no step to create them, so an install
made at an earlier era could not run that era's own documented upgrade unattended. It cannot be fixed in
history; from HEAD on, `just upgrade` runs the placeholder step before anything starts (CF-4), so every hop
**to** HEAD — from v0.1 directly, or from any era — needs nothing else, and 09 §5's rule ("every new secret
is optional") plus `secrets-placeholders.test.ts` keep it so.

**The chain's verdict.** PASS on every upgrade check; the HEAD hop needed zero extra steps; RED on one
restore check, F-94-6, which is a defect in a migration this package does not own and which no upgrade path
can route around: a backup of a database holding a plan scenario does not restore at any commit since 0022. It turns green the commit the §9 item 5 migration lands; nothing in the harness changes.

## 5. Findings, red → green

| ID         | Severity                | What                                                                                                                                                                                                        | Red (observed)                                                                                                                                               | Green                                                                                                                                                                                                                | Owner                                                                                           |
| ---------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **CF-2**   | HIGH (plan)             | An older binary migrates or serves a newer database                                                                                                                                                         | `migrate-newer.test.ts` 2 red on the unmodified `migrate.ts` (§1 17:36Z); at the stack, W5's image on HEAD+1's schema: up, `/api/ready` 200 (§3, §6)         | `refuseDatabaseNewer` (set membership) in `runMigrations` and `pendingMigrations`; 4/4 + 14/14; at the stack the pinned rollback is refused by name and `/ready` 500s (§3); S-CF2-max and S3 red                     | 9.4 — **closed**                                                                                |
| **CF-3**   | HIGH (plan)             | No backup is taken before a migration                                                                                                                                                                       | S2: the upgrade succeeds and the verifier finds no backup older than the first new migration (§1 18:35Z)                                                     | `pre-migrate-backup` one-shot; every HEAD hop in every path: backup 1–3 s before the first new migration, marker present; S-CF3-graph and S-CF3-fixture red                                                          | 9.4 — **closed**                                                                                |
| **CF-4**   | HIGH (plan)             | A v0.1 install cannot start HEAD: 11 declared secret files missing                                                                                                                                          | S1: `bind source path does not exist: …/secrets/plaid_env`, 11 names (§1 04:44Z)                                                                             | `secrets-placeholders.sh` in `just upgrade`; every HEAD hop: `created 11 empty optional placeholder(s)`; S-CF4-required red                                                                                          | 9.4 — **closed**                                                                                |
| **CF-5**   | MEDIUM (plan)           | `returns_cache` predating C-1 stays root-owned                                                                                                                                                              | At W4: `0:0 755`, worker `EACCES` (§1 attempt 2)                                                                                                             | At HEAD after the chain: `10001:10001`, writable — Docker's copy-up into an empty volume; no change needed (§1)                                                                                                      | 9.4 — **closed, no fix needed**                                                                 |
| **F-94-1** | MEDIUM                  | `backup.sh`'s `printf … \| grep -qE` under pipefail: SIGPIPE false refusals once the TOC outgrows the pipe                                                                                                  | 300/300 false refusals in isolation; `backup-1 is unhealthy` on `up --wait` (§1 18:00Z)                                                                      | The harness's test tree carries the one-line fix (`grep -E … >/dev/null`), conditional on the buggy text; `pre-migrate.sh` never had it                                                                              | **9.1** (`backup.sh`; its finisher has `scripts/soak/backup-script-pipefail.test.ts` in flight) |
| **F-94-2** | MEDIUM (historical)     | An era that declared new file secrets had no step to create them: v0.1 → W2 and W2 → W3 by those eras' own docs fail at `up`                                                                                | W2 hop: `bind source path does not exist: …/secrets/plaid_secret` (4 names); W3 hop: `…/secrets/tiingo_api_key` (7 names) (§4)                               | Not fixable in history. HEAD's `just upgrade` closes it for every hop **to** HEAD (0 extra steps on every HEAD hop); the RUNBOOK says to upgrade to a commit that has `just upgrade`, and how to bridge an older one | 9.4 — recorded; RUNBOOK note                                                                    |
| **F-94-3** | LOW (historical)        | W2 has no API path to a dismissed insight (no grant route; `/advisors/run` 503 without a token secret)                                                                                                      | —                                                                                                                                                            | Loaded at W5 instead                                                                                                                                                                                                 | —                                                                                               |
| **F-94-4** | LOW (historical)        | W3 has no route that adds a holding to a manual account                                                                                                                                                     | —                                                                                                                                                            | Balance-only investment account at W3                                                                                                                                                                                | —                                                                                               |
| **F-94-5** | MEDIUM                  | `GET /budgets/current` creates the budget, then 409s on an unreported balance; the actuals consumer then dead-letters on the next ledger event, with no operator path to resume it; `/ready` 200 `degraded` | Chain attempt 2: `budgeting.actuals@v1 failed on event seq 5: on-budget accounts with no balance observation …`, `failed_count 5`, still failed at HEAD (§1) | Open. `just upgrade` now prints a WARNING on a non-`ready` 200                                                                                                                                                       | **budgeting / platform** (handed on)                                                            |
| **F-94-6** | **HIGH**                | A backup of any install holding a plan scenario cannot be restored (`plan_scenario_levers_are_well_formed` calls `plan_amount_json_is_well_formed` unqualified; `pg_restore`'s empty `search_path`)         | Chain attempt 2 step 25 FATAL; isolated repro `pg_restore exit 1`, 0 rows (§1)                                                                               | Isolated repro with the inner call `public.`-qualified: exit 0, 1 row. The migration is not this package's (Wiring item 5)                                                                                           | **migrations — orchestrator** (handed on)                                                       |
| **F-94-7** | LOW (historical)        | A W1 file-import connection cannot take another file after the upgrade to W2+ (W1 staged in memory; W2 hydrates only durable rows)                                                                          | Chain attempt 3: `409 connector.auth_required … Reconnect the connection to continue` (§1)                                                                   | Not fixable in history; the era's own message ("upload the file again") is the path, and the chain's W2 load takes it                                                                                                | —                                                                                               |
| O-94-1     | observation (budgeting) | A card already owing when a budget's first period opens fails identity II                                                                                                                                   | W2: `409 budgeting.card_identity_violation … owed 350.00 ≠ available 0.00 + unfunded 0.00` (§1 attempt 4)                                                    | Not tested at HEAD; HEAD's opening has the same carryover-only shape                                                                                                                                                 | **budgeting** (handed on)                                                                       |
| O-94-2     | observation (platform)  | The outbox lag metric counts events outside a filtered consumer's types, so `/ready` can read `degraded` (> 1,000) on a healthy, quiet install                                                              | HEAD after the chain: `maxLagEvents 137`, categorisation at seq 8 since W3 (§1 attempt 7)                                                                    | Not exercised to the threshold                                                                                                                                                                                       | **platform** (handed on)                                                                        |

Era defects seen and not counted (each fixed by a later era, absent at HEAD): G3-1 (W0's worker exits with no
holder: W0 `worker=1`); W0/W1's worker `memory: 512M` against a 1 GiB KEK (cgroup OOM at every boot once a
holder exists: W1 `worker=1`–`2` in a 40 s window, 1886 over 9.5 h in attempt 1; W2 raised it to 1536M).

## 6. Sabotages, each observed red, each recorded as it happened

| ID               | Where                                  | Sabotage                                                     | Test                               | Observed                                                                                              | Restored                                   |
| ---------------- | -------------------------------------- | ------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| S-CF2-max        | `packages/db/src/migrate.ts`           | "newer" as `version > max(files)`                            | `migrate-newer.test.ts`            | `× newer is an applied version absent on disk, never a larger number` (§1 17:39Z)                     | from copy; `grep -c SABOTAGE` 0            |
| S-CF4-required   | `scripts/secrets-placeholders.sh`      | `is_required` → `return 1`                                   | `--self-test`                      | `case 3: a missing required secret was not refused` + 3 more, rc 1 (§1 17:48Z)                        | from copy; 0                               |
| S-CF3-graph      | `compose.yml`                          | `migrator.depends_on.pre-migrate-backup` → `service_started` | hardening check (real)             | `migrator-missing-pre-migrate-backup: depends_on pre-migrate-backup is "service_started"` (§1 17:57Z) | from copy; 0                               |
| S-CF3-fixture    | `scripts/fixtures/compose-hostile.yml` | hostile `pre-migrate-backup` `user: '0:0'` → `'10002:10002'` | hardening `--self-test`            | `SELF-TEST FAILED: … did not fire: pre-migrate-backup:root-user` (§1 04:51Z)                          | from copy; 0; `git diff` empty             |
| **S1** (harness) | the run's test tree `upgrade.just`     | placeholder step → `true`                                    | `run.sh --path s1-no-placeholders` | `just upgrade` FAILED: `bind source path does not exist: …/secrets/plaid_env`, 11 names (§1 04:44Z)   | test tree deleted at teardown; real tree 0 |
| **S2** (harness) | the run's test tree `compose.yml`      | `pre-migrate-backup` command → `['true']`                    | `run.sh --path s2-no-premigrate`   | `FAIL: no backup older than the first new migration` (§1 18:35Z, at `3f414ec`)                        | test tree deleted; real tree 0             |
| **S3** (harness) | the run's test tree `migrate.ts`       | `refuseDatabaseNewer` short-circuited                        | `run.sh --path s3-no-newer-check`  | control refused; sabotaged image serves HEAD+1's schema, `/api/ready` 200 (§1 04:50Z)                 | test tree deleted; real `migrate.ts` 0     |

## 7. S3: why a path of its own, and how the spec's words map

The exit test reads "the newer-DB check removed → W5's image serves HEAD's schema". W5's image predates CF-2,
so it has no check to remove: run literally, W5 serves a newer schema with or without any sabotage — that is
CF-2 as found, not a sabotage of the fix. The stack-level observation recorded inside the direct path
(`rollback_suite` (c)) already ran the meaningful version, but as one row among the rollback checks, with no
control beside it. **Decision: run it as its own harness path**, `s3-no-newer-check`, with the claim stated
generally: _the previous release's binary, on the schema the next release left behind_. With CF-2 landed,
HEAD is "the previous release" and HEAD+1 (one extra migration) "the next". The path shows all three rows
side by side: the **control** (HEAD's real image, refused by name), the **sabotage** (the same image with the
check removed, serving: red, as the exit test expects), and the **literal** row (W5's image, serving: why the
fix exists). Red first try at `faf42cc` (§1 04:50Z).

## 8. CI: `.github/workflows/upgrade-test.yml`

- Triggers: `workflow_dispatch`, weekly (`17 6 * * 1`), and `workflow_call` — `release.yml` calls it and
  `build-sign-publish` `needs: upgrade-test` (landed by the orchestrator at `faf42cc`).
- One job, `direct-jump`, `ubuntu-latest`, `timeout-minutes: 75`; every step declares its own timeout
  (install 10, Playwright 10, just 5, self-test 5, the jump 60 with `timeout 3500` inside, report 2,
  teardown 5).
- Builds exactly **two image sets**, W0 (`d04669e`) and HEAD: `run.sh --path direct --ci` skips the
  stack-level rollback suite (which builds HEAD+1, a sabotaged HEAD and W5). CF-2 is covered on every push
  by `migrate-newer.test.ts` (ci.yml's `db` project); the suite, the chain and the S-paths run locally at
  each gate.
- Self-contained: `actions/checkout` with `fetch-depth: 0` (for `git archive d04669e`), pinned
  `setup-node`, `pnpm@12.4.1`, `pnpm install --frozen-lockfile`, the repo's Playwright Chromium for the
  passkey ceremonies, `just` from apt with a ≥ 1.19 assertion (the justfile's `import`), `WORK` under
  `runner.temp`. Nothing reads `/tmp/wp94`; the only `/tmp/wp94` in the harness is `WORK`'s local default.
- The jump runs in the foreground under `timeout`; the full log is kept and the report step appends the
  harness report to the job summary; teardown runs `--teardown` always.
- Not run on a GitHub runner from here (no push from an agent). Checked: prettier parses and formats it;
  the actions are ci.yml's pinned ones; and the exact command the job runs, `run.sh --path direct --ci`,
  ran locally at `430d453`: `RESULT: PASS` in 5 min with two image sets (§1 06:41Z).

## 9. Wiring for the orchestrator (files this package does not own)

**1. `justfile` — two one-line recipes** wrapping this package's scripts (`upgrade` is already imported,
`d950bf2`). Tested in a scratch copy of the justfile against the real tree (`just --list` shows both;
`just secrets-placeholders --self-test` → `SELF-TEST PASS`; `just --dry-run upgrade-test chain --keep` →
`bash scripts/upgrade-test/run.sh --path chain --keep`). Place after the `import` line:

```diff
 import 'scripts/upgrade-test/upgrade.just'
+
+# WP 9.4 (CF-4). Never overwrites; refuses a missing required secret; `just upgrade` runs it.
+# Create every optional secret compose.yml declares, empty, if it is missing
+secrets-placeholders *args:
+    bash scripts/secrets-placeholders.sh {{args}}
+
+# WP 9.4. path: direct | chain | s1-no-placeholders | s2-no-premigrate | s3-no-newer-check
+# The unattended-upgrade test: v0.1 installed cold, then this checkout by `just upgrade` alone
+upgrade-test path="direct" *args:
+    bash scripts/upgrade-test/run.sh --path {{path}} {{args}}
```

**2. `.github/workflows/release.yml` — `needs: upgrade-test`: already landed (`faf42cc`)**, checked:
`upgrade-test: uses: ./.github/workflows/upgrade-test.yml` and `build-sign-publish: needs: upgrade-test`.
Nothing further. (`upgrade-test.yml`'s `concurrency` moved to the job, so it means the same thing under
`workflow_call`.)

**3. `compose.yml` top-level `name:` — not needed, and it must not be added without a migration plan.**
Nothing in the harness or the RUNBOOK "Upgrade" section depends on it: the harness names every project
with `-p` and writes `COMPOSE_PROJECT_NAME` into the test install's `.env`; `just upgrade` runs plain
`docker compose`, which takes the project from `COMPOSE_PROJECT_NAME` (env or `.env`) and otherwise from
the directory name. Compose's precedence is `-p` > `COMPOSE_PROJECT_NAME` > top-level `name:` > directory.
So adding `name: personalfi` would **silently re-point** every install that relies on its directory name
(e.g. `~/personalfi-prod` without the `.env` line) at a new project with **new, empty volumes** on its next
`just upgrade` — a fresh database where the old one was. The soak's isolation rule (RUNBOOK, 9.1's section;
`.env.example` since `188ee07`) already pins `COMPOSE_PROJECT_NAME=personalfi-prod`; that, not `name:`, is
the right mechanism.

**4. `compose.yml` api healthcheck (not this package's block) — one line.** Docker probes every
`start_interval` (default 5 s) during `start_period` (20 s) and every `interval` (30 s) after it, so `up
--wait` sees `healthy` up to ~30 s after `/ready` first answers whenever boot outlasts the start period.
Measured at HEAD hops (load 1.2–2.3): `up --wait` 28, 35 and 30–32 s against a polled `/api/ready` of
23.0, 28.7 and 24.1–25.8 s — `up --wait` trails readiness by 5–7 s. Proposal:

```diff
       interval: 30s
       timeout: 3s
-      start_period: 20s
+      start_period: 60s
+      start_interval: 1s
       retries: 3
```

(Engine ≥ 25 — this host runs 29.8.1. A probe failure inside `start_period` does not count toward
`retries`, so the longer period changes nothing for a crashed api except that it is reported unhealthy
after 60 s + 3 × 30 s rather than 20 s + 3 × 30 s.)

**5. F-94-6 (HIGH): a new migration** — the number is the orchestrator's (09 §4: 0040 is the spare; 0039 is
9.11's). Expand-only (replaces one function; no table or row touched). The exact text, tested on top of
0022 as a live install would apply it (§1 05:3xZ: CHECK still refuses a bad lever; `pg_restore` exit 0, all
rows), is `/tmp/wp94/f946-fix-migration.sql`, reproduced here:

```sql
-- F-94-6 (WP 9.4): plan_scenario_levers_are_well_formed calls plan_amount_json_is_well_formed
-- unqualified; pg_dump archives restore with an empty search_path, so every COPY into
-- plan_scenarios failed and a backup holding one plan scenario could not be restored.
-- Same body as 0022, the inner call schema-qualified (still inlinable; a SET search_path
-- clause would also work but stops inlining). Expand-only: no table, no data touched.
CREATE OR REPLACE FUNCTION plan_scenario_levers_are_well_formed(levers JSONB)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(levers) IS DISTINCT FROM 'object' THEN false
    WHEN levers = '{}'::jsonb THEN false
    ELSE NOT EXISTS (
      SELECT 1
      FROM jsonb_each(levers) AS lever (name, setting)
      WHERE NOT (CASE lever.name
        WHEN 'retire_age' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}') ~ '^[0-9]{1,3}$'
        WHEN 'savings_rate' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        WHEN 'annual_spending' THEN
          public.plan_amount_json_is_well_formed(lever.setting)
        WHEN 'expected_return_shift' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}') ~ '^-?(0|[1-9][0-9]*)(\.[0-9]+)?$'
        WHEN 'ss_claim_age' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}') ~ '^[0-9]{2,3}y([0-9]|1[01])m$'
        WHEN 'part_time_income' THEN
          CASE
            WHEN jsonb_typeof(lever.setting) IS DISTINCT FROM 'object' THEN false
            ELSE
                  (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(lever.setting) AS key)
                    = ARRAY['annual', 'years']
              AND public.plan_amount_json_is_well_formed(lever.setting -> 'annual')
              AND jsonb_typeof(lever.setting -> 'years') = 'string'
              AND (lever.setting ->> 'years') ~ '^[0-9]{1,2}$'
          END
        WHEN 'one_time_windfall' THEN
          CASE
            WHEN jsonb_typeof(lever.setting) IS DISTINCT FROM 'object' THEN false
            ELSE
                  (SELECT array_agg(key ORDER BY key) FROM jsonb_object_keys(lever.setting) AS key)
                    = ARRAY['amount', 'on']
              AND public.plan_amount_json_is_well_formed(lever.setting -> 'amount')
              AND jsonb_typeof(lever.setting -> 'on') = 'string'
              AND (lever.setting ->> 'on') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          END
        WHEN 'glidepath' THEN
              jsonb_typeof(lever.setting) = 'string'
          AND (lever.setting #>> '{}')
                ~ '^(age_based|target_date|rising_equity|static:(0|1|0\.[0-9]+|1\.0+))$'
        ELSE false
      END)
    )
  END;
$$;

```

With it: `packages/db/test/migrate.test.ts` gains the migration's attribution (shared file, orchestrator);
the export registry needs nothing (no new table). A regression test belongs with the migration's owner:
`pg_dump -Fc` → `pg_restore` of a database holding one `plan_scenarios` row (the chain path is the
end-to-end one: its step 25 goes green when the migration lands). **The monthly restore drill should hold
a plan scenario from then on** (9.1's `restore-drill` body), or it keeps passing on databases that cannot
show this.

**6. F-94-1 — landed in 9.1 (`c35821a`).** The harness's conditional patch is a no-op from that commit on.

**7. F-94-5 — handed to the budgeting/platform owner** (the orchestrator picks the package; 9.11 or 9.14).
Two halves, both outside this package: (a) `GET /budgets/current` persists a new budget and then answers
409 `budgeting.balance_unreported`, after which `budgeting.actuals@v1` dead-letters on the next ledger
event — either create the budget only when its first recompute succeeds, or have the consumer treat
`balance_unreported` as "not yet" (retry later, never dead-letter); (b) an operator path to resume a
dead-lettered consumer (`@core/platform`'s `setConsumerStatus`/`replayConsumer` exist; no recipe, route or
CLI reaches them), documented in the RUNBOOK beside `/ready`'s `degraded`.

**8. Nothing for** `vitest.config.ts` (the tests live in the existing `db` and `scripts` projects),
`eslint-boundaries.js`, `package.json`, the lockfile, `ci.yml`, or the export registry.

### F-94-8 — v0.1's images cannot be built from source on a clean host (observed by the orchestrator, 2026-10-06)

Found by the first `upgrade-test.yml` run on a GitHub runner (run 37463986162, then 37466231586 with the
per-step logs printed): `FATAL: W0 build failed` in 7 s, `w0-build.log`: `ERROR: unable to select
packages: age-1.3.2-r0: breaks: world[age=1.3.1-r6] … libcrypto3-3.5.7-r0: breaks:
world[libcrypto3=3.5.8-r0]`. Every era's `docker/backup.Dockerfile` (and `api.Dockerfile` from Phase 3)
pins apk packages to exact builds, and Alpine's index keeps only the current build of each, so the pinned
builds expire. On this host the cached `apk add` layer hid it for every waypoint; CI's own image job hid it
at HEAD the same way (GHA layer cache). HEAD was affected too: the same `age=1.3.1-r6`, `tzdata=2026d-r0`,
`libssl3=3.5.8-r0`, `libcrypto3=3.5.8-r0` pins, which the pinned base `alpine:3.24@sha256:28bd5fe8…`'s
index no longer serves (`apk policy` in the base image: age 1.3.2-r0, tzdata 2026e-r0, libssl3 and
libcrypto3 3.5.7-r0).

- **HEAD, fixed by the Dockerfiles' own documented procedure:** the pins bumped to the index's current
  builds in `docker/backup.Dockerfile` and `docker/api.Dockerfile`; `docker build --no-cache -f
docker/backup.Dockerfile docker` green on this host.
- **Eras, in the harness:** `prepare_tree` drops the `=version` pins inside `apk add` for W0–W5 test trees
  only (the base-image digest pin stays); HEAD is never patched, so a red there stays a real finding. Logged
  per tree as `F-94-8: <wp> test tree — apk version pins dropped …`; it is a build-reproducibility finding,
  not an upgrade extra step (the documented upgrade is `git pull && just upgrade`, which builds from the
  pulled tree — on a host with no cached layer the build itself is what fails).
- **Handed on (WP 9.10/9.11, with 9.12's RUNBOOK bump procedure):** the pin policy. An exact-version apk
  pin on Alpine is a build that expires; the choices are (a) pin the base digest and leave apk unpinned,
  with the trivy image scan as the control, (b) keep exact pins and add a scheduled CI build with no cache
  so an expiry is found the week it happens, not on a stranger's host, or (c) vendor the packages. Until it
  is ruled, a production `just upgrade` on a host without the cached layer can fail at the build — the
  soak install's first build on Chris's host has the layer cached and is not at risk.

## 10. Open items / handed to other packages

1. **F-94-6 (HIGH) — the migration in §9 item 5**, the orchestrator's to number and land. Until it lands,
   **no backup of an install holding a plan scenario restores**; the soak install must not save a plan
   before it, and the restore drill must hold a plan scenario after it (9.1's drill body). The chain's
   step 25 is the end-to-end check: red today, green the commit after the migration lands, with no harness
   change.
2. **F-94-5 (MEDIUM) — budgeting/platform** (§9 item 7): the budget persisted before a 409, the actuals
   consumer dead-lettered for good, no operator path back. `just upgrade` now warns on a non-`ready` 200.
3. **Card identity II at a budget's first period — budgeting, to check at HEAD** (§1 05:37–05:42Z): W2
   refused a budget for a card already owing (`owed 350.00 ≠ available 0.00 + unfunded 0.00`), and HEAD's
   opening reads the same carryover-only shape. Not tested at HEAD by this package; it matters on the soak
   install (a real card carries a balance).
4. **(vi) above 09 §5.3's 20 s — performance (9.9).** HEAD hops at load ≈ 2: polled `/api/ready` 24.1–25.8 s,
   `up --wait` 30–32 s. The stage breakdown puts the pre-migration backup and the migrations under 2 s;
   the remainder is the api's own boot. The healthcheck line (§9 item 4) trims `up --wait`'s overhang, not
   the boot. 9.9 owns the budget and the boot.
5. **The CI workflow has never run on a GitHub runner** (agents do not push). The first run is the
   orchestrator's `workflow_dispatch` after this lands; `--ci` itself is exercised locally (§1, the
   `direct-ci` run).
6. **Wiring** §9 items 1 (justfile recipes) and 4 (healthcheck); items 2 and 6 already landed.
7. **History, recorded and closed:** F-94-2 (eras declaring new secrets), F-94-3/-4 (era API gaps),
   F-94-7 (W1 file connections dead at W2), the W2 era's stalled consumers, G3-1 and the W0/W1 worker OOM.
   None is reachable from an install that upgrades to a commit carrying `just upgrade`.
8. **F-94-8** (above): the apk pin policy — 9.10/9.11 to rule; the harness relaxes era pins, HEAD bumped.
9. **v1.0 close (09 §4):** the direct jump and the chain re-run at the release commit —
   `bash scripts/upgrade-test/run.sh --path direct` and `--path chain`, each detached, ~15 and ~25 min
   on this host.

## 11. Final check

Before the full check (06:5xZ, HEAD `430d453`, working tree = this package's files only): `just typecheck`
rc 0; `just lint` rc 0 (one warning, not in this package's files); `vitest run --project db` 2 files / 14
tests passed; `--project scripts` 4 files / 18 tests passed; `secrets-placeholders.sh --self-test` PASS;
`compose-hardening-check.sh --self-test` PASS and the real check PASS (3 files); `bash -n` on every
script; `just --list` shows `upgrade`. Prettier clean on every touched `.md`/`.yml`/`.mjs`/`.ts`. No
`pf-upgrade-*` container, volume or network left; images kept; `/tmp/wp94` kept.

`just check` — RUNNING (tail appended below when it finishes).
