# WP 5.6 — The Weekly Advisory Brief

_Agent: backend-architect (Sonnet). Branch `main`. Written incrementally; sabotages are recorded as they
are observed. Concurrent in the same tree: WP 5.3 (the narrator), Wave C. Neither package touches the
other's files; `packages/contexts/insights/src/index.ts` is shared and each package appends its own
labelled block at the end._

Scope: 05-phase-5-dispatch.md §3 WP 5.6; migration **0032_advisory_briefs.sql**; §4's "Shared files" items
4 and 5 (the `insights.brief` job kind and the `insights.weekly_brief` schedule, exported for the
orchestrator); §5's gate standard; §6 Q3 (in-app only this phase; `insights.BriefPublished` is the hook).

## 0. Log

| Time (local) | Step                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —            | Read §3's preamble, the WP 5.6 entry, §4's migration table and shared-files items 4–5, §5's gate standard, §6 Q3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| —            | Read 07 §3.2 (the ranking formula, "never compound speculative returns into the headline number"), §7.3 (explainability); 09 ADV-1, S1, E11 (edge cases, cold start), NOT-1/NOT-6.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| —            | Read `docs/evidence/phase-2/wp2.7-advisor-catalog.md` (`advisors/ranking.ts`'s factor functions), `wp5.5-planning.md` §8 (`solveRetirementImpact`, the binding shown as wiring for the orchestrator, `earliestRetirementAge` named as the function an adapter must not call), `wp5.9-feedback.md` (dismiss rates, outcome verification), `wp5.7-anomaly-fees.md` §1, `wp5.1-run-control.md` (the `insights.run_local` lane).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| —            | Read `read.ts`, `store.ts` (upsert deletes and re-inserts evidence/actions on every re-run — confirmed a Brief item must snapshot every displayed field, never join through to `insights`), `advisors/ranking.ts`, `policy/alert-budget.ts` (confirmed `rank()`'s severity-dominant term is the thing to leave out, and that `belowFloor`/`effectiveImpactMinor` are the exact functions to reuse), `schema/{insights,advisors}.ts`, `packages/db/migrations/0012_insights.sql` and `0030_insight_feedback_reasons.sql` (constraint and comment conventions), `apps/api/src/domain.ts`'s `createInsightsPlanningPort` (the pattern `createInsightsRetirementImpactPort` mirrors), `packages/contexts/planning/src/engine/retirement-date.ts` (`solveRetirementImpact`'s exact signature and return shape), `projection-service.ts` (`assembleInput`, `assembleBaselinePlan`, `getBaseline`), `apps/api/src/modules.ts` (`insightsModule`'s current jobs/schedules shape, for the wiring section below), `apps/api/src/reports/export/registry.ts` (the `EXEMPT_TABLES` precedent for `insight_outcomes`), `vitest.config.ts` (`insights` collects `test/*.test.ts` one level deep; `insights-db` collects `test/db/**/*.test.ts`; `api`/`api-db` similarly). |
| —            | Designed the split: `brief/candidate.ts` (the pure `BriefCandidate` shape, declared rather than importing `read.ts`'s `InsightView` so the pure tests need no database and no dependency on WP 5.3's file this wave), `brief/ranking.ts` (score, family cap, attention strip, the $50 floor reused), `brief/assembly.ts` (pure: candidates → ranked/attention/nothing-material/cold-start), `brief/ports.ts` (`RetirementImpactPort`, declared in Insights' own vocabulary), `brief/retirement.ts` (candidate → port request, the no-dollar-figure short-circuit), `brief/store.ts` (DB reads, the JSONB round-trip for the retirement effect, `publishWeeklyBrief`'s idempotency guard), `brief/job.ts` (`insights.brief`, `insights.weekly_brief`, the narration enqueue).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| —            | Wrote migration 0032, `schema/briefs.ts`, `schema/index.ts`'s re-export line, all of `src/brief/**`, the `BriefPublished` event, the `index.ts` WP 5.6 block, `createInsightsRetirementImpactPort` in `domain.ts`, the export-registry deferrals, `migrate.test.ts`'s list and attribution block, the `INSIGHTS_EVENTS` pin, `OWNERSHIP.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| —            | `pnpm run typecheck` clean after every file (run repeatedly through the session; the whole monorepo, not just this package — the layer-boundary and `RetirementImpactAnswer` mirror-shape claims are compile-time, and this is what proves them).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| —            | Mid-session: `packages/contexts/insights/src/index.ts` changed on disk under me — WP 5.3 landed its own labelled block after mine. Collision found: both packages had independently declared `NARRATOR_ADVISOR_ID` (mine in `brief/job.ts`, theirs in `advisors/local/manifest.ts`, both `'local.narrator'`) and both exported it from the shared barrel, which does not compile (duplicate export). Renamed mine to `WEEKLY_BRIEF_NARRATOR_ADVISOR_ID` rather than importing theirs — the two packages stay decoupled at the file level, which is what the ownership split is for. `pnpm run typecheck` clean after.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| —            | `test/brief.test.ts` (6), `test/brief-retirement.test.ts` (1), `test/db/brief.test.ts` (2), `apps/api/test/db/brief-retirement-port.test.ts` (1) written and run green; five sabotages run, all red on the first try, all restored (§5 below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| —            | Full `insights` + `insights-db` + `db` vitest projects run together: 335 passed, 1 skipped, 0 failed — no regression against WP 5.3/5.7/5.9's concurrent or already-landed work. `api` project's `phase3-registration.test.ts` and `api-db`'s `export-import-phase3-phase4.test.ts` (the export-registry completeness self-check) also run green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| —            | `node scripts/check-numeric-boundaries.ts`: 0 violations. `node scripts/check-schema-ownership.ts`: ok, 108 claimed / 95 defined. `node scripts/check-ci-projects.ts`: 42/42 (unchanged — this WP adds no vitest project).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| —            | Evidence written; the Brief-on-candidates table and the retirement-effect-beside-a-direct-run table below are real output from this session's runs, captured before the final verification. Load average at the time of the last full run: 5.66 1m / 5.18 5m / 4.00 15m (`uptime`, 2026-09-30 08:43 local) — WP 5.2/5.3 have the compose stack; no timing number in this evidence is a duration claim, so the elevated load does not undermine anything measured here (nothing here is timed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 1. Files

**New:**

- `packages/db/migrations/0032_advisory_briefs.sql`
- `packages/contexts/insights/schema/briefs.ts`
- `packages/contexts/insights/src/brief/{candidate,ranking,assembly,ports,retirement,store,job}.ts`
- `packages/contexts/insights/test/brief.test.ts`
- `packages/contexts/insights/test/brief-retirement.test.ts`
- `packages/contexts/insights/test/db/brief.test.ts`
- `apps/api/test/db/brief-retirement-port.test.ts`

**Edited (my own lines only, or the one line named):**

- `packages/contexts/insights/schema/index.ts` — the WP 5.6 re-export block, appended.
- `packages/contexts/insights/src/events.ts` — `BriefPublished`, appended to `INSIGHTS_EVENTS`.
- `packages/contexts/insights/src/index.ts` — the WP 5.6 labelled block, appended after WP 5.7's (before WP 5.3's, which landed after mine and appended after it in turn).
- `packages/contexts/insights/OWNERSHIP.md` — `advisory_briefs`, `advisory_brief_items` claimed.
- `apps/api/src/domain.ts` — `createInsightsRetirementImpactPort` and its two helpers, appended after `createInsightsPlanningPort`; the `@ctx/planning` and `@ctx/insights` import lists widened for the names it needs.
- `apps/api/src/reports/export/registry.ts` — the two tables added to `EXEMPT_TABLES`.
- `packages/db/test/migrate.test.ts` — the two tables added to the alphabetical list; the `0032_advisory_briefs` attribution block, placed after 0030's per the dispatch.
- `apps/api/test/phase3-registration.test.ts` — the `INSIGHTS_EVENTS` pin (a new `it`, `import { INSIGHTS_EVENTS }` added to the existing `@ctx/insights` import).

## 2. Migration 0032 and what it touches

`packages/db/migrations/0032_advisory_briefs.sql` — references only 0012-era objects (`insights`, `users`)
or its own, per 05 §4's ordering rule (0031, WP 5.3's, and 0033, WP 5.8's, are not referenced).

- `advisory_briefs` — one row per `(user_id, iso_week)`. `advisory_briefs_user_week_idx` (unique on
  `(user_id, iso_week)`) is the idempotency/immutability boundary `publishWeeklyBrief`'s
  `ON CONFLICT DO NOTHING` depends on. `nothing_material`, `cold_start`/`cold_start_note`, `input_digest`
  (`sha256:` over the canonical set of source insights), `published_at`.
- `advisory_brief_items` — one row per ranked or attention-strip item. Every displayed field is
  **snapshotted at publish time** — title, summary, severity, confidence, impact, evidence — never a join
  back through `insight_id` (nullable, `ON DELETE SET NULL`, click-through only): `store.ts`'s
  `upsertInsight` deletes and re-inserts `insight_evidence`/`insight_actions` on every re-run, so a Brief
  that read through would let this week's re-run answer last week's "why did it say $720?" (07 §7.3).
  Composite FK `(user_id, brief_id)` → `advisory_briefs (user_id, id)`. `retirement_effect` is the
  `RetirementImpactAnswer` stored whole (JSONB); `score`/`score_factors` are `NULL` together for an
  attention-strip item, which was never ranked by score.

Same commit: `packages/db/test/migrate.test.ts` — `'advisory_brief_items'`, `'advisory_briefs'` added to
the alphabetical table list (between `'advisors'` and `'allocation_targets'` — confirmed against
`String.prototype.localeCompare`, matching the query's `ORDER BY table_name`) and a
`// 0032_advisory_briefs:` attribution block placed after 0030's (WP 5.9's), before 0034's (the Phase 4
gate condition's) — the dispatch's own instruction, followed literally. `apps/api/src/reports/export/registry.ts`
— both tables added to `EXEMPT_TABLES`, the `insight_outcomes` precedent's wording reused: "insights (WP
2.6); not named in this WP's export scope", with the derivation noted (`advisory_brief_items` snapshots
`insights`/`insight_evidence`, both already exempt). `packages/contexts/insights/OWNERSHIP.md`:
`advisory_briefs`, `advisory_brief_items` claimed; `lint:schema-ownership`: ok, 108 claimed / 95 defined.
`db` project: 10/10 (§4 below).

