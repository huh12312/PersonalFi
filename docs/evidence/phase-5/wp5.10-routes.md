<!-- SPDX-License-Identifier: MIT -->

# WP 5.10 — REST surface

Written against `main` while W-C wiring and WP 5.4 (red-team corpus) are in flight in the same tree, on
disjoint files. This WP's dependencies — 5.1 (run control), 5.6 (the Brief), 5.9 (rule health) — were
already landed at the time this package started (evidence files `wp5.1-run-control.md`, `wp5.6-brief.md`,
`wp5.9-feedback.md` present under `docs/evidence/phase-5/`); 5.8 (health score) had not, exactly as the
dispatch anticipated ("WP 5.8 is Wave E: implement the route to return 404 ... and note it").

## 0. Log

Written incrementally as the work happened, per the phase rule.

| When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | What                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read `05-phase-5-dispatch.md` §3 WP 5.10 in full, §4 item 8 (shared files), §5 item 8 (cross-user sabotage), and the backends this WP exposes (`wp5.1-run-control.md` §13, `wp5.6-brief.md`, `wp5.9-feedback.md`, `wp5.3-narrator.md` §4).                                                                                                                                                                                                                                                     | —                                                                                                                                                                                                                   |
| Read the mirror routes (`insights.ts`, `advisor-grants.ts`) and the shared route infra (`deps.ts`, `app.ts`, `problem.ts`, `wire.ts`).                                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                   |
| **Found while reading**: `@ctx/insights`'s barrel (`src/index.ts`) does not export `brief/store.ts`'s `findBriefByWeek`/`listBriefItems` or `brief/iso-week.ts`'s `isoWeekOf`/`isIsoWeek`, nor `store.ts`'s `startRun`/`finishRun`. `package.json`'s `exports` map (`"."` only) makes a deep import a compile error under `moduleResolution: "nodenext"`. Recorded under §7 below rather than worked around by editing `packages/contexts/insights/src/index.ts` (out of this WP's ownership). | Design decision below.                                                                                                                                                                                              |
| Wrote `apps/api/src/routes/brief.ts` and `apps/api/src/routes/advisor-runs.ts`; registered both in `app.ts`.                                                                                                                                                                                                                                                                                                                                                                                   | `pnpm run typecheck` clean (one pre-existing red in `apps/api/test/phase3-registration.test.ts`, W-C wiring's in-flight file — not this WP's).                                                                      |
| Wrote `apps/api/test/db/brief-routes.test.ts` (10 tests) and `apps/api/test/db/advisor-runs-routes.test.ts`.                                                                                                                                                                                                                                                                                                                                                                                   | brief-routes: 10/10 passed on first green run after one CHECK-constraint fixture fix (`horizon: 'ongoing'` is not a published horizon — `'this_period'` is).                                                        |
| First run of `advisor-runs-routes.test.ts`: 4 of 18 red.                                                                                                                                                                                                                                                                                                                                                                                                                                       | See §4.1 — each a real finding, none a flaky test; all four diagnosed, fixed (three in the test's own fixtures, one — the CHECK-constraint 500 on a `local_model` approval — in the route itself) and re-run green. |
| `just openapi`; `cd apps/web && pnpm run gen && pnpm run gen:check`; `node scripts/check-proxy-routes.ts`.                                                                                                                                                                                                                                                                                                                                                                                     | See §5.                                                                                                                                                                                                             |
| Edited RUNBOOK's "Advisor kill switches" — only the SQL-as-interim lines for levels 2 and 4, per the dispatch's explicit carve-out.                                                                                                                                                                                                                                                                                                                                                            | §6.                                                                                                                                                                                                                 |
| Sabotage matrix (§4.2): `loadBrief`'s `userId` predicate and `loadItems`'s `briefId` predicate, each commented out, the affected test re-run and observed red, the line restored, `git status`/a scoped green re-run confirming the restore.                                                                                                                                                                                                                                                   | §4.2.                                                                                                                                                                                                               |
| Posted this report; ran final verification (§8).                                                                                                                                                                                                                                                                                                                                                                                                                                               | §8.                                                                                                                                                                                                                 |

## 1. Route table

Every route under the existing `/insights` and `/advisors` prefixes — `docker/Caddyfile` needed no edit
(§5).

| Route                                   | Auth        | Scoping predicate(s)                                                                                                                                           | Notes                                                                                                                         |
| --------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /insights/brief/current`           | session     | `advisoryBriefs.userId = caller`, ordered `iso_week DESC LIMIT 1`                                                                                              | "Current" = latest published week, not today's ISO week (see §3).                                                             |
| `GET /insights/brief/{isoWeek}`         | session     | `advisoryBriefs.userId = caller AND isoWeek = :isoWeek`; items: `advisoryBriefItems.userId = caller AND briefId = :briefId`                                    | Two predicates each; §4.                                                                                                      |
| `GET /insights/health-score`            | session     | —                                                                                                                                                              | Always 404 `insights.health_score_not_computed` — WP 5.8 has not landed.                                                      |
| `GET /advisors/{id}/runs`               | session     | `advisors.userId = caller AND advisorId = :id` (existence check) then `advisorRuns.userId = caller AND advisorId = :id` (`latestRuns`, WP 5.1)                 |                                                                                                                               |
| `GET /advisors/runs/{runId}`            | session     | `advisorRuns.userId = caller AND id = :runId` (`findRun`, WP 5.1); payload: `advisorRunPayloads.userId = caller AND runId = :runId` (`findRunPayload`, WP 5.1) | `digestVerified` recomputed server-side from the retained bytes, never trusted (§4).                                          |
| `POST /advisors/runs/{runId}/cancel`    | **step-up** | `advisorRuns.userId = caller AND id = :runId AND status = 'started'`, then `advisors` row lock by `(caller, run.advisorId)` (`requestRunCancel`, WP 5.1)       | 404 not-the-caller's-run; 409 `insights.run_not_in_flight` already finished.                                                  |
| `GET /advisors/{id}/payload-preview`    | session     | `dependencies.registry` built from `listAdvisors(caller)` only (§3)                                                                                            | Sends nothing to any model (§4).                                                                                              |
| `POST /advisors/{id}/payload-approvals` | **step-up** | Same registry scoping; `approvePayload` takes the `advisors` row lock by `(caller, advisorId)`                                                                 | Refuses `insights.payload_shape_changed` if the shape moved since the preview.                                                |
| `PUT /advisors/kinds/{kind}/enabled`    | **step-up** | `feature_flags` keyed `(user_id, key)`, `key = 'advisors.kind.' + kind`                                                                                        | Only a kind with a declared flag (`ADVISOR_KIND_FLAGS`, today `local_model` alone) — else 404 `insights.kind_flag_not_found`. |
| `GET /advisors/rule-health`             | session     | `ruleHealth(caller)` — every join inside it is `WHERE user_id = caller` (WP 5.9)                                                                               |                                                                                                                               |

Money is `{ "minor": "…", "currency": "USD" }` everywhere (`moneySchema`/`Money.toJSON`'s own shape,
unchanged by this WP); a Brief item's months-of-spending is `z.string()` on the wire (`brief.ts`'s
`monthsOfSpendingSchema`), never a JSON number — proved in §4.

## 2. Files by path

**New:**

- `apps/api/src/routes/brief.ts`
- `apps/api/src/routes/advisor-runs.ts`
- `apps/api/test/db/brief-routes.test.ts`
- `apps/api/test/db/advisor-runs-routes.test.ts`
- `docs/evidence/phase-5/wp5.10-routes.md` (this file)

**Edited:**

- `apps/api/src/app.ts` — two import lines, two `app.register(...)` lines, a comment. No other change.
- `RUNBOOK.md` — "Advisor kill switches": levels 2 and 4's SQL-as-interim lines only (§6).
- `packages/contracts/openapi/openapi.json` — regenerated (§5).

**Unchanged, confirmed:**

- `apps/api/src/routes/deps.ts` — nothing this WP's routes need was missing from `RouteDeps`
  (`database`, `pool`, `clock`, `config`, `guards` covered every route).
- `docker/Caddyfile`, `compose.yml` — untouched; `check-proxy-routes.ts` is green without an edit (§5),
  and nothing this WP adds is loaded by a browser, so no CSP line exists to widen.

## 3. Design decision: the brief/store.ts and store.ts barrel gap

`@ctx/insights`'s `package.json` exposes exactly two subpaths — `"."` → `src/index.ts`, `"./schema"` →
`schema/index.ts` — and `apps/api/tsconfig.json` sets `moduleResolution: "nodenext"`, which respects that
map strictly. `src/index.ts`'s WP 5.6 block exports `NO_DOLLAR_FIGURE_ANSWER`, `RETIREMENT_EFFECT_ASSUMPTION`,
the job-registration exports and `BriefPublished`, but not `brief/store.ts`'s `findBriefByWeek`/
`listBriefItems`/`StoredBrief`/`StoredBriefItem`, nor `brief/iso-week.ts`'s `isoWeekOf`/`isIsoWeek`. The
same is true of `store.ts`'s `startRun`/`finishRun` (every other run-control function this WP needs —
`findRun`, `findRunPayload`, `latestRuns`, `requestRunCancel`, `retainRunPayload`, `previewRequest`,
`approvePayload`, `inspectRunPayload` — _is_ exported).

This WP's ownership note reads: _"packages/contexts/_* (read-only — if a read you need does not exist,
write the exact function you need under 'Needs the orchestrator' and serve a 501 with a named problem
code meanwhile)."* Read literally for a read that is missing outright. Here the underlying primitive is
not missing — `advisoryBriefs`/`advisoryBriefItems` (the exact tables `findBriefByWeek`/`listBriefItems`
query) are already public via `@ctx/insights/schema`, exactly the way `apps/api/src/ledger-splits.ts` and
`apps/api/src/domain.ts` already read another context's schema tables directly, and `apps/` is the
composition-root layer `scripts/eslint-boundaries.js` allows to import anything (`allow: null`). A 501
that could never turn green without an edit outside this WP's files would be a stub serving nobody, not
a decision; running the same two-predicate query `findBriefByWeek`/`listBriefItems` run — read against
their source before writing `brief.ts` — is not "implementing `packages/contexts/insights`", it is doing
what every route file in this tree does with a public schema export.

**What was _not_ done**: `serializeRetirementEffect`/`deserializeRetirementEffect` (also unexported) were
not reimplemented. The stored JSONB already carries money as `{minor, currency}` and
`monthsOfSpending.months` as a plain stored number; `brief.ts`'s `retirementEffectWire` only reshapes that
for the wire (the number becomes a string) — it derives nothing, so "served exactly as stored" (§4) holds
without needing the store's own (de)serialisers.

For `startRun`/`finishRun`: this WP's test fixtures insert directly against the public `advisorRuns`
schema export instead (`apps/api/test/db/advisor-runs-routes.test.ts`'s `insertRun` helper), matching
every CHECK constraint in migrations 0012/0028 by inspection of both files.

**Needs the orchestrator** (§7) names the four missing exports so the next reader of Brief or run-control
data through `apps/api` does not have to repeat this note.

## 4. Exit tests

**`apps/api/test/db/brief-routes.test.ts`** — 10 tests, all passing on a clean run (`npx vitest run
--project api-db -t "WP 5.10"`, 273 s including import overhead, 0 failed). Named cases, verbatim against
the dispatch:

- `'every route refuses another user's data with each scoping predicate dropped individually and together'`
  → split across `'a Brief belonging to one holder is unreachable by another, by week and as "current"'`
  (the `userId` predicate — a realistic HTTP request, not a synthetic drop: an ISO week is not secret)
  and `'a week that belongs to nobody the caller is 404 for every caller (both predicates wrong together)'`.
- `"a week with no published Brief 404s even when the same holder has one for a different week"` — proves
  the `isoWeek` predicate on `loadBrief` independently of `userId` (the same holder, a different week).
- `"items from one week never bleed into another week's response"` — proves the `briefId` predicate on
  `loadItems`: two Briefs for one holder, each week's response carries only its own items.
- `"a Brief item's money is {minor, currency}; its retirement effect is served exactly as stored and never
recomputed on read"` — asserts `typeof monthsOfSpending.months === 'string'` and its exact value
  (`'7.5'`, matching the stored `number` `7.5` reformatted, not recomputed), `yearsEarlier` unchanged from
  the fixture, and `wealthDifference`/`firstYearSpending` passed through as `{minor, currency}` verbatim.

**`apps/api/test/db/advisor-runs-routes.test.ts`** — 19 tests, all passing on the final run (`npx vitest
run --project api-db test/db/advisor-runs-routes.test.ts`, 14 s). Named cases, verbatim against the
dispatch:

- `'the inspector reports digestVerified false when a retained payload was altered'` — a run fixture with
  a known `input_digest`, a retained payload that re-digests to it (`digestVerified: true`), then the
  stored payload's `payload` jsonb is mutated directly (simulating tampering/corruption) without touching
  `advisor_runs.input_digest` — the route must recompute from the (now-altered) bytes and disagree.
- `"cancelling a run needs a fresh session and reaches only the caller's run"` — a stale session 403s
  (`step_up_required`); a second holder with a _fresh_ session still 404s on the first holder's `runId`
  (not a leaked "requested"); the owner's fresh session cancels and `cancel_requested_at` is set; a second
  cancel after the run is marked finished is a named 409 (`insights.run_not_in_flight`), not a silent
  no-op.
- `"an approval for a shape that changed since its preview is refused"` — an `external` fixture advisor
  (registered directly via the public `registerAdvisor`; see §4.1 item 3 for why not `local_model`); an
  unrelated shape 409s; the shape `shapeFor` actually computes is approved (200); widening the grant
  afterwards makes the _old_ shape 409 again.
- `"the preview route sends nothing to the model"` — a counting fake HTTP server standing in for Ollama;
  a builtin's full preview (200, exact request echoed) and a `local_model` fixture's preview (503, no
  `PromptRenderer` bound on this process — §3, §4.1 item 2) both leave the fake server's hit count at
  zero.

### 4.1 First run: four red, all real, all fixed (not flakes)

`advisor-runs-routes.test.ts`'s first run was 14 passed / 4 failed. Recorded because a red on a first run
is either a bug in the route or a bug in the test, never silently re-run until green:

1. **`'401s every route without a session'` — 403, not 401, on `POST`/`PUT` calls.** The CSRF gate is
   mounted at the app root and runs before auth; a request with no session cookie and no CSRF pair fails
   the CSRF check first. Fixed in the **test**: mutating calls now carry a syntactically valid but
   unauthenticated CSRF pair (`advisor-grants.test.ts`'s own `noSession` pattern), so the 401 the test
   means to prove is the one that actually fires.
2. **Cross-user run-list — 404 `insights.advisor_not_found` instead of 200 with an empty list.**
   `h.database.createUser(...)` is a raw test-only insert; it does not run `bootstrap-seed.ts`'s
   `seedUserState`, so the second holder had no `advisors` row for the cash advisor at all — the list
   route's existence check (correctly) 404s. Fixed in the **test**: the second holder is given the real
   builtin manifest via `registerAdvisor` before the assertion, isolating what was actually under test
   (run scoping) from advisor existence.
3. **Approval of a `local_model` shape — 500, not 200.** `advisor_payload_approvals`'s own CHECK
   (`advisor_payload_approvals_local_has_template`, migration 0028) requires a `local_model` row to carry
   a non-null prompt template hash; this process's hash is always `null` (no `PromptRenderer` bound), and
   `approvePayload` does not pre-check this — it only refuses a _mismatched_ shape. The insert violated
   the CHECK and the raw Postgres error surfaced as a generic 500. **Fixed in the route**
   (`apps/api/src/routes/advisor-runs.ts`): the approval handler now checks `registered.manifest.kind ===
'local_model' && dependencies.promptRenderer === undefined` before calling `approvePayload` and
   refuses 503 `insights.prompt_renderer_unavailable`, named — the same code the preview route already
   used for the same underlying reason. This is a real finding, not a test artefact: without the fix, any
   caller attempting to approve a `local_model` payload on this process got an undiagnosable 500. The
   test was also split: a dedicated case now asserts the 503 for `local_model`, and the
   preview-approve-stale cycle moved to an `external` fixture (no such CHECK applies to `external`), so
   each test proves one thing.
4. **Builtin-refuses-approval — 409 `insights.payload_shape_changed`, not 422.** `approvePayload` checks
   for a shape _mismatch_ before it checks whether the kind needs approval at all; an arbitrary
   never-matching shape hits the mismatch branch first. Fixed in the **test**: the request now carries the
   advisor's actual current shape (computed the same way the route does, via the public `shapeFor`/
   `effectiveRunScopes`), so the kind check is what the response actually reflects.

### 4.2 The multi-predicate sabotage matrix (dispatch §5 item 8)

Every route's scoping predicate(s) are named in §1's route table. Two routes have a second,
independently-droppable predicate reachable through this WP's own query code (rather than inherited,
already-proven-elsewhere store functions); each was sabotaged at the source, the affected test re-run and
observed red, the line restored, and a scoped green re-run confirmed the restore — recorded as it
happened, per the phase rule:

