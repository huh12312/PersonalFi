# WP 9.7 — Plan screens: C-8 honesty, C-10 goals, questionnaire, forking

Written incrementally; a finisher resumes from the last section that is filled in. State at each save is in
§0.

## 0. Progress marker

- [x] Red tests written first for C-8 (8 tests in `e2e/plan.spec.ts`, `e2e/plan-sliders.spec.ts`), all red at
      HEAD `beaa8be` for the reasons in §2.
- [x] C-8 implemented, green (e2e 18/18 in plan + plan-sliders; 77 unit tests in features/plan); sabotage batch §3.1 run and restored.
- [x] C-10 implemented (goals, questionnaire, forking), sabotage-proven (§3.2, §3.3).
- [x] Unit tests, axe both themes, screenshots (45 PNGs, §4). Final check: §9.

## 2. Red first, at HEAD `beaa8be` (src untouched, `pnpm exec playwright test … --workers=1`)

| Test (verbatim)                                                                        | Red at HEAD because                                                                                                                                 |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| every projection problem code reads as words                                           | `getByTestId('plan-problem')` not found for the first code (`planning.scenario_not_found`): the screen has no error branch                          |
| a deterministic run is never phrased as a probability                                  | headline read `You're on track for +$180,000.00 … at age 65 — 100% of plans succeed.` for a `method: deterministic` run (G4-13, the exact sentence) |
| a stale run says so and names its version                                              | `plan-run-stale` not found: no surface reads `status: 'stale'` / `staleness`                                                                        |
| (extra) a stale answer with no stored run says so instead of projecting forever        | `plan-run-stale` not found                                                                                                                          |
| (extra) saving an assumption override re-reads the projection                          | PUT overrides invalidated `GET /assumptions` only: the projection POST count stayed at 1 for 10 s (G4-16)                                           |
| (extra) only paths the engine reads are offered as overrides                           | 17 `Edit` buttons for 17 overridable paths; expected 9 (O-5)                                                                                        |
| the preview's starting balance is the sealed net worth, or is labelled a placeholder   | starting balance field read `250000` while the series route's newest sealed day was `612345` (G4-11)                                                |
| (extra) a deterministic saved plan is never quoted as a share of paths (worker absent) | fallback line read `Your saved plan: 100% of simulated paths succeed.`                                                                              |

## 3. Sabotage log (recorded as it happens)

Backups of the six files taken to `/tmp/wp97-sab/` before the batch; each file restored by `cp` and verified
with `git diff --stat`-free comparison (`cmp`) against the backup afterwards.

### 3.1 C-8 batch (six sabotages applied together; every test is independent, so each red is attributable)

| #   | Sabotage (file)                                                                                   | Expected red                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| S1  | delete the `planning.projection_no_balances` entry from `PROBLEM_WORDS` (`problem-words.ts`)      | e2e 'every projection problem code reads as words'; `problem-words.test.ts`                                                        |
| S2  | `deterministic.phrasing: 'single_path'` → `'probability'` (`engine.ts`)                           | e2e 'a deterministic run is never phrased as a probability'; `engine.test.ts`, `PlanHeadline.test.tsx`, `ScenarioCompare.test.tsx` |
| S3  | drop `currentVersion` from the `assumptions_changed` sentence (`StaleRunNotice.tsx`)              | e2e 'a stale run says so and names its version'; `StaleRunNotice.test.tsx`                                                         |
| S4  | remove `invalidateProjections(queryClient)` from the override mutation (`api.ts`)                 | e2e 'saving an assumption override re-reads the projection'; `PlanScreen.test.tsx`                                                 |
| S5  | drop the `!point.sealed` guard in `pickSealedStart` (`sliders/sealedStart.ts`)                    | e2e 'the preview's starting balance is the sealed net worth…'; `sealedStart.test.ts`, `GoalSliders.test.tsx`                       |
| S6  | add `'capitalMarket.tips.expectedReturn': 'both'` to `ENGINE_READ_PATHS` (`engine-read-paths.ts`) | e2e 'only paths the engine reads are offered as overrides'; `engine-read-paths.test.ts`                                            |