## 3. `RetirementImpactPort` — declared, and the binding

`packages/contexts/insights/src/brief/ports.ts` declares `RetirementImpactPort` in Insights' own
vocabulary (`Money`, numbers, strings) — the same reason `PlanningPort` is declared in `src/ports.ts` for
`createInsightsPlanningPort`: 08 §1.6's arrows point down, and `@ctx/insights` may not import
`@ctx/planning` (`personalfi/layer-imports` denies `@ctx/*` → `@ctx/*` unconditionally). Its shapes —
`RetirementAgeEffect`, `MonthsOfSpendingEffect`, `RetirementEffect` — mirror `@ctx/planning`'s
`RetirementAgeAnswer`, `MonthsOfSpending`, `RetirementImpact` field-for-field, because the adapter's job is
to convert, not to redesign.

`apps/api/src/domain.ts#createInsightsRetirementImpactPort` binds it over `solveRetirementImpact` — the
Money-facing entry point wp5.5-planning.md §8.5 names, **never `earliestRetirementAge`**, the engine-unit
function an adapter must not call because it would have to cross the numeric boundary itself. The plan is
assembled one step past `createInsightsPlanningPort`'s: through `assembleInput` (not `assembleBaselinePlan`
alone), so a holder's stored one-off outflows (WP 5.5's carry) reach the plan the retirement effect is
computed against.