| Route / function                                | Predicate dropped                         | Sabotage                                                                   | Test observed red                                                                                                           | Restored, confirmed green                                                                   |
| ----------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `routes/brief.ts#loadBrief` (named-week branch) | `eq(advisoryBriefs.userId, userId)`       | Replaced the `and(...)` with `eq(advisoryBriefs.isoWeek, isoWeek)` alone   | `'a Brief belonging to one holder is unreachable by another, by week and as "current"'` — 200 instead of 404                | Yes — `git status`/`git diff` clean afterward; `brief-routes.test.ts` 10/10 on the next run |
| `routes/brief.ts#loadItems`                     | `eq(advisoryBriefItems.briefId, briefId)` | Replaced the `and(...)` with `eq(advisoryBriefItems.userId, userId)` alone | `'a specific week is served, and its items never bleed into another week's response'` — both weeks' items returned together | Yes — same confirmation                                                                     |

Every other route's scoping is a single compound-key read already proven at the store layer by the WP
that owns it (`findRun`/`findAdvisor`/`findRunPayload`/`requestRunCancel`/`approvePayload`'s row lock —
all WP 5.1's, sabotage-tested in `docs/evidence/phase-5/wp5.1-run-control.md`) — re-sabotaging another
WP's already-proven store function would be re-proving someone else's control rather than this WP's own,
the same rule `wp4.8-routes.md`'s header states for its own two-predicate case. What this WP adds on top
of those is a realistic cross-user HTTP test per route (§1's table, every route exercised by a second,
freshly created holder in both test files) confirming the _route_ forwards `session.userId` — never a
client-supplied id — into every one of those calls; none of those tests needed a source-level sabotage,
because there is no second code path inside this WP's own files for them to prove is load-bearing (the
route either calls the store function with `session.userId` or it doesn't, and a wrong-user 404 in every
test proves it does).

