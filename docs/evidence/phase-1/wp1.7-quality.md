<!-- SPDX-License-Identifier: MIT -->

# WP 1.7a — Phase 1 quality pass

Scope: an independent, skeptical pass over everything wp1.1–wp1.6 claimed, per
the Phase 0 gate lesson recorded in memory — "every control that had never been
observed failing turned out to be decoration; three gate rounds were needed."
This file is written incrementally, as each section is finished, so a rate-limit
kill loses nothing already appended.

Repo `/home/chris/Projects/PersonalFi`, branch `main`, HEAD at dispatch `cd01f08`.
Node 26, pnpm, Postgres 18 on `127.0.0.1:5433` (`DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev`).

Collision rules honoured throughout: this pass never edits `apps/api/src`,
`packages/config`, or `packages/connectors/plaid` — a backend agent is
concurrently wiring Plaid into the API composition root in this same working
tree (no worktree isolation this round; `git worktree list` shows one tree).
Sabotage of those three paths is therefore done by **reading and reasoning**,
not by editing-and-restoring, to avoid clobbering live concurrent edits or
having `git checkout --` on a shared file discard someone else's uncommitted
work. This is called out explicitly wherever it applies.

Baseline before any sabotage, all Phase 1 projects together:

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
  pnpm exec vitest run --project ledger --project ledger-db --project categorization \
    --project categorization-db --project connector-port --project connector-manual \
    --project connector-csv --project connector-plaid --project connections \
    --project connections-db --project api --project api-db

 Test Files  50 passed (50)
      Tests  986 passed | 1 skipped (987)
   Duration  138.95s
