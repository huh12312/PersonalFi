# WP 5.8 — Health score with breakdown

_Agent: backend-architect (Sonnet). Branch `main`, resuming at `d243ffa` (a wip snapshot of a previous
agent's partial work, killed by a weekly limit at `health/score.ts` and `health/thresholds.ts`, with no
store, migration, route or tests). Written incrementally; sabotages are recorded as they are observed.
Concurrent in the same tree: two frontend agents (WP 5.11, WP 5.12) under `apps/web/**`, never touched
here._

Scope: `docs/plan/05-phase-5-dispatch.md` §3 WP 5.8; migration **0033_health_scores.sql**; §4's migration
table and "Shared files" items 4–5 (the weekly-job fold is the orchestrator's; `packages/db/test/migrate.test.ts`
is mine this wave); `docs/research/09-requirements-prd.md` ADV-7, §4 benchmark row 20, TRD-6;
`docs/evidence/phase-5/wp5.6-brief.md` (`brief/job.ts`, which the fold goes into), `wp5.10-routes.md`
(the `GET /insights/health-score` stub in `apps/api/src/routes/brief.ts`); `docs/evidence/phase-4/wp4.2-assumptions.md`
(the cited-data-file rule); `packages/contexts/insights/src/snapshot/` (the blocks the six components
read); `docs/CONVENTIONS.md` (the numeric-boundary rule).

## 0. Log