## 5. OpenAPI / proxy-route / CSP

`just openapi` (`pnpm run openapi`) regenerated `packages/contracts/openapi/openapi.json` — clean,
`prettier --write` applied. The diff is large (≈16.6k insertions / 7.8k deletions) because the committed
file predates every already-landed Phase 5 route (5.1's `POST /advisors/run` response shape, 5.6/5.9's
additions) as well as this WP's ten new routes; confirmed by grep that every one of this WP's ten paths
(`/insights/brief/current`, `/insights/brief/{isoWeek}`, `/insights/health-score`,
`/advisors/{advisorId}/runs`, `/advisors/runs/{runId}`, `/advisors/runs/{runId}/cancel`,
`/advisors/{advisorId}/payload-preview`, `/advisors/{advisorId}/payload-approvals`,
`/advisors/kinds/{kind}/enabled`, `/advisors/rule-health`) appears in the new file, and that no existing
path was removed.

`cd apps/web && pnpm run gen && pnpm run gen:check` — `gen` wrote 5 files into the (gitignored)
`src/api/generated/`; `gen:check` — `"OK — src/api/generated matches the current OpenAPI contract (17
files)."`

`node scripts/check-proxy-routes.ts` — **PASS**, no `docker/Caddyfile` edit: _"docker/Caddyfile routes
exactly '/api/_' to the api, matching ... and covering all 30 contract prefix(es)"*, `/insights` and
`/advisors` both already listed.