**Result (2026-10-06 20:4x, all six applied together, then `cmp`-verified restored):** unit — 21 red across the
suites named above (`vitest run src/features/plan`); e2e — 7 red, each the named test: 'every projection problem code
reads as words' (S1: `planning.projection_no_balances` fell to `data-problem-words="fallback"`), 'a deterministic
run is never phrased as a probability' (S2: the headline phrased a deterministic run as a probability) and the
sliders-fallback test (S2), 'a stale run says so and names its version' (S3: `assumptions_changed` lost
`assumptions-2`), 'saving an assumption override re-reads the projection' (S4: POST count never rose), 'the preview's
starting balance is the sealed net worth, or is labelled a placeholder' (S5: the open day's balance was used),
'only paths the engine reads are offered as overrides' (S6: 10 `Edit` buttons for 9 expected). The other 11 e2e stayed
green, so each red is that sabotage's and no other's. Restored; unit 77/77 and no `SABOTAGED` left in the tree.

### 3.2 C-10 batch (six sabotages applied together; backups in `/tmp/wp97-sab2/`)

| #   | Sabotage (file)                                                                                               | Expected red                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| G1  | the "Add goal" `<Button>` becomes a `<div onClick>` with no role or tabindex (`GoalsScreen.tsx`)              | e2e 'a goal can be created, edited, funded and deleted by keyboard alone' (`tabTo` never reaches it); unit `GoalsScreen` |
| G2  | the goal's `ConfirmDialog` `onConfirm` stops calling the delete mutation (`GoalsScreen.tsx`)                  | same e2e (`No goals yet` never appears); unit 'deletes a goal only after the confirmation'                               |
| G3  | the contribution form sends `source: 'DERIVED'` instead of `'USER'` (`ContributionsPanel.tsx`)                | same e2e (`source: 'USER'` and "entered by you"); unit 'funds a goal…'                                                   |
| G4  | the questionnaire sends `answers: {}` (`RiskQuestionnaire.tsx`)                                               | e2e 'the questionnaire produces a risk profile the plan reads'; unit `RiskQuestionnaire`                                 |
| G5  | the plan's risk card prints a constant "Moderate" instead of the stored tolerance (`RiskProfileSummary.tsx`)  | same e2e (plan shows `Conservative`); unit `RiskProfileSummary`                                                          |
| G6  | the plan's fork form `onCreated` does nothing, so the new fork is not put into the compare (`PlanScreen.tsx`) | e2e 'a scenario can be forked and compared'                                                                              |

**Result (all restored by `cp` from `/tmp/wp97-sab2/`, `cmp`-verified):** unit — 9 red across `GoalsScreen`, `RiskQuestionnaire`
and `RiskProfileSummary` (G1 broke the whole `GoalsScreen` suite at its first step; G6 is in `PlanScreen`, which no
unit test of the fork wiring covered — added afterwards, §3.3). e2e, first run with all six: 'a goal can be
created, edited, funded and deleted by keyboard alone' red at `tabTo` (G1: the "Add goal" `<div>` has no role, so
the keyboard never reaches it — the structural proof of "by keyboard alone"), 'the questionnaire produces a risk
profile the plan reads' red (G4: the PUT carried `{}`), 'a scenario can be forked and compared' red (G6:
`Scenario A` stayed `""`). G1 masked G2 and G3 in the keyboard test, so each was re-run alone: G3 → red at
`toContainText('entered by you')` (the row said "worked out from your history"); G2 → red at `No goals yet`
(the goal was still there). G5's e2e attribution rode on G4 (the same test); its unit test is the separate proof.

### 3.3 Follow-ups to §3.2

- G6 had no unit-level proof, only the e2e. Added `PlanScreen.test.tsx` 'puts a freshly forked scenario straight into
  the compare against the baseline (C-10)'; with `onCreated={() => undefined}` it is red (1 failed), restored
  (`grep -c` of the sabotage line: 0), green (12/12).
- G5 on its own against the e2e: `RiskProfileSummary` printing `TOLERANCE_LABELS['moderate']` made 'the questionnaire
  produces a risk profile the plan reads' fail at `toContainText('Conservative risk tolerance')`, received "Moderate risk
  tolerance, answered 2026-10-06…". Restored.

## 1. What the package closes