| Time (local) | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —            | Read §3's preamble and the WP 5.8 entry in full; §4's migration table (0033 is mine, `health_scores`, referencing only 0012-era objects or its own) and "Shared files" items 4–5; 09 ADV-7, §4 benchmark row 20, TRD-6; `wp5.6-brief.md` (`brief/job.ts`, the fold target), `wp5.10-routes.md` (the health-score stub's exact shape and the "needs the orchestrator" note it already carried for WP 5.8); `wp4.2-assumptions.md` §9/§10 (the cited-node rule, unverified-source posture); `packages/contexts/insights/src/snapshot/{builder.ts,ports.ts}`; `docs/CONVENTIONS.md`'s money/decimal rules.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| —            | Read the state on disk: `health/thresholds.ts` and `health/score.ts`. Verified both against the spec: six components in `HEALTH_COMPONENT_IDS` order, four bands with three cited ascending boundaries each, a component with no data excluded and named (never scored as zero), weights renormalised to sum to exactly `1_000_000n` by construction, pure over `AdvisorSnapshot`, reading only the seven named blocks (`cash_summary`, `cashflow_monthly`, `plan_projection`, `liabilities_terms`, `recurring_list`, `holdings_aggregate`, `fees_summary`). Cross-checked every field name against `contract/snapshot.ts`'s real schemas (`CashSummarySchema`, `CashflowMonthlySchema`, `PlanProjectionSchema`, `LiabilitiesTermsSchema`, `RecurringListSchema`, `HoldingsAggregateSchema`, `FeesSummarySchema`) line by line — every read in `score.ts` matches a real, required or correctly-nullable field. **Verdict: both files are correct as written. Kept unchanged.** No fix was needed, which this evidence records explicitly rather than silently. |
| —            | Designed `health/store.ts`: `computeAndStoreHealthScore` takes an already-built `AdvisorSnapshot` rather than building one itself (composition-root machinery this WP does not own — `SnapshotBuilder`, `SnapshotPorts`, a token key — see §6 below), the idempotent-per-`(user, isoWeek)` pattern mirrored exactly from `brief/store.ts#publishWeeklyBrief`, and `previousComponentScoresFor` reading backward through `previousIsoWeek` (`brief/iso-week.ts`, imported read-only — not edited).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| —            | Wrote migration `0033_health_scores.sql`, `schema/health.ts`, `schema/index.ts`'s re-export line, `src/health/store.ts`, the `src/index.ts` WP 5.8 block, `OWNERSHIP.md`'s table list and migration-provenance paragraph, the `apps/api/src/reports/export/registry.ts` exemption, `packages/db/test/migrate.test.ts`'s alphabetical list and attribution block, the `GET /insights/health-score` route handler in `apps/api/src/routes/brief.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| —            | `pnpm run typecheck` — one error on the first pass (`routes/brief.ts`: `readonly HealthComponentResult[]` is not assignable to the zod-inferred mutable array type in the Fastify response), fixed by mapping into fresh object literals before returning; clean after.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| —            | `test/health.test.ts` (5 tests), `test/db/health.test.ts` (3 tests), `apps/api/test/db/health-routes.test.ts` (4 tests) written and run green on the first try (after fixing one arithmetic mistake of my own in a draft — see §2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| —            | Four sabotages run against the real production code, each observed red on the real assertion, then reverted and re-confirmed green (§4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| —            | Confirmed no collision with WP 5.10's existing stub test in `apps/api/test/db/brief-routes.test.ts`: its `'GET /insights/health-score 404s insights.health_score_not_computed (WP 5.8 has not landed)'` case seeds no `health_scores` row, and my route still answers that exact 404 code when none exists — ran that file alone, 10/10 still pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| —            | Evidence written; the full `insights`, `insights-db` and `db` vitest projects and the `api-db` project's two relevant files run green (§7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## 1. The worked example — the score on a hand-built snapshot

`test/health.test.ts`'s `fullSnapshot()`. All seven blocks present, each landing on a different band:

| Component               | Inputs                                                                                                            | Arithmetic                  | Band                        | Score | Weight (renormalised) |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------- | ----- | --------------------- |
| `emergency_fund_months` | `cash_summary.emergency_fund_months = 4`                                                                          | —                           | `good` (3 ≤ 4 < 6)          | 75    | 0.2                   |
| `savings_rate`          | `plan_projection.savings_rate.observed = '0.12'` (preferred over `cashflow_monthly`)                              | —                           | `good` (0.10 ≤ 0.12 < 0.15) | 75    | 0.2                   |
| `debt_to_income`        | one liability, minimum payment $900; monthly income $6,000 (2 months of $6,000 income / $4,500 expense, averaged) | 900 ÷ 6000 = 0.15           | `excellent` (< 0.20)        | 100   | 0.2                   |
| `subscription_load`     | one $100/month stream, 12×/yr; annualised income $72,000                                                          | (100×12) ÷ 72000 ≈ 0.016667 | `excellent` (< 0.02)        | 100   | 0.15                  |
| `diversification`       | one position at weight 0.08 of `investable_total`                                                                 | —                           | `good` (0.05 ≤ 0.08 < 0.10) | 75    | 0.15                  |
| `fee_drag`              | one avoidable fee row, $30.00; `expense_ratio_drag = null`                                                        | —                           | `good` ($25 ≤ $30 < $50)    | 75    | 0.1                   |

All six computable → renormalisation is a no-op, weights are exactly the base weights (`200000, 200000,
200000, 150000, 150000, 100000` out of `1_000_000`):

```
overall = 0.2·75 + 0.2·75 + 0.2·100 + 0.15·100 + 0.15·75 + 0.1·75
        = 15 + 15 + 20 + 15 + 11.25 + 7.5
        = 83.75
```

`computeHealthScore(fullSnapshot(), null).overall === 83.75`, asserted in `test/health.test.ts`. Every
component's `direction` reads `'no_previous_data'` — no previous-week map was given — which is the
first-week case stated directly rather than only through the database suite.

**The excluded-component case.** `snapshotMissingLiabilities()` — `fullSnapshot()` with
`liabilities_terms` dropped entirely (no scope granted, the real-world "cash.summary granted,
liabilities.terms not" case). `debt_to_income` is excluded with reason `'liabilities.terms was not
granted, or had no source behind it'`; the remaining five components renormalise their weights to sum to
exactly `1_000_000n` (`0.25, 0.25, 0.1875, 0.1875, 0.125` for emergency/savings/subscription/diversification/fee,
in that order, the last absorbing the exact remainder). `debt_to_income`'s score **never appears at all** —
not as a zero, not as a `null` inside `components`, only as a named entry in `excluded`.

**The degenerate case.** An empty snapshot (`{}`): all six components excluded, `overall` reads `null`
(never `0`), weights are vacuously summed over zero components.

## 2. The thresholds table, with sources

Unchanged from the state found on disk — `health/thresholds.ts`'s own header and table, verified against
09 ADV-7 and 07's own rules:

| Component               | Unit   | Boundaries (ascending) | Source                                                                                                                                  |
| ----------------------- | ------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `emergency_fund_months` | months | 1 / 3 / 6              | 1: PersonalFi default. 3, 6: CFPB consumer education + Fidelity Viewpoints' commonly-cited 3–6 month range.                             |
| `savings_rate`          | ratio  | 0.05 / 0.10 / 0.15     | 0.05, 0.10: PersonalFi default, fractions of the 15% target below. 0.15: Fidelity's "50/15/5" rule.                                     |
| `debt_to_income`        | ratio  | 0.20 / 0.36 / 0.43     | 0.20: PersonalFi default. 0.36: CFPB's "manageable" DTI. 0.43: 12 CFR 1026.43(e)(2)(vi), the QM back-end ceiling.                       |
| `subscription_load`     | ratio  | 0.02 / 0.05 / 0.10     | 0.02, 0.05: PersonalFi default, fractions of U7's trigger below. 0.10: 07's rule U7 generalised from a review trigger to a boundary.    |
| `diversification`       | ratio  | 0.05 / 0.10 / 0.25     | 0.05: PersonalFi default. 0.10: 07's rule I5 (employer-stock concentration), generalised to any top position. 0.25: PersonalFi default. |
| `fee_drag`              | USD/yr | 25.00 / 50.00 / 150.00 | 25: WP 5.7's anomaly materiality floor. 50: WP 5.6's Brief ranking floor. 150: PersonalFi default, 3× the Brief floor.                  |

Every "memo" boundary carries that word verbatim as its source and a note explaining the posture
(`wp4.2-assumptions.md` §9/§10's "unverified this session is still a citation" rule, applied one context
over) — no boundary is a bare number with no citation.

## 3. Files

**New:**

- `packages/db/migrations/0033_health_scores.sql`
- `packages/contexts/insights/schema/health.ts`
- `packages/contexts/insights/src/health/store.ts`
- `packages/contexts/insights/test/health.test.ts`
- `packages/contexts/insights/test/db/health.test.ts`
- `apps/api/test/db/health-routes.test.ts`
- `docs/evidence/phase-5/wp5.8-health.md` (this file)

**Edited:**

- `packages/contexts/insights/schema/index.ts` — one re-export line for `schema/health.ts`.
- `packages/contexts/insights/src/index.ts` — the labelled `// WP 5.8` block appended at the end (three
  re-export statements: `health/thresholds.ts`, `health/score.ts`, `health/store.ts`).
- `packages/contexts/insights/OWNERSHIP.md` — `health_scores` added to the table list; the migration-provenance
  paragraph extended.
- `apps/api/src/reports/export/registry.ts` — one `EXEMPT_TABLES` entry for `health_scores`.
- `packages/db/test/migrate.test.ts` — `health_scores` inserted alphabetically (between `goals` and
  `holdings`); the `// 0033_health_scores:` attribution block inserted between 0032's and 0034's (0034
  already exists in the tree, landed by another package before this one started, per `wp5.10-routes.md` §7
  item 5).
- `apps/api/src/routes/brief.ts` — the `GET /insights/health-score` handler's body replaced (the stub's 404
  behaviour is preserved for "nothing computed yet"; a 200 path was added); the header's "WP 5.8 has not
  landed" section rewritten to describe the landed read; three wire schemas added
  (`healthComponentWireSchema`, `healthExcludedWireSchema`, `healthScoreSchema`) and a
  `healthScoreNotComputed()` helper.
- `health/thresholds.ts`, `health/score.ts` — **verified against spec, zero changes.** See §0's log entry:
  every component's data source, band boundary direction, exclusion reason and renormalisation property was
  checked against 09 ADV-7, the dispatch's exit tests and `contract/snapshot.ts`'s real schemas, and all of
  it was already correct.

## 4. Exit tests, and sabotages observed red

**`packages/contexts/insights/test/health.test.ts`** (pure, no database):

1. `'the score decomposes into six named components, each with value, weight and direction'`
2. `'a component with no data is excluded and named, never scored as zero'`
3. `'the weights sum to one over the computable components'`
4. `'the same snapshot always yields the same score'`
5. `'direction reads against the given previous-week map, and improved/worsened/unchanged all occur'` (added beyond the verbatim four, to exercise every `HealthScoreDirection` value)

**`packages/contexts/insights/test/db/health.test.ts`** (real Postgres):

1. `'direction of travel compares against the previous stored week, and the first week says so'`
2. `'is idempotent per (user, ISO week): a second call for the same week writes nothing new'`
3. `'a component with no data is still excluded and named when stored and read back'`

**`apps/api/test/db/health-routes.test.ts`** (real Postgres, real HTTP):

1. `'401s without a session'`
2. `'404s insights.health_score_not_computed before any score has been computed'`
3. `'serves the stored score with its breakdown and names excluded components'` — the verbatim exit test
4. `'a health score belonging to one holder is never served to another'` — the cross-user case

All of the above were written and ran **green on the first try against the real implementation** — the
code under test (`health/thresholds.ts`, `health/score.ts`) pre-existed and was correct, and `health/store.ts`
and the route handler were written directly against it. Per the dispatch's rule that sabotages must be
**recorded as they happen**, four sabotages were run directly against the production code (not the tests)
to confirm each control actually fails when broken, immediately reverted after each:

| #   | Sabotage                                | File                                                                                                                                                         | Result observed                                                                                                                                                                                                                                                             | Reverted, re-confirmed green |
| --- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1   | A missing component scored as zero      | `health/score.ts#debtToIncome`: returned `{ computable: true, figure: 0n, value: '0.000000' }` instead of `excluded(...)` when `liabilities_terms` is absent | **RED** — `'a component with no data is excluded and named, never scored as zero'` failed (`result.excluded` was `[]`, expected the named entry); `'the weights sum to one…'` also failed on its degenerate all-excluded case (`empty.components` had length 1, expected 0) | Yes — both green after       |
| 2   | Weights not renormalised                | `health/score.ts#renormalizeWeights`: returned the raw `BASE_WEIGHT` for every computable id, with no division by the sum                                    | **RED** — `'the weights sum to one over the computable components'` failed on the five-computable case: `sumWeights(...)` was `800000n`, expected `1_000_000n`                                                                                                              | Yes — green after            |
| 3   | Direction against the current week      | `health/store.ts#previousComponentScoresFor`: looked up `isoWeek` (the week being computed) instead of `previousIsoWeek(isoWeek)`                            | **RED** — `'direction of travel compares against the previous stored week, and the first week says so'` failed: `previousComponentScoresFor` for week 1, called _after_ week 1 was stored, returned week 1's own just-written row instead of `null`                         | Yes — green after            |
| 4   | The figure served without its breakdown | `apps/api/src/routes/brief.ts`'s health-score handler: returned `components: []` and `excluded: []` regardless of the stored row                             | **RED** — `'serves the stored score with its breakdown and names excluded components'` failed: `body.healthScore.components` had length 0, expected 1                                                                                                                       | Yes — green after            |

Each sabotage's diff and revert is in the session transcript; `grep -rn SABOTAGE packages/contexts/insights/src/health/ apps/api/src/routes/brief.ts` returns nothing at the final state, confirming no sabotage marker was left behind.

## 5. The migration and `migrate.test.ts`

`packages/db/migrations/0033_health_scores.sql` creates one table, `health_scores`, referencing only
`users` (0012-era, through `@ctx/identity`) — **no** foreign key toward `advisory_briefs`/`advisory_brief_items`
(0032, WP 5.6), satisfying 05 §4's rule that two migrations landing in the same wave never reference each
other's objects. Two CHECK constraints beyond the usual ISO-week pattern:

- `health_scores_six_components_named` — `jsonb_array_length(components) + jsonb_array_length(excluded) = 6`,
  the database-level mechanisation of "every row names exactly six components, computed or excluded, never
  a seventh and never fewer".
- `health_scores_overall_requires_components` — `(overall IS NULL) = (jsonb_array_length(components) = 0)`,
  pinning "never a score over zero components" the way `advisory_brief_items_score_matches_factors` pins
  score/scoreFactors in 0032.

`packages/db/test/migrate.test.ts`: `health_scores` added to the alphabetical table list (between `goals`
and `holdings`); the `// 0033_health_scores:` attribution comment inserted between 0032's block and 0034's
(0034 — `securities_composite_fks`, WP 5.13a — already existed in the tree at the start of this session, per
`wp5.10-routes.md` §7 item 5's own note that it "landed before this WP started").

## 6. Wiring for the orchestrator — the fold line

`health/store.ts` exports `computeAndStoreHealthScore(database, { userId, isoWeek, snapshot, clock? })` —
see its header for why it takes an already-built `AdvisorSnapshot` rather than building one: `SnapshotBuilder`,
`SnapshotPorts` and a token key are composition-root machinery (`apps/api/src/domain.ts`/`worker.ts`), and
this WP owns `src/health/**` only.

**What the weekly-job fold needs**, concretely, in `packages/contexts/insights/src/brief/job.ts`'s
`BriefJobDependencies` and `createBriefJob` (not edited here — that file is WP 5.6's, and W-C's own wiring
batch per 05 §4 is "the health score … folded into the weekly job"):

```ts
// BriefJobDependencies gains:
readonly snapshotPorts: SnapshotPorts; // the same `dependencies.ports` the advisor-run path already has
readonly tokenSecret: string;         // `deriveTokenKey(tokenSecret, context.userId)`

// The seven scopes the health score reads (health/score.ts's own header names them):
export const HEALTH_SNAPSHOT_SCOPES = [
  'cash.summary', 'cashflow.monthly', 'plan.projection',
  'liabilities.terms', 'recurring.list', 'holdings.aggregate', 'fees.summary',
] as const satisfies readonly AdvisorScope[];

// Inside createBriefJob's handler, after `isoWeek` is computed and
// independent of whether the Brief itself has anything material (a
// "nothing material" week still gets a score):
const built = await new SnapshotBuilder(input.snapshotPorts).build({
  userId: context.userId,
  kind: 'builtin',
  grantedScopes: HEALTH_SNAPSHOT_SCOPES,
  today: todayIn(clock, input.timeZone),
  baseCurrency: input.currencyCode,
  tokenKey: deriveTokenKey(input.tokenSecret, context.userId),
});
await computeAndStoreHealthScore(input.database, {
  userId: context.userId,
  isoWeek,
  snapshot: built.snapshot,
  clock,
});
```

`kind: 'builtin'` with the full seven-scope grant is correct because the health score is not an advisor and
carries no `snapshot_grants` row of its own — `scopesPermittedForKind('builtin')` permits every scope in
the catalogue (confirmed: `contract/scopes.ts#scopesPermittedForKind`, the `externalAllowed` filter only
restricts `'external'`), so all seven are read regardless of what any particular advisor has been granted.
This is exactly 09 TRD-6's posture: the score reads only builtin-sourced blocks, by construction, never a
sidecar's.

## 7. Needs the orchestrator

1. **The fold line itself (§6)** — `brief/job.ts`'s `BriefJobDependencies`/`createBriefJob` and the two
   composition-root files that assemble them (`apps/api/src/modules.ts`, `apps/api/src/worker.ts`) are not
   this WP's to touch; the exact call is written above for W-C's wiring batch to apply.
2. **`apps/api/test/db/brief-routes.test.ts`'s stub test is now stale in name only, not in behaviour.**
   Its `'GET /insights/health-score 404s insights.health_score_not_computed (WP 5.8 has not landed)'` case
   (line ~218, that file) still passes unchanged: it seeds no `health_scores` row, and the real handler
   answers the identical 404 code for "no score computed yet" as the old stub did. Confirmed by running
   that file alone, 10/10 green, after this WP's route change landed. The orchestrator may want to drop the
   parenthetical from that test's name at its convenience — not urgent, and not this WP's file to edit.
3. **`index.ts`'s WP 5.8 block exports `computeAndStoreHealthScore` deliberately**, so the fold (§6) and any
   future reader can import it through `@ctx/insights` rather than repeating the "schema re-export only, no
   deep import" workaround `wp5.10-routes.md` had to apply for the Brief's own store functions. The
   route handler in this same WP already uses that path (`findLatestHealthScore` from `@ctx/insights`).

## 8. `just check` / verification

Posted before the final run, per the phase rule; foreground, in groups.

1. `pnpm run typecheck` — clean (one error fixed mid-session: a `readonly` array returned where the
   Fastify/zod response type wanted a mutable one; fixed by mapping into fresh object literals in the
   route handler).
2. `npx eslint` over every file this WP touched — clean.
3. `npx prettier --write` over every file this WP touched (`.sql` excepted — no prettier parser for SQL in
   this repo, same as every other migration file) — clean, no further diffs.
4. `node scripts/check-numeric-boundaries.ts` — `PASS — 862 file(s) scanned, 0 violations`.
5. `npx vitest run --project insights` — **295 passed, 1 skipped** (no regression).
6. `npx vitest run --project insights-db` — **44 passed** (includes this WP's 3).
7. `npx vitest run --project db` — **10 passed** (`migrate.test.ts`, including the new attribution/list entries).
8. `npx vitest run --project api-db apps/api/test/db/health-routes.test.ts` — **4 passed**.
9. `npx vitest run --project api-db apps/api/test/db/brief-routes.test.ts` — **10 passed** (confirms §7 item 2: no regression from the health-score handler change).
10. Full `npx vitest run --project api-db` (every file in the project, `fileParallelism: false`) — run
    **twice**. The first run overlapped this evidence's own sabotage window (§4) and its result is
    discarded as untrustworthy for that reason, named rather than quietly kept. The second, run after every
    sabotage was confirmed reverted (`grep -rn SABOTAGE` clean) and against a `git diff` showing
    `health/score.ts`/`health/store.ts` back to their landed state: **59 test files passed, 1 failed, 1
    skipped (61); 359 tests passed, 1 failed, 4 skipped (364).** The one failure,
    `test/db/projection-perf.test.ts`'s `'POST /plan/scenarios/{id}/projections p95 is within budget over
real HTTP'` (measured 856.9 ms against an 800 ms budget), is unrelated to this WP: last touched at
    `ab0b5e4`, zero diff from this session (`git diff --stat` confirms), a Planning/WP 4.5/4.14 file this WP
    never claims, and the exact host-load sensitivity 05 §3's preamble rule 4 names ("no performance number
    is believed while a model is loaded on the host") — `uptime` read `6.88 1m` during the full-project
    run. Re-run alone, immediately after, with nothing else contending: **3/3 passed**, p95 574 ms, well
    inside the 800 ms budget. Recorded here as a known, pre-existing, load-induced flake outside this WP's
    ownership, not a regression from the health-score handler.