`effectOf`:

1. `getBaseline` — `null` → `{ kind: 'not_computable', reason: 'no_baseline' }` before any engine work.
2. `resolveForUser`, `createProjectionInputsReader(...).derivedInputs({ asOf: null, allowOpenDay: false })`,
   `listLifeEvents`, `assembleInput` — any `ProjectionRefused`/`ProjectionInputRefused`/`AssumptionOverrideRefused`
   (`isPlanningRefusal`, the same predicate `createInsightsPlanningPort` uses) is carried through **by its
   own code**, not swallowed into a generic reason.
3. `solveRetirementImpact(assembled.plan, resolved, action)`, converted field-for-field.

### The bound port reproduces a direct engine run for the same plan — real numbers

`apps/api/test/db/brief-retirement-port.test.ts`, over a real Postgres, a real baseline
(`birthDate: 1966-09-25`, `retirementAge: 65`, `planEndAge: 90`, `annualSpending: $40,000`,
`contributions.TAXABLE: $12,000`, `withdrawalPolicy: constant_real`), action `extra_annual $60/yr`:

| Field                  | Bound port                                                                                     | Direct `solveRetirementImpact` call                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `engineVersion`        | `personalfi.deterministic/1`                                                                   | `personalfi.deterministic/1`                                                                                                                                                                                                                                                                                                                                          |
| `assumptionsVersion`   | `sha256:4997f2ff…3b42be`                                                                       | `sha256:4997f2ff…3b42be`                                                                                                                                                                                                                                                                                                                                              |
| `plannedRetirementAge` | 65                                                                                             | 65                                                                                                                                                                                                                                                                                                                                                                    |
| `baseline`             | `unreachable`, `latest_age` (80), _"even retiring at 80 leaves spending the plan cannot fund"_ | same reason, same detail; the direct call's `shortfallAtLatest` ($52,194.67) is the one field the port's `RetirementAgeEffect` deliberately drops (`brief/ports.ts` mirrors `RetirementAgeAnswer`'s shape without the unreachable-branch's Money field — not read by either exit test, and not displayed by any WP 5.6 file; noted here rather than silently trimmed) |
| `withAction`           | `earliest`, age 79, `engineRuns: 9`                                                            | `earliest`, age 79, `verified: true`, `engineRuns: 9`                                                                                                                                                                                                                                                                                                                 |
| `yearsEarlier`         | `null` (baseline unreachable)                                                                  | `null`                                                                                                                                                                                                                                                                                                                                                                |
| `monthsOfSpending`     | 9 months, at age 65, wealth diff `$32,226.88`, first-year spending `$40,000.00`                | identical, byte-for-byte on the two `Money` values (`Money.equals`)                                                                                                                                                                                                                                                                                                   |

