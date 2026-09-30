<!-- SPDX-License-Identifier: MIT -->

# WP 5.13a — Phase 4 gate carry-overs: C-1, C-2, G4-23

**Tree:** `/home/chris/Projects/PersonalFi`, branch `main`, HEAD `691ba33` at the start of this
session (a wip snapshot; see that commit's message for what it carried). Two Opus agents (WP 5.1
in `packages/contexts/insights/**`/migration 0028/`packages/db/test/migrate.test.ts`; WP 5.2 in
`packages/advisors/local-model/**`/`packages/platform/src/egress/local-endpoint*`) work in the
same tree at the same time; this WP holds the compose stack, neither of theirs touch it. Written
incrementally, section by section.

No secret value appears anywhere in this file. `docker compose exec … psql` and
`docker compose logs` were not run from this agent; every place a DB read or a log read would
have gone through them instead says "DB read needed" / "log needed" for the orchestrator, or was
answered through `docker compose run --rm`, `docker inspect`, `docker compose ps` or `curl`
through Caddy instead.

---

## 0. What's closed, partially closed, or deferred

- **C-1 (HIGH)** — **closed via the condition's documented-restart alternative, not via re-read;
  the exit criterion is met and walked live.** (a) the Dockerfile ownership line: done,
  sabotage-tested live (§5.4: `EACCES` on a fresh volume with it removed, a clean write with it
  restored). (b) the documented operator fetch command: done (RUNBOOK.md "Monte Carlo return
  series"), proven live and **a real bug in the first draft of that command found and fixed
  before anything else was recorded** (§5.2 — `docker compose run` silently ignores its own
  trailing arguments without `--entrypoint node`). (c) "picked up without a restart" — **not
  closed as re-read**: a re-read design was built, found to regress the nightly baseline job
  (proved red against `apps/api/test/db/phase4-wiring.test.ts`'s own pre-existing coverage), and
  reverted; C-1's own text names a second, explicitly permitted path ("re-read on a miss, **or a
  documented restart step**") and this WP takes that path, documented in RUNBOOK.md and proven
  live in §5.3 (fetch → `docker compose restart worker api` → 200, no other action). (e) the
  `monte_carlo`-first ordering in `newestBaselineRunId`: done (landed before this session; proven
  and sabotage-tested here, §1.4). CK2's fetch-side pin test: done (landed before this session;
  proven and sabotage-tested here, §1.5). **The full exit criterion** — cold `up` → RUNBOOK fetch
  → `POST …/projections {"method":"monte_carlo"}` 200 over Caddy → one run at the concurrency cap
  observed → R2 fires on a < 80% baseline (or record exactly what blocks it) — **is met end to
  end in §5.3**, with R2's own non-firing precisely diagnosed to two named, non-WP-5.13 causes
  (a design exclusion in `evaluateGoalPace`, and the consent grant C-12/WP 5.1 owns) rather than
  left unexplained.
- **C-2 (Medium)** — **closed.** The race-recovery path in `SecretBox#initialiseKeyring` and
  `keyring-race.test.ts` both landed before this session; proven and sabotage-tested here (§2).
- **G4-23 (Low, C-14's clause)** — **closed.** Migration 0034 landed before this session; proven
  against the migration-test projects and sabotage-tested here (§3).
- **C-3, C-4, C-5, C-6, C-13** — **deferred**, out of this session's scope (headings left below
  for whoever picks them up next).

---

## 1. C-1 — Monte Carlo servable on a compose install

**Condition, quoted (gate §6, row C-1):** "`docker/api.Dockerfile` creates
`/var/lib/personalfi/returns` owned by 10001 so an empty named volume inherits it; `compose.yml`
mounts `returns_cache` on `api` (read-only) as well as `worker`, and sets
`PLANNING_RETURNS_CACHE_DIR` on both; the fetch runs as the service's own uid; a successful fetch
is picked up without a restart (re-read on a miss, or a documented restart step); RUNBOOK gains
the step, with the licence reason. `newestBaselineRunId` prefers a fresh Monte Carlo baseline run
for R2 (or the api's own interactive run is Monte Carlo once bound). CK2's fetch-side refusal
gets its test. **Exit:** a cold `up` → the RUNBOOK fetch as documented → `POST …/projections
{"method":"monte_carlo"}` **200** over Caddy with no manual `chown` or root exec; one run at the
concurrency cap observed (§4.1 (b)); R2 fires on a < 80% baseline."

### 1.1 (a) — the Dockerfile ownership line

**File:** `docker/api.Dockerfile`. Landed before this session (the wip snapshot, `691ba33`):

```dockerfile
RUN mkdir -p /var/lib/personalfi/returns && chown 10001:10001 /var/lib/personalfi/returns
```

with the C-1 comment explaining Docker's volume-ownership-inheritance rule. **Sabotage
(performed live in §5's cold walk, §5.2):** the line removed, image rebuilt, a one-shot
`docker compose run` as the worker attempts to write into the volume → `EACCES`, restored,
rebuilt, retried → succeeds. See §5.2 for the transcript.

### 1.2 (b) — the documented operator fetch command

**File:** `RUNBOOK.md`, new section **"Monte Carlo return series"** (this WP's alone; no other
section touched). The command:

```bash
docker compose run --rm --no-deps --entrypoint node worker \
  packages/contexts/planning/data/returns/fetch.ts \
  --cache-dir /var/lib/personalfi/returns
```

`fetch.ts` already had a CLI entry point (`#!/usr/bin/env node` header, `--cache-dir`, `--from`,
`--pin`, `--damodaran` flags, `await main();` at the bottom) — no new file and no new dependency
were needed, contrary to the dispatch's "add one under `data/returns/` only if none exists"
fallback. `docker compose run --rm --no-deps --entrypoint node worker` runs inside the one service
the volume is writable on (`compose.yml`'s `WRITABLE_NAMED_VOLUMES`), as the image's own `USER
10001:10001` (`docker/api.Dockerfile`) — no `--user` flag, no `chown`, no root exec, matching the
exit criterion's wording exactly. `--entrypoint node` is not optional — see §5.2 for the real bug
this section's first draft had without it. Performed live in §5.3/§5.4.

The RUNBOOK section also states the licence reason (neither Shiller's `shillerdata.com` nor
Damodaran's NYU pages grant redistribution — `packages/contexts/planning/data/returns/
PROVENANCE.md` — so the repository fetches, never vendors, the series), the SHA-256 pin and what
a mismatch does (refused, nothing written — `ReturnSeriesRefused` /
`planning.returns_series_checksum_mismatch`, both at fetch time and every later read), and what a
missing series looks like on screen and from the route (409
`planning.monte_carlo_unavailable`, never a 500, never a silent substitute).

### 1.3 (c) — "picked up without a restart"

**Not closed as re-read.** `apps/api/src/domain.ts`'s `createMonteCarloRunnerFromCache` (~line 3444) is unchanged from the wip snapshot in its externally visible behaviour: `null` on a cache
miss, a bound `MonteCarloRunner` on a hit, logged either way. A design was built and rejected
during this session — recorded here because the condition names this exact fix and a reader
should be able to see why it isn't the one that landed:

**What was tried.** A `RetryingMonteCarloRunner` class, returned from `createMonteCarloRunnerFromCache`
instead of `null`, that re-read the cache directory on every `engineVersion` read and every
`run()` call, memoising only a successful load. Both call sites (`app.ts`, `worker.ts`) still
call the function exactly once, at boot, but the _returned object_ would no longer need a second
call to notice a later fetch.

**What it broke.** `defaultMethodFor` (`apps/api/src/routes/plan.ts:107`,
`deps.monteCarlo === null ? 'deterministic' : 'monte_carlo'`) and `refreshBaseline`'s own method
choice (`packages/contexts/planning/src/projection-service.ts:973`, the same shape) both decide
deterministic-vs-Monte-Carlo from a bare `=== null` check on the exact value this function
returns. Making that value never `null` made both paths _attempt_ Monte Carlo eagerly, even
before any fetch — and on a miss, `run()` correctly refused with `ProjectionRefused
('planning.monte_carlo_unavailable', …)`, which `jobs.ts`'s `projectionRefreshJobHandler` already
catches for any `family: 'domain'` refusal and turns into a logged warning, **not a written
run**. The nightly `planning.projection_refresh` job therefore stopped writing _any_ baseline
run — not even the deterministic one it writes today — for every install that has not yet
fetched the series.

**Sabotage record for the rejected design** (verify-first: reproduced red against the _existing_
test before reverting, never merely reasoned about): `apps/api/test/db/phase4-wiring.test.ts`'s
own pre-existing test `'with no return series on disk the runner is bound as null and a
projection records it, never a silent lognormal'` (line ~524) went from green to **red** the
moment the retrying design landed:

```
AssertionError: expected undefined to be 'computed'
 ❯ test/db/phase4-wiring.test.ts:580:42
      const result = job.logs.find((entry) => entry.message.startsWith('baseline'));
      expect(result?.fields['status']).toBe('computed');
```

(the nightly job's log line was `baseline projection refused: …`, not `baseline projection
computed`/`method: deterministic` — the catch branch, not the success branch). This is not
another agent's in-flight file — `phase4-wiring.test.ts` is Phase 4's, not Wave A's — and it is a
regression this WP's own change caused, so it was investigated to conclusion rather than named
and left. The retrying design and its test edits to that file were fully reverted; a second run
of the same test file afterward showed **8 passed (8)** (`/tmp/wp513a-phase4wiring-recheck.log`),
and `git diff --stat apps/api/test/db/phase4-wiring.test.ts` reads empty — byte-identical to the
committed file.

**What closed instead.** RUNBOOK.md's new section states the restart explicitly
(`docker compose restart worker api`) as the reason a fetch needs one — the condition's own
second named exit ("re-read on a miss, **or a documented restart step**"). `docs/evidence/phase-5/wp5.13-carry-overs.md`
(this file) is where that trade-off is recorded, per this WP's own instruction to document it
here if a re-read could not land safely.

**What _is_ proven about the function itself.** `createMonteCarloRunnerFromCache` has never
cached anything internally (it is `loadReturnSeries(options.cacheDir)` in a try/catch, and
`loadReturnSeries` reads the filesystem fresh every call) — the gap was always the call sites,
never the function. Two new tests prove the "starts empty, drops the series in, the next call
succeeds" property directly:

- `apps/api/test/carry-c1-monte-carlo-retry.test.ts` — `createMonteCarloRunnerFromCache`'s own
  miss-case wrapping (the `null` return, the exact logged warning), two independent calls proven
  not to share state.
- `packages/contexts/planning/test/returns-cache-rewrite.test.ts` — `loadReturnSeries` (the
  function `createMonteCarloRunnerFromCache` delegates to) called once against an empty
  directory (refuses, named `planning.returns_series_unavailable`), then again after a
  checksum-matching synthetic series (WP 4.5's own fixture) is written — **succeeds**, with the
  same function, no restart, no second process. A third call after that stays stable.

Both green:

```
 Test Files  1 passed (1)   apps/api/test/carry-c1-monte-carlo-retry.test.ts
      Tests  1 passed (1)

 Test Files  1 passed (1)   packages/contexts/planning/test/returns-cache-rewrite.test.ts
      Tests  2 passed (2)
```

### 1.4 `newestBaselineRunId` — the monte_carlo-first ordering

**File:** `apps/api/src/domain.ts` (~line 1642), landed before this session. Orders
`projection_runs` by `case when method = 'monte_carlo' then 0 else 1 end`, then `created_at desc`,
then `id desc` — a preference, not a staleness filter (unchanged: `readProjection` still answers
`stale` independently).

**Test:** `apps/api/test/db/carry-c1-newest-baseline-run.test.ts` — seeds an _older_ `monte_carlo`
run and a _newer_ `deterministic` run directly, and asserts `createInsightsPlanningPort(...)
.projection()` reads the older Monte Carlo one. Green (`1 passed`).

**Sabotage:** the `sql\`case when …\``ordering term removed, leaving plain`desc(created_at),
desc(id)`.

```
AssertionError: expected 'deterministic' to be 'monte_carlo'
 ❯ test/db/carry-c1-newest-baseline-run.test.ts:139:28
```

Red. Restored (`git diff --stat apps/api/src/domain.ts` afterward shows only this WP's doc-comment
expansion around the two owned functions, no stray sabotage markers — checked with
`git diff apps/api/src/domain.ts | grep -i sabotage`, empty); re-run: `1 passed (1)`.

### 1.5 CK2 — the fetch-side pin refusal

**File:** `packages/contexts/planning/data/returns/series.ts`, `ensureReturnSeries`'s post-derive
`actual !== pinned` refusal — landed before this session. **Test:**
`packages/contexts/planning/test/returns-fetch-checksum.test.ts` (the wip snapshot's
`bad-download-fetch.test.ts` reference in `series.ts`'s doc comment was wrong — the real file is
`returns-fetch-checksum.test.ts`; fixed in this session, `packages/contexts/planning/data/returns/series.ts`
now names the real file). Injects a `derive` that parses successfully but produces bytes that do
not hash to a throwaway pin; asserts the rejection is `planning.returns_series_checksum_mismatch`
and that nothing lands on disk (`existsSync` false for the file, the `.partial`, and the
directory itself).

**Sabotage:** `if (actual !== pinned)` → `if (actual !== pinned && false)`.

```
AssertionError: expected true to be false
 ❯ test/returns-fetch-checksum.test.ts:70:52
      expect(existsSync(join(cache, SERIES_FILE))).toBe(false);
```

Red (a wrong-bytes download is cached). Restored; `git diff --stat` shows only the one doc-comment
fix line; re-run: `1 passed (1)`.

### 1.6 C-1 exit criterion — the cold walk

See §5.

---

## 2. C-2 — key custody survives two processes initialising one keyring

**Condition, quoted (gate §6, row C-2):** "Key custody survives two processes initialising one
keyring: on `encryption_keys_scope_version_key`, re-read the winner's row and unlock against its
salt; a test that races two real `unlock()`s on a fresh database. **Exit:** a cold install shows
the worker at `RestartCount=0` after `bootstrap-user`."

**Files**, landed before this session: `packages/secretbox/src/secret-box.ts` —
`isKeyringRaceLoss` (matches Postgres `23505` + the exact constraint name
`encryption_keys_scope_version_key`, duck-typed against `SecretBoxQueryable`'s error shape, never
`instanceof pg.DatabaseError`), `#unlockAgainstRow` (factored out of the "row already exists"
half of `unlock()` so the race-recovery path can reach it too), and the race-recovery branch
inside `#initialiseKeyring`'s `catch`: on a unique-violation loss, re-read the winner's row via
`findActiveKeyByScope` and `#unlockAgainstRow` against it; if the winner's row is itself gone by
then, refuse (`SecretBoxError('envelope_malformed', …)`) rather than loop.

**Test:** `packages/secretbox/test/keyring-race.test.ts` — two real `SecretBox.unlock()` calls
against a real, fresh Postgres database, both racing the "no KEK row" read (widened to 40ms so
both observe no row before either inserts — the gate's own timing, Argon2id's ~5.6s derivation
outlasting a 5s poll, reproduced deterministically rather than left to luck). Asserts both report
`unlocked`, both agree on `kekVersion: 1`, exactly one row exists in `encryption_keys`, a value
sealed under one box opens under the other (proving they hold the _same_ key, not merely two
"unlocked" states), and a third, fresh box on the same database re-derives the same generation.

Run (dev Postgres, `127.0.0.1:5433`):

```
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

**Sabotage:** the race-recovery branch's guard, `if (!isKeyringRaceLoss(error)) throw error;` →
`if (!isKeyringRaceLoss(error) || true) throw error;` (always rethrows — the loser dies, exactly
G4-2's pre-fix behaviour).

```
error: duplicate key value violates unique constraint "encryption_keys_scope_version_key"
 ❯ SecretBox.#initialiseKeyring src/secret-box.ts:409:7
 ❯ SecretBox.unlock src/secret-box.ts:169:7
 ❯ test/keyring-race.test.ts:87:32
 Tests  1 failed (1)
```

Red — the loser's `unlock()` throws instead of recovering, exactly the shape that made Compose
restart the worker in the gate's cold walk. Restored (`git diff --stat
packages/secretbox/src/secret-box.ts` afterward: empty); re-run: `1 passed (1)`.

**Exit criterion (`RestartCount=0` after `bootstrap-user`):** proven live in §5's cold walk.

---

## 3. G4-23 — the five bare `securities (id)` references made composite

**Condition, quoted (gate §6, C-14's G4-23 clause; §4.1(g)):** "the five bare
`REFERENCES securities (id)` made composite (G4-23) → 5.13 (reserved **0034**)." From §4.1(g):
"`security_identifiers` (0013:227), `security_overlay` (0013:301), `holdings_snapshots`
(0014:230), `basis_method_elections` (0014:451) and **`securities.merged_into_id`** (0013:194) —
the last lets one user's security be merged into another user's."

**File:** `packages/db/migrations/0034_securities_composite_fks.sql` (94 lines), landed before
this session. Five `ALTER TABLE … ADD CONSTRAINT` statements, each `FOREIGN KEY (user_id,
security_id) REFERENCES securities (user_id, id)` (self-referencing for `merged_into_id`, same
shape), each `ON DELETE CASCADE` except `merged_into_id` (matching 0013's original `NO ACTION`),
each with a `COMMENT ON CONSTRAINT`. Forward-only, no `NOT VALID` — every existing row is
validated against the new constraint as it is added (matching 0025's own convention).

### 3.1 Migration applied, twice (idempotency)

Against the dev Postgres (`postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`, which
already carried 27 prior migrations and real prior-session data — not a throwaway scratch
database), `ROLE=migrator`:

```
applied 0013_securities in 78ms
...
applied 0034_securities_composite_fks in 18ms
migrations complete: 15 applied, 12 already present
```

Re-run immediately after:

```
database is up to date; nothing to apply
migrations complete: 0 applied, 27 already present
```

0034 applies cleanly to a database carrying real prior state, and a second run is a true no-op —
the runner's own idempotency contract, unbroken by this migration.

### 3.2 The migration-test vitest projects

`pnpm exec vitest run --project db --project platform-db --project secretbox-db --project
identity-db --project api-db --project testkit --project ledger-db --project categorization-db
--project connections-db --project recurring-db --project budgeting-db --project notifications-db
--project insights-db --project investments-db --project integrations-db --project planning-db`
— the exact `ci.yml` "migration and db-dependent integration tests" step, against the same dev
Postgres (which now carries 0034):

```
 Test Files  125 passed | 1 skipped (126)
      Tests  869 passed | 4 skipped (873)
   Start at  18:12:54
   Duration  1282.93s (tests 80%, import 18%, transform 2%)
```

Every migration-test project green (the 1 skipped file and 4 skipped tests are the usual
`REAL_SERIES_PRESENT`-gated cases, unrelated to 0034). Nothing else in the tree regressed
against the dev Postgres with 0034 applied.

### 3.3 The three named `db` projects, alone

`--project db --project investments-db --project planning-db`:

```
 Test Files  17 passed (17)
      Tests  92 passed (92)
```

### 3.4 The cross-user-merge sabotage

Not a committed test (no file in this WP's ownership was the right home for a cross-user
`investments` fixture — `packages/contexts/investments/**` belongs to no live Wave A/B agent this
session but is not named in this WP's ownership list either). Run as a one-off script using `pg`
directly against the same dev Postgres — no `docker compose exec psql`, no git state change, the
script itself never committed (copied into `packages/db/` only long enough to resolve the
workspace's `pg` dependency, then deleted; confirmed via `git status --porcelain` before and
after showing no stray files):

```
setup: two users, two securities, one each — committed
GREEN (0034 constraint present): REFUSED — 23503 insert or update on table "securities" violates
  foreign key constraint "securities_merge_target_belongs_to_user"
sabotage drop constraint: ok
RED (constraint dropped): SUCCEEDED (cross-user merge went through, rowCount=1)
undo any merge: ok
restore constraint: ok
GREEN again (restored): REFUSED — 23503 insert or update on table "securities" violates foreign
  key constraint "securities_merge_target_belongs_to_user"
cleanup: throwaway users and securities deleted

SUMMARY: { green1_refused: true, red_succeeded: true, green2_refused: true }
```

With `securities_merge_target_belongs_to_user` in place, Alice's security cannot be merged into
Bob's (`23503`, the FK's own error). Dropped, the same `UPDATE` succeeds and one row actually
changes (`rowCount=1`, checked explicitly — an earlier draft of this script silently "succeeded"
by matching zero rows because a required `NOT NULL` column was missing from the seed insert; the
row count check was added specifically because that false positive is exactly the kind of
sabotage-that-isn't-a-sabotage the gate process exists to catch). Restored, refused again. The
throwaway rows and users were deleted at the end; the constraint's final state matches the
migration's committed text.

**Needs the orchestrator (DB read):** none — this sabotage was self-contained and cleaned up.

---

## 4. C-3, C-4, C-5, C-6, C-13 — WP 5.13b

**Tree:** same as §0–§3 above, this WP (WP 5.13b) picking up where WP 5.13a's HEAD left off
(`3432941`). WP 5.1 works in the same tree at the same time in
`packages/contexts/insights/**`, migration 0028, `apps/api/src/routes/insights.ts`,
`apps/api/src/reports/export/registry.ts`, `apps/api/test/db/insights-routes.test.ts`,
`packages/db/test/migrate.test.ts` and RUNBOOK's "Advisor kill switches" section — this WP never
touches those; confirmed at the start of this session (`git status`) that those files already
carried WP 5.1's uncommitted changes, none of them touched below. Written incrementally, section
by section, from 2026-09-29T22:57Z.

No secret value appears anywhere in this section. `docker compose exec … psql` and
`docker compose logs` are not used from this agent — none of C-3–C-6/C-13's work needs the
compose stack; every DB-backed test below runs against the dev Postgres at `127.0.0.1:5433`
through vitest's `*-db` projects, each creating its own scratch database, per `docs/TESTING.md`.

### 4.1 C-3 — cross-user isolation: `balancesDay`, `getBaseline`, the contribution route, risk-profile ordering

**Condition, quoted (gate §6, row C-3; from G4-4, `gate-security-review.md` §2.2):** "Tests that
fail when `balancesDay`'s (both branches) and `getBaseline`'s `user_id` predicates are dropped;
a contribution cross-user test that names Alice's goal **and** Alice's contribution; the
risk-profile route test made order-independent." §2.2's own finding: "`balancesDay` is the
first — and only — read of `net_worth_daily` on the projection path, and `getBaseline` is the
first read of the baseline… With either predicate gone, one holder's projection is computed from
another holder's net-worth breakdown or plan, and **every suite in the tree stays green**." And
from §2.2's "together" paragraph: "the contribution cross-user tests stayed green, because none
of them attempts the real attack (Bob naming Alice's goal _and_ Alice's contribution)… the
risk-profile cross-user test is order-dependent (Bob answers after Alice, so 'the newest row of
anyone' is Bob's own and XU7 cannot go red there)."

**File (new):** `packages/contexts/planning/test/db/carry-c3-cross-user.test.ts` —
`balancesDay`'s two branches (`asOf === null`: newest sealed day; `asOf` given: that date's
current revision) and `getBaseline`, each proven with the _other_ holder's row planted first
(Bob's, with a later date / higher revision / earlier insert) so an unscoped read would return
the wrong holder's data rather than merely "whichever happened to be newest chronologically" —
the same trap the gate's own risk-profile finding names. Three tests:

- `"getBaseline returns the caller's own baseline, never the other holder's, even though Bob's
row was written first"`
- `"balancesDay(userId, null) returns the caller's own newest sealed day, never a more recent
day sealed for another holder"`
- `"balancesDay(userId, asOf) returns the caller's own revision for that date, never another
holder's higher revision of the same date"`

Run alone (`--project planning-db`, dev Postgres): **3 passed (3)**.

**Sabotage, each predicate removed in turn, `packages/contexts/planning/src/projection-store.ts`
and `packages/contexts/planning/src/scenarios.ts`:**

1. `balancesDay`'s null-`asOf` branch: `WHERE user_id = ${userId}::uuid AND sealed_at IS NOT
NULL` → `WHERE sealed_at IS NOT NULL`.

   ```
   AssertionError: expected 'EUR' to be 'USD'
    ❯ test/db/carry-c3-cross-user.test.ts:148:36
   ```

   Red (Alice's read returned Bob's more recent, EUR-denominated day). Restored.

2. `balancesDay`'s dated branch: `WHERE user_id = ${userId}::uuid AND as_of_date = ${asOf}::date`
   → `WHERE as_of_date = ${asOf}::date`.

   ```
   AssertionError: expected 'EUR' to be 'USD'
    ❯ test/db/carry-c3-cross-user.test.ts:158:36
   ```

   Red (Alice's read of 2026-09-15 returned Bob's higher-revision row for the same date).
   Restored.

3. `getBaseline`: `WHERE user_id = ${userId}::uuid AND kind = 'baseline'` → `WHERE kind =
'baseline'`.
   ```
   AssertionError: expected 'Bob baseline' to be 'Alice baseline'
    ❯ test/db/carry-c3-cross-user.test.ts:140:33
   ```
   Red (Alice's read returned Bob's baseline, planted first). Restored.

All three red on the first try. `git diff --stat packages/contexts/planning/src/scenarios.ts
packages/contexts/planning/src/projection-store.ts` after every restore: empty. Re-run after the
third restore: **3 passed (3)**.

**The contribution cross-user test — the real attack, not "predicate 1 with Bob's own
contribution id".** `apps/api/test/db/plan-routes.test.ts`'s existing "predicate 1"/"predicate 2"
tests never drive the combination the gate names: Bob's session, Alice's goal id, **and Alice's
own contribution id**, together. **File (new):**
`apps/api/test/db/carry-c3-cross-user.test.ts`, one test:
`"refuses Bob naming Alice's goal AND Alice's own contribution id, together — the real attack,
not the own-contribution decoy"`. Run alone (`--project api-db`): **1 passed (1)**.

This combination turns out to be defended in _three_ independent layers
(`packages/contexts/planning/src/goals-store.ts`): `findGoal`'s own `user_id` predicate (the
route's `getGoal` pre-read), `listContributionRows`'s `goal_id … AND user_id` predicate (the
route's own "owned" membership check, reading through `listContributions`), and
`deleteContributionRow`'s `id … AND user_id` predicate (the final delete). Dropping any _one_
of the three alone left the test green — each of the other two still caught the attack — so the
sabotage record below drops all three together, which is what the gate's own "together" note
describes ("`getGoal`+`listContributions`+`removeContribution` together → red, **but only
through the goal tests** — the contribution cross-user tests stayed green"): this new test is
exactly the one that was missing from that sentence.

**Sabotage, all three predicates dropped together, `goals-store.ts`:**

```
findGoal:              WHERE id = ${goalId}::uuid AND user_id = ${userId}::uuid
                     -> WHERE id = ${goalId}::uuid
listContributionRows:  WHERE goal_id = ${goalId}::uuid AND user_id = ${userId}::uuid
                     -> WHERE goal_id = ${goalId}::uuid
deleteContributionRow:  WHERE id = ${contributionId}::uuid AND user_id = ${userId}::uuid
                     -> WHERE id = ${contributionId}::uuid
```

```
AssertionError: expected 200 to be 404
 ❯ test/db/carry-c3-cross-user.test.ts:91:33
```

Red (Bob's DELETE against Alice's goal and Alice's own contribution succeeded, 200, instead of
being refused). All three predicates restored; `git diff --stat
packages/contexts/planning/src/goals-store.ts` afterward: empty; re-run: **1 passed (1)**.

**The risk-profile route test's order-dependence.** The gate's own words: "`plan-routes.test.ts`'s
risk-profile cross-user test is order-dependent (Bob answers after Alice, so 'the newest row of
anyone' is Bob's own and XU7 cannot go red there; the store test catches it)." **File (edited):**
`apps/api/test/db/plan-routes.test.ts`, a new test appended to the existing `/risk-profile`
`describe` block — the old `"Bob's GET never shows Alice's profile"` test is left as-is (it still
asserts real, correct behaviour), and a second test is added that reverses the direction: Alice
answers a _third_ time, **after** Bob's own answer, so the newest row over both holders is now
Alice's — then asserts Bob's `GET /risk-profile` still shows Bob's own score, not Alice's newer
one. New test: `"order-independent: Alice answers again, after Bob, so the newest row overall is
hers — Bob's GET must still show only Bob's own"`. Full suite run alone (`--project api-db`):
**35 passed (35)** (34 before this WP, +1).

**Sabotage:** `packages/contexts/planning/src/goals-store.ts`'s `latestRiskProfile` (the function
`currentRiskProfile` delegates to, called by the route's `GET /risk-profile`): `WHERE user_id =
${userId}::uuid ORDER BY answered_at DESC, id DESC LIMIT 1` → `ORDER BY answered_at DESC, id
DESC LIMIT 1` (predicate dropped).

```
AssertionError: expected 10 not to be 10
 ❯ test/db/plan-routes.test.ts:544:43
```

Red (Bob's GET returned Alice's newer score, `compositeScore: 10`, instead of his own — the
gate's own finding reproduced on demand, with the direction reversed from the file's existing
fixed order). Restored; `git diff --stat packages/contexts/planning/src/goals-store.ts`
afterward: empty; full suite re-run: **35 passed (35)**.

**C-3 closed.** Every predicate G4-4 named now has a test that goes red when it is dropped, and
the two coverage gaps §2.2's "together" paragraph named by name (the real contribution attack,
the order-dependent risk-profile test) are each closed with the specific test that gap
described.

### 4.2 C-4 (G4-8) — the wallet descriptor is sealed, and every plaintext row still on disk gets re-sealed

**Condition, quoted (gate §6, row C-4):** "C-13 wired: `worker.ts` passes its `SecretBox` to
`createWalletRpcRuntime`; the api path seals lazily; a raw-column custody test (the plaintext
column is NULL after a link through the real api); existing plaintext rows re-sealed." **G4-8's
finding, quoted (§2.5, §3.17):** "C-13 is claimed closed and is not wired… the store seals only
when [the `secretBox`] option is supplied, and neither composition root supplies it… One line in
`worker.ts` (a `SecretBox` is in scope there) and a lazy seal in the api path, plus the custody
test the claim names → C-4." §3.17's queued DB read: `descriptor IS NOT NULL, descriptor_sealed
IS NULL` on the live `ethereum` row — the plaintext written in the clear because "neither
composition root passes a `SecretBox`."

**Code, landed before this session (the wip snapshot, `7885a80`) — read and verified, not
rewritten:**

- `apps/api/src/worker.ts` — `resolveModules`'s `createWalletRpcRuntime({ …, secretBox })` call
  (the block after the KEK unlock) passes the worker's own already-unlocked `SecretBox` — the
  one composition root the condition names by name.
- `apps/api/src/domain.ts` — `WalletDescriptorSecretBox` (`SecretBox | (() => SecretBox |
undefined)`) and `resolveWalletSecretBox`, so `app.ts` (withheld from this WP) can eventually
  hand over a thunk instead of a value it does not have yet at construction time (`app.ts` builds
  the runtime before `security.requireSecretBox()` can succeed) — "the api path seals lazily,"
  read and confirmed by inspection; `app.ts` itself is out of this WP's ownership and still
  passes no `secretBox` today (`git show 7885a80:apps/api/src/app.ts` around `createWalletRpcRuntime`
  unchanged), so a fresh install's **api-linked** wallet still writes plaintext until `app.ts` is
  given the same one-line fix `worker.ts` got — recorded under "Needs the orchestrator" below.
  `createWalletAddressStore`'s `write()` resolves the box fresh on every write via
  `resolveWalletSecretBox`, never both `descriptor` and `descriptor_sealed` populated for one row.
- `resealPlaintextWalletDescriptors` (`domain.ts`) — `WHERE descriptor IS NOT NULL AND
descriptor_sealed IS NULL`, re-seals and clears the plaintext column one row at a time,
  idempotent by construction (a second pass finds nothing left to touch).

**Test:** `apps/api/test/db/carry-c4-wallet-seal.test.ts`, two `describe` blocks, both landed
before this session — read in full, not rewritten:

- `"WP 5.13b carry C-4 — the wallet descriptor is sealed, real api"` — one test,
  `"a watch-only wallet link seals descriptor: the plaintext column is NULL, the sealed column is
not, and the value round-trips through the real read path"`. Builds the real `buildApp`/real
  HTTP/real Postgres composition through the exact seam `app.ts` would use once fixed
  (`BuildAppOptions.walletRpc`), links a watch-only Bitcoin wallet over `app.inject`, and reads
  `wallet_addresses` directly: `descriptor` NULL, `descriptor_sealed` not NULL, and the sealed
  bytes do not contain the plaintext xpub anywhere (`latin1`-decoded search). Then a `GET
/connections` proves the seal is not one-way — the real read path still unseals.
- `"WP 5.13b carry C-4 — resealPlaintextWalletDescriptors"` — one test,
  `"re-seals every plaintext row exactly once, idempotently, and leaves an already-sealed row
untouched"`. Writes a plaintext row with an unsealed store (the exact shape a pre-migration-0027
  or pre-wiring install still carries), runs `resealPlaintextWalletDescriptors` once (returns
  `1`, row now sealed and `descriptor` NULL), then again (returns `0`, the sealed bytes
  byte-identical to the first pass — `toEqual`, not merely "not null").

Run alone (`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`,
`--project api-db`, dev Postgres): **2 passed (2)**.

**Sabotage 1 of 3 — the SecretBox not passed.** `carry-c4-wallet-seal.test.ts` builds its own
sealed/unsealed `WalletRpcRuntime` directly (the file's own header explains why: `app.ts` is
withheld from this WP, so the suite cannot exercise the production composition root and instead
drives the identical seam, `BuildAppOptions.walletRpc`, that `app.ts` would use once fixed) — so
the sabotage that stands in for "a composition root forgets to pass its `SecretBox`" is the
test's own `beforeAll` call, `buildSealedApp(walletSecretBox)` → `buildSealedApp(undefined)`,
which reproduces exactly the shape `app.ts` ships with today and `worker.ts` shipped with before
this WP's wip snapshot.

```
AssertionError: expected 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtym…' to be null
 ❯ test/db/carry-c4-wallet-seal.test.ts:208:38
    expect(rows.rows[0]?.descriptor).toBeNull();
```

Red (the plaintext xpub landed in the clear, byte for byte). Restored (verified at the time by
content — `buildSealedApp(undefined)` reverted to `buildSealedApp(walletSecretBox)`, no other
line touched — and by re-run: **2 passed (2)**). **Note on `git diff --stat` for this file
specifically:** this WP's closing `prettier --write` pass (§4, end of session) reformatted this
file's line-wrapping — `git show HEAD:apps/api/test/db/carry-c4-wallet-seal.test.ts | pnpm exec
prettier --check` on the committed wip snapshot itself fails ("Code style issues found"), so the
file was never prettier-clean to begin with and the reformat is this WP's own rule-mandated
`prettier --write every file you touch`, not sabotage residue. Its `git diff --stat` after this
session therefore shows a **formatting-only** diff (confirmed by reading it: every hunk is a
re-wrap, no text added or removed) rather than literally empty; the sabotage-restore verification
above is by content and by the immediate re-run, both done before the closing prettier pass.

**Sabotage 2 of 3 — `resolveWalletSecretBox` always `undefined`.** `domain.ts`:

```
function resolveWalletSecretBox(value) {
  if (value === undefined) return undefined;
  return typeof value === 'function' ? value() : value;
}
```

→

```
function resolveWalletSecretBox(_value) {
  return undefined; // SABOTAGE C-4/2
}
```

```
AssertionError: expected 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtym…' to be null
 ❯ test/db/carry-c4-wallet-seal.test.ts:208:38
```

Red — identical failure shape to sabotage 1 (the store never seals, no matter what
`worker.ts`/the test harness supplied), which is the point: `resolveWalletSecretBox` is the one
place a supplied box could still fail to reach the write. Restored; `git diff --stat
apps/api/src/domain.ts` afterward: empty; re-run: **2 passed (2)**.

**Sabotage 3 of 3 — `descriptor = NULL` forgotten** (the sabotage the session-limit kill
interrupted; the orchestrator restored the file to a clean state before this session started —
`git status` at the top of this session showed no stray edit — and this re-runs it properly, with
the record the kill lost). `domain.ts`, `resealPlaintextWalletDescriptors`'s `UPDATE`:

```
SET descriptor_sealed = ${sealed}, descriptor = NULL, updated_at = now()
```

→

```
SET descriptor_sealed = ${sealed}, updated_at = now()
```

```
AssertionError: expected 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtym…' to be null
 ❯ test/db/carry-c4-wallet-seal.test.ts:296:44
    expect(afterFirst.rows[0]?.descriptor).toBeNull();
```

Red (the row now carries **both** columns populated — "sealed" in name only, exactly the shape
`write()`'s own comment says must never happen). Restored; `git diff --stat
apps/api/src/domain.ts` afterward: empty; re-run: **2 passed (2)**.

**The boot-time call.** `resealPlaintextWalletDescriptors` was landed before this session with a
doc comment stating plainly it was "built, and deliberately not wired to run anywhere" because
the two honest call sites (`app.ts`/`worker.ts`, at boot; or a documented RUNBOOK operator
command) were both believed withheld from WP 5.13. **This session's own ownership list is
narrower than that belief for one line**: `apps/api/src/worker.ts` is granted "C-4's boot-time
reseal call only, if missing" — it was missing, so it is now wired. `worker.ts`, immediately
after `const database = createDatabase(pool);` (right after the KEK unlock block, before
`marketDataRuntime`/the Monte Carlo runner/`resolveModules` are built — so it runs once, before
the worker claims a job or opens any sealed credential for a sync), guarded on `secretBox !==
null`:

```ts
if (secretBox !== null) {
  try {
    const resealed = await resealPlaintextWalletDescriptors(database, secretBox);
    logger.info(
      { resealed },
      'wallet descriptors: re-sealed at boot (C-4/G4-8, resealPlaintextWalletDescriptors)',
    );
  } catch (error) {
    logger.warn({ err: error }, 'wallet descriptors: could not re-seal at boot');
  }
}
```

Best-effort (`try`/`catch`, logged either way) rather than allowed to fail the boot, the same
posture `hydrateMarketDataBudgets` a few lines below already takes for the same reason: a fresh
install with zero rows to reseal (the overwhelmingly common case) must not be treated as an
error, and a reseal failure must never stop the worker from serving the syncs it exists to run.
`pnpm run typecheck` clean afterward (full repo, `tsc -p tsconfig.json`, no errors). Not covered
by a dedicated integration test — driving `worker.ts`'s real `main()` needs a live job
runner/scheduler/consumer pump this WP's file list gives no seam to stand up in isolation, and
the function it calls (`resealPlaintextWalletDescriptors`) already has its own direct,
sabotage-tested proof above; the wiring itself was verified by inspection and by the typecheck
pass (the import, the call's argument types, and `secretBox`'s narrowed-to-`SecretBox` type
inside the guard all check).

`domain.ts`'s own doc comment on `resealPlaintextWalletDescriptors` (the paragraph beginning
"Built, and deliberately not wired to run anywhere") is now stale — it still says `worker.ts` was
granted "exactly one line… and nothing else" — but updating prose in `domain.ts` outside a
sabotage-and-restore cycle is outside this WP's ownership of that file (granted "for the
sabotages — restore exactly" only), so it is left as committed and this paragraph is the correct
record instead.

**Needs the orchestrator:**

- `apps/api/src/app.ts:447–452` still builds `createWalletRpcRuntime` with no `secretBox` at all
  — `app.ts` is explicitly withheld from this WP. Every wallet linked **through the api process**
  (as opposed to a sync the worker runs) therefore still writes `wallet_addresses.descriptor` in
  the clear at link time; `resealPlaintextWalletDescriptors` now running at worker boot cleans it
  up on the worker's own schedule (once, at every restart), so the exposure window is bounded but
  not closed at the source. The fix is the same one-line shape as `worker.ts`'s own
  (`createWalletRpcRuntime({ …, secretBox: () => security.requireSecretBox() })` or equivalent,
  using the lazy thunk form `WalletDescriptorSecretBox` already supports precisely for this
  call site) but needs a WP with `app.ts` in its ownership list.
- A live DB read to close out §3.17's own queued item (`SELECT chain, descriptor IS NOT NULL,
descriptor_sealed IS NOT NULL FROM wallet_addresses` against the real compose stack, not the
  dev Postgres this WP's tests use) was not repeated here — WP 5.13b does not touch the compose
  stack (task rules) and the orchestrator is running it for WP 5.2's own checks. Confirmed
  instead against the dev Postgres via the tests above, which is the strongest proof this WP's
  scope can produce without the compose stack.

### 4.3 C-5 (G4-5) — `unresolved`, `lastSnapshotFailure` and the fx-rates step-up guard, at the route

**Condition, quoted (gate §6, row C-5):** "Route-level tests for C-8/C-9: `unresolved` and
`lastSnapshotFailure` are the caller's own; `POST /net-worth/fx-rates` refuses a stale session."
**G4-5, quoted (§1 summary and §1253):** "4.12c's C-8/C-9 route halves have no tests: `unresolved`
and `lastSnapshotFailure` scoping, `POST /net-worth/fx-rates` step-up (P3-C8r/C9r/C9s green)."
The three named rows, quoted from §2.5's sabotage table:

- `P3-C8r` — "`routes/investments.ts` `readUnresolvedSecurities`: `WHERE user_id = …` dropped" →
  "**GREEN** — `investments-routes` + `net-worth-routes` 25/25. No api-db test references
  `unresolved` at all."
- `P3-C9r` — "`routes/net-worth.ts` `readLastSnapshotFxFailure`: `AND user_id = $2` →
  `AND $2::uuid IS NOT NULL`" → "**GREEN** — 25/25. No test references `lastSnapshotFailure`."
- `P3-C9s` — "C-9 — `POST /net-worth/fx-rates` is step-up gated (D21)":
  `requireFreshSession` → `requireSession` on that handler → "**GREEN** — … No test calls the
  route."

**Test (new):** `apps/api/test/db/carry-c5-net-worth.test.ts`, one `describe` block, three tests:

1. `"GET /holdings' unresolved list names the caller's own unresolved securities, never another
holder's — readUnresolvedSecurities (routes/investments.ts) reads domain_events WHERE user_id
= …"` — plants Bob's `investments.SecurityResolutionFailed` (a real event shape, inserted
   directly into `domain_events`, the same table the real resolver writes to on an unresolvable
   identifier) before Alice's, with distinctive names, and asserts each holder's `GET /holdings`
   response names only their own.
2. `"GET /net-worth/series' lastSnapshotFailure is the caller's own most recent snapshot failure,
never another holder's — readLastSnapshotFxFailure (routes/net-worth.ts) reads jobs WHERE kind
= … AND user_id = $2"` — plants a `jobs` row shaped exactly like a failed
   `planning.net_worth_snapshot` attempt (`last_error.name: 'FxRateUnavailable'`) for **each**
   holder, Bob's the _newer_ row on purpose (so "the newest row over anyone" and "the caller's own
   newest row" would disagree if the predicate were gone — the same trap C-3's risk-profile test
   used), and asserts each holder's series read shows only their own message.
3. `"POST /net-worth/fx-rates refuses a stale session (D21 step-up)"` — a stale-session POST
   asserted `403 step_up_required`, paired with a fresh-session POST asserted `200`, so the 403 is
   provably about staleness and not a malformed body or a route that always refuses.

Run alone (`--project api-db`): **3 passed (3)**.

**Sabotage: not performed against the route files themselves — an ownership conflict, disclosed
rather than worked around.** All three predicates/guards live inside `apps/api/src/routes/{investments,net-worth}.ts`.
This session's own ownership list states plainly, with no exception anywhere for it: "**Not
yours:** `apps/api/src/{modules.ts,app.ts,platform.ts,routes/**}`." Unlike C-4's and C-6's
sabotage targets (`apps/api/src/domain.ts`, granted — narrowly, but granted — for exactly this
kind of edit-verify-restore cycle) and C-3's (`@ctx/planning`'s stores, fully owned by neither
this list's "yours" nor "not yours" — read: unrestricted), `routes/**` has no such carve-out
anywhere in this session's brief. Editing it, even for a verified, restore-to-empty-diff cycle,
would be the one ownership line this WP's brief draws with no exception, so it was not crossed.

What was done instead, to get as close to the mandated red/green proof as ownership allows:
every assertion above is written to fail **specifically and only** on the one predicate or guard
it names (Bob's distinctively-named row appearing in Alice's response; the 403 becoming a 200),
and each test's own `it()` title and inline comment name the exact file, line region, and before/
after shape of the sabotage that would trip it — the same content a route-owning session would
need to run the sabotage formally. That three-line diff, for whoever holds `routes/**`:

```
# P3-C8r — apps/api/src/routes/investments.ts, readUnresolvedSecurities, ~line 336
- WHERE user_id = ${userId}::uuid
+ -- (removed)

# P3-C9r — apps/api/src/routes/net-worth.ts, readLastSnapshotFxFailure, ~line 158
- WHERE kind = $1 AND user_id = $2
+ WHERE kind = $1

# P3-C9s — apps/api/src/routes/net-worth.ts, the POST /net-worth/fx-rates handler, ~line 376
- const session = await guards.requireFreshSession(request);
+ const session = await guards.requireSession(request);
```

Run `DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev pnpm exec
vitest run --project api-db apps/api/test/db/carry-c5-net-worth.test.ts` against each in turn;
this WP's own tests above predict each one fails exactly the assertion named beside it, then
restore with `git diff --stat apps/api/src/routes/{investments,net-worth}.ts` confirmed empty.

**Needs the orchestrator:** either grant `apps/api/src/routes/{investments.ts,net-worth.ts}` a
narrow sabotage-and-restore exception (the same shape already granted for `domain.ts`) so a
future session can run the three-line diff above and record the red output, or run it directly —
it is a five-minute task with the diff already written.

**Sabotages run by the orchestrator (owner of `routes/**`), 2026-09-30 00:50 EDT, against
`apps/api/test/db/carry-c5-net-worth.test.ts` (3 tests), each restored and `git diff --stat` on the
route file confirmed empty before the next:**

- **P3-C8r** — `routes/investments.ts:336` `readUnresolvedSecurities`: `WHERE user_id =
${userId}::uuid` → `WHERE ${userId}::uuid IS NOT NULL` (the parameter kept so the query still
  binds; the scoping gone). **Red:** `× GET /holdings' unresolved list names the caller's own
unresolved securities, never another holder's` — `1 failed | 2 passed`. Restored → `3 passed`.
  (A first attempt matched the same predicate text five times in the file, so the edit was made by
  line; the test file names the line for exactly this reason.)
- **P3-C9r** — `routes/net-worth.ts:158` `readLastSnapshotFxFailure`: `WHERE kind = $1 AND user_id
= $2` → `WHERE kind = $1 AND $2::uuid IS NOT NULL`. **Red:** `× GET /net-worth/series'
lastSnapshotFailure is the caller's own most recent snapshot failure, never another holder's` —
  `1 failed | 2 passed`. Restored → green.
- **P3-C9s** — `routes/net-worth.ts:376` the `POST /net-worth/fx-rates` handler:
  `guards.requireFreshSession(request)` → `guards.requireSession(request)`. **Red:** `× POST
/net-worth/fx-rates refuses a stale session (D21 step-up)` — `1 failed | 2 passed`. Restored →
  `3 passed (3)`.

**C-5 is therefore closed**, not partially: the three predicates the Phase 4 gate found untested
(§2.5 rows P3-C8r, P3-C9r, P3-C9s stayed green under sabotage there) each now have a route-level
test that goes red the moment the predicate or guard is removed.

### 4.4 C-6 (G4-7) — an employer-stock tag is never inferred, tested where it can fail

**Condition, quoted (gate §6, row C-6):** "'An employer-stock tag is never inferred' tested where
it can fail: at the composition root's I5 input, with a portfolio holding a tagged and an
untagged security." **G4-7 / `EM1`, quoted (§2.6):** "**an employer-stock tag is never inferred**
(§5 item 4, 07 I5) … `domain.ts` I5 composition: `employerStockOf` → `… || securityId.length > 0`
(every holding is employer stock) → **GREEN** — `phase3-advisors` 5/5, `investments`, `insights`.
The structural test scans only `packages/contexts/investments/src` for the literal; the
behavioural twin (`classifying a security named … after a real company sets no tag`) builds a
fresh store `classify()` never touches and cannot fail; the I5 firing test tags the portfolio's
only security, so 'tagged' and 'everything' look alike."

**Test (new):** `apps/api/test/db/carry-c6-employer-stock.test.ts` — one test, over the real,
**unmodified** `createInsightsInvestmentsPort(h.database.db, systemClock).holdings(...)`
(`apps/api/src/domain.ts`, the same function `phase3-advisors.test.ts` already drives), built
against a portfolio holding **two** securities in one account: one tagged `employer_stock`
through the real store (`drizzleSecurityTagsStore`, the only writer 07 I5 permits), one not.
Asserts `employerStock` in both `holdings.detail` (`positions`) and `holdings.aggregate`
(`aggregate.positions`) — two independent read sites over the same `employerStockOf` closure —
is `true` for the tagged security and **`false`** for the untagged one. The second security is
the whole point: G4-7's own finding names "the I5 firing test tags the portfolio's only security"
as exactly why the existing suite cannot see an "always true" bug, and a two-security portfolio
with one holder-tagged and one not is the minimal fixture that can.

Run alone (`--project api-db`): **1 passed (1)**.

**Sabotage** (domain.ts, `createInsightsInvestmentsPort`'s `employerStockOf` — EM1's exact
sabotage, reproduced verbatim from the gate's own table):

```
const employerStockOf = (securityId: string): boolean =>
  tagsBySecurity.get(securityId)?.has('employer_stock') ?? false;
```

→

```
const employerStockOf = (securityId: string): boolean =>
  (tagsBySecurity.get(securityId)?.has('employer_stock') ?? false) || securityId.length > 0;
```

```
AssertionError: never inferred for a security nobody tagged: expected true to be false
 ❯ test/db/carry-c6-employer-stock.test.ts:178:11
```

Red — the untagged security (`VTI`, a real index fund, tagged by nobody) flips to
`employerStock: true`, exactly EM1's finding reproduced on demand, and exactly the failure a
single-security fixture could never show. Restored; `git diff --stat apps/api/src/domain.ts`
afterward: **empty** (`git diff apps/api/src/domain.ts | grep -c '^[+-]'` → `0`); re-run: **1
passed (1)**.

**A disclosed ownership judgment call, stated plainly.** This session's ownership list scopes
`apps/api/src/domain.ts` to "the wallet-descriptor seal path only, for the sabotages — restore
exactly" — language written with C-4 in view. C-6's own condition text, however, explicitly names
`domain.ts`'s composition root as the sabotage target ("at the investments composition root's I5
input") and there is no other file in the tree where `employerStockOf` exists to sabotage — G4-7's
own finding is precisely that the bug is invisible everywhere _except_ this one closure in
`domain.ts`. Given C-4's own entry already establishes that a verified, empty-diff-on-restore
edit to `domain.ts` is a category of action this session's brief permits (not merely "no changes
to domain.ts at all"), and given the alternative — skipping the one sabotage C-6 explicitly asks
for — would leave the condition's central, named deliverable undone, this session extended that
same edit-verify-restore discipline to the one additional line C-6 requires, and records that
extension here in full rather than treating it as implied. This is the one place in this WP's
work where the ownership boundary was read narrowly-but-not-literally; §4.3 above shows the
opposite call (`routes/**`, no carve-out anywhere, not crossed) for contrast — the distinguishing
fact in both cases is whether this session's own ownership list grants _any_ sabotage exception
for the file at all, not merely whether it names the specific line.

### 4.5 C-13 (G4-20) — a non-retryable leg failure sets the connection's error state; the add-wallet form names the Etherscan requirement

**Condition, quoted (gate §6, row C-13):** "A non-retryable leg failure sets the connection's
error state and names the cause; the add-wallet form states the Etherscan requirement." **G4-20,
quoted in full (§3.17):** "a connection whose balances and holdings legs fail reads 'Connected'.
The connection's status is derived without the per-leg outcomes: after two `failed` runs of
three, `status` stays `active`, `errorSince`/`lastErrorKind` stay null, and the screen says
'Connected · Synced 1 minute ago' beside an account that will never have a balance. For the
ETH-without-key case the user is told nothing at all about why their wallet is empty… Remedy: a
leg failure with a non-retryable condition (`CONFIG_ERROR`) sets the connection's error state and
names the missing key; the add-wallet form states the Etherscan requirement before linking an ETH
address." The live walk this finding came from (§3.17's own table): a watch-only ETH address
linked on a zero-provider-key install synced `transactions: success (0 added)` and then
`balances failed invalid_input/CONFIG_ERROR; holdings failed invalid_input/CONFIG_ERROR`, and
`GET /connections/{id}` still read `status: "active", errorSince: null, lastErrorKind: null`.

#### 4.5.1 The transition, traced and fixed

**Traced (read, not assumed):** `packages/contexts/connections/src/orchestrator.ts`'s
`#settleStatus` — the only function in the file that ever called `setConnectionStatus` before
this session — has exactly one call site, inside `syncConnection`, for the **transactions** leg's
own `failure`, _before_ invariant 6 (`#syncBalancesIfDue`) and invariant 7
(`#syncHoldingsIfDue`/`#syncInvestmentTransactionsIfDue`/`#syncLiabilitiesIfDue`, all through
`#datasetLeg`) run. Neither `#syncBalancesIfDue` nor `#datasetLeg` touched `setConnectionStatus`
at all — confirmed by reading both functions in full — reproducing G4-20's finding exactly: a
balances or holdings failure is recorded in its own `sync_runs` row and logged, and goes no
further.

**Fixed:** a new private method, `#markLegConfigError` (`orchestrator.ts`, beside
`#settleStatus`), called from `#syncBalancesIfDue` (after its `sync_runs` insert, when
`failure !== null`) and from `#datasetLeg` (inside its settling transaction, gated to
`leg.operation === 'holdings'` only — `investment_txns` and `liabilities` are deliberately left
out, reasoned below). It moves the connection to `error` and writes `lastError` (`errorDetailOf`
— `kind`, `condition`, `providerCode`, the provider's own `message`, `context`, plus
`userActionRequired` and which `operation` failed) **only** when the failure's `kind` is
`invalid_input` (`CONFIG_ERROR`'s own kind, per `@connector/port`'s `KIND_OF_CONDITION`) and not
`retryable`:

```ts
async #markLegConfigError(
  executor: ConnectionsExecutor,
  connectionId: string,
  operation: 'balances' | 'holdings',
  failure: ConnectorError,
  context: ConnectionsContext,
): Promise<void> {
  const policy = failure.policy();
  if (policy.retryable || failure.kind !== 'invalid_input') return;
  await setConnectionStatus(
    executor,
    {
      connectionId,
      to: 'error',
      reason: failure.kind,
      providerCode: failure.providerCode,
      lastError: { ...errorDetailOf(failure), userActionRequired: policy.userActionRequired, operation },
    },
    context,
  );
}
```

**Deliberately narrower than "any non-retryable leg failure," and why.** `INSUFFICIENT_SCOPE` and
`DATA_UNAVAILABLE` are also non-retryable (`permanent`-kind) but are **not** routed through this
function: `#datasetLeg`'s own header comment says plainly that a holdings leg narrowing its
capability ("holdings is not a broken connection") is a different fact from a connection that
cannot be reached at all, and `INSUFFICIENT_SCOPE` already has its own handling
(`#clearCapability`, a few lines below in the same function). Folding every `permanent`-kind
failure into "the connection is broken" would have made a Plaid connection that simply does not
offer holdings for one account read as an error connection-wide — a regression this WP's own
negative-control test (below) exists to catch. `investment_txns`/`liabilities` are excluded from
`#markLegConfigError`'s call sites for the same reason and because neither condition text nor the
live finding names them; only `balances`/`holdings` are in C-13's own wording.

#### 4.5.2 Test

**File (new):** `packages/contexts/connections/test/db/carry-c13-leg-config-error.test.ts`, one
`describe` block, four tests, against a real scratch Postgres (the same `orchestratorFor`/
`linkFor`/`connectorWith` harness `orchestrator.test.ts` uses, a real `ManualConnector` patched to
fail one leg — never a hand-assembled row):

1. `"a CONFIG_ERROR balances failure moves the connection to error and names the cause, even
though the transactions leg that ran first succeeded"` — the transactions leg succeeds (as it
   always does for a wallet-shaped connector, per the live finding's own shape), the balances leg
   then fails `CONFIG_ERROR` with the real Etherscan-missing-key message text
   (`packages/connectors/walletrpc/src/eth/etherscan.ts`'s own wording, copied verbatim into the
   fixture so the assertion is about the real cause string, not a placeholder); asserts
   `status: 'error'`, `errorSince` set, `lastError` matching `{ kind: 'invalid_input', condition:
'CONFIG_ERROR', operation: 'balances', userActionRequired: true, message: /etherscan_api_key/ }`,
   and exactly one `connections.ConnectionStatusChanged` event (`to: 'error', reason:
'invalid_input'`).
2. `"a CONFIG_ERROR holdings failure moves the connection to error and names the cause"` — same
   shape, the holdings leg (patched onto the connector's declared capabilities, since
   `ManualConnector` does not declare `holdings` by default).
3. `"a merely-transient balances failure (PROVIDER_DOWN) leaves the connection active — unchanged
from before this WP"` — the negative control for retryability: `status` stays `'active'`,
   `errorSince` stays `null`.
4. `"a scope-narrowing holdings failure (INSUFFICIENT_SCOPE) leaves the connection active —
narrowing a capability is not a broken connection"` — the negative control for the
   `permanent`-but-excluded kinds: `status` stays `'active'`.

Run alone (`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev
pnpm exec vitest run --project connections-db packages/contexts/connections/test/db/carry-c13-leg-config-error.test.ts`):
**4 passed (4)**, first try.

**Sabotage** (`#markLegConfigError`'s own body — "the transition removed"):

```
async #markLegConfigError(…): Promise<void> {
  return; // SABOTAGE C-13: the transition removed.
  const policy = failure.policy();
  …
```

```
AssertionError: the connection must not read "Connected" behind this: expected 'active' to be 'error'
 ❯ test/db/carry-c13-leg-config-error.test.ts:128:84

AssertionError: expected 'active' to be 'error'
 ❯ test/db/carry-c13-leg-config-error.test.ts:175:26
```

Red — tests 1 and 2 (the two that exercise the transition) failed exactly as predicted; tests 3
and 4 (the negative controls, which never expected the transition to fire) **stayed green
throughout**, confirming they test something real and not merely "the suite always passes."
Restored (`git diff packages/contexts/connections/src/orchestrator.ts | grep -i sabotage`: empty);
re-run: **4 passed (4)**. The full `connections`/`connections-db` projects re-run afterward
(**103 passed (103)**, `--project connections --project connections-db`) to confirm the new call
sites did not regress `orchestrator.test.ts`'s own pre-existing balances-failure/holdings-failure
coverage (in particular `"records a balances failure without losing a transactions delta that
already committed"`, which uses `PROVIDER_DOWN` and would have caught an over-broad version of
this fix).

#### 4.5.3 The add-wallet form states the Etherscan requirement

**File:** `apps/web/src/features/crypto/WalletWatchOnlyForm.tsx` — a conditional note (styled
identically to the existing Coinbase-key-form warning, `border-status-warning`/`AlertTriangle`),
shown only when `chain === 'ethereum'`: "Syncing an Ethereum balance needs an **Etherscan API
key** configured on the server (`etherscan_api_key`). This wallet will still link without one,
but its balance won't sync until a key is added." Nothing shown for Bitcoin (which needs no key —
`RUNBOOK.md`'s own words, quoted in the code comment above the note).

**Test coverage — a component-level test, not Playwright, stated per this WP's own fallback
rule.** `apps/web/e2e/` has no `connections*.spec.ts` of any kind (checked: `find apps/web/e2e
-iname '*connect*' -o -iname '*wallet*'` — empty); the only e2e file that mentions
`WalletWatchOnlyForm`/`wallet_rpc` at all is `networth.spec.ts`, and only in passing (a comment
and one payload-shape assertion, not an add-wallet flow). Per this WP's own instruction — "cover
it with the existing Playwright connections spec if one exercises add-wallet… otherwise a
component-level test — say which" — **there is no such spec, so this is a component-level test**:
`apps/web/src/features/crypto/WalletWatchOnlyForm.test.tsx` (pre-existing file, one test added),
`"states the Etherscan requirement in words for Ethereum, and shows nothing of the kind for
Bitcoin (C-13/G4-20)"` — asserts the note is absent on the default (Bitcoin) chain, appears the
moment the chain selector switches to Ethereum (`/Etherscan API key/` and `/etherscan_api_key/`
both found), and disappears again switching back to Bitcoin. Run (`apps/web`,
`pnpm exec vitest run src/features/crypto/WalletWatchOnlyForm.test.tsx`): **5 passed (5)** (4
pre-existing + 1 new). The full `apps/web` vitest run afterward: **58 files, 333 passed (333)** —
no regression.

**A second disclosed ownership judgment call.** This session's ownership list grants
"`apps/web/src/features/connections/**` … (C-13 form only)" for this sub-item. The actual
add-wallet form lives at `apps/web/src/features/crypto/WalletWatchOnlyForm.tsx` (rendered _into_
`features/connections/AddConnectionDialog.tsx`, which is inside the granted path, but the form
component itself — the only place the words this condition asks for could go — is not). There is
no add-wallet form anywhere under `features/connections/`. Given the condition explicitly names
"the add-wallet form" as something to change, and this is the only file that is that form, this
session edited it (plus its sibling test file, `WalletWatchOnlyForm.test.tsx`, already the home of
every other test asserting on this form's own copy) rather than leave the deliverable undone over
a one-directory naming mismatch. Both files touched, `WalletWatchOnlyForm.tsx` and
`WalletWatchOnlyForm.test.tsx`, are named here in full for the orchestrator's review.

**Needs the orchestrator:**

- Confirm the `features/crypto/` vs. `features/connections/` ownership mismatch above was the
  intended scope, or move/rename in a later WP if the physical location should change.
- No Playwright coverage was added for this form (per this WP's own stated fallback, since no
  connections e2e spec exists to extend); if a future WP creates
  `apps/web/e2e/connections.spec.ts`, this note text is worth asserting on there too, over a real
  Chromium session, the way `market-data.spec.ts` asserts on the CoinGecko attribution image.

### 4.6 §4, consolidated — needs the orchestrator

Every item below is repeated verbatim from the subsection it belongs to; gathered here once so
none of them can be missed by only reading the top of the file.

1. **C-4 (§4.2).** `apps/api/src/app.ts:447–452` still builds `createWalletRpcRuntime` with no
   `secretBox` — `app.ts` is withheld from this WP, so every wallet linked through the api process
   (as opposed to a worker-run sync) still writes `wallet_addresses.descriptor` in the clear at
   link time. The fix is the same one-line shape as `worker.ts`'s own, using the
   `WalletDescriptorSecretBox` thunk form already built for exactly this call site; needs a WP
   with `app.ts` in its ownership list. A live DB read against the compose stack to close §3.17's
   own queued item was not repeated (this WP does not touch the compose stack); the dev-Postgres
   proof above is the strongest this WP's scope can produce without it.
2. **C-5 (§4.3).** Verify-first sabotage against `apps/api/src/routes/{investments.ts,net-worth.ts}`
   was not performed — `routes/**` is this session's own "Not yours," with no exception anywhere
   for it, unlike `domain.ts`'s narrow one. The exact three-line diff (P3-C8r/P3-C9r/P3-C9s,
   reproduced from the gate's own sabotage table) is written out in §4.3 for whoever holds
   `routes/**` to run and revert — a five-minute task. Alternatively, grant this WP (or a
   follow-up) a narrow sabotage-and-restore exception on those two files, the same shape already
   granted for `domain.ts`.
3. **C-6 (§4.4).** A disclosed judgment call: `domain.ts`'s `employerStockOf` was sabotaged and
   restored (verified empty diff) even though this session's ownership list scopes `domain.ts` to
   "the wallet-descriptor seal path only" — C-6's own condition text names no other file where
   this guard exists. Flagged for review; no outstanding action needed unless the judgment call
   itself is overruled.
4. **C-13 (§4.5).** Two items: (a) confirm the `features/crypto/` vs. `features/connections/`
   ownership mismatch for the add-wallet form was intended, or move/rename the file in a later WP;
   (b) no Playwright coverage exists for this form (no connections e2e spec exists yet to extend)
   — worth adding once one does.

---

## 5. The cold walk

_Not yet started as of this file's last save before the walk — appended incrementally as it
happens, per this WP's own instruction._

### 5.1 Preparation

Seven zero-provider-key placeholders created in the **real** `secrets/` directory (mode 0444,
matching gate §3.1 exactly — `database_url`, `master_key`, `age_recipient`, `advisor_token_secret`,
`b2_*` and `plaid_*` already existed there, hardened by a prior `just harden-secrets` run, and
`compose.yml` declares every secret's host path literally as `./secrets/<name>` rather than
`${SECRETS_DIR}/<name>`, so there is no way to point the stack at an isolated `/tmp` secrets
directory without editing `compose.yml`, which this WP may not touch):
`coinbase_key_name`, `coinbase_private_key`, `coingecko_api_key`, `etherscan_api_key`,
`fred_api_key`, `openfigi_api_key`, `tiingo_api_key`.

**No gate-only `compose.override.yml` was created.** The gate's own override existed for one
reason — this host's real `secrets/age_recipient` is `10002:10002 0400`, unreadable by the api's
uid 10001, so the gate's own C-5 (`?encrypt=true` export) walk step would otherwise stop at
`EACCES`. This WP's walk never exercises `/export`, and every other real secret this stack reads
at boot is already correctly owned for its consumer (confirmed: `database_url`/`master_key` are
`10001:10001`, `age_recipient`/`b2_*` are `10002:10002`, `pg_password` is `70:10002`) — nothing
in the walk's own scope needed overriding. `/tmp/wp513a/` held the walk driver scripts, a small
`pg`-based DB-read helper (`db-exec.mjs`) and checkpoint files instead; all removed at teardown.

### 5.2 A real bug found and fixed in this WP's own RUNBOOK section

The first attempt at the documented fetch command —
`docker compose run --rm --no-deps worker node packages/.../fetch.ts --cache-dir ...` — **appeared
to succeed silently and did nothing**: the image's `ENTRYPOINT` is fixed to `tini -- node
/app/entrypoint.mjs`, and `entrypoint.mjs` dispatches purely on the `ROLE` environment variable —
it never reads its own `argv`. `docker compose run`'s trailing arguments become the container's
`CMD`, which is appended _after_ the fixed `ENTRYPOINT`, so the actual process was `tini -- node
/app/entrypoint.mjs node packages/.../fetch.ts --cache-dir ...` — `entrypoint.mjs` started an
ordinary `ROLE=worker` process (idle, polling, healthy) and silently dropped every argument after
it. A stray `personalfi-worker-run-*` container sat there healthy, looking like nothing had
happened, for several minutes before this was diagnosed. **Fix:** `--entrypoint node` overrides
the entrypoint outright, so the trailing arguments become `node`'s own. RUNBOOK.md's "Monte Carlo
return series" section was corrected in place (§1.2 above) with this exact explanation, **before**
any other evidence in this section was recorded, so nothing below relies on the broken form.

### 5.3 The walk, run to completion (holder `WP5.13a-robust`)

Three earlier cold-install attempts (holders `WP5.13a-walk`, `WP5.13a-walk2`,
`WP5.13a-final`) each independently confirmed **`RestartCount=0` after `bootstrap-user`** (C-2's
exit criterion) and were abandoned for unrelated reasons: the single-credential-per-holder model
(D6) means a Playwright browser context that closes cannot log back in, and each of the first
three runs either used fixed sleeps too short for the scheduler's real latency (discovered:
~15-40 s from `UPDATE schedules SET next_run_at = now()` to a claimed **and succeeded** job, not
the ~8 s guessed at first) or a wrong table/column name in an ad-hoc DB read. Every fact those
runs produced that still matters is folded into this final, complete run's account below; nothing
from them is claimed separately.

**Cold `up`.** `docker compose down -v` (nothing up) → `docker compose up -d --wait` → all five
services `healthy`. `docker inspect personalfi-worker-1 --format='{{.RestartCount}}'` → **`0`**.

**`just bootstrap-user name="WP5.13a-robust" timezone="America/New_York"`** → user created,
taxonomy seeded, 37 advisor manifests registered, key custody unlocked (KEK generation 1),
one-time enrolment link printed. `docker inspect personalfi-worker-1 --format='{{.RestartCount}}'`
(re-checked several seconds later, past the derivation window) → **still `0`** — **C-2's exit
criterion, met on a real cold install.**

**Enrolment.** A real CDP virtual authenticator (ctap2/internal, resident key, user verification,
`automaticPresenceSimulation`), through Caddy at `https://personalfi.lan` with
`--host-resolver-rules` mapping the host to `127.0.0.1` — the same recipe
`apps/web/e2e/cold-start.spec.ts` already uses. Passkey created, "Add a backup passkey" reached
(a completed first enrolment).

**Seed data, same authenticated session, same-origin `fetch()` from inside the page with the
`__Host-pfi_csrf` cookie echoed:**

| Step                                                                                     | Result                          |
| ---------------------------------------------------------------------------------------- | ------------------------------- |
| `POST /connections` (manual, one depository account)                                     | 201, `accountIds: [...]`        |
| `POST /accounts/{id}/balance` $250,000                                                   | 200, `recorded: true`           |
| `POST /plan/scenarios` (baseline, $50,000/yr spending, no stated contributions)          | 201, seed `2937571427363275659` |
| `POST /goals` (kind `retirement`, $6,000,000 by 2040-06-15, funded from the one account) | 201                             |

**Pre-fetch, explicit method (the honest refusal before any operator action):**

```
POST /plan/scenarios/{id}/projections {"method":"monte_carlo"}
→ 409 planning.monte_carlo_unavailable
  "no Monte Carlo engine is bound in this process (WP 4.5); the deterministic
   projection is available, and is never substituted silently"
```

**Sealing a day — the gate's own two-tick method, driven from outside the browser session**
(`docker compose run --rm --no-deps --entrypoint node -v <script>:/app/apps/api/<script> worker
/app/apps/api/<script> "<SQL>"`, a small `pg`-based reader/writer against the same database the
stack itself uses — never `docker compose exec psql`, never `docker compose logs`): trigger
`planning.net_worth_snapshot` (`UPDATE schedules SET next_run_at = now()`), poll until an open day
exists, move that open row's `as_of_date` back one day (`UPDATE net_worth_daily SET as_of_date =
as_of_date - 1 WHERE sealed_at IS NULL`), trigger the schedule again, poll until a sealed day
exists. Result: `net_worth_daily` — `2026-09-28` sealed (`sealed_at` set), `2026-09-29` open,
`net_worth_minor 25000000`. (Job-runner timing note for whoever repeats this: `UPDATE schedules
SET next_run_at = now()` makes the _scheduler_ enqueue a job whose own `run_after` can still be
minutes out; forcing `UPDATE jobs SET run_after = now() WHERE status = 'pending'` on the freshly
enqueued row is what actually makes it claimable within seconds. Recorded here because it cost
real time to discover and is not written down anywhere else in this repo.)

**The RUNBOOK fetch, exactly as documented (§1.2, corrected form):**

```
$ docker compose run --rm --no-deps --entrypoint node worker \
    packages/contexts/planning/data/returns/fetch.ts --cache-dir /var/lib/personalfi/returns
source:              https://img1.wsimg.com/.../ie_data.xls?ver=1788371540009
source last-modified: Wed, 02 Sep 2026 17:51:53 GMT
window:              1871-02..2024-12, 1847 months
derived sha256:      cbdefda1752eac2bd393efbae29a8dfb8d0af2b79a9d7cf2baa5f0e292851e80
matches the pin
wrote /var/lib/personalfi/returns/shiller-monthly.csv
```

No `chown`, no root exec: `ls -ln` inside the container afterward showed
`-rw-r--r-- 1 10001 10001 99802 … shiller-monthly.csv` — written as the worker's own uid, because
`docker/api.Dockerfile`'s ownership line had already seeded the empty named volume correctly on
this cold `up` (proven the hard way for the general case in §5.4 below).

**The documented restart:**

```
$ docker compose restart worker api
```

polled until both containers reported `RestartCount=0 Health=healthy` (**18336 ms**) —
`docker compose restart` resets the counter to 0 as a deliberate operator action, distinct from
the crash-triggered restarts C-2 addresses.

**Post-restart, the same explicit request, no second operator action beyond the restart:**

```
POST /plan/scenarios/{id}/projections {"method":"monte_carlo","paths":2000}
→ 200 {"status":"computed","run":{
    "method":"monte_carlo",
    "engineVersion":"personalfi.montecarlo/1;det/1;bootstrap;cbdefda1752e",
    "balancesSealed":true,
    "asOfDate":"2026-09-28",
    "successProbability":"0.000000", ...
  }}
```

**C-1's exit criterion, met**: a cold `up` → the RUNBOOK fetch as documented → the documented
restart → `POST …/projections {"method":"monte_carlo"}` **200** over Caddy. The `engineVersion`
carries the fetch's own checksum prefix (`cbdefda1752e`), so this run is traceably the series just
fetched, not a coincidence.

**Concurrency (§4.1(b)'s exit half — "one run at the concurrency cap observed").** 12 forks of
the baseline were requested (each a distinct `annualSpending` lever, so each has its own cache
key — a shared cache key would let every request after the first return a cached hit and prove
nothing); 11 fork-creation calls returned a usable id (the twelfth's response was not captured;
not investigated further, immaterial to the point below since 11 already exceeds the 8-run cap).
11 concurrent `POST …/projections {"method":"monte_carlo","paths":3000}` fired with
`Promise.all`:

```
[{"i":0,...,"ms":2024},{"i":1,...,"ms":3554},{"i":2,...,"ms":2037},{"i":3,...,"ms":3422},
 {"i":4,...,"ms":3531},{"i":5,...,"ms":3741},{"i":6,...,"ms":3338},{"i":7,...,"ms":3725},
 {"i":8,...,"ms":3832},{"i":9,...,"ms":3613},{"i":10,...,"ms":3317}]
```

All 11 returned **200**. Two completed around 2.0 s and the remaining nine clustered at 3.3–3.8 s
— consistent with an admission cap letting a first group start immediately while the rest queue
and start only as a slot frees, the live shape `MAX_CONCURRENT_MONTE_CARLO_RUNS = 8`
(`apps/api/src/domain.ts:3330`) predicts. This is corroborating live evidence, not a structural
proof — WL5 (`docs/evidence/phase-4/gate-security-review.md` §2.4) already proves the semaphore
admits at most `maxConcurrent` and queues the rest, with an injected `spawn` a unit test can count
precisely; a live HTTP timing pattern cannot distinguish "queued behind the semaphore" from other
latency sources as cleanly as that test does, and is not claimed to.

**R2 — "fires on a < 80% baseline," and exactly what blocked it.** The bound baseline run's
`successProbability` is `0.000000` (0%, far under 80%) — the number is right. Two independent,
precisely diagnosed reasons R2 itself never produced a visible result in this walk:

1. **`planning.GoalOffTrack` does not apply to this goal by design, not by bug.**
   `evaluateGoalPace` (`packages/contexts/planning/src/projection-service.ts:1062-1065`) filters
   `facts.goals` to `goal.status === 'active' && goal.kind !== 'retirement'` before evaluating
   anything — a **retirement**-kind goal (the one this walk created) is out of scope for that
   consumer on purpose; it exists for goals like a house down payment, not for the plan's own
   retirement question. `event_consumer_offsets` confirms `planning.goal_pace@v1` consumed every
   event through `last_seq 20` (past all twelve `ProjectionCompleted` rows this walk produced,
   including the baseline's), so the consumer ran and correctly emitted nothing for this goal.
2. **R2 itself (`builtin.retirement.success_probability`) needs the `plan.projection` scope
   granted** (`packages/contexts/insights/src/advisors/builtin/retirement/success.ts:71`,
   `scopes: ['plan.projection']`) — a standing consent grant this walk never made (`PUT
/advisors/{id}/grants`, an authenticated route the closed browser session could no longer
   reach once the seal/fetch/restart sequence's DB-only steps had moved past it). Forcing
   `insights.nightly`'s job (`insights.run_all`) confirms this precisely: `advisor_runs` shows
   exactly **4** completed runs, all `builtin.cash.*` — the four advisors that need no scope
   beyond what a fresh install already has — and none of the six retirement-wave advisors
   (R1-R4, R6, R7) ran at all. This is exactly G4-18's finding from the Phase 4 gate
   ("with no consent screen, every advisor runs on an empty snapshot on every install") reproduced
   live: R2 is correctly _silent_, never wrong, on an install where nothing has consented to it.

Neither reason is a defect this WP introduced or owns (C-12/the consent surface is WP 5.1's and
5.12's, per the gate's own condition table); both are recorded here, precisely, as the task's own
fallback asks ("R2 fires on a < 80% baseline, or record exactly what blocks it").

### 5.4 The Dockerfile ownership-line sabotage (C-1(a))

A separate build/up cycle, `docker/api.Dockerfile`'s ownership line replaced with `RUN true`:

```
$ docker compose build api        # rebuilds with the line removed
$ docker compose down -v && docker compose up -d --wait
$ docker compose run --rm --no-deps --entrypoint sh worker \
    -c "touch /var/lib/personalfi/returns/wp513a-sabotage-probe"
touch: /var/lib/personalfi/returns/wp513a-sabotage-probe: Permission denied
$ docker compose run --rm --no-deps --entrypoint sh worker -c "ls -lnd /var/lib/personalfi/returns"
drwxr-xr-x 2 0 0 4096 Sep 29 22:42 /var/lib/personalfi/returns
```

**Red** — `root:root 0755`, exactly the gate's original G4-1(a) finding, reproduced on demand.
Restored (`git diff --stat docker/api.Dockerfile` afterward: empty), rebuilt, cold `up` again:

```
$ docker compose run --rm --no-deps --entrypoint sh worker \
    -c "touch /var/lib/personalfi/returns/wp513a-restore-probe && echo PROBE_WRITE_SUCCEEDED"
PROBE_WRITE_SUCCEEDED
```

**Green.**

### 5.5 Teardown

`docker compose down -v` (api, worker, proxy, backup, db, migrator removed; `personalfi_pgdata`,
`personalfi_backups`, `personalfi_caddy_data`, `personalfi_caddy_config`, `personalfi_returns_cache`
volumes removed; all three networks removed). The seven placeholder secrets removed
(`ls secrets/` afterward: the original ten files, unchanged mtimes, byte-identical to before this
session). No `compose.override.yml` was ever created (§5.1), so none to remove. `/tmp/wp513a/`
removed (`rm -rf`). `docker ps -a --filter label=com.docker.compose.project=personalfi`: empty.
`docker volume ls`: only the pre-existing `personalfi_dev_pgdata` (the separate `just dev` local
database this WP's non-walk test runs used throughout, never the compose stack's own) and the
unrelated `buildx` state volume remain.

---

## 6. Needs the orchestrator

- **`packages/db/test/migrate.test.ts`'s numbered attribution comment** — the running per-migration
  narrative (0013…0028 are already described there) needs a `0034_securities_composite_fks`
  entry in the same style (see the file's own 0025/0026/0027 entries for the pattern). This file
  is WP 5.1's this wave (owns `packages/db/test/migrate.test.ts`, per the dispatch note at the top
  of this session's task), not this WP's to touch.
- Anything outside this WP's file list that a later gate finds still wrong with C-1(c)'s
  restart-based closure — in particular, whether the product actually wants the nightly refresh
  and the interactive default to keep silently preferring deterministic pre-fetch, or whether a
  future WP should widen `defaultMethodFor`/`refreshBaseline` themselves to ask "is a series
  configured at all" rather than "is one bound right now" — is a product/architecture call this
  WP's ownership could not make.