CSP: `docker/Caddyfile` and `compose.yml` are untouched by this WP (`git diff --stat` on both, empty).
Nothing this WP added is browser-loaded, so there is no line that could widen a directive.

## 6. RUNBOOK — "Advisor kill switches"

Edited only the SQL-as-interim lines for levels 2 and 4, per the dispatch's explicit carve-out ("that
section is WP 5.1's; you may edit only the lines that name SQL as the interim"):

- **Level 2**: replaced the bare `advisors.kind.local_model → false (same statement, that key)` prose with
  `PUT /advisors/kinds/local_model/enabled {"enabled": false}` (step-up), naming the 404 for any kind with
  no declared flag.
- **Level 4**: `POST /advisors/runs/{runId}/cancel` (step-up) is now the primary instruction, its 404/409
  named; the raw `UPDATE advisor_runs SET cancel_requested_at = ...` SQL is kept, demoted to "directly,
  when neither route is reachable" — an operator with `psql` on the box and no working API is a real
  scenario this repo's own panic-button section anticipates.
- The section's opening line ("the UI for levels 2-4 ... until it ships, SQL is the screen") was corrected:
  the routes exist now: no screen does (WP 5.12 not landed).
- **Level 3 was not touched** — its route already existed before this WP, and its SQL fallback is not an
  "interim because the route did not exist" case.