This baseline genuinely does not sustain to age 80 on its own (the profile's stated contributions are
modest against $40k of spending) — the $60/yr action is what makes it reachable at all, at 79. That is a
more informative proof than a comfortable plan would have been: it exercises the `unreachable` branch of
`RetirementAgeEffect` for real, not only in the pure `brief-retirement.test.ts` fixture. Full test:
`WP 5.6's RetirementImpactPort reproduces a direct engine run > the bound port reproduces a direct engine
run for the same plan exactly` — **passed**.

## 4. Ranking — a Brief built with every candidate, scored

`packages/contexts/insights/src/brief/ranking.ts`'s `scoreOf`: `effectiveImpactMinor × confidence ×
actionability × urgency × (1 − 0.5·dismiss_rate)` — WP 2.7's `actionabilityOf`/`urgencyOf`/`DISMISS_PENALTY`
and WP 2.6's `effectiveImpactMinor`, reused verbatim; `rank()`'s severity-dominant term is not composed in
at all (05 §3's own instruction — see the sabotage in §6). Ten candidates, one script run
(`assembleBrief` called directly, the same function `test/brief.test.ts` and `brief/job.ts` call):

| Key                                   | Family     | Severity   | Claimed  | Score            | In the five?                    | Why                                                                                                                                                                                                           |
| ------------------------------------- | ---------- | ---------- | -------- | ---------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spending.fee_hunter.a`               | spending   | warning    | $720.00  | 50,400.0         | **Yes, #1**                     | highest score                                                                                                                                                                                                 |
| `debt.rate_above_market.a`            | debt       | warning    | $640.00  | 44,800.0         | **Yes, #2**, carried            | 2nd highest; carried from last week (seeded in `carriedIdentities`)                                                                                                                                           |
| `investing.expense_ratio.a`           | investing  | notable    | $480.00  | 33,600.0         | **Yes, #3**                     | 3rd highest                                                                                                                                                                                                   |
| `investing.idle_cash.a`               | investing  | info       | $310.00  | 21,700.0         | **Yes, #4**                     | 4th highest — an `info`-severity finding outranks every remaining `notable`/`urgent` one below it, because dollar impact and not severity is the key                                                          |
| `spending.category_anomaly.a`         | spending   | notable    | $215.00  | 15,050.0         | **Yes, #5**                     | 5th highest; spending's 2nd — the family cap (2) is not yet binding here since no 3rd spending candidate scored above it                                                                                      |
| `retirement.savings_rate.a`           | retirement | notable    | $180.00  | 12,600.0         | No                              | 6th highest score; the five slots were already full                                                                                                                                                           |
| `spending.new_merchant_high_charge.a` | spending   | notable    | $98.00   | 6,860.0          | No                              | would be spending's 3rd — excluded by score alone here (below `retirement.savings_rate.a`); §6's sabotage shows the family cap excluding a _higher_-scored 3rd spending item when three compete for two slots |
| `crypto.idle_stablecoins.a`           | crypto     | info       | $60.00   | 4,200.0          | No                              | score too low                                                                                                                                                                                                 |
| `debt.missed_payment.a`               | debt       | **urgent** | _(none)_ | — (never scored) | **Attention strip**, position 0 | no dollar figure at all; never competes for a ranked slot                                                                                                                                                     |
| `spending.category_anomaly.b`         | spending   | notable    | $12.00   | — (never scored) | No (below the $50 floor)        | `isBelowFloor` excludes it before scoring — the same $50 floor `policy/alert-budget.ts` uses, reused unchanged                                                                                                |