| Item                                                                                        | Closed by                                                                                                                                                             | Where on screen                                                         |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| CF-15 / C-8, G4-10: an error rendered as "Projecting your plan…"                            | `ProjectionProblem`, `problem-words.ts` (43 projection codes plus 13 goal/questionnaire codes, each with its own sentence), `PlanHeadline`                            | plan headline and section; compare panel; required-savings result       |
| C-8, G4-13: "100% of plans succeed" for a deterministic run; section labelled "Monte Carlo" | `engine.ts` (table keyed by the contract's `method` enum), `PlanHeadline`, `ScenarioCompare`, `FanChart` (no band swatches, "projected path"), `GoalSliders` fallback | headline, section heading and source line, compare cards, chart legend  |
| C-8, G4-16: stale status never shown; an override left the headline quoting the old run     | `StaleRunNotice` (all three `ProjectionStaleness` arms), `invalidateProjections` on the override PUT                                                                  | notice under the headline; 9.2's notices are unchanged and not repeated |
| C-8, G4-11: preview seeded from $250,000                                                    | `sliders/sealedStart.ts`, `useSealedStart.ts`, `GoalSliders`                                                                                                          | the "Starting balance" source line and the "Illustration only" note     |
| C-8, O-5: eight overridable paths nothing reads                                             | `engine-read-paths.ts`, `AssumptionsPanel`                                                                                                                            | assumptions panel                                                       |
| C-10: goal CRUD and contributions, questionnaire, forking                                   | `features/goals/*`, `ScenarioForkForm`, `RiskProfileSummary`, route `/goals`, nav line                                                                                | `/goals`, the plan's risk card, the compare section                     |

Exit tests (verbatim names) and where each lives:

| Exit test                                                                            | File                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| every projection problem code reads as words                                         | `e2e/plan.spec.ts` (codes read from the API's typed tables); `problem-words.test.ts`              |
| a deterministic run is never phrased as a probability                                | `e2e/plan.spec.ts` (methods read from `openapi.json`)                                             |
| a stale run says so and names its version                                            | `e2e/plan.spec.ts` (arms read from `openapi.json`)                                                |
| the preview's starting balance is the sealed net worth, or is labelled a placeholder | `e2e/plan-sliders.spec.ts`                                                                        |
| a goal can be created, edited, funded and deleted by keyboard alone                  | `e2e/goals.spec.ts` (zero `pointerdown`/`mousedown`/`touchstart` events recorded across the flow) |
| the questionnaire produces a risk profile the plan reads                             | `e2e/goals.spec.ts`                                                                               |
| a scenario can be forked and compared                                                | `e2e/goals.spec.ts`, `PlanScreen.test.tsx`                                                        |

Extra tests beyond the list: a stale answer with no stored run; saving an override re-reads the projection (G4-16);
only engine-read paths are offered (O-5); a deterministic saved plan is not quoted as a share of paths when the Web Worker
is absent; the plan screen with the fork form and risk card axe clean in both themes; the goals screen, the goal dialog
and the delete confirmation axe clean (the confirmation in dark is the CF-9 known-defect test, §8).

## 2a. Per-item table

| Item                              | Red at HEAD        | Fix                                                                    | Green                     | Files                                                                         |
| --------------------------------- | ------------------ | ---------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------- |
| Problem codes in words            | §2 row 1           | `problem-words.ts`, `ProjectionProblem.tsx`, `PlanScreen.tsx`          | e2e (43 codes)            | `features/plan/problem-words.ts`, `ProjectionProblem.tsx`, `PlanHeadline.tsx` |
| Engine named, never a probability | §2 row 2           | `engine.ts`, `PlanHeadline.tsx`, `ScenarioCompare.tsx`, `FanChart.tsx` | e2e                       | `features/plan/engine.ts` and those                                           |
| Stale run                         | §2 rows 3, 4       | `StaleRunNotice.tsx`                                                   | e2e (3 arms + no run)     | `features/plan/StaleRunNotice.tsx`                                            |
| Override invalidates projection   | §2 row 5           | `api.ts` `invalidateProjections`                                       | e2e + unit                | `features/plan/api.ts`                                                        |
| Engine-read overrides only        | §2 row 6           | `engine-read-paths.ts`, `AssumptionsPanel.tsx`                         | e2e + source-derived unit | `features/plan/engine-read-paths.ts`                                          |
| Sealed starting balance           | §2 row 7           | `sealedStart.ts`, `useSealedStart.ts`, `GoalSliders.tsx`               | e2e + unit                | `features/plan/sliders/*`                                                     |
| Goals, contributions              | new; sabotage §3.2 | `features/goals/*`                                                     | e2e keyboard + unit       | `features/goals/*`                                                            |
| Questionnaire                     | new; §3.2          | `RiskQuestionnaire.tsx`, `RiskProfileSummary.tsx`                      | e2e + unit                | `features/goals/*`                                                            |
| Forking                           | new; §3.2, §3.3    | `ScenarioForkForm.tsx`                                                 | e2e + unit                | `features/plan/ScenarioForkForm.tsx`                                          |

## 4. 04 §5 item 3, walked on screen

Test 'the Phase 4 on-screen steps walk end to end, in both themes' (`e2e/goals.spec.ts`) asserts each step and
photographs it. **The screenshots were written explicitly, once, from the specs** (`PLAYWRIGHT_EVIDENCE_DIR=docs/evidence/phase-9`
with `-g "plan screen honesty|starting balance is the sealed|goals, questionnaire and forking"`, so the committed
`wp4.10-*`/`wp4.11-*` files were not touched; an ordinary run writes to the gitignored default). They are against the specs'
mocks, not a live stack; the live cold-install walk is the gate's.

| Step                                                            | Asserted                                                                                                                                                                            | Screenshots (`docs/evidence/phase-9/`)      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| a goal is created                                               | card shows $2,000,000.00 by 2050-04-12                                                                                                                                              | `wp9.7-step1-goal-created-{light,dark}.png` |
| questionnaire answered inconsistently, score moves conservative | result "Conservative"; "Averaging your answers would have said moderate"                                                                                                            | `wp9.7-step2-risk-conservative-*.png`       |
| fan chart with labelled median                                  | `median` on the chart, section "Monte Carlo fan chart", source line                                                                                                                 | `wp9.7-step3-fan-chart-median-*.png`        |
| dotted gap line returns a required monthly saving               | "Save an additional …"                                                                                                                                                              | `wp9.7-step4-required-saving-*.png`         |
| life event moved with the keyboard                              | `aria-valuetext` changed after ten ArrowRight                                                                                                                                       | `wp9.7-step5-life-event-moved-*.png`        |
| two scenarios compare                                           | fork created, put into the compare, "36 months earlier"                                                                                                                             | `wp9.7-step6-two-scenarios-compare-*.png`   |
| every assumption shows source and date                          | `Source:` / `As of` visible                                                                                                                                                         | `wp9.7-step7-assumptions-cited-*.png`       |
| saved projection re-opened                                      | after a reload the headline and source line are identical text. Byte-identity of the stored run is the API's property (the `projection_runs` cache hit), which a screen cannot show | `wp9.7-step8-reopened-*.png`                |

C-8 views in both themes: `engine-deterministic`, `engine-monte_carlo`, `stale-<arm>` (three), `problem-last-code`,
`start-balance-sealed`, `start-balance-placeholder`, `assumptions-engine-read-only`. C-10: `goal-created`, `goal-funded`,
`goals-{light,dark}`, `goal-dialog-dark`, `risk-result-*`, `plan-risk-profile-*`, `fork-and-compare-*`. The `engine-*` and
`stale-*` shots were taken while the risk card and the sealed-balance lookup were still on their loading states (those
routes are unmocked in those tests); the `start-balance-*` shots show the lookup settled.

## 6. Decisions

- **Where the problem codes come from.** The OpenAPI document does not enumerate them (`Problem.code` is a free string;
  the only `planning.*` code in `openapi.json` is `scenario_levers_empty`, in a description). The list is the API's own
  typed tables: `ProjectionRefusalCodeWp46` (`projection-store.ts`), `ProjectionRefusalCode` (`engine/boundary.ts`),
  `MonteCarloRefusalCode` and the two timeout/worker codes (`engine/worker-host.ts`), the assumptions refusals
  (`routes/domain-errors.ts`), and `PlanningErrorCode` minus earmarks (`errors.ts`). The vitest (`import.meta.glob`,
  `?raw`) and the e2e (`node:fs`) both read those files; a code with no sentence fails both. **Finding for the
  orchestrator:** publishing the code list in the contract (an enum on `Problem.code` per operation) would turn this
  source read into a generated check.
- **Where the words live.** One table, `features/plan/problem-words.ts`; `ProjectionProblem` renders it and shows the
  server's `detail` verbatim beneath, with the code and `correlationId`. An unknown code falls back by status and says so
  (`data-problem-words="fallback"`), which is what the e2e keys on. A refusal (4xx) is not retried by the projection
  query; a 5xx or dropped connection is retried once and offers "Try again".
- **Deterministic wording.** "On this one path the balance is $X at age N, and the plan lasts to the end of the plan /
  runs out of money before the plan ends." The section is "Deterministic projection", the chart says "projected path"
  (not "median"), band swatches are hidden, and the compare cards show an outcome with no Δ-probability. A method the app
  does not know is named as unrecognised and never phrased as a probability; the table is typed by the contract's `method`
  enum, so a new one is a compile error.
- **Starting balance field.** The series route carries `netWorth` and `investable`; the engine projects investment-bucket
  assets, so the preview uses the newest sealed day's `investable` (not `netWorth`, which includes a house and loans). A
  day with `sealed: false` is never used; a non-USD base currency, no sealed day, or a failed read is a placeholder.
  Placeholder label: "Starting balance: $250,000 is a placeholder, not your data — <reason>", plus "Illustration only:
  the starting balance is a placeholder, not your data." on the sentence it feeds; spending and savings that fall back to
  the panel's defaults are named the same way. The preview waits for the lookup to settle.
- **O-5.** `ENGINE_READ_PATHS` has nine paths (four read by both engines, five by Monte Carlo only and labelled so);
  eight say "Not used by the current engine". `engine-read-paths.test.ts` extracts the reads from `boundary.ts` and fails
  if the table and the engine disagree.
- **The plan "reads" the risk profile by displaying it** (`GET /risk-profile`) and says plainly that the projection does
  not use it: the glidepath is set in the baseline plan. Nothing in `planning` feeds the profile to the engine.
- **Not built:** funding accounts on a goal (`fundedFromAccountIds`, optional in the contract). Priority is shown as a
  plain 1–5 with no direction claimed (neither contract nor schema says which end is first).
- **Status Badge is neutral**, not `accent` (the shared accent Badge is 4.28:1 in dark).

## 7. Wiring for the orchestrator

- `apps/web/playwright.config.ts`: **applied by me**, `goals` added to the chromium `testMatch` regex (one entry).
- `apps/web/src/routeTree.gen.ts`: regenerated by the Vite router plugin (21 lines for `/goals`, not hand-edited); commit it
  with this package. `apps/web/src/app/shell/nav-items.ts`: `'/goals'` added to `NavPath` and one `NAV_GROUPS` line
  (Wealth). **Not done:** `MORE_NAV_ITEMS` (the mobile "More" sheet) has no Goals entry, so on a phone `/goals` is reachable
  only from the plan's risk card; one line there closes it.
- Shared mock (`e2e/support/mock-plan.ts`): **no change needed.** The handlers a shared mock would want are
  `installServer` in `e2e/goals.spec.ts` (`/goals`, `/goals/{id}/contributions`, `/risk-profile`, a forkable
  `/plan/scenarios`, id-driven `/plan/compare`). Specs that mount `/plan` against the shared mock alone see
  `/risk-profile` and `/net-worth/series` go to the dev proxy (a worded error and a placeholder).
- Nothing else.

## 8. Open items

For 9.8 (WCAG sweep):

- **CF-9 confirmed live:** the delete confirmation's destructive button (`bg-money-neg text-white`) fails `color-contrast`
  in dark. `e2e/goals.spec.ts` 'the delete confirmation is axe clean in dark' is `test.fail(...)`: it passes while the defect
  stands and goes red when 9.8 fixes the token; delete the annotation then.
- The shared accent `Badge` (4.28:1 dark) was avoided, not fixed.
- Dialogs portal out of `#app-content`; I scanned the goal dialog and the delete confirmation directly with the injected
  axe (`[role="dialog"]`, both themes): clean except the CF-9 button. Scans must wait for `getAnimations()` to drain first
  (a mid-fade dialog and a mid-transition theme change both produced false `color-contrast` hits).
- Focus: the goal dialog focuses its first field on open and Escape closes it (the keyboard test covers both). Native
  `<select>` and `type="date"` throughout; the date field takes typed digits.
- The top bar repeats the page title as an `<h1>` beside the screen's own `<h1>`: two `h1`s per screen (my tests scope to `main`).

For the orchestrator and later packages:

- No `DELETE /plan/scenarios`: a fork cannot be removed from the UI and the selectors only grow.
- The questionnaire's `taxBracketBand` is stored but not shown. Goals show no progress (no balance-toward-goal field in the contract).
- `GoalSliders` seeds spending and savings from placeholders when the plan states none; they are labelled, not sourced.

2026-10-06, end of session:

- `pnpm --filter @app/web typecheck` (`pnpm run gen && tsc -b --noEmit`): clean.
- `vitest run src/features/plan src/features/goals src/app`: 18 files, 100 tests passed.
- `playwright test e2e/plan.spec.ts e2e/plan-sliders.spec.ts e2e/goals.spec.ts --project=chromium --workers=1`: 25 passed
  (the 5th, 'the delete confirmation is axe clean in dark', is the expected-failure CF-9 test, counted as passed).
- `eslint` over `features/plan`, `features/goals`, `e2e`: clean. `just lint` as a whole exits 1 only on `prettier --check`
  of other packages' files (`wp9.9-perf.md`, `wp9.10-security-review.md`, `docs/security/*`, `scripts/perf/load-scale.ts`);
  the repo's `eslint` run also reports three errors outside this package's files.
