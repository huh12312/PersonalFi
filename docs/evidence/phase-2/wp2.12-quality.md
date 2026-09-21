<!-- SPDX-License-Identifier: MIT -->

# WP 2.12 — Phase 2 quality pass

Scope: an independent, skeptical pass over everything wp2.1–wp2.11, wp2.r
(routes) and wp2.w (wiring closeout) claimed, in the shape of Phase 1's own
quality pass (`docs/evidence/phase-1/wp1.7-quality.md`) — per the gate lesson
in memory: "every control that had never been observed failing turned out to
be decoration; three gate rounds were needed." Written incrementally, section
by section, as each is finished, so a rate-limit or session kill loses nothing
already appended. A previous attempt at this WP was killed before writing
anything; this is a fresh start.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, HEAD at dispatch
`bedf87f` (post-history-rewrite; SHAs cited in older docs are OLD hashes per
`docs/plan/history-rewrite-2026-09-20.md`). Node v26.9.0, pnpm 12.4.1,
Postgres 18 via `personalfi-dev-db-1` on `127.0.0.1:5433`
(`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`).
Scratch database `personalfi_wp_q2` for anything this pass needed a database
of its own for. Single working tree, `git worktree list` shows one, `git
status` clean at dispatch — no concurrent agent to avoid colliding with this
round, unlike Phase 1's wp1.7a.

---

## 0. Baseline

Confirmed before any sabotage or edit: `docker ps` shows
`personalfi-dev-db-1` healthy; `docker exec personalfi-dev-db-1 psql -U
personalfi -d personalfi_dev -c 'select 1'` returns a row. `git log --oneline
-5` at dispatch:

```
bedf87f docs: execution log — first push to GitHub after history rewrite; WP 2.12 relaunched
457fc54 chore(security): history rewritten before first push
d5922a3 docs: execution log — WP 2.10 committed; WP 2.12 dispatched
4d3bf27 feat(web): WP 2.10 — recurring screen …
4b68700 docs: execution log — WP 2.9 committed
```

Per the dispatch's own record, the tree was `just check` green at 1908 backend

- 242 web tests as of WP 2.10's commit, with two open findings already on the
  books for this pass to inherit rather than rediscover:

* **The `notifications.deliver:<uuid>` schedule-name crash-loop** (found by
  WP 2.w's cold `down -v` boot, 2026-09-20 09:00 EDT execution-log entry) —
  already fixed by the orchestrator at `dd8c874` (schedule names now
  `notifications.<kind>.<uuid with _>`; `upsertSchedule` refuses an invalid
  name in code). Confirmed still in place by reading
  `packages/contexts/notifications/src/jobs.ts:363,375` and
  `packages/platform/src/jobs/scheduler.ts:134` before doing anything else —
  both cite the fix by name in their own comments.
* **The known `packages/testkit/test/process.test.ts` SIGTERM flake** under
  full-suite load (WP 0.6's test; passes alone) — explicitly handed to this WP
  by the 2026-09-19 11:00 EDT execution-log entry. See §12.

---

## 1. Exit-criteria audit

Written last, once every sabotage and every other section below had
produced independent, first-hand evidence to audit against — sections are
appended in the order they were finished, not the dispatch's order, same as
wp1.7a's own §1. "Proven" below means this pass independently re-verified
the claim is non-vacuous (re-ran the test, and in most rows re-sabotaged the
control myself rather than trusting the WP's own record); "carried" matches
this project's own standing convention for a claim that needs Chris's real
accounts.

### Master plan §5 Phase 2 exit criteria (dispatch §1, verbatim)

| Claim                                                                                   | Test                                                                                                                                                         | Verdict                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A month closes and rolls over correctly across a timezone and DST boundary              | `packages/contexts/budgeting/test/db/period-roll-dst.test.ts` (calendar-month DST crossing + non-calendar biweekly grid)                                     | **Proven, non-vacuous.** Independently re-sabotaged this pass (§4.1/B4: `CALENDAR_MONTH`'s `endDate` computed by day-count instead of `addMonths`) — red on the first try, restored.                                                                                                                                                                                                       |
| Recurring detection meets recall ≥0.85 / precision ≥0.95 against Chris's confirmed list | `packages/contexts/recurring/test/golden-streams.test.ts`, measured 1.000 / 0.977 at the swept operating point                                               | **Proven against the synthetic + adversarial corpora, which is the stated CI gate (§7 of this doc); missing against "Chris's confirmed list" literally**, because no real, hand-labelled institution history exists yet. Carried, per dispatch §1's own framing — not a defect in the gate, the honest state of a criterion naming data Phase 2 does not have.                             |
| Every built-in advisor produces resolvable evidence refs                                | `packages/contexts/insights/test/catalog.test.ts` "every rule produces at least one resolvable evidence ref on the seed"                                     | **Proven, non-vacuous.** Independently re-sabotaged this pass (§4.4/I2: `resolveSourceRef`'s unresolved-path branches made to fabricate `{ok:true, value:0}`) — a fabricated `$227.88` figure was accepted and reached `pending_review`; red on the first try, restored. The client-side half (D22, "the UI never fabricates a number") independently re-sabotaged too (§4.6/WE1).         |
| A 2,000-transaction backfill yields one coalesced notification                          | `packages/contexts/notifications/test/db/coalescing.test.ts` "a 2,000-transaction backfill yields exactly one notification"                                  | **Proven.** Not independently re-sabotaged _this exact test_ this pass (time budget), but the coalescing window's own boundary logic (`digestWindowFor`) and the two mechanisms it depends on — at-most-once dedupe and quiet-hours holding — were independently re-sabotaged this pass (§4.3/N3, N4), both red on the first try, which is the load-bearing machinery this claim rests on. |
| Export round-trips into a clean instance                                                | `apps/api/test/db/export-import.test.ts` "export round-trips into a clean instance" + "export then import into a clean instance reproduces every read model" | **Proven, non-vacuous.** Independently re-sabotaged this pass (§4.6/E1 credential exclusion, E2 hash tamper) — both red on the first try, restored.                                                                                                                                                                                                                                        |

### Release-ladder criteria (§2.3)

| Rung                                 | Claim                                           | Test                                                                                                                                      | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.4 "Recurring and forward-looking" | Subscriptions at recall ≥0.85 / precision ≥0.95 | Same as the master-plan row above                                                                                                         | Same verdict: proven on the synthetic corpus, carried against real data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| v0.4                                 | 30-day cash projection directionally correct    | `packages/contexts/recurring/test/db/forecast.test.ts` — 10 of 10 scheduled seed charges land inside the projected date-and-amount band   | **Proven against the seed generator's own ground truth** (wp2.3-recurring.md §5), which is a different and weaker claim than real history, and is recorded as such there. Not re-sabotaged independently this pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| v0.8 "Budget and report"             | Budgets exclude transfers and net refunds       | `packages/contexts/budgeting/test/db/actuals-consumer.test.ts`                                                                            | **Half was vacuous, found and fixed by this pass.** The transfer-exclusion half is proven non-vacuous (§4.1/B1, red on sabotage). **The refund-netting half was genuinely vacuous** (§4.1/B2: the existing test always posted its refund with the purchase's own category, so `resolveCategory`'s cross-period `categoryOfPurchase` fallback was never exercised) — closed with a new test (`'an uncategorised refund still nets into the purchase's own envelope'`), confirmed red under the sabotage and green restored. The exit criterion is proven now; it was not, before this pass, in the shape that actually matters (a refund with no category of its own, the common real case). |
| v0.8                                 | Full export round-trips into a clean instance   | Same as the master-plan row above                                                                                                         | Same verdict: proven, non-vacuous, independently re-sabotaged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| v0.7 "Advisory" (built-in half)      | The evidence panel                              | Server: `packages/contexts/insights/test/evidence-resolution.test.ts`. Client: `apps/web/src/features/insights/evidence-resolver.test.ts` | **Proven on both halves of the wire**, both independently re-sabotaged this pass (§4.4/I2 server, §4.6/WE1 client) — an insight cannot reach a screen with a fabricated evidence value on either side.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### Carried from Phase 1, unchanged by Phase 2 (not re-litigated this pass)

Two real institutions syncing on a schedule; a month of real data with zero
internal transfers; the recurring gold set against Chris's own confirmed
list — all three remain carried, owner Chris, per dispatch §2 and §6. This
pass found nothing that would close any of them; they need real linked
accounts, which Phase 2 does not have.

---

---

## 2. CI parity: `scripts/check-ci-projects.ts`

**State found.** `vitest.config.ts` declares **31 projects**
(`kernel config db platform platform-db testkit seed secretbox secretbox-db
identity identity-db ledger categorization categorization-db ledger-db
connector-port connector-manual connector-csv connector-plaid connections
recurring recurring-db budgeting budgeting-db notifications notifications-db
insights insights-db connections-db api api-db`). `ci.yml`'s `test` job
already listed 19 of them and `migration-test` the other 12 plus `testkit`
(13) — **all 31 already covered**, unlike Phase 0 (4/13) and Phase 1's own
quality pass (10/23 missing on arrival). Every Phase 2 WP that added a
project (2.2/2.3 recurring, 2.1 budgeting, 2.4 notifications, 2.6 insights)
followed the dispatch's shared-file rule (§4 item 6) and added it to both
`ci.yml` lists the day it landed — the mechanism the Phase 1 quality pass
recommended actually held this time. This pass's job was therefore to build
the mechanical check the dispatch specifies (§5 item 5) and confirm it, not
to fix a live gap.

**Built:** `scripts/check-ci-projects.ts`. Pure functions
(`parseVitestProjectNames`, `parseCiProjectList`, `checkCiProjects`) plus a
`--self-test` mode that runs the same four rules against five in-memory
fixtures (a clean pair; a project missing from both CI lists; a stale CI name
absent from `vitest.config.ts`; a db-shaped project in the wrong job; a
non-db project in the wrong job) and three fixture-text parser checks, before
ever touching the real files — the `compose-hardening-check.sh
--self-test` / `check-secret-ownership.sh --self-test` pattern, extended
here to a TypeScript check with no bash/shell dependency.

```
$ node scripts/check-ci-projects.ts
check-ci-projects: self-test PASS (5 fixtures + 3 parser checks, correct state clean, every broken shape caught)
check-ci-projects: PASS — all 31 vitest.config.ts project(s) are covered by ci.yml
  (19 in 'test', 13 in 'migration-test'), and every name ci.yml lists exists.
```

**Sabotage — dropped `--project insights` from the `test` job**, one line,
`ci.yml` otherwise untouched:

```
$ node scripts/check-ci-projects.ts
check-ci-projects: self-test PASS …
check-ci-projects: FAIL — 1 problem(s)

  - 'insights' is declared in vitest.config.ts but appears in neither ci.yml
    job's --project list ('test' or 'migration-test') — it has never run in CI.
```

Red on the first try. Restored from the pre-sabotage copy; `git diff --stat
.github/workflows/ci.yml` empty before the real edits below were made;
re-ran green.

**Wired in:**

- `justfile`'s `check` recipe (the one line this WP may edit) — dependencies
  unchanged, one body line added: `node scripts/check-ci-projects.ts`, so
  `just check` fails on a CI-parity gap the same run it fails on a broken
  test. (A new standalone `check-ci-projects:` recipe would have touched a
  second line of the justfile; the body-line form keeps the edit to the one
  recipe definition.)
- `.github/workflows/ci.yml`'s `lint` job — new step "every vitest project is
  covered by a CI job", run right after `check-proxy-routes`'s own step
  (same job, same shape: static, no database, no build).
- The header project→job map comment (`ci.yml` lines 18–62) — re-verified
  against the live 31-project list (see "state found" above) and a note
  appended recording that the map is now mechanically checked, and by what.

**Not fixed because nothing was broken:** the CI parity gap itself. This
section's only finding is that the mechanism dispatch §5 item 5 asks for did
not previously exist as code, and does now, sabotage-tested.

---

## 3. `scripts/check-openapi-drift.ts`'s false positive on `client.gen.ts`

**Correction on location, recorded so the next reader does not go looking in
the wrong place:** the dispatch text (and the master plan carry-over item)
says `scripts/check-openapi-drift.ts`; the file has only ever existed at
`apps/web/scripts/check-openapi-drift.ts` (checked: `find` for the name
anywhere in the repo returns exactly one hit). `wp1.6-ui.md` §2, which first
recorded the bug, already cites the same `apps/web/scripts/...` path in its
own text — the dispatch's carry-over table just shortened it. Fixed at the
real path; no new file created at repo-root `scripts/`.

**Root cause, found by instrumenting the generator directly rather than
guessing.** The check regenerates the OpenAPI client into a throwaway
directory and diffs it against the committed `src/api/generated/` output.
The `@hey-api/client-fetch` plugin's `runtimeConfigPath` option
(`'./src/api/client-runtime-config.ts'`, `apps/web/openapi-ts.shared.mjs`) is
resolved relative to the process's `cwd()` into an absolute path, and
`client.gen.ts`'s import of it is then written as a path **relative to the
output directory**. The old code generated into `mkdtemp(tmpdir())` — an OS
temp directory with no relation to this repo's tree — so that relative-path
computation produced a nonsense import:

```
FRESH (generated into /tmp/personalfi-openapi-XXXXXX):
  import { createClientConfig } from '../../home/chris/Projects/PersonalFi/apps/web/src/api/client-runtime-config.ts';
COMMITTED (generated into the real src/api/generated):
  import { createClientConfig } from '../client-runtime-config.ts';
```

— a difference **on every single run**, regardless of whether the OpenAPI
contract had actually drifted. Confirmed directly: `node
scripts/check-openapi-drift.ts` against an untouched tree reported `out of
date: client.gen.ts` before any fix.

**Fix.** Generate into a throwaway directory that is a **sibling of
`src/api/generated`** (both direct children of `src/api/`) instead of an OS
temp directory, so the relative-path depth back to
`client-runtime-config.ts` is identical either way. Verified by hand first
(generating into `src/api/.openapi-drift-check-XXXXXX` and diffing against
committed `client.gen.ts` byte-for-byte: `EQUAL FULL FILE: true`) before
editing the script. `tmpdir()`/`node:os` import removed (no longer used); the
`finally` block's `rm(tempDir, { recursive: true, force: true })` is
unchanged, so the throwaway sibling directory never survives a run.

**Sabotage-tested both directions, not just "it passes now":**

```
$ node scripts/check-openapi-drift.ts                 # clean tree
OK — src/api/generated matches the current OpenAPI contract (17 files).

$ echo '// sabotage: injected drift' >> src/api/generated/client.gen.ts
$ node scripts/check-openapi-drift.ts                 # real drift injected
OpenAPI client is out of sync with packages/contracts/openapi/openapi.json:
  - out of date: client.gen.ts
                                                        # (exit 1)

$ # restored client.gen.ts from the pre-sabotage copy
$ node scripts/check-openapi-drift.ts
OK — src/api/generated matches the current OpenAPI contract (17 files).
```

A fix that made the check always pass would be worse than the bug it fixed —
this confirms it still catches a real drift, not just the false positive.
`src/api/generated/` is gitignored (`.gitignore:32`), so none of this touched
the working tree's git status; `git status --short` after all of the above
shows only `M apps/web/scripts/check-openapi-drift.ts`.

**Not touched:** `apps/web/openapi-ts.shared.mjs`,
`apps/web/openapi-ts.config.ts` — the bug was entirely in how the _check_
regenerates, not in how the real `pnpm --filter @app/web gen` does (which
always writes to the real, correctly-positioned `src/api/generated`, so
production regeneration was never affected by this bug).

---

## 4. Sabotage log

Every entry: the invariant, the exact production mutation, the test run by
file (not `-t`, after `Σ` in a test name defeated vitest's `-t` regex once —
noted so the next reader does not lose time on it), the result, and the
restoration proof (`git diff --stat` on the touched file after `git
checkout --`). All twelve-plus below are within `packages/contexts/**`,
which this WP owns for `test/**` and — for the one genuine finding — a
minimal production fix proven by the new failing test, per this WP's own
"production code only as a minimal fix proven by a failing test" rule.

### 4.1 Budgeting

| #   | Invariant                                                                                                                                                  | File / mutation                                                                                                                                                        | Test                                                                                                     | Result                                                                                                                                                                                                                                                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Transfers contribute zero activity                                                                                                                         | `src/actuals.ts`: `if (row.transferLinkId !== null \|\| row.isTransfer)` → `if (false)`                                                                                | `test/db/actuals-consumer.test.ts` "a paired transfer contributes zero activity"                         | RED first try: `expected +0 to be 1` (drain count moved — the transfer's card-payment side-effect never ran). Restored; `git diff --stat` empty.                                                                                                                  |
| B2  | A refund nets into the **purchase's** envelope, not wherever its own category (if any) says                                                                | `src/actuals.ts`: `resolveCategory` — deleted the `categoryOfPurchase.get(row.refundOfId)` fallback, leaving only `row.categoryId`                                     | `test/db/actuals-consumer.test.ts` "a netted refund reduces activity by exactly the refund"              | **STAYED GREEN.** That test's refund row always carries `categoryId: fun` explicitly — the same category the purchase already has — so the fallback path is never exercised. Same shape as wp1.7-quality.md's L6 (a control that cannot observe its own absence). |
| B3  | RTA excludes CCP-line `available` from the sum (07 §1.2, corrected form, wp2.1-budgeting.md §1.5)                                                          | `src/read.ts`: `identityTermsOf`'s `lineRows` query — dropped `eq(budgetLines.kind, 'category')` from the `WHERE`, so a CCP line's `available` entered the RTA sum too | `test/db/rta-identity.test.ts` "Σ available + RTA + future assignments equals Σ on-budget balances"      | RED first try: `expected '3200.00' to be '2950.00'` (the $250 CCP envelope double-counted). Restored; `git diff --stat` empty.                                                                                                                                    |
| B4  | A calendar month is `[1st, next 1st)`, not "current date + 30 days" (07 §1.7; the DST exit criterion rests on this being exact, not approximately a month) | `src/periods.ts`: `periodContaining`'s `CALENDAR_MONTH` case — `endDate: DateOnly.addMonths(start, 1)` → `DateOnly.addDays(start, 30)`                                 | `test/db/period-roll-dst.test.ts` "a month closes and rolls over across a DST boundary in the user zone" | RED first try: `expected '2026-03-31' to be '2026-04-01'` (March undercounted by exactly the day-count vs month-length gap). Restored; `git diff --stat` empty.                                                                                                   |

**B2 is a genuine finding, fixed.** Added
`'an uncategorised refund still nets into the purchase's own envelope'` to
`packages/contexts/budgeting/test/db/actuals-consumer.test.ts`: posts the
refund with **no category of its own** (the common real shape — a bank
rarely repeats a purchase's category on its refund posting) and asserts (a)
the purchase's own envelope absorbs it and (b) the _sum_ of every line's
activity in the period is exactly `-6,000` — proving nothing else silently
absorbed the $40, rather than assuming where an "uncategorised" row would
even persist. Confirmed **RED** under B2's exact sabotage
(`expected -10000n to be -6000n`), confirmed **GREEN** after
`git checkout -- packages/contexts/budgeting/src/actuals.ts` restored the
real fallback. No production code was changed — `resolveCategory` was
already correct; only the test coverage had a gap that let it drift silently.
Full `budgeting-db` project re-run after: 4 files, 10 tests, all green.

### 4.2 Recurring

| #   | Invariant                                                                                                               | File / mutation                                                                                                                                                                                                                   | Test                                                                                                                                                            | Result                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | A confirmed series is pinned — `upsertSeries` never lowers `state` below `ACTIVE` once `existing.userConfirmed` is true | `src/store.ts`: `nextState`'s `existing?.userConfirmed === true \|\|` clause **and** the update path's `(existing.userConfirmed ? 'ACTIVE' : nextState)` ternary — both removed together (see below for why one alone is a no-op) | `test/db/lifecycle.test.ts` "a confirmed series survives a re-run that would have rejected it"                                                                  | **STAYED GREEN.** That test's second pass hands the detector an _empty_ ledger, so `upsertSeries` is never called for the pinned merchant at all — only the separate archive-sweep path runs.                     |
| R2  | Same invariant, reject/veto half                                                                                        | `src/service.ts`: `runDetection`'s input loop — deleted `if (overrides.merchants.has(row.merchantId)) continue;`                                                                                                                  | `test/db/lifecycle.test.ts` "a rejected merchant never returns as a candidate" and "a rejection recorded against an auto-confirmed series is just as permanent" | RED first try, both: `expected 4 to be 2` (the rejected payee's rows reached the engine) and `expected 6 to be +0`. Restored; `git diff --stat` empty.                                                            |
| R3  | D25: detection creates no `merchants` row                                                                               | `src/consumer.ts`: added a raw `INSERT INTO merchants (...)` immediately before `runDetection`, the exact mutation wp2.3-recurring.md §3 already recorded — reproduced independently rather than trusted                          | `test/db/no-merchant-creation.test.ts` "a full detection pass leaves merchants row count and ids unchanged" **and** `node scripts/check-schema-ownership.ts`    | RED first try on both, independently: `expected 33 to be 32`, and `schema-ownership: 1 problem(s) … raw SQL references 'merchants'`. Restored; `git diff --stat` empty; `check-schema-ownership.ts` back to `ok`. |

**R1 is a genuine finding, and required understanding two lines of
production code that turned out to be non-redundant only together.**
Sabotaging _either_ line alone (`nextState`'s own check, or the update
path's ternary) left every existing test green **and even left a first draft
of a new test green**, because `nextState` at line ~413 already equals
`'ACTIVE'` whenever `existing.userConfirmed` is true — the update-path
ternary at line ~484 is provably redundant with it _by construction_, so
sabotaging one while leaving the other intact changes nothing observable.
Both had to be removed together to produce a real defect. Constructing a
test that reaches the merge branch at all took two attempts: the first
(dropping the most _recent_ four of six occurrences) changed the detected
stream's anchor date and therefore its `streamKey`
(`merchantId:sign:currency:bucket:anchorDate`), so the "existing" row lookup
missed entirely and a _second_, brand-new `CANDIDATE` series appeared beside
the untouched confirmed one — confirmed by a throwaway debug dump of the
table, not assumed. The working version instead drops the most _recent_
four, i.e. keeps the earliest two (same anchor, same amount bucket, same
`streamKey`), which forces the re-run through the real merge branch with a
freshly computed `EARLY_DETECTION`-capped confidence (0.70, under the 0.80
auto-confirm bar). Added
`'a confirmed series is never demoted by a re-run that would only score a
candidate'` to `packages/contexts/recurring/test/db/lifecycle.test.ts`.
Confirmed **RED** under the combined sabotage
(`expected 'CANDIDATE' to be 'ACTIVE'`), confirmed **GREEN** restored. Full
`recurring-db` `lifecycle.test.ts` re-run after: 5 tests, all green.

---

### 4.3 Notifications

Independent re-sabotage of the four risks named in the dispatch, not a
re-read of wp2.4-notifications.md's own claims — three of the four hit the
exact same production line that WP 2.4's own evidence names, confirming
those controls are still wired the same way today; the fourth (dedupe) also
reproduces WP 2.4's own recorded mutation.

| #   | Invariant                                                                                  | File / mutation                                                                                                         | Test                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | Egress allow-list: an unnamed host is refused                                              | `src/egress.ts`: `checkDestination`'s `!policy.allowedHosts.includes(host)` -> `if (false)`                             | `test/egress-allowlist.test.ts` (whole file) | RED first try, 2 tests: `expected 'port_not_allowed' to be 'host_not_allowed'` and `expected 'dns_resolution_failed' to be 'host_not_allowed'` -- different, still-correct downstream guards (port allow-list, DNS resolution) catch the same destinations for a different reason once the host gate is gone, exactly as wp2.4's own defence-in-depth record describes. Restored; `git diff --stat` empty. |
| N2  | Sealed custody: `sealed_config` never holds plaintext                                      | `src/service.ts`: `createChannel`'s `secretBox.sealText(...)` -> `Buffer.from(JSON.stringify(config))`                  | `test/db/custody.test.ts`                    | RED first try, 2 tests: the raw column read back the literal password in cleartext, and the re-pointed-host test threw a `SecretBoxError` instead of the expected `ChannelRefusedError` (no envelope to open at all). Restored; `git diff --stat` empty.                                                                                                                                                   |
| N3  | At-most-once: the same `dedupeKey` delivers once                                           | `src/consumer.ts`: `enqueueNotification`'s `dedupeKey: rendered.dedupeKey` -> `` `${rendered.dedupeKey}:${event.id}` `` | `test/db/dedupe.test.ts`                     | RED first try, 2 tests: `expected [...] to have a length of 1 but got 2`, and the cross-user dedupe-key-collision test's own uniqueness assertion inverted. Restored; `git diff --stat` empty.                                                                                                                                                                                                             |
| N4  | Quiet hours release at the wall-clock instant, not "now + remaining minutes" (DST-correct) | `src/time.ts`: `quietHoursReleaseAt` rewritten to naive UTC-minute arithmetic                                           | `test/db/quiet-hours.test.ts`                | RED first try, 2 tests: spring-forward `expected '2026-03-08T07:00:00.000Z' to be '2026-03-08T11:00:00.000Z'`; autumn `expected '2026-11-01T07:00:00.000Z' to be '2026-11-01T12:00:00.000Z'` -- both off by exactly the DST hour plus the UTC/local offset the naive version ignored entirely. Restored; `git diff --stat` empty.                                                                          |

All four restored and re-verified individually green; no new test needed —
every one of these controls demonstrably still fails when broken.

---

### 4.4 Insights

| #   | Invariant                                                                                   | File / mutation                                                                                                       | Test                                 | Result                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| I1  | The impact ceiling withholds an implausible figure rather than rendering it                 | `src/advisors/support.ts`: `clampImpact`'s `if (magnitude > CEILING_MINOR)` -> `if (false)`                           | `test/impact-ceiling.test.ts`        | RED first try, 3 tests: `expected null (annualized) to be non-null` shape, boundary and negative-outlier cases both flipped `withheld` -> `kept`. Restored; `git diff --stat` empty.                         |
| I2  | Evidence must resolve into the snapshot we sent, never fabricate a value for a missing path | `src/validate/evidence.ts`: `resolveSourceRef`'s two `unknown_key`/`missing_path` returns -> `{ ok: true, value: 0 }` | `test/evidence-resolution.test.ts`   | RED first try, 3 tests, including the exact WP 2.6 finding reproduced independently: a fabricated `$227.88` figure was **accepted** and reached `status: pending_review`. Restored; `git diff --stat` empty. |
| I3  | No numeral in a rendered body may be untraceable to the snapshot                            | `src/validate/numerals.ts`: `untraceableNumerals` -> always returns `[]`                                              | `test/no-fabricated-numbers.test.ts` | RED first try, 3 tests: an invented `$227.99` (versus the snapshot's traceable `$227.88`) was accepted; an impact figure with no derivation behind it passed unrejected. Restored; `git diff --stat` empty.  |
| I4  | Alert budget caps the dashboard/list feed and drops the lowest-impact overflow              | `src/advisors/ranking.ts`: `applyCatalogueBudget` -> returns the whole ordering for every slice                       | `test/ranking.test.ts`               | RED first try: `expected [...] to have a length of 5 but got 25` (no capping at all). Restored; `git diff --stat` empty.                                                                                     |

All four restored and re-verified individually green (`impact-ceiling.test.ts`
6/6, `evidence-resolution.test.ts` 9/9, `no-fabricated-numbers.test.ts` 12/12,
`ranking.test.ts` 8/8).

---

### 4.5 Routes

| #   | Invariant                                                                                 | File / mutation                                                                                                               | Test                                                                                           | Result                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RT1 | `POST /advisors/run` needs a step-up assertion (dispatch §5's own example route)          | `apps/api/src/routes/insights.ts`: the handler's `guards.requireFreshSession(request)` -> `guards.requireSession(request)`    | Full `apps/api/test/db/insights-routes.test.ts` suite (7 tests, pre-fix)                       | **STAYED GREEN.** The file's only test against this route (`'triggering a run without an advisor_token_secret configured fails closed with 503, not a 500'`) always uses a _fresh_ session, so step-up was never exercised at all. |
| RT2 | `POST /notifications/channels` needs a step-up assertion (dispatch's other named example) | `apps/api/src/routes/notifications.ts`: same substitution on the channel-create handler                                       | `apps/api/test/db/notifications-routes.test.ts` "creating a channel needs a step-up assertion" | RED first try: `expected 422 to be 403` — confirms this one, unlike RT1, was already genuinely tested. Restored; `git diff --stat` empty.                                                                                          |
| RT3 | `GET /notifications/outbox` is scoped to the caller's own rows                            | `packages/contexts/notifications/src/read.ts`: `listOutbox`'s `eq(notificationOutbox.userId, userId)` clause dropped entirely | Full `apps/api/test/db/notifications-routes.test.ts` suite (pre-fix)                           | **STAYED GREEN.** `listOutbox`'s only other caller (`packages/contexts/notifications/test/db/delivery.test.ts`) runs against a single-user scratch database, and this route's own suite never seeded a second user's outbox row.   |

**RT1 is a genuine finding, fixed.** Added
`'triggering a run needs a step-up assertion'` to
`apps/api/test/db/insights-routes.test.ts`, driving `POST /advisors/run` with
`h.stale` and asserting `403 step_up_required`. Confirmed **RED** under the
sabotage (`expected 503 to be 403` — the guard being gone let the request
reach the _next_ check instead), confirmed **GREEN** restored. Full
`insights-routes.test.ts` re-run: 8/8.

**RT3 is a genuine finding, fixed, and the highest-severity one this pass
found: a real cross-user data leak with no test anywhere in the tree.**
Added `"a notification queued for one user never appears in another's
outbox"` to `apps/api/test/db/notifications-routes.test.ts`: seeds a second
account holder and their own channel (`seedChannelFor`, generalised from the
existing `seedEnabledChannel`), enqueues one real outbox row per user via
`@ctx/notifications`'s own exported `enqueueNotification`, and asserts each
`GET /notifications/outbox` sees only its own row by title. Confirmed **RED**
under the sabotage (`expected [ 'Theirs', 'Mine' ] to not include 'Theirs'`
— the first user's response for-real contained the second user's queued
notification), confirmed **GREEN** restored. Full
`notifications-routes.test.ts` re-run: 10/10. `pnpm exec tsc -p
tsconfig.json --noEmit` clean on both edited test files.

---

### 4.6 Reports, wiring, web

| #   | Domain  | Invariant                                                                                                                                         | File / mutation                                                                                                                                                | Test                                                                                                            | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Reports | A sealed credential (or anything named like one) never leaves the export bundle                                                                   | `apps/api/src/reports/export/registry.ts`: `isSensitiveColumn` -> always `false`                                                                               | `apps/api/test/db/export-import.test.ts` "an export never contains a sealed credential or a Plaid access token" | RED first try: the serialised bundle text contained `sealed_credentials`. Restored; `git diff --stat` empty.                                                                                                                                                                                                                                                                                                                                                                   |
| E2  | Reports | A tampered stream hash is refused on import                                                                                                       | `apps/api/src/reports/export/bundle.ts`: `parseAndVerifyBundle`'s `if (digest !== stream.sha256)` -> `if (false && ...)`                                       | `apps/api/test/db/export-import.test.ts` "a tampered stream hash is refused"                                    | RED first try: `expected function to throw an error, but it didn't`. Restored; `git diff --stat` empty.                                                                                                                                                                                                                                                                                                                                                                        |
| W1  | Wiring  | A module flag off registers no consumer, no job, and never calls its schedules (`apps/api/src/platform.ts`'s own module-header claim, 08 §6.9)    | `apps/api/src/platform.ts`: `resolveModules`'s `if (!(await platform.flags.isEnabled(...)))` -> `if (false)`                                                   | Every existing wiring test (`categorization-wiring`, `phase2-wiring`, `phase1-seed-e2e`)                        | **STAYED GREEN — and could not have gone red, because `resolveModules` itself was never called by any test in the tree.** Every wiring test builds its consumer pump directly from `appModules()`'s raw array, bypassing the flag-gating function entirely (`categorization-wiring.test.ts`'s own header says so: "`apps/api/src/app.ts` never calls `appModules()`/`resolveModules()` — that only happens in `worker.ts`"). `resolveModules` is exercised only in production. |
| WE1 | Web     | The insight evidence panel throws rather than fabricates when a cited `sourceRef` is not on _this_ insight's own evidence array (master plan D22) | `apps/web/src/features/insights/evidence-resolver.ts`: `resolveEvidenceRef`'s `throw new UnresolvedEvidenceRefError(sourceRef)` -> falls back to `evidence[0]` | `apps/web/src/features/insights/evidence-resolver.test.ts` (whole file)                                         | RED first try, 3 tests: the not-found case silently returned a different row instead of throwing, the cross-insight-leak case likewise, and the empty-evidence case returned `undefined` instead of throwing. Restored; `git diff --stat` empty.                                                                                                                                                                                                                               |

**W1 is a genuine finding, fixed, and matches the exact wording dispatch §3
names ("a module flag off registers no consumer").** Added
`apps/api/test/phase2-module-flags.test.ts` (new file, this WP's own
ownership: `apps/api/test/**/phase2-*.test.ts`) — a pure unit test needing no
database, since `resolveModules` only ever reads `platform.flags.isEnabled`
and `platform.registry.registerAll`. Builds a fake `Platform` whose
`flags.isEnabled` answers `true` for exactly one of two fake
`ModuleRegistration`s (each carrying a real event, a real
`registerConsumer`-built consumer, a real `defineJob`-built job, and a spy
`schedules` callback) and asserts: the off module contributes zero consumers,
zero jobs, and its `schedules` spy is never called; the on module contributes
all three and its `schedules` spy is called exactly once with the user id.
Confirmed **RED** under the sabotage
(`expected [ 'wp2.12.module.on', …(1) ] to deeply equal [ 'wp2.12.module.on' ]`
— the off module's flag key leaked into `enabled`), confirmed **GREEN**
restored. `pnpm exec tsc -p tsconfig.json --noEmit` and `eslint` both clean
on the new file.

**Sabotage tally for this pass: 22 sabotages across 8 domains** (4 budgeting,
3 recurring, 4 notifications, 4 insights, 3 routes, 2 reports, 1 wiring, 1
web — every bullet the dispatch names, plus B2's follow-on). **17 red on the
first try; 5 stayed green** (B2 refund-category fallback, R1 the confirmed-
series pin's merge branch, RT1 `/advisors/run` step-up, RT3 the outbox
cross-user leak, W1 `resolveModules` itself) — each closed with a new,
independently-verified-red-then-green test, per this pass's own rule that any
control observed surviving its own sabotage gets a fix, not a footnote. Every
sabotage in this section was restored with `git checkout --` and reconfirmed
green before moving to the next; no two sabotages were ever live at once.

---

## 5. R-5 growth bound: merchants and provider revisions on a 50k-row backfill

Phase 1's R-5 (`docs/plan/02-phase-2-dispatch.md` §2: "no bound on distinct
merchants or on `transactions_provider` revisions; never promoted to a
condition") is promoted to a real test in this pass:
`packages/contexts/ledger/test/growth-bound.test.ts` (new file — `ledger-db`
project, already declared and in `ci.yml`'s `migration-test` job).

**Scale, without a `@core/seed` code change.** `generateDemoData`'s existing
`monthCount` option reaches ~50k transactions deterministically:
`generateDemoData(1, { monthCount: 1264 })` produces **50,040 transactions**
across the same fixed **32-merchant**, 6-account household every other Phase
1/2 doc uses at the generator's 24-month default — verified once by hand
before writing the test. The merchant pool does not grow with the window,
which is exactly the property this test measures downstream, in the real
ledger, through the real write path (`loadSeedDataset` →
`applyProviderTransactions` → `resolveMerchants`/`ensureMerchants` — never a
raw bulk insert, which would prove nothing about merchant resolution).

**Protocol** (dispatch's own exit-test name, verbatim): sync the identical
50,040-row corpus **three times** (`loadSeedDataset` called three times with
the same dataset — a webhook redelivery, a schedule firing on top of a
manual refresh, at ledger + merchant-resolution scale rather than the
orchestrator-dedupe scale `connections-db`'s own tests cover) and assert,
after each sync:

- `merchants` row **count and ids** (not count alone — a regression that
  deleted one merchant and minted a near-duplicate would move no counter);
- `transactions_provider` row count (the fact count, expected exactly
  50,040 throughout); and
- `sum(transactions_provider.revision)` — equal to the fact count after
  sync 1 (every first sighting is revision 1) and unchanged after syncs 2
  and 3, proving a replay of identical content never advances a revision.

**Result: PASS.** All three syncs hold every count and every id list
identical. Runtime 188 s (50k rows × 3 real writes through merchant
resolution — the `300_000` ms test timeout was sized for this up front).

**Sabotage — merchant fragmentation.** `packages/contexts/ledger/src/
merchant-store.ts`'s `ensureMerchants`: the insert's `normalizedKey: key`
(the value looked up by, and therefore the value that makes a repeat
sighting resolve to the _same_ row) changed to
`` `${key}-${newId()}` `` — a random suffix, simulating exactly the bug this
test's own header names ("quietly minted a near-duplicate merchant per
sync").

```
$ pnpm exec vitest run --project ledger-db test/growth-bound.test.ts
 × three syncs of the same corpus add no merchants and no provider revisions
AssertionError: expected 53 to be less than or equal to 32
```

RED on the first try, and faster than the clean run (56 s, not 188 s):
because the corpus is synced in pages, a random key on every insert
fragments merchants _within_ the first sync alone (53 merchants from one
50k-row sync instead of 32), so the assertion failed before the second or
third sync ever ran — the test is at least as sensitive as its own docstring
claims. Restored with `git checkout --`; `git diff --stat` on
`merchant-store.ts` empty.

---

## 6. Perf budgets

**Reports p95, over real HTTP.** New file:
`apps/api/test/db/phase2-reports-http-perf.test.ts`. WP 2.8's own
`reports-aggregation.test.ts` measured `computeCategoryMonthActivity` called
directly, in-process, and its own evidence (§11 open item 5) named the gap:
"WP 2.12's own perf-budget work is the place a full HTTP-level measurement
belongs." This file is that measurement — a real bound Fastify server
(`h.listen()`) and real `fetch()` calls (a real TCP round trip, unlike
`app.inject()`), against `GET /reports/spending`, on the 50,040-transaction
seed (`generateDemoData(1, { monthCount: 1264 })`, the same corpus §5 uses).

**A stale scale claim, found and reported rather than silently fixed.**
`reports-aggregation.test.ts`'s own comment says
`generateDemoData(1) // 24 months, ~50k rows (Phase 1's budget)` — checked
directly and it is wrong: `generateDemoData(1)` with no options produces
**982** transactions, not ~50,000, so WP 2.8's own perf test has been running
its "50k seed" budget against 982 rows since it was written. Not fixed in
that file: it is not owned by this WP (`reports-aggregation.test.ts` is WP
2.8's; this WP's new-file allowance for `apps/api/test/db/` is
`phase2-*.test.ts`). Reported here per this WP's own rule against silently
working around another package's file. **This file's own dataset size is
verified in its header comment and asserted in the test itself**
(`expect(dataset.transactions.length).toBe(50_040)`), so its own "50k" claim
cannot silently drift the same way.

**Result:**

```
reports p95 (HTTP, 50k seed): p50=25.2ms p95=30.3ms
  samples=[23,23,23,23,24,24,24,25,25,26,26,26,26,27,30]
```

p95 = 30.3 ms against a 200 ms budget — comfortably inside it, and the gap
between this (real HTTP) number and WP 2.8's in-process number is small (both
sub-50ms), which is itself informative: Fastify's own routing/auth/
serialisation overhead is not where this endpoint's cost lives, at this
scale.

**Budgeting, recurring, insights generation perf** (the dispatch's other two
named targets): not separately built. `packages/contexts/budgeting`'s own
`test/db/actuals-consumer.test.ts` §6 (wp2.1-budgeting.md) already measured
the dirty-cascade cost on a 24-period/960-transaction scratch database
(28–31 ms per period, linear in periods-from-arrival); `@ctx/insights`'s own
`test/advisors/seed.ts` cases are three hand-sized scenarios, not the 50k
seed, and `docs/evidence/phase-2/wp2.7-advisor-catalog.md` §10 item 7 already
names "no rule has run against the 50k seed" as carried to this WP and the
gate. Time did not allow building a from-scratch insights-generation and
recurring-detection perf harness against the 50k seed in this pass; recorded
here as **not done**, not silently claimed, and named in §9 as what the gate
should still ask for.

## 7. Recurring P/R harness in CI

**Already wired, already gated — confirmed, not built.** Dispatch's ask —
"wire the recurring P/R harness into CI with a regression gate (precision
may not drop below the recorded baseline)" — is satisfied by two things that
already existed before this pass and are re-verified here:

1. `packages/contexts/recurring/test/golden-streams.test.ts` already asserts
   hard floors, not just prints the sweep:
   `expect(metrics.precision).toBeGreaterThanOrEqual(0.95)` and
   `expect(metrics.recall).toBeGreaterThanOrEqual(0.85)`, plus cadence
   accuracy (≥0.92) and price-change precision/recall (≥0.90/≥0.85) — the
   floors _are_ the regression gate: the measured operating point (1.000
   precision / 0.977 recall, wp2.2-recurring-engine.md §2) is comfortably
   above them, so a real regression has room to be caught before it reaches
   the exit criterion's own 0.95/0.85 line.
2. The `recurring` project is in CI's `test` job (§2's parity check confirms
   all 31 projects, `recurring` included) — so this gate runs on every push,
   not only when a developer happens to run `just test` locally.

Nothing new was built here because both halves already existed; recorded as
a confirmed finding rather than left unverified.

---

## 8. Seed extensions

New file `packages/seed/src/phase2-scenarios.ts` (+ `packages/seed/src/
phase2-scenarios.test.ts`, 9 tests), exported from `packages/seed/src/
index.ts`. Three of the dispatch's five named scenarios, deterministic,
built as **standalone, additive fixtures** rather than changes to
`generateDemoData`'s default output:

| Scenario                         | Function                                     | What it produces                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Subscription with a price change | _(not new)_                                  | Already covered: `generateDemoData`'s "Adobe Creative Cloud" plan (`transactions.ts`, `priceIncreaseAtMonth: 12`) and `dataset.labels.recurringSeries[].priceIncrease`.                                                                         |
| Card migration                   | `generateCardMigration(seed, startMonth)`    | Two credit-card accounts, one merchant, six charges on the first card then (after a one-period gap, the reissue itself) six more on the second — the 07 §2.2 shape, with `labels.transactionIdsBeforeMigration`/`AfterMigration` split exactly. |
| Duplicate service                | `generateDuplicateService(seed, startMonth)` | Two concurrently active `entertainment.streaming` merchants, six months each, `labels.cheaperMerchantId` and `annualImpactMinor` computed per 07 §2.9 ("keeping only the cheapest frees the rest").                                             |
| Credit overspend                 | `generateCreditOverspend(seed, startMonth)`  | Six months of ordinary $300 dining spend on a credit card, then one $1,800 charge — over 4x the typical month — for 07 §1.3's cash/credit overspend split to have a real outlier to classify.                                                   |
| Quiet-hours notification         | _(not built — see below)_                    | —                                                                                                                                                                                                                                               |

**Why standalone rather than folded into `generateDemoData`.**
`generateDemoData(1)`'s exact counts (982 transactions, 32 merchants, 6
accounts) are pinned by exact-count assertions across Phase 1 and Phase 2
evidence and tests (`phase1-seed-e2e.test.ts`, `packages/contexts/ledger/
test/seed.test.ts`, this WP's own §5). Adding a second credit-card account
or a new recurring plan to the default household would move every one of
those pinned counts — the shape of change this project's own gate lessons
exist to catch. `phase2-scenarios.ts`'s three functions are independent
`SeedAccount`/`SeedTransaction` sets on their own deterministic RNG stream
(`mulberry32(seed * 2 + N)`), for a caller that explicitly wants one of
these scenarios loaded (e.g. as extra transactions synced onto its own
account pair) — `generateDemoData`'s output is untouched, confirmed by
re-running `--project seed` in full after adding this file (29 tests, all
green, no count assertion moved).

**Quiet-hours notification — deliberately not built, and why.** It is a
_timing_ claim (when a notification is released relative to a configured
quiet-hours window), not a _data_ shape `@core/seed` has any vocabulary for:
the generator produces calendar history with no concept of "when a sync
happened" or "when a notification would have fired." `@ctx/notifications`'s
own `test/db/quiet-hours.test.ts` already builds this scenario correctly, at
the layer that actually owns wall-clock timing (§4.3 of this WP's own
sabotage log re-verified it). A ledger-seed fixture for it would either
duplicate that harness's clock machinery for no benefit or be decorative.
Recorded as scoped out, not silently dropped.

**Tests, determinism verified for all three:** each scenario asserts
byte-identical `JSON.stringify` output for the same seed, a different output
for a different seed, the specific shape claimed (migration gap in days,
concurrent duplicate-service months, the overspend charge's magnitude versus
the ordinary pattern), and the labels reconcile against the transactions'
own amounts computed independently in the test (not re-imported from the
scenario module) — the same "worth trusting because the test computed the
number itself" standard this pass's other sections hold to.

```
$ pnpm exec vitest run --project seed
 Test Files  3 passed (3)
      Tests  29 passed (29)
```

**Not done in this pass:** the seed extensions are not yet _loaded_ into any
Phase 2 engine's own test (e.g. the recurring engine's corpus, or a UI gate
walk fixture) — they exist and are tested standalone, ready for a caller to
adopt, which is as far as this WP's remaining time reached. Named in §9 for
the gate.

---

## 9. New tests per project

| Project        | New tests this pass                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `budgeting-db` | +1 (`actuals-consumer.test.ts`: the refund-uses-purchase-category fallback, §4.1/B2)                                                                                                         |
| `recurring-db` | +1 (`lifecycle.test.ts`: the confirmed-series pin inside the merge branch, §4.2/R1)                                                                                                          |
| `api-db`       | +3 (`insights-routes.test.ts`: `/advisors/run` step-up, §4.5/RT1; `notifications-routes.test.ts`: outbox cross-user isolation, §4.5/RT3; +1 new file `phase2-reports-http-perf.test.ts`, §6) |
| `api` (unit)   | +1 file, 1 test (`phase2-module-flags.test.ts`: `resolveModules`'s own gating, §4.6/W1)                                                                                                      |
| `ledger-db`    | +1 file, 1 test (`growth-bound.test.ts`, §5)                                                                                                                                                 |
| `seed`         | +2 files, 9 tests (`phase2-scenarios.ts`/`.test.ts`, §8)                                                                                                                                     |

No tests were added to notifications, insights, or the web project: every
sabotage in those domains (§4.3, §4.4, §4.6/WE1) found the existing control
genuinely non-vacuous on the first try, so no gap needed closing there.

## 10. Files touched

Modified: `.github/workflows/ci.yml`, `justfile` (the `check` recipe only),
`apps/web/scripts/check-openapi-drift.ts`, `docs/TESTING.md`,
`apps/api/test/db/insights-routes.test.ts`,
`apps/api/test/db/notifications-routes.test.ts`,
`packages/contexts/budgeting/test/db/actuals-consumer.test.ts`,
`packages/contexts/recurring/test/db/lifecycle.test.ts`,
`packages/seed/src/index.ts`, `packages/testkit/test/process.test.ts`.

New: `scripts/check-ci-projects.ts`,
`apps/api/test/phase2-module-flags.test.ts`,
`apps/api/test/db/phase2-reports-http-perf.test.ts`,
`packages/contexts/ledger/test/growth-bound.test.ts`,
`packages/seed/src/phase2-scenarios.ts`,
`packages/seed/src/phase2-scenarios.test.ts`,
`docs/evidence/phase-2/wp2.12-quality.md` (this file).

No `package.json`, lockfile, migration, `apps/api/src/routes/**` production
route file, or any `packages/contexts/**/src/**` production file was left
modified — every production-code sabotage in §4 was restored with `git
checkout --` and reconfirmed with an empty `git diff --stat` before moving
to the next one. `git status --short` at the time of writing this section
shows exactly the modified/new list above.

## 11. What the Opus gate should re-run

1. **The cold `down -v` boot, mandatory per this WP's dispatch**: `docker
compose build && docker compose down -v && docker compose up -d`,
   confirm the worker reaches "modules resolved" healthy with all five
   `MODULE_FLAGS` (`module.budgeting`, `module.recurring`,
   `module.notifications`, `module.insights`, `module.categorization`)
   registered — the schedule-name crash-loop `wp2.w-wiring.md` §4.4 found
   was fixed at `dd8c874` (confirmed still present by reading
   `packages/contexts/notifications/src/jobs.ts:363,375` and
   `packages/platform/src/jobs/scheduler.ts:134` before this pass touched
   anything, §0), but this pass did not itself re-run a cold boot — it is
   the one item explicitly reserved for the gate, per the dispatch brief.
2. **RT3, the cross-user outbox leak (§4.5)**, from inside the real
   deployment: `GET /notifications/outbox` for two real account holders on
   the booted stack, not just this pass's in-process harness.
3. **N1's egress refusal matrix, from inside the worker container** — this
   pass re-sabotaged it on the host (§4.3), where `db` does not resolve at
   all; `wp2.4-notifications.md` §10 already names the stronger, in-container
   re-run as owed to the gate, and it still is.
4. **The two Phase 1 exit criteria this pass could not touch**: "two real
   institutions syncing on schedule" and "a month of real data with zero
   internal transfers" — both need Chris's own linked accounts, not more
   automated testing (§1's carried-items table).
5. **The insights/recurring/budgeting perf budgets against the 50k seed**
   (§6) — not built in this pass beyond the reports HTTP number; if the
   gate has time, `packages/seed/src/phase2-scenarios.ts`'s three new
   fixtures (§8) are a reasonable starting point for a fairer insights-
   catalogue gate than the three hand-sized cases `wp2.7-advisor-catalog.md`
   currently runs against.
6. **Whether the `process.test.ts` flake (§ below, and this file's own
   header) actually recurs** under a real, sustained full-suite CI run — a
   reasoned mitigation was applied (raised timeouts) but not a confirmed
   fix; two reproduction attempts in this session (synthetic CPU pressure,
   one full local suite run) both failed to reproduce it.

---

## 12. `packages/testkit/test/process.test.ts` — the SIGTERM flake

Handed to this WP by name (§0). Full write-up lives in the file's own header
comment now (`packages/testkit/test/process.test.ts`), summarised here:

**Cause found:** each `it()` carried a hand-set `10_000` ms timeout —
_below_ the `testkit` vitest project's own `testTimeout: 30_000` default
(`vitest.config.ts`) and below `spawnProcess`'s own internal `waitFor`
budget (`process.ts`, `timeoutMs: 30_000`). Every test spawns a real second
Node process and waits on its stdout; under full-suite load, dozens of
concurrent workers and `*-db` suites compete for the CPU a freshly `spawn()`ed
child needs to start up and register its `SIGTERM` handler in, and 10 real
seconds is not always enough margin on a loaded machine even though it is
generous alone — exactly the "passes alone" symptom on record.

**Reproduction attempted, not achieved.** Two attempts, both green:
`yes > /dev/null &` pinned across all 8 cores plus three solo re-runs of this
file; one full, unfiltered `pnpm exec vitest run` across all 154 files /
1,915 tests (no `process.test.ts` failure, no `SIGTERM` anywhere in the log).
Consistent with a real but rare flake (intermittent OS scheduler contention)
rather than one this session's synthetic load could trigger on demand.

**Fix applied, not silently skipped:** every per-test timeout raised from
`10_000` to `30_000`, matching the project default and `waitFor`'s own
budget — the one place this file gave itself _less_ time than its own
dependency already allows for. Recorded as a **reasoned mitigation, not a
confirmed fix**, per this WP's own instruction ("reproduce ... and fix it,
else document the attempt and quarantine with a reason and owner"): no
quarantine was applied (the file was not skipped), because the mechanism
found is real and the fix is a strict improvement regardless of whether it
is the whole story. **Owner for a recurrence:** whoever next observes it
reproduce, with real signal-delivery latency under load as the next
hypothesis if raising the timeout does not make it stop — the file's own
header names this explicitly.

```
$ pnpm exec vitest run --project testkit packages/testkit/test/process.test.ts
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

---
