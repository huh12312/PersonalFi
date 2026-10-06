<!-- SPDX-License-Identifier: MIT -->

# The unattended-upgrade test (WP 9.4)

v1.0's second clause, "unattended upgrade from v0.1 works", as a repeatable run.
`docs/plan/09-phase-9-dispatch.md` §3 WP 9.4 is the specification; the evidence
is `docs/evidence/phase-9/wp9.4-upgrade.md`.

```bash
bash scripts/upgrade-test/run.sh --path direct              # W0 (v0.1) -> HEAD by `just upgrade` alone
bash scripts/upgrade-test/run.sh --path chain               # W0 -> W1 -> W2 -> W3 -> W4 -> W5 -> HEAD
bash scripts/upgrade-test/run.sh --path s1-no-placeholders  # sabotage S1: must go red
bash scripts/upgrade-test/run.sh --path s2-no-premigrate    # sabotage S2: must go red
bash scripts/upgrade-test/run.sh --path s3-no-newer-check   # sabotage S3: must go red
bash scripts/upgrade-test/run.sh --path direct --ci         # CI: no rollback suite (two image sets)
bash scripts/upgrade-test/run.sh --path direct --teardown   # down -v its projects, delete its $WORK
```

A run takes 10–40 minutes. Detach it (`setsid nohup … > /tmp/wp94/logs/x.log &`) and
read the log. It resumes where it stopped (`$WORK/runs/<run>/state/<step>.done`);
`--from <step>` re-runs from a step. The report is `$WORK/runs/<run>/report.md`
(`WORK` defaults to `/tmp/wp94/work`). The commit tested as HEAD is resolved
once per run and kept in `$WORK/runs/<run>/head.sha`, so a commit landing
mid-run, or a resume, never splits one run across two commits.

## Waypoints

| Waypoint | Commit    | What it is                                |
| -------- | --------- | ----------------------------------------- |
| W0       | `d04669e` | v0.1, Phase 0 re-gate                     |
| W1       | `2e67648` | Phase 1 gate                              |
| W2       | `d3a51a0` | Phase 2 gate                              |
| W3       | `6391428` | Phase 3 gate                              |
| W4       | `d0dcf70` | Phase 4 gate                              |
| W5       | `f24160f` | Phase 5 landing                           |
| HEAD     | the tree  | `git archive <head.sha>` + WP 9.4's files |

Trees come from `git archive <sha> | tar -x` — never `checkout` or `worktree`.
Images are `pf-upgrade/{api,proxy,backup}:<sha>` (every era tags
`${REGISTRY}/<svc>:${PERSONALFI_VERSION}`), never `personalfi/*:dev`.

## What it does

1. **Install W0 cold**, as W0's own RUNBOOK says: `just gen-pg-secrets`,
   `just gen-master-key`, `just build`, an age keypair from the backup image
   (identity kept under `$WORK` only), b2 placeholders, `just up`,
   `just bootstrap-user`. The compose project is `pf-upgrade-<run>`, bound to
   `127.0.0.1:8451/8452`, with its own volumes.
2. **Load data through each version's own API** (`driver.mjs`; never SQL): a
   passkey (real WebAuthn ceremonies in the repo's Playwright Chromium, against
   a CDP virtual authenticator), TOTP and recovery codes at W0; a CSV import of
   `generateDemoData(1)` and a category override at W1; at W2 a rule, a
   confirmed recurring series (retried at W3 if W2's worker has not detected
   one in 240 s), the statements again as OFX on a new connection (W1's file
   connection cannot take another file at W2, F-94-7; OFX carries balances,
   which the budget requires), the superseded W1 accounts closed, then a
   budget line; a manual investment account and a watch-only wallet at W3; a
   plan, a goal, an assumption override and a deterministic projection from
   the open day at W4; advisor grants, a run, a dismissal with a reason code
   and a published Brief at W5. Two schedules are shortened by SQL
   (`schedules.next_run_at` and `jitter_seconds` only: the net-worth snapshot
   at W4, the weekly Brief at W5), because their crons have no config knob
   and their jitter (600 s, 180 s) would outlast the load's wait. Timing
   metadata, never data; both are logged.
3. **Upgrade by the documented command only.** Era hops (to W1–W5) run that
   era's RUNBOOK "Upgrade" verbatim (`just build`, `just backup`,
   `docker compose up -d --wait`); a failure is recorded with its exact error,
   and the only remediation ever applied is HEAD's own fix for it, counted as an
   extra step in `extra-steps.tsv` and the chain's closing table (F-94-2: an
   era that declared new file secrets gets HEAD's `secrets-placeholders.sh
--project-dir <install>`). The hop to HEAD is "replace the tree, `just
upgrade`", nothing else, and is never remediated.
4. **After every upgrade**: (i) `schema_migrations` equals the files on disk,
   checksum for checksum; (ii) every fact loaded so far reads back through the
   running API; (iii) the master key unlocks, the KEK generation is unchanged,
   W0's TOTP and passkey work; (iv) the W0-state backup restored into a fresh
   project and migrated by HEAD passes (i)–(iii), and a HEAD backup passes the
   restore drill's assertions; (v) api and worker restart counts are 0; (vi)
   up-to-ready seconds, with the load average.
5. **CF-2 at the stack** (direct path, skipped by `--ci`): HEAD → a synthetic
   HEAD+1 (one extra migration) → the old "pin the prior image" rollback must
   be refused; the documented rollback — restore the pre-migration backup,
   `just upgrade` — must work.
6. **The sabotages**, each its own path and each expected red: S1 removes the
   placeholder step from the test tree's `upgrade.just`; S2 turns the
   `pre-migrate-backup` one-shot into `true`; S3 removes `refuseDatabaseNewer`
   from the test tree's `migrate.ts` and pins that image on HEAD+1's schema
   (with HEAD's real image as the control, and W5's image as the literal row).
   A sabotage only ever exists in the run's test tree under `$WORK`.

## Safety

Every `docker compose` call names `-p pf-upgrade-*` (`lib.sh`'s
`assert_project` refuses anything else); `down -v` only on those. No prune.
The production project is never named, listed or read. The harness never runs
`just restore-drill` (it discovers its volume by label and could pick another
project's): the drill's assertions are made against the named restore project.