`nothingMaterial = false`, `coldStart = false` (default `historyDays: 60`, above the 30-day threshold).

**Nothing-material week:** the same assembly called with only the below-floor candidate present —
`ranked.length = 0`, `nothingMaterial = true`, `attention.length = 0`. No filler item is produced.

**Cold-start week:** the same ten candidates with `historyDays: 12` — `coldStart = true`, and
`coldStartNote`: _"Under 30 days of advisor history, so trend-based findings — spending creep, category
baselines, subscription drift — are not yet assessable; only what a single snapshot can show is
included."_ Ranking itself is unaffected by `historyDays` (it is a per-item score, not a trend), which is
the honest limit of what `assembleBrief` can say about "what it cannot yet assess" without a real
first-seen-date signal per finding — recorded as a scope decision, not hidden: `historyDays` is measured
from `advisor_runs.started_at` (`brief/store.ts#historyDaysAsOf`), i.e. "how long has this deployment been
watching your finances", the only signal available to a job that may not read `@ctx/ledger` directly.

## 5. Persistence and idempotence

`test/db/brief.test.ts`, a real Postgres, a custom advisor (not `harness.ts`'s `selfCiting`, which
deliberately carries neither impact nor an action — a Brief candidate needs both) with one insight, $800
annualised, citing the account balance the test set to exactly $800 so the evidence-value check and the
numeral trace both pass without a derivation.