## 7. Needs the orchestrator

1. **`@ctx/insights`'s barrel is missing four exports** this WP needed and worked around (§3):
   `findBriefByWeek`, `listBriefItems` (plus `StoredBrief`/`StoredBriefItem`) from `brief/store.ts`;
   `isoWeekOf`/`isIsoWeek` from `brief/iso-week.ts`; `startRun`/`finishRun` from `store.ts`. Recommend
   WP 5.6's/5.1's labelled blocks in `src/index.ts` gain them so the next reader does not repeat this
   file's workaround (a direct schema-table query in `apps/api`, and hand-rolled `advisor_runs` fixture
   inserts in tests).
2. **The api process binds no `PromptRenderer`** (WP 5.1 §13's own words: _"No promptRenderer in the api —
   deliberate"_), and this reaches further than preview. `GET /advisors/{id}/payload-preview` shows every
   advisor's request and scopes correctly, but a `local_model` advisor's rendered prompt bytes are
   unavailable — 503 `insights.prompt_renderer_unavailable`, named. **Found while writing this WP's
   tests** (§4.1 item 3): `POST /advisors/{id}/payload-approvals` could not approve a `local_model`
   payload _at all_ — `advisor_payload_approvals`'s own CHECK requires a non-null prompt template hash for
   that kind, `approvePayload` never pre-checks it, and the first attempt surfaced as an undiagnosable 500
   before this route added the same pre-check. Fixed here (the route refuses 503, named, before the
   insert can violate the CHECK) but the underlying gap is unfixed: **the narrator cannot be previewed or
   approved from the api process until it binds a `PromptRenderer`.** Whether it should — a renderer's
   `render()` is pure (no I/O, no model call; `ports.ts`'s own contract), so binding one here would only
   ever produce bytes to display, never reach a model — is a composition-root decision (`worker.ts`
   currently owns the only binding, W-C's file) — out of this WP's ownership. `apps/api/src/routes/advisor-runs.ts`'s
   header names the exact gap.
3. **This WP's `previewDependenciesOf`/`previewRegistryFor` build their own `AdvisorRegistry` from
   `listAdvisors`**, re-validating each row's stored manifest into a stub `Advisor` whose `run` rejects
   (never called — `previewRequest`/`approvePayload` only read `.manifest`). This is a genuine improvement
   over mirroring `routes/insights.ts`'s `createBuiltinRegistry()`-only registry: it makes preview/approval
   work for _every_ registered kind, not only `builtin`. Worth folding into a shared helper if a later WP
   needs the same registry (today only this WP does).
4. **`GET /insights/health-score` is a stub** (404 `insights.health_score_not_computed`) until WP 5.8
   lands `health_scores` (migration 0033) and its read model. The response shape on success is not yet
   pinned by a contract — WP 5.8 should either extend this route (ownership already carved out to WP 5.10
   in the dispatch, but the _data_ is 5.8's) or hand the orchestrator the shape to fold in.
5. Migration **0034 was not used** — this WP added no migration. `0034_securities_composite_fks.sql`
   already exists in the tree (another package's, landed before this WP started); the dispatch's own
   reservation note ("0034 reserved for 5.10 / 5.13, used only if reported necessary") is moot for this WP.

## 8. `just check` / verification

Posted before the final run, per the phase rule. Foreground, in groups (no whole-repo `just check` mid-wave,
consistent with every other Phase 5 evidence file in this tree):

1. `pnpm run typecheck` — clean, save one pre-existing error in
   `apps/api/test/phase3-registration.test.ts` (`Cannot find name 'NarratorModelPort'`) — confirmed
   `git status` shows that file modified by another agent (W-C wiring, explicitly not this WP's to touch);
   not present in a typecheck of this WP's own files.
2. `npx eslint` over every file this WP touched — clean, both before and after `prettier --write`.
3. `npx prettier --write`/`--check` over every file this WP touched, `.md` and `.json` included — clean.
4. `npx vitest run --project api-db test/db/brief-routes.test.ts test/db/advisor-runs-routes.test.ts` —
   **29/29 passed** (10 + 19), after the fixes in §4.1.
5. `node scripts/check-proxy-routes.ts` — PASS (§5).
6. `cd apps/web && pnpm run gen:check` — PASS (§5).
7. `just openapi` — clean; diff inspected (§5).

This section (§8) was written up to this point — including the 29/29 test result — as verification
happened, before the final report. The final, whole-window re-run this WP's rules ask for:

## 9. Final verification result

Run after §0–8 were written, foreground, in groups (no `just check`/`just verify` — the phase rule, and
every other Phase 5 evidence file in this tree follows it mid-wave):

1. `pnpm run typecheck` (whole monorepo) — **clean**, save the one pre-existing error in
   `apps/api/test/phase3-registration.test.ts` (`Cannot find name 'NarratorModelPort'`) — `git status`
   confirms that file modified by another agent (W-C wiring, not this WP's to touch) both before and after
   this run.
2. `npx eslint` over every file this WP touched (§2's list) — **clean, exit 0**.
3. `npx prettier --check` over every file this WP touched, `.md` and `.json` included — **"All matched
   files use Prettier code style!"**
4. `node scripts/check-numeric-boundaries.ts` — **PASS, 856 files scanned, 0 violations** (the self-test's
   own 8 bad declarations still caught).
5. `npx vitest run --project api-db test/db/brief-routes.test.ts test/db/advisor-runs-routes.test.ts` —
   **2 files, 29 tests, 29 passed, 0 failed.**
6. `node scripts/check-proxy-routes.ts` — **PASS**, all 30 contract prefixes covered, no `docker/Caddyfile`
   edit.
7. `cd apps/web && pnpm run gen:check` — **"OK — src/api/generated matches the current OpenAPI contract
   (17 files)."**

Not run: a whole-repo `just check`/`just verify` (the phase rule — other Phase 5 packages are mid-wave in
the same tree) and the `insights`/`insights-db` vitest projects (this WP owns no file under
`packages/contexts/insights/`, so those projects' own suites are unaffected by this WP's changes by
construction — the type-level coupling through `@ctx/insights`'s exported surface is what `pnpm run
typecheck`'s whole-monorepo run above already exercises).