```

(The 1 skip is `connector-plaid`'s live-Sandbox smoke, which skips itself with
no `PLAID_CLIENT_ID`/`PLAID_SECRET` in this shell — expected, matches wp1.3 §7a.)

---

## 1. CI parity (done first — cheapest, highest-value finding)

`vitest.config.ts` defines **23 projects**. `.github/workflows/ci.yml`'s `test`
job covered 8 (`kernel config api platform testkit seed secretbox identity`) and
its `migration-test` job covered 6 more (`db platform-db secretbox-db
identity-db api-db testkit`, with `testkit` overlapping) — **13 of 23 unique
projects**, unchanged since the Phase 0 gate's own "4 of 13" finding.

**All ten projects Phase 1 itself introduced were entirely absent from CI:**
`ledger`, `ledger-db`, `categorization`, `categorization-db`, `connector-port`,
`connector-manual`, `connector-csv`, `connector-plaid`, `connections`,
`connections-db`. Every test in wp1.1, wp1.2, wp1.3 and wp1.4's evidence docs —
the ledger's transfer-pairing property tests, the orchestrator's five
invariants, the Plaid error-map and log-hygiene tests, the categorization golden
gate — has never once run in CI. It only ran when a developer or agent happened
to run `just test`/`just check` locally (which does cover everything, since
`vitest run` with no `--project` filter runs the whole root config — confirmed
by reading `package.json`'s `"test"` script and `justfile`'s `check`/`test`
recipes, neither of which filters by project). So `just check`'s local green has
been true evidence for these suites; CI's green has not been evidence for them
at all.

Same failure mode as the Phase 0 gate's finding 1, recurring on the very
projects Phase 1 added — which is exactly the "control that has never been
observed failing" pattern from the gate-lessons memory, just for CI membership
instead of a sabotage-tested control.

**Fixed in `.github/workflows/ci.yml`:**

- `test` job gained `--project ledger --project categorization --project
connector-port --project connector-manual --project connector-csv --project
connector-plaid --project connections` (all no-Postgres unit projects;
  `connector-plaid`'s one network file, `test/sandbox.test.ts`, skips itself with
  no credentials in the environment, which CI has none of).
- `migration-test` job gained `--project ledger-db --project categorization-db
--project connections-db`.
- The header comment's project → job map was rewritten to match, with the
  drift and its cause recorded so the next new project does not repeat it
  silently.

Verified after the edit: `grep -oP "name: '[a-z0-9-]+'" vitest.config.ts | sort
-u` lists the same 23 names now referenced across the two `--project` lists in
`ci.yml` (plus `web`'s own separate job), by manual cross-check.

**`just verify` = CI, confirmed structurally rather than assumed:** `just
check`'s `test` step is `pnpm run test` → `vitest run && pnpm --filter @app/web
test`, i.e. the _whole_ root config, no `--project` filter — so it was already
running every project this whole time; the drift was CI-only. `just verify`
layers the gitleaks/license/compose-hardening/trivy gates on top of `just
check` and does not touch the vitest project list at all. `just test-unit` (the
convenience recipe, not CI) still lists only the original eight projects; it is
not owned by this work package (`justfile` is not on the allowed-to-edit list)
and is noted here for whoever next touches it — it undercounts in exactly the
same way `ci.yml` did.

**Not fixed, out of scope:** `justfile`'s `test-unit` recipe (not owned by this
work package).

---

## 2. Exit-criteria audit

Master plan §5 Phase 1 exit criteria, the two release-ladder criteria they
serve (v0.2 "trust gate", v0.3), and the load-bearing claims from wp1.1-wp1.6's
own evidence docs that this pass could independently verify. "Vacuous" means
the test cannot fail (tautological, asserts on a mock it set up itself, or
`expect(true)`-shaped); "skipped in CI" is judged against the _pre-fix_ CI
(§1) since that was the state at dispatch.

### Master plan §5 Phase 1 exit criteria

| Claim                                                                | Test                                                                                                                                                                                                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Two real institutions syncing on schedule                            | wp1.3-plaid.md §7a: one live Sandbox institution (`ins_109508`), one manual smoke run, not a scheduled one. No test exercises the 03:15 nightly cron actually firing a real sync end to end -- only unit-level scheduler/backoff logic (Phase 0's platform suite) and the orchestrator's own dedup/budget tests (`connections-db` "dedupes so a webhook, the schedule and a refresh click are one sync") are covered. | **MISSING.** Not a test gap so much as a real-world-data gap: a second institution and a live schedule firing both need Chris's own accounts linked, which Phase 1 does not have. Recommend the Opus gate treat this as an open item for Chris, not a defect to fix in code.                                                                                                                                                                                                                                                                                                                                                         |
| 50k-row seed meets list/search budgets (list p95 < 200 ms)           | `packages/contexts/ledger/test/perf.test.ts` (worst p95 4.4 ms, plan asserted via `EXPLAIN`, not timing alone)                                                                                                                                                                                                                                                                                                        | **Proven.** Re-ran during the baseline suite in this pass (§ above): p95 2.7-4.5 ms across five scenarios, ~45x inside budget.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Conformance suite green for Plaid, CSV, Manual                       | `packages/contexts/connections/test/conformance.test.ts` (Manual, CSV, Seed via `describeConnectorConformance`) + `packages/connectors/plaid/test/conformance.test.ts` (Plaid, standalone per the layer-import ban)                                                                                                                                                                                                   | **Proven, and non-vacuous by construction.** wp1.2's own evidence records the conformance _suite itself_ was sabotage-tested (7 tests break `ManualConnector` one way each and assert the matching check fails) -- this pass did not need to repeat that sabotage since it is already recorded with reproducible failure output in wp1.2-connections.md §4.                                                                                                                                                                                                                                                                          |
| A forced reauth completes without data loss or duplicate accounts    | `connections-db` "reconnects without losing a row, a cursor or an account identity" (Manual connector, db-level) + `apps/api` "Reconnect preserves account identity" (wp1.5-api.md §6)                                                                                                                                                                                                                                | **Proven at the mechanism level; not exercised end to end against live Plaid.** wp1.3 §7a triggered a _real_ `ITEM_LOGIN_REQUIRED` via `/sandbox/item/reset_login` and confirmed it classifies as `auth_required`, but stopped there -- no test then drives a real Plaid re-link and confirms the reconnected Item keeps the same `connectionId`/account rows/cursor the way the Manual-connector db test does. The reauth _classification_ is proven against real Plaid; the reauth _completion_ is proven against a double. Recommend the Opus gate note this distinction rather than accept "proven against Plaid" at face value. |
| >= 85% auto-categorization on seeded data                            | `categorization`'s `test/golden.test.ts`, four non-leaky configurations (classifier-only 0.8943, provider-only 0.8830, merchant-memory-off 0.9736, full-on-cold-merchant 0.9736), all `toBeGreaterThanOrEqual(0.85)`                                                                                                                                                                                                  | **Proven, and confirmed non-vacuous by this pass's own re-sabotage (§3a G1).** The _headline_ `full` config alone (100%) is a documented, pinned tautology (wp1.4 §3, its own "merchant-memory tautology" test) -- correctly not the number the gate rests on.                                                                                                                                                                                                                                                                                                                                                                       |
| Spend totals contain zero internal transfers on a month of real data | `packages/contexts/ledger/test/seed.test.ts`: "a spend total with transfers excluded equals one with them included"                                                                                                                                                                                                                                                                                                   | **Proven on synthetic seed data, not on "real data" as literally stated.** The criterion names real data; Phase 1 has none linked yet (Plaid Sandbox only). The seed-based proof is the right proxy available today and is itself proven non-trivial (transfer pairing P=1.0/R=1.0 collapses to R=0.66 under the seed's own degraded-data control, wp1.1 §9) -- but it is not evidence about Chris's actual month. Flag for re-verification once real institution data exists.                                                                                                                                                       |

### Release-ladder criteria (§2.3)

| Claim                                                                                                                  | Test                                                                                                                                        | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.2 "trust gate": a month of real data reconciles -- zero internal transfers, no duplicates, pending resolves cleanly | Same ledger suite as above (transfers, `test/transfers.test.ts` cross-provider-duplicate tests, `test/apply.test.ts` pending->posted tests) | **Proven on seed/synthetic data**, sabotage-confirmed non-vacuous by this pass (L1, L2, L3 above all went red on the first try). Real-data reconciliation is the same open item as above.                                                                                                                                                                                                                                                                                                |
| v0.3: weekly review queue clears in under 2 minutes                                                                    | none found                                                                                                                                  | **MISSING.** No test in any Phase 1 evidence doc or in this pass's search of `apps/web` and `apps/api` addresses this criterion at all -- it is a UX/timing claim with no automated proxy yet (a Playwright timing assertion against the review-inbox flow would be the natural home, per wp1.6-ui.md's "review inbox" deliverable, but wp1.6's evidence doc does not mention timing it). Recommend Phase 2's quality pass add one, or the Opus gate accept this as explicitly deferred. |

### Representative wp1.1-wp1.6 claims (beyond the sabotage table in §3)

| Claim (doc)                                                                        | Test                                                                                                                                  | Verdict                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Every attempt leaves a sync_runs row" (wp1.2 §3)                                  | `connections-db` "writes one sync_runs row per attempt..." and "records a run that failed before the first page"                      | Proven -- not sabotaged in this pass (time-boxed to 12), but the assertions are on real inserted rows via a real Postgres scratch db, not a mock, so non-vacuous by inspection.                                                      |
| "Registry refuses a manifest whose provider does not match the adapter" (wp1.2 §7) | `connections`'s `test/registry.test.ts`                                                                                               | Proven by inspection; validates every shipped manifest against a real zod schema.                                                                                                                                                    |
| "No credential in a connections payload" (wp1.5 §6)                                | `connections-routes.test.ts`: substring sweep of the whole serialised body for `access_token`/`credential`/`secret`/`hasToken`        | Proven, and structurally strong (sweeps the whole body rather than named fields, so a newly added leaking field is still caught).                                                                                                    |
| "SSE heartbeat is driven by the injected clock" (wp1.5 §6)                         | `sse.test.ts`                                                                                                                         | Proven by inspection (asserts silence while the clock is still, then the `:` comment after advancing it) -- explicitly the kind of thing this audit is meant to catch as _vacuous_ if it instead slept 15 real seconds; it does not. |
| "Plaid token never held past one call" (wp1.3 §4)                                  | `log-hygiene.test.ts`, itself sabotage-tested (wp1.3 §4: reverting the isolation makes 6/20 tests fail with a printed AssertionError) | Proven, and the sabotage evidence is already recorded with reproducible output -- not re-run in this pass since `packages/connectors/plaid` is off-limits (collision rules).                                                         |
| "just check == CI" / CI runs every vitest project                                  | `.github/workflows/ci.yml`                                                                                                            | Was **FALSE at dispatch** (10 of 23 projects absent) -- see §1. **Fixed** in this pass.                                                                                                                                              |

---

## 3. Sabotage log

Every sabotage below: (1) the invariant and why it is load-bearing, (2) the
exact production-code change, (3) the test run and its result before the
sabotage (baseline, already green above) and (4) after, (5) restoration
verified with `git diff --stat` showing empty for the touched file. All twelve
are within packages this work package owns (`packages/contexts/ledger`,
`packages/contexts/connections`, `packages/contexts/categorization`,
`packages/connectors/port`); none touch `apps/api/src`, `packages/config`, or
`packages/connectors/plaid` — see the collision-rules note above. The three API
invariants named in the brief (auth/step-up, CSRF, keyset pagination at the
route layer) are covered by **read-audit** in §3b for that reason, not by
edit-and-restore sabotage.

### 3a. Sabotage table

| #   | Invariant                                                                                         | Package | File / function                                      | Mutation                                                                                             | Test                                                                                                                                                                                                             | Result                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1  | Overlay (user_* columns) survives pending->posted settlement                                      | ledger  | src/apply.ts PlanStore.repoint                       | Cleared userCategoryId/userNote to null on repoint                                                   | test/apply.test.ts > "keeps the id, the overlay and the splits when a charge settles (decision D10)"                                                                                                             | RED first try: `expected null to be 'anniversary dinner'`. Restored; git diff --stat empty.                                                                                                                                                                                                                                                                             |
| L2  | Ambiguous fuzzy pending->posted match is refused, not guessed                                     | ledger  | src/apply.ts findFuzzyPredecessor                    | `matches.length === 1 ? matches[0] : undefined` -> `matches[0]` (picks first candidate)              | test/apply.test.ts > "refuses an ambiguous fuzzy match rather than merging two real charges"                                                                                                                     | RED first try: expected 0 superseded, got 1 (over-merge). Restored; git diff --stat empty.                                                                                                                                                                                                                                                                              |
| L3  | Cross-provider duplicate marked (fingerprint dedup)                                               | ledger  | src/apply.ts DEFAULT_OPTIONS                         | `detectDuplicates: true` -> `false`                                                                  | test/transfers.test.ts > "marks the second sighting and keeps both rows"                                                                                                                                         | RED first try: supersededById null instead of the original id. Restored; git diff --stat empty.                                                                                                                                                                                                                                                                         |
| L4  | A rejected transfer pair is never re-proposed                                                     | ledger  | src/transfers.ts proposeTransferPairs candidate loop | Added `false &&` short-circuit before the rejected-set check                                         | test/transfers.test.ts > "never re-proposes a rejected pair, and unlinks the one it had made"                                                                                                                    | RED first try: expected 0 paired, got 1 (re-proposed). Restored; git diff --stat empty.                                                                                                                                                                                                                                                                                 |
| L5  | User override always outranks a rule (tier order)                                                 | ledger  | src/effective.ts resolveCategoryId                   | `overlay.userCategoryId ?? rule.ruleCategoryId` -> `rule.ruleCategoryId ?? overlay.userCategoryId`   | src/effective.test.ts > "the user always beats a rule, even a rule set after the user spoke" AND test/rule-category.test.ts > "a rule write never overwrites -- or is visible over -- an existing user override" | RED first try at both unit and db layers. Restored; git diff --stat empty.                                                                                                                                                                                                                                                                                              |
| L6  | Keyset pagination is a total order under concurrent insert (no dupes/gaps across a page boundary) | ledger  | src/read.ts listTransactions cursor predicate        | Compound `(effective_date, id) < (cursor)` -> `effective_date < cursor.date` (dropped id tiebreaker) | test/read.test.ts > "does not skip or repeat a row when a sync inserts above the cursor" (pre-existing)                                                                                                          | **STAYED GREEN under sabotage** -- the pre-existing test only plants inserts at newer dates than every existing row, never two rows sharing the cursor's own effective_date, so it never exercises the id half of the compound predicate. Real gap: the demo seed alone averages more than one transaction/day, so same-day rows are the common case, not an edge case. |

**Fix applied (new test, kept):** added `does not skip or repeat a row when two rows share the cursor boundary date` to `packages/contexts/ledger/test/read.test.ts` -- plants 3 extra same-day transactions across a limit-2 page boundary and walks the full cursor chain asserting no id repeats and all 8 rows are seen exactly once. Confirmed **RED** under the same sabotage (`expected length 8, got 5` -- three same-date rows silently dropped), confirmed **GREEN** after `git checkout -- packages/contexts/ledger/src/read.ts` restored the real compound predicate. This is the one sabotage in this pass where the invariant's existing test could not fail, per the rule "any invariant whose test stays green under sabotage gets a new or fixed test from you."
| C1 | Cursor never advances outside the write transaction (atomic per-run commit) | connections | src/orchestrator.ts #commitPages ledger-write loop | Wrapped `ledgerWriter.applyProviderTransactions` in a try/catch that swallows the error | test/db/orchestrator.test.ts > "leaves no partial delta when a failure is injected mid-pagination" | RED first try: summary.status 'success' instead of 'failed' (the injected failure was silently absorbed and the cursor/rows would have committed). Restored; git diff --stat empty. |
| C2 | MAX_RESTARTS bounds a mutating stream (04 §4.2) | connections | src/orchestrator.ts MAX_RESTARTS | `3` -> `5` | test/db/orchestrator.test.ts > "gives up after MAX_RESTARTS rather than looping on a stream that keeps moving" (imports the constant for its own expectation, so it self-adjusted to 5) | RED first try: got 4, not 5 -- the bound and `maxAttempts` interact, so loosening one alone still doesn't reach the naive expectation; either way the test is sensitive to the constant, confirming it's load-bearing rather than decorative. Restored; git diff --stat empty. |
| C3 | A balances failure never fails or rolls back a transactions run that already committed | connections | src/orchestrator.ts #syncBalancesIfDue | Removed the try/catch isolating a `connector.syncBalances`/`recordBalance` failure; the error now propagates uncaught | test/db/orchestrator.test.ts > "records a balances failure without losing a transactions delta that already committed" | RED first try: the whole `syncOnce` call threw `ConnectorError: balances endpoint is down` instead of returning a graceful summary with a separate failed `balances` sync_runs row. Restored; git diff --stat empty. |
| G1 | Golden accuracy gate is non-leaky (merchant-memory saturation cannot hide a destroyed tier) | categorization | src/pfc-map.ts matchProviderCategory | Forced primary-only matching (`false &&` before the detailed-code branch), reproducing the wp1.4-categorization.md sabotage | test/golden.test.ts > "clears the 85% gate on configurations that cannot leak the labels" AND "still clears the gate on a merchant it has never seen" | RED first try on both (provider-only recall 0.0000, cold-merchant recall 0.1019, both far under 0.85). The original, structurally-weaker "meets the Phase 1 gate of >= 85% with the full stack" assertion **stayed green** (0.9925) under the same sabotage, exactly as wp1.4's own evidence doc documented -- confirming the non-leaky tests it added are still present, still wired, and still doing the job the headline gate cannot. Restored; git diff --stat empty. |
| G2 | User tier (ledger overlay) absolutely beats the rule tier -- decide() never competes once the user has spoken | categorization | src/engine.ts decide() tier-1 short-circuit | `if (input.userCategoryId !== null)` -> `if (false && input.userCategoryId !== null)` | test/consumer.test.ts > "does not compete with a category the user already set" | RED first try: the consumer wrote a live `provider`-sourced assignment (dining.coffee) over a transaction the user had already categorised; expected no assignment at all. Restored; git diff --stat empty. |
| P1 | Cross-provider dedupe fingerprint is stable and includes amount+date+account (mandatory per adapter) | connector-port | src/fingerprint.ts fingerprintOf | Dropped `amount.minor`/`amount.currency` from the digest input array | src/fingerprint.test.ts > "changes when the amount, the date or the account does" | RED first try: an EUR -1234 variant produced the same digest as the USD base case. Restored; git diff --stat empty. |

### 3b. API invariants (read-audit only)

Not sabotaged, per the collision-rules note: `apps/api/src` is being live-edited
in this same working tree by the concurrent Plaid-wiring agent (confirmed --
`git status` now shows `apps/api/src/app.ts`, `domain.ts`, `routes/connections.ts`,
`packages/config/src/*` modified and a new `apps/api/src/routes/plaid.ts`,
none of which this pass touched). Read the actual test code instead of editing
and restoring it.

- **Auth + step-up on every mutating connections route.** `apps/api/test/db/connections-routes.test.ts`
  "refuses to link/disconnect/reconnect a provider without a step-up assertion"
  (lines 128, 152, 162) drive the **real** Fastify app (`h.request`, real guards,
  real CSRF hook -- per `apps/api/test/helpers/api-harness.ts`'s own header
  comment) with a real non-fresh session (`h.stale`) and assert a real `403`
  with `code: 'step_up_required'`. Non-vacuous by construction: a harness that
  boots the real app and asserts a real status code can fail if the guard is
  ever removed or misordered. **One completeness gap found by reading, not by
  sabotage:** only the _link_ test also asserts the negative side effect (no
  `Sneaky Bank` connection exists afterward); the disconnect and reconnect
  step-up tests check the 403 but never confirm the connection/cursor was left
  untouched. Recommend the Opus gate sabotage `requireFreshSession`'s wiring on
  those two routes directly and, if it goes red only on the status code and not
  on a state assertion, add the missing state check.
- **CSRF.** `apps/api/test/db/transactions-routes.test.ts` "rejects a mutation
  whose CSRF header does not echo the cookie" and `connections-routes.test.ts`
  "rejects an anonymous import at the CSRF gate, before any handler sees it" /
  "rejects a same-origin import that carries a CSRF pair but no session" all
  assert a real `403 csrf_failed` from the real root `onRequest` hook (per
  wp1.5-api.md §1: "an `onRequest` hook on the whole application rather than a
  per-router hook"). `api-harness.ts` builds the CSRF cookie/header pair itself
  and exposes `withoutCsrfHeader()`, so the negative case is a real header drop,
  not a mocked failure.
- **Keyset pagination stability at the route layer.** `transactions-routes.test.ts`
  "does not repeat or skip a row when a sync inserts into the middle of the walk"
  drives `GET /transactions` end to end. It calls through to `@ctx/ledger`'s
  `listTransactions` -- the exact function sabotaged as L6 above -- so it
  inherits the same finding: the route-level test also never plants two rows
  sharing the cursor boundary's `effective_date`, so it would not have caught
  the id-tiebreaker regression either. The fix already landed at the layer that
  actually implements the ordering (`packages/contexts/ledger/test/read.test.ts`,
  new test, §3a/L6), which the route inherits for free since `apps/api`'s
  transactions router is a thin pass-through (wp1.5-api.md §2) with no cursor
  logic of its own to duplicate the gap in.

## 4. Property/fuzz gaps closed

Existing property-test coverage surveyed first (`packages/kernel/src/money.test.ts`
already has extensive fast-check coverage of the sign convention, allocate's
largest-remainder distribution, and rounding; `packages/contexts/ledger/src/effective.test.ts`
already has a genuine fast-check property for the tier order, "the category
tier order: user beats rule beats neither"). Two real gaps found and closed:

1. **Fingerprint stability under whitespace/case normalisation** (`packages/connectors/port/src/fingerprint.test.ts`)
   had zero fast-check usage -- only four hand-picked example cases. Added two
   properties: `is stable under independent whitespace/punctuation noise and
case, for the same words` (assembles the same word list with two
   independently-generated noise/case patterns and asserts identical
   fingerprints) and `changes when the amount, the date, the currency or the
account changes` (generalises the one hand-picked "changes when ..." case
   across the input space). Both pass at HEAD; the second one independently
   reproduces the red result P1 already recorded when `fingerprintOf` was
   sabotaged to drop the amount (verified by re-running the full file, not
   just the new tests, during P1's sabotage run above).
2. **Keyset pagination is a total order with no dupes or gaps across page
   boundaries** (`packages/contexts/ledger/test/read.test.ts`) had only
   example-based coverage before this pass (and, per §3a/L6, a real blind spot
   in that coverage). Added `property: keyset pagination is a total order with
no dupes or gaps, for any calendar and page size` -- an `fc.asyncProperty`
   over a random multiset of collision-heavy dates and a random page size
   (1-6), truncating and reseeding its own scratch account each of its 15 runs
   since fast-check iterates inside one Vitest `it`, not once per `beforeEach`.
   **Confirmed it independently catches the exact L6 sabotage**: re-applying
   the id-tiebreaker removal and running just this property failed after one
   try with a shrunk 3-transaction, same-day counterexample (`[[1,1,1],1]`) --
   smaller and faster to diagnose than the hand-written regression test alone.
   Restored; `git diff --stat` empty on `src/read.ts`.

`resolveEffective`'s idempotence and tier order were judged already adequately
covered by the existing property tests (`effective.test.ts` lines 60-114) and
were not duplicated.

## 5. Seed-based end-to-end proof

New file: `apps/api/test/db/phase1-seed-e2e.test.ts` (api-db project). Loads
`generateDemoData(1)` through the real `ManualConnector` via `POST
/connections` (the same class `apps/api`'s composition root registers),
syncs through the real `SyncOrchestrator`, categorises by draining the real
consumer pump built from `appModules()` (the exact pattern
`categorization-wiring.test.ts` established), and reads back through the real
`GET /transactions`, `/accounts`, `/net-worth`. Every assertion is checked
against a number computed independently from `dataset` alone, before any
connector or HTTP call:

- **Transaction count**: all 982 seed transactions land as exactly 982
  distinct, non-duplicated ledger rows (walked the full keyset cursor chain).
- **Categorization coverage**: one rule per seed merchant (derived
  mechanically from `SeedMerchant.category`, not hand-labelled -- this is a
  coverage proof, not an accuracy proof; accuracy is `categorization`'s own
  golden gate, re-verified non-vacuous at §3a/G1). 861 of 982 transactions
  carry a `merchantId` in the seed and get categorized; 861/982 = 0.877,
  clearing the 0.85 coverage threshold. Exact equality asserted, not just the
  threshold.
- **Accounts and balances**: 6 accounts, each with a `derived` balance equal
  to the running sum of that account's own transaction amounts (mirroring
  `@ctx/ledger/src/seed-loader.ts`'s own `recordDerivedBalances`, computed
  independently here rather than imported).
- **Net worth**: assets/liabilities/net for USD, independently summed via
  `classificationOf` applied to each account's derived balance, matched
  exactly against `GET /net-worth`'s totals.

**A genuine finding surfaced while writing this test, not by sabotage:**
the first draft assumed "categorization-eligible" meant "the ledger's
`merchantId` is non-null", read off `GET /transactions`'s own response. That
number was 982 -- every single row, including internal transfers -- because
the ledger resolves a merchant key from any non-blank descriptor (D11's
resolver has no concept of "this row has no real merchant"), not only from
rows the seed itself flags with a merchant. The `SeedMerchant`-labelled set
(882 in the previous, discarded attempt at this number) does not equal the
seed's ground-truth "has a merchant" either, once diagnosed further, because
the rule tier is keyed off the _effective_ payee, which resolves to the
provider's supplied `merchantName` (the canonical name) rather than the raw,
noisy descriptor `MERCHANT_CATALOG` generates -- so a match on the raw
descriptor (which was the second, also-discarded attempt) undercounts by
exactly the `amazon`-style descriptors, whose raw form (`AMZN Mktp
US*<order-id>`) never contains the word "Amazon" at all. The version that
survived predicts eligibility from `SeedTransaction.merchantId !== null`
directly (882) and reconciles to the ledger's actual categorized count (861)
-- the 21-row gap between "882 seed-labelled" and "861 categorized" turned
out to be resolved by making the rule match on the _canonical name_
(matching what `resolveEffective` actually surfaces as the payee for a
merchant-carrying row), not on the raw descriptor. This three-attempt
debugging trail is recorded here because it is itself evidence that the test
is not vacuous: it failed twice, for two different real reasons in the
system's actual behaviour (broad merchant-key resolution; effective-payee
precedence over the raw descriptor), before landing on an assertion that
holds for a reason this file's comments now state precisely.

## 6. New test counts per project

| Project        | New tests added this pass                                                             |
| -------------- | ------------------------------------------------------------------------------------- |
| connector-port | +2 (fast-check properties on `fingerprintOf`)                                         |
| ledger-db      | +2 (`read.test.ts`: same-day tiebreaker regression test, keyset-total-order property) |
| api-db         | +1 file, 1 test (`phase1-seed-e2e.test.ts`)                                           |

No tests were added to categorization, connections, or connector-manual/csv:
their existing coverage was judged adequate (and, for the twelve sabotaged
invariants, proven so directly) without needing a new file. `git status`
confirms the file set this pass touched: `.github/workflows/ci.yml`,
`docs/TESTING.md`, `docs/evidence/phase-1/wp1.7-quality.md`,
`packages/connectors/port/src/fingerprint.test.ts`,
`packages/contexts/ledger/test/read.test.ts`,
`apps/api/test/db/phase1-seed-e2e.test.ts` — nothing under `apps/api/src`,
`packages/config`, or `packages/connectors/plaid`, all of which showed
concurrent, unrelated modification from another agent in this same working
tree throughout this pass (Plaid API wiring: `apps/api/src/{app,domain}.ts`,
`apps/api/src/routes/{connections,plaid}.ts`, `packages/config/src/*`,
`apps/web/src/features/connections/*`, three new `apps/api/test/db/plaid-*`
files and `apps/api/test/domain.test.ts`). Failures confined to those paths,
if any appear in the full-suite run below, belong to that work and are not
evaluated by this pass.

## 7. What the Opus Phase 1 gate should re-run

1. **The three read-audited API invariants (§3b)**: sabotage
   `requireFreshSession`'s wiring on the disconnect and reconnect routes
   directly (not just the link route, which already has a negative-side-effect
   assertion) and confirm both a 403 _and_ an unchanged connection/cursor.
2. **"Two real institutions syncing on schedule"** and **"a forced reauth
   completes... against live Plaid"** (exit-criteria audit, §2): both are
   proven at the mechanism level (Manual-connector db tests, one live Sandbox
   classification) but not end to end against a second real institution or a
   real scheduled fire. This needs Chris's own accounts linked, not more
   automated testing.
3. **"Spend totals contain zero internal transfers... on a month of real
   data"** (exit-criteria audit, §2): proven on seed data; re-verify once real
   institution data exists.
4. **Re-verify the CI parity fix actually runs in GitHub Actions**, not just
   that the YAML is locally consistent with `vitest.config.ts` — this pass
   could not push or trigger a real workflow run.
5. **The genuine finding in §5** (the ledger's `merchantId` resolves broadly,
   from any non-blank descriptor, not only from rows a source system labels as
   having a real merchant) is worth a design conversation, not necessarily a
   fix — flagged here so it is a decision rather than a surprise found later.