- `'the Brief is idempotent per ISO week and immutable once published'` — first `publishWeeklyBrief` call:
  `alreadyPublished: false`, one item written, the fake `RetirementImpactPort` called once. Second call,
  same `isoWeek`: `alreadyPublished: true`, **same** brief id, **same** item id, the port **not called
  again** (the short-circuit runs before any engine work, so idempotence also means no wasted compute) —
  **passed**.
- `'every retirement effect on a published Brief names the engine and assumptions versions that computed
it'` — the published item's stored `retirement_effect` reads back `kind: 'computed'` with
  `engineVersion`/`assumptionsVersion` equal to what the fake port answered — **passed**.

## 6. Sabotages, recorded as they happened — all red on the first try, all restored

1. **The severity-dominant term added back.** `brief/ranking.ts#scoreOf`'s score composed through
   `policy/alert-budget.ts`'s `rank()` (log-scaled magnitude + `severityRank(...) × 10`) instead of the raw
   `effectiveImpactMinor` × the four factors.
   `test/brief.test.ts > 'the Brief holds at most five actions ranked by dollar impact times confidence,
not by severity'` → **red**: `rank(urgent, $60) ≈ 33.8` (severity term 30 + `log10(6000) ≈ 3.78`)
   outranked `rank(info, $1000) ≈ 5.0`, so the $60 urgent finding entered the ranked five and the $1,000
   `info` finding was no longer guaranteed first — exactly wp4.9 §12's finding, reproduced one layer up, at
   the magnitudes that make it bite (a log-scaled term is dominated by a linear one at the dollar sizes the
   floor already guarantees; `rank()`'s term is not). Restored; confirmed green.
2. **The family cap removed.** `selectRanked`'s `if (count >= MAX_PER_FAMILY) continue;` short-circuited
   to `if (false && …)`.
   `test/brief.test.ts > 'no rule family takes more than two of the five'` → **red**:
   `families.filter(f => f === 'spending')` read length 3, not 2 — three `spending.*` items (fee hunter,
   two category-anomaly variants) filled three of the five slots. Restored; confirmed green.
3. **The attention strip merged into the ranked competition.** `assembleBrief` changed to score every
   eligible candidate (0 for one with no dollar figure) and take the top five by `score` then `key` alone —
   wp4.9 §12 item 1's exact bug, reproduced one layer up from `rank()`/`applyAlertBudget` into
   `assembleBrief`/`selectRanked`.
   `test/brief.test.ts` → **two red**: `'no rule family takes more than two of the five'` (the merge also
   collapsed the family cap, a compounding finding recorded rather than treated as noise) and
   `'an urgent finding with no dollar figure goes to the attention strip and is never dropped by a key
tie-break'` — `expected [] to include 'a.overdraft_ahead'`: the urgent no-dollar finding lost every one
   of the five slots to candidates whose keys sorted ahead of it, and the attention strip came back empty.
   Restored; confirmed green.
4. **The retirement effect computed even with no dollar figure.** `brief/retirement.ts#retirementEffectOf`'s
   `if (action === null) return NO_DOLLAR_FIGURE_ANSWER;` guard short-circuited to `if (false && …)`, and a
   zero-action fallback substituted so the port was called regardless.
   `test/brief-retirement.test.ts > "a retirement effect is only ever the port's answer: an item without
one says not computable and shows no figure"` → **red**: the no-figure candidate's effect came back
   `{ kind: 'computed', … }` (the fake port's fixed answer) instead of `not_computable` — exactly the
   failure the exit test's name describes, and the second assertion (`calls` stayed at 1) would have caught
   it even had the first not. Restored; confirmed green.
5. **The immutability guard removed.** Two changes together, both needed to expose it: the pre-check
   short-circuit (`findBriefByWeek` before any write) gated to `false ? … : null`, and
   `.onConflictDoNothing(...)` changed to `.onConflictDoUpdate(...)`.
   `test/db/brief.test.ts > 'the Brief is idempotent per ISO week and immutable once published'` → **red**:
   the second `publishWeeklyBrief` call reached the item insert with a **freshly generated** `brief_id` that
   no longer matched the (now-updated) existing `advisory_briefs` row, and Postgres itself refused it —
   `error: insert or update on table "advisory_brief_items" violates foreign key constraint
"advisory_brief_items_brief_fk"`. A stronger failure than a silent duplicate would have been: removing
   the guard does not merely rewrite the week, it corrupts the write immediately, caught by the schema as a
   second line of defence beside the missing application-level guard. Restored; confirmed green
   (`test/db/brief.test.ts`: 2/2 again).

All five sabotages, plus the retirement-port test, plus the full `insights`/`insights-db`/`db` project run,
are recorded above with their exact failure text — nothing here is a paraphrase of a result not actually
observed.

## 7. Wiring for the orchestrator (`apps/api/src/modules.ts` — not edited by this WP)

`insightsModule` (the function that builds `module.insights`'s `ModuleRegistration`) needs three additions,
all inside the branch already guarded by `options.advisorTokenSecret !== undefined` (the same
feature-detection `createRunLocalJob` is already inside):

**7.1 Two import lines.**

```ts
// from './domain.ts' (alongside createInsightsPlanningPort)
createInsightsRetirementImpactPort,
```

```ts
// from '@ctx/insights' (alongside createRunLocalJob)
createBriefJob,
registerWeeklyBriefSchedule,
```

**7.2 The job**, added to `insightsModule`'s `jobs: [...]` array beside `createRunLocalJob({ database,
dependencies, clock })`:

```ts
createBriefJob({
  database,
  retirementImpactPort: createInsightsRetirementImpactPort(database, {
    timeZone: options.timezone,
  }),
  timeZone: options.timezone,
  // No config key yet — `dependencies.settings.baseCurrency` above has the same
  // reason (wp2.6-insights.md §6 open item 3): every account in this
  // deployment is USD today.
  currencyCode: 'USD',
  clock,
}),
```

**7.3 The schedule**, added inside `insightsModule`'s `schedules` callback, beside the existing
`registerInsightsNightlySchedule` call:

```ts
schedules: async (userId: string): Promise<void> => {
  await registerInsightsNightlySchedule(database, { userId, timezone: options.timezone }, clock);
  // WP 5.6: Sunday 06:00 local, after the nightly advisor pass (04:15) and
  // the projection refresh (04:30).
  await registerWeeklyBriefSchedule(database, { userId, timezone: options.timezone }, clock);
},
```

`WEEKLY_BRIEF_SCHEDULE_NAME = 'insights.weekly_brief'` matches `SCHEDULE_NAME_PATTERN`
(`^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`) — checked by inspection against the same regex `jobs.ts`'s
`SCHEDULE_NAME` already satisfies; `upsertSchedule` itself asserts it at registration, so a typo here would
fail loudly at boot rather than crash-looping the worker (the Phase 2 lesson §4 item 4 names).
`BRIEF_JOB_KIND = 'insights.brief'` likewise matches the job-kind pattern.

## 8. Needs the orchestrator (outside this WP's files)

1. **§7's three additions**, then `just verify`.
2. **Whether the narration enqueue should be feature-detection-gated on the narrator being registered.**
   `brief/job.ts#createBriefJob` enqueues `insights.run_local` for `WEEKLY_BRIEF_NARRATOR_ADVISOR_ID`
   (`'local.narrator'`) unconditionally after every first publish. If `LOCAL_MODEL_ENDPOINT`/
   `LOCAL_MODEL_DIGEST` are unset (the default — kill level 2 is off by default), WP 5.3's narrator is
   never registered, and that job will fail when the worker picks it up (`runAdvisor` refuses an unknown
   advisor). This is bounded — one job per published week, visible in `job_runs`, never retried into a
   crash-loop — but it is a failed row a fresh install will always show once the first Brief publishes with
   the local model off. Two honest options, both cheap: (a) leave it, and record in the RUNBOOK that one
   `insights.run_local` failure per week is expected with the model off; (b) have W-C's wiring pass
   `createBriefJob` a boolean (`narratorConfigured: options.localModelConfigured`, the same flag
   `createRunSwitches` above already reads) and skip the enqueue when it is false. Not decided here because
   it is a W-C composition-root call, not a `brief/**` one — `brief/job.ts` does not know whether the
   narrator is registered, on purpose (WP 5.1's local-model lane is the only place that distinction already
   lives).
3. **The health score (WP 5.8) and the outcome check folding into the weekly job**, per §4's Wave D wiring
   note — not this WP's; `insights.brief`'s own job body has no knowledge of either and adds nothing that
   would need to change for them to be added beside it.
4. **`RetirementImpactPort` binding is now proven exact** (§3) — a later change to `solveRetirementImpact`'s
   signature or return shape will fail `pnpm typecheck` in `domain.ts` before it fails anything at runtime,
   the same safety `createInsightsPlanningPort`'s header already describes for its own binding.

## 9. `just check`

Not run as a whole-repo command (WP 5.3's compose-adjacent work and the general Phase 5 rule against
believing a `just check`/`just verify` run on this tree mid-wave). In its place, run individually and
recorded above: `pnpm run typecheck` (whole monorepo, repeated after every change, last clean); the
`insights`, `insights-db`, `db` vitest projects together (335 passed, 1 skipped); `api`'s
`phase3-registration.test.ts` (16 passed); `api-db`'s `brief-retirement-port.test.ts` (1 passed) and
`export-import-phase3-phase4.test.ts` (4 passed, the export-registry completeness self-check);
`node scripts/check-numeric-boundaries.ts` (0 violations); `node scripts/check-schema-ownership.ts` (ok);
`node scripts/check-ci-projects.ts` (42/42, unchanged). `eslint` run scoped to every file this WP touched:
one real finding (an unused parameter in a test fixture), fixed, re-run clean.

This report is posted before the final verification run, per the phase rule; nothing below this line is
added after it except that run's own result, appended.

## 10. Final verification result

Run after §0–9 were written, foreground, in groups (no `just check`/`just verify`, per the phase rule):

1. `pnpm run typecheck` — whole monorepo — **clean, exit 0**.
2. `npx vitest run --project insights --project insights-db --project db --project api` — **59 test files,
   433 tests passed, 1 skipped, 0 failed.** This is the broadest run this WP's evidence makes: every WP 5.3
   file landed in the same tree by then (its own labelled `index.ts` block, `advisors/local/**`, migration
   0031, its own test files) is exercised alongside mine with no regression either way.
3. `npx eslint` over every file this WP touched (§1's list) — **clean, exit 0** (the one earlier finding —
   an unused `request` parameter in `test/db/brief.test.ts`'s `worthyInsight` fixture — fixed before this
   run, not during it).
4. `npx prettier --check` over every file this WP touched, `.md` included, `.sql` excluded (this prettier
   install has no SQL parser — true of every other migration in the tree, not particular to 0032) —
   **"All matched files use Prettier code style!"**
5. `node scripts/check-numeric-boundaries.ts` — **0 violations**, 853 files scanned.
6. `node scripts/check-schema-ownership.ts` — **ok**, 108 claimed / 95 defined.
7. `node scripts/check-ci-projects.ts` — **42/42** (unchanged; this WP adds no vitest project).
8. `git status --porcelain` — every changed or new path is one this WP's Ownership section names, or is
   WP 5.3's (untouched by me, not staged, not committed — no commits were made).

No red anywhere in the final pass. The five sabotages in §6 and the `1`/`0` counts above are the only
claims in this document about what a test run showed; nothing here is asserted without the command that
produced it shown beside it.
