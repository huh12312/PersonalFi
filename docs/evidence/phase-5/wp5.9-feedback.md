# WP 5.9 — The dismiss-reason feedback loop, outcome verification, forward validation, rule health

_Agent: backend-architect (Sonnet). Branch `main`. Written incrementally; sabotages are recorded as they
are observed. Concurrent in the same tree: WP 5.5 (planning) and WP 5.7 (anomaly/fee hunter), both Wave B._

Scope: 05-phase-5-dispatch.md §3 WP 5.9; migration **0030_insight_feedback_reasons.sql**; the §2 row
"the feed never applies the learned dismiss penalty" (`read.ts:307`).

## 0. Log

| Time (local) | Step                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —            | Read §3 preamble, WP 5.9 entry, §4 migration table, §1 cut line 2, §5 gate standard; 07 §8.2/§8.3, 09 ADV-4; wp2.6/wp2.r evidence (dismissal ladder, cooldowns, review route); wp4.9 §12 item 1 (S6 tie-break, not mine — WP 5.7's) and item 5 (`enabled_source`); wp5.1-run-control.md (`enabled_source`, quarantine, breaker already built by WP 5.1).                                                                                    |
| —            | Confirmed WP 5.1 had already landed: `advisors.enabled_source` and `setAdvisorEnabled(..., source)` exist; `quarantineAdvisor(..., reason)` accepts any `QuarantineReasonValue`. Neither needed new plumbing — only `QUARANTINE_REASONS` needed `not_true_rate` added.                                                                                                                                                                      |
| —            | Read `read.ts` at `insightFeed`/`rankableOf` (line ~303–309 at the time): confirmed it composed `applyAlertBudget` (`policy/alert-budget.ts`'s `rank()`), never `applyCatalogueBudget`/`rankBuiltin` (`advisors/ranking.ts`) — the dispatch's §2 finding, live in the tree.                                                                                                                                                                 |
| —            | Designed the split: `policy/feedback.ts` pure (`decideFeedbackEffects`, mirroring `kill-switches.ts`'s `decideRun`); `policy/outcomes.ts` and `policy/rule-health.ts` do their own IO, `store.ts`'s `recordFeedback` orchestrates.                                                                                                                                                                                                          |
| —            | Wrote migration 0030, schema changes, `cooldown.ts` additions (`afterAlreadyKnow`, `afterIntentional`), `policy/feedback.ts`, `policy/outcomes.ts`, `policy/rule-health.ts`, the `store.ts` and `read.ts` rewrites, the `index.ts` WP 5.9 export block, the route body, the export-registry deferral, `migrate.test.ts`, `OWNERSHIP.md`.                                                                                                    |
| —            | `test/feedback.test.ts` (15 tests), `test/db/outcomes.test.ts` (2), `test/db/feedback-migration.test.ts` (1), `test/ranking.test.ts` (+2, 10 total) written and green; six sabotages run, all red on the first try, all restored (§5).                                                                                                                                                                                                      |
| —            | `apps/api/test/db/insights-routes.test.ts` — one describe appended, one route-level sabotage, red then green (§6).                                                                                                                                                                                                                                                                                                                          |
| —            | `packages/db/test/migrate.test.ts` caught a real defect: my `COMMENT ON TABLE` prose used the word "timestamp" in an English sentence, which the file's own `/\bTIMESTAMP\b(?!TZ)/i` check (guarding against a naked, zone-losing `TIMESTAMP` column type) matched inside the SQL string literal. Reworded to "proposal"; not a false alarm about the check — a genuinely blunt regex this repo accepts, and the fix was mine to make (§4). |
| —            | Full `insights`/`insights-db`/`db` projects run together: 4 pre-existing files red — `contract-parity.test.ts`, `alert-budget-wave.test.ts`, `advisor-golden.test.ts`, `catalog.test.ts` — all against WP 5.7's in-flight catalogue/scope/contract changes (1.3.0→1.4.0, the anomaly wave), none of them mine and none touching a file I own (§7, "Needs the orchestrator").                                                                |
| —            | Evidence written; `db-up`'s dev Postgres used for every `*-db` suite in this file — `TEST_ADMIN_DATABASE_URL`/`DATABASE_URL` unset otherwise, so `just db-up` was run once at the start (compose.dev.yml, not the main app stack — §8).                                                                                                                                                                                                     |

## 1. Migration 0030 and what it touches

`packages/db/migrations/0030_insight_feedback_reasons.sql` — references only 0012-era objects
(`insights`, `insight_feedback`, `advisors`, `users`) or its own, per 05 §4's ordering rule:

- `insight_feedback.reason_code TEXT` + `insight_feedback_reason_code_check` (the seven codes) +
  `insight_feedback_reason_code_for_response` (`reason_code` only on `dismiss`/`snooze`) +
  `insight_feedback_reason_idx (user_id, advisor_id, reason_code)`.
- Three `UPDATE` statements backfilling the three preset strings to codes, `WHERE reason_code IS NULL`
  (idempotent, one-time).
- `advisors_quarantine_reason_check` dropped and re-added with `not_true_rate` (0012's inline column
  CHECK, Postgres-named `advisors_quarantine_reason_check` — the 0028 precedent for `advisor_runs.status`
  / `.refusal`).
- `insight_outcomes` — one row per acceptance; composite FK `(user_id, advisor_id)` → `advisors`; FK
  `insight_id` → `insights (id)`; `insight_outcomes_due_after_accepted` (`due_at > accepted_at`);
  `insight_outcomes_evaluated_has_outcome` (`outcome IS NULL ⇔ evaluated_at IS NULL`);
  `insight_outcomes_evaluated_after_due` (never evaluated before its own horizon); unique index
  `(user_id, insight_id)` (one live verification per acceptance; a re-accept resets it);
  `insight_outcomes_due_idx (user_id, due_at) WHERE outcome IS NULL` for the evaluator's scan.

Same change: `packages/db/test/migrate.test.ts` — `'insight_outcomes'` added to the alphabetical table
list (between `'insight_feedback'` and `'insights'`) and a `// 0030_insight_feedback_reasons:` attribution
block placed after 0028's; `apps/api/src/reports/export/registry.ts` — `insight_outcomes` added to
`EXEMPT_TABLES` beside the other `insight_*` rows (same reason: WP 2.6's export scope, unnamed here);
`packages/contexts/insights/OWNERSHIP.md` — `insight_outcomes` claimed (`lint:schema-ownership`: ok, 106
claimed / 93 defined). `db` project: 10/10.

## 2. The reason table, each effect demonstrated

| Code             | 07 §8.3 effect                                                                                        | Where it is decided                                                                                                                                                                                                                                                                                                                                                                                      | Demonstrated by                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NOT_TRUE`       | Counts toward the rule's rate; > 0.2 over ≥ 5 firings quarantines the advisor, reason `not_true_rate` | `feedback.ts`'s `decideFeedbackEffects` → `notTrueRate`/`shouldQuarantineForNotTrue`; `store.ts`'s `recordFeedback` calls `quarantineAdvisor(..., 'not_true_rate')`                                                                                                                                                                                                                                      | `test/feedback.test.ts`: `'NOT_TRUE counts toward the rate but does not change the ladder'`, `'quarantines the moment the fifth firing crosses the threshold'`, `'does not trip at exactly the threshold…'`                                                                                                                                                                                                                    |
| `ALREADY_KNOW`   | Skips to the 90-day rung                                                                              | `cooldown.ts`'s `afterAlreadyKnow` — reads `COOLDOWN_LADDER_DAYS[1]` (90) directly rather than through `rungFor`, so it never sits through the 30-day rung first                                                                                                                                                                                                                                         | `test/feedback.test.ts`: `'ALREADY_KNOW skips straight to the 90-day rung'`                                                                                                                                                                                                                                                                                                                                                    |
| `NOT_ACTIONABLE` | Feeds the dismiss penalty                                                                             | No override — `afterDismissal`, the ordinary ladder. The _penalty_ itself is `rankBuiltin`'s `(1 − 0.5·dismissRate)`, computed from `read.ts`'s `loadDismissRates` (dismissed ÷ (dismissed + accepted) per advisor)                                                                                                                                                                                      | `test/feedback.test.ts`: `'NOT_ACTIONABLE feeds the ordinary dismiss penalty…'`; `test/ranking.test.ts`: `'the feed ranks with the learned dismiss penalty…'`                                                                                                                                                                                                                                                                  |
| `DONT_CARE`      | Switches the rule off for this holder, `enabled_source = 'feedback'`, undoable                        | `feedback.ts` returns `setEnabled: { enabled: false, source: 'feedback' }`; `store.ts` calls `setAdvisorEnabled(..., false, 'feedback')`. `registerAdvisor`'s conflict CASE (WP 5.1) only follows the catalogue while `enabled_source = 'default'`, so `'feedback'` behaves exactly like `'user'` from then on — a later `setAdvisorEnabled(..., true, 'user')` (the existing step-up route) always wins | `test/feedback.test.ts`: `'DONT_CARE switches the rule off for this holder'`, the `'DONT_CARE switches the rule off for this holder and a human can switch it back'` describe; `apps/api/test/db/insights-routes.test.ts`: `'DONT_CARE turns the rule off, and a human can turn it back on'` — a real dismissal through `POST /insights/:id/review`, a real `GET /advisors` read, a real `POST /advisors/:id/enabled` override |
| `WRONG_AMOUNT`   | Flags the insight's derivations and digest for review on rule health                                  | No write at all — a read-side join. `rule-health.ts`'s `ruleHealth` joins `insight_feedback` (`reason_code = 'WRONG_AMOUNT'`, `action = 'dismiss'`) back to `insights` for `derivations`/`inputDigest`/`key`                                                                                                                                                                                             | `test/feedback.test.ts`: `'WRONG_AMOUNT changes nothing this function writes…'`; the scripted-month run below shows one `wrongAmountFlags` entry with the insight's own digest and `derivations: []`                                                                                                                                                                                                                           |
| `INTENTIONAL`    | That entity suppressed permanently                                                                    | `cooldown.ts`'s `afterIntentional` forces `dismissCount = max(prev+1, PERMANENT_AFTER_DISMISSALS)` and `permanent: true` on the _first_ refusal — not earned over three — while keeping `insight_dismissals_permanent_is_earned` (`dismiss_count ≥ 3` whenever `permanent`) true for every row regardless of which reason reached it                                                                     | `test/feedback.test.ts`: `'INTENTIONAL suppresses the entity permanently on the first refusal, not the third'`                                                                                                                                                                                                                                                                                                                 |
| `LATER`          | A snooze                                                                                              | No override at all — realised entirely by `action = 'snooze'` (the pre-existing `afterSnooze`); the reason code is a label on the row, not a second mechanism                                                                                                                                                                                                                                            | `test/feedback.test.ts`: `'LATER is realised entirely by action = snooze…'`                                                                                                                                                                                                                                                                                                                                                    |

## 3. The migration of existing reasons, with row counts

`test/db/feedback-migration.test.ts` drives `@core/db`'s `runMigrations` directly over two temporary
migration directories built from the real files (`readMigrationFiles()` filtered by version) — once through
`0029`, once more through `0030` — so the assertions are against the actual `UPDATE` statements a real
deploy runs over real historical rows, not a re-implementation of them. Seed: one `insights` row, five
`insight_feedback` rows written _before_ 0030 ran:

| Stored `reason`                                                | `reason_code` after 0030      |
| -------------------------------------------------------------- | ----------------------------- |
| `That's wrong`                                                 | `NOT_TRUE`                    |
| `Already handled`                                              | `ALREADY_KNOW`                |
| `Not useful`                                                   | `NOT_ACTIONABLE`              |
| `the whole category is wrong, not just this row` (custom text) | `NULL` — survives as the note |
| _(no reason given)_                                            | `NULL`                        |

Row counts: **5 total, 3 mapped, 2 unmapped** — the assertion is exact, not "at least".
`apps/web/src/features/insights/DismissReasonDialog.tsx:12`'s three presets (read-only; WP 5.11 owns the
screen) are exactly the three strings the migration maps.

## 4. Rule health on the seed, after a scripted month of feedback

Script (via a throwaway harness run, not a committed test): register the echo advisor
(`scenario()`), grant its scope, run it once (day 0), `accept` the one insight it proposes, then on the
same insight — `dismiss` with `WRONG_AMOUNT` (day 1), `reopen` (day 2), `dismiss` with `NOT_ACTIONABLE`
(day 3); `evaluateDueOutcomes` at day 65 (past the 60-day horizon set by the day-0 accept). `ruleHealth`'s
output:

```json
[
  {
    "advisorId": "builtin.subscriptions.annualised_cost",
    "firings": 1,
    "accepted": 0,
    "dismissedByReason": {
      "NOT_TRUE": 0,
      "ALREADY_KNOW": 0,
      "NOT_ACTIONABLE": 1,
      "DONT_CARE": 0,
      "WRONG_AMOUNT": 1,
      "INTENTIONAL": 0,
      "LATER": 0,
      "none": 0
    },
    "notTrueRate": 0,
    "notTrueFiringsConsidered": 2,
    "quarantinedForNotTrue": false,
    "outcomes": { "acted": 1, "incomplete": 0, "pending": 0 },
    "wrongAmountFlags": [
      {
        "insightId": "01a0f0a8-cfab-73fb-9635-d947049d67fb",
        "key": "subscription.annual_cost.example",
        "inputDigest": "sha256:c04f1e715b677a193cf0bbd04daf0a171e8cd96f5b10bc17225c29bfad51ac61",
        "derivations": [],
        "flaggedAt": "2026-09-20T09:00:00.000Z"
      }
    ]
  }
]
```

Two things worth reading carefully rather than glossing over: **`accepted: 0`** even though the row was
accepted on day 0 — the final review action (the day-3 dismiss) is what `insights.status` reads at query
time, and `firings`/`accepted` are a snapshot of _current_ state, not a log of every review ever recorded
(`insight_feedback` is the log; `dismissedByReason` reads it). **`outcomes.acted: 1`** stands regardless —
the day-0 acceptance opened its own `insight_outcomes` row, independent of the insight's later reviews, and
it evaluated `ACTED` on its own timeline because the advisor was never run again after day 0 (so
`last_proposed_at` never crossed `due_at`). Outcome verification is scoped to the acceptance event, not to
whatever the insight's status happens to read later — a deliberate consequence of `insight_id` (not
`insights.status`) being the join key, not a bug found while writing this.

## 5. What forward validation can and cannot say

Stated once, here, before any number from this migration is read as more than it is:

**What it can say.** From the day 0030 lands, every acceptance opens one `insight_outcomes` row with
`due_at` fixed at `accepted_at + horizon_days` (60 by default, never recomputed). At the horizon, the row
is judged against exactly one fact — has `insights.last_proposed_at` moved past `due_at`? — and that fact
is forward-only by construction: `last_proposed_at` can only advance, and it is compared against `due_at`,
fixed at acceptance, never against a value that predates it. That gives a real, per-rule `ACTED` /
`INCOMPLETE` count, and from it a genuine precision figure, accumulating from now on.

**What it cannot say.** It is not 07 §8.2's backtest. There is no counterfactual re-evaluation of a rule
against restated history, no `predicted_impact` vs `realized_impact` scatter, no way to ask "would this
insight have fired a month earlier with today's categorisation?" — those need `valid_time`/`knowledge_time`
on the underlying facts (05 §6 Q4), which this phase does not add. It cannot calibrate over the month of
history the app already has before this migration lands: a month with no knowledge time is a month no
backtest — forward or otherwise — can ever use. And it says nothing about a rule's _correctness_ on a
finding nobody has yet accepted or dismissed; it only ever measures the ones a human answered.

## 6. Sabotages, recorded as they happened — all red on the first try, all restored

| #   | File                                                       | What was changed                                                                                                                | Observed red                                                                                                                                                                                                                       | Test(s)                                                                                        |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `src/read.ts`                                              | `rankFeed` and its composition into `insightFeed` deleted, reverting to the pre-fix `applyAlertBudget`/`rankableOf` composition | `rankFeed is not a function` — 2/10                                                                                                                                                                                                | `test/ranking.test.ts`                                                                         |
| 2   | `src/policy/outcomes.ts`                                   | `isNull(outcome)` removed from **both** the `SELECT` and the `UPDATE` in `evaluateDueOutcomes`                                  | `secondPass` read length 1, not 0 — the second evaluation re-decided an already-decided row                                                                                                                                        | `test/db/outcomes.test.ts` (test 1)                                                            |
| 2b  | _(same file, separate run)_                                | Only the `UPDATE`'s guard removed, `SELECT`'s left in place                                                                     | **Stayed green** — the `SELECT`'s own `isNull` filter alone was enough to keep the row out of a second pass. Recorded as a finding, not a failed sabotage: the two guards are independently sufficient, not just redundant-looking | —                                                                                              |
| 3   | `src/policy/outcomes.ts`                                   | The join's `lastProposedAt` selected `insights.firstProposedAt` instead                                                         | `firstPass[0]?.outcome` read `'ACTED'` instead of `'INCOMPLETE'` for the finding that really was re-proposed past its horizon — the exact "reads a proposal that predates the insight" failure forward validation exists to refuse | `test/db/outcomes.test.ts` (test 1; test 2 stayed green under this swap — see its own comment) |
| 4   | `src/policy/feedback.ts`                                   | `NOT_TRUE_MIN_FIRINGS` changed 5 → 6                                                                                            | The five-firing case no longer quarantined; the constants test read `6` where it expected `5`                                                                                                                                      | `test/feedback.test.ts` (2 tests)                                                              |
| 5   | `src/policy/feedback.ts`                                   | `DONT_CARE`'s `setEnabled` wrote `source: 'user'` instead of `'feedback'`                                                       | Both DONT_CARE assertions failed on the source field                                                                                                                                                                               | `test/feedback.test.ts` (2 tests)                                                              |
| 6   | `apps/api/src/routes/insights.ts`                          | The review route no longer forwarded `request.body.reasonCode` (hardcoded `null`)                                               | `DONT_CARE` sent over HTTP never reached the store; the advisor stayed enabled                                                                                                                                                     | `apps/api/test/db/insights-routes.test.ts`                                                     |
| 7   | `packages/db/migrations/0030_insight_feedback_reasons.sql` | The `NOT_ACTIONABLE` preset `UPDATE` (`'Not useful'`) deleted                                                                   | The row's `reason_code` stayed `NULL` instead of `NOT_ACTIONABLE`                                                                                                                                                                  | `test/db/feedback-migration.test.ts`                                                           |

Every sabotage above was applied with `Edit`, observed red, then restored byte-for-byte (`diff` against a
pre-sabotage backup confirmed clean) and re-run green before moving to the next. No git state was touched
at any point — no `stash`, no `checkout --`, no `add`.

## 7. Needs the orchestrator

- **The Phase 4 pre-existing suites `test/contract-parity.test.ts`, `test/alert-budget-wave.test.ts`,
  `test/advisor-golden.test.ts` and `test/catalog.test.ts` read red** when the full `insights` project runs
  in this tree — all four against WP 5.7's in-flight scope/contract/catalogue changes (1.3.0 → 1.4.0,
  `transactions.anomalies`, the anomaly wave), landing in the same shared working tree. None of the four
  files, and none of the source files their failures point at (`contract/scopes.ts`, `contract/snapshot.ts`,
  `snapshot/builder.ts`, `snapshot/ports.ts`, `advisors/catalogue.ts`), are owned by WP 5.9 or touched by
  this package. `git status` at the time of writing shows them modified by the concurrent agent, not by
  this one. Theirs to land; named here so a reviewer does not go looking for the cause in this file's
  changes.
- **`packages/contexts/planning/*.tmp.ts`** (`walk2.tmp.ts`, `oneoff.tmp.ts`) appeared and disappeared
  during a `pnpm run typecheck` run while WP 5.5 was active in the same tree, tripping one transient
  `tsc` failure (`TS6053`, file not found — a scratch file `tsconfig.json`'s `packages/**/*.ts` include
  matched mid-write). Re-ran clean seconds later. Not a WP 5.9 defect; recorded so a reviewer who sees it
  in a log does not chase it here.
- **`just db-up`** (compose.dev.yml — the standalone dev Postgres, not the main app stack) was run once at
  the start of this session because `DATABASE_URL`/`TEST_ADMIN_DATABASE_URL` were unset and no Postgres was
  reachable on 127.0.0.1:5433. `docker compose ps` (main stack) showed nothing running at the time either.
  No `docker compose exec`/`logs` was run against it; every table read went through this package's own
  functions or `@core/db`'s `createPool`/`createDatabase`/`runMigrations`.
- **Migration 0034 (`0034_securities_composite_fks.sql`) and WP 5.13a's shared-batch/wiring evidence** were
  already present in the tree at the start of this session (unrelated to WP 5.9; recorded once here so the
  "0028 is highest, 0030 is genuinely next" framing in this file's own log is read correctly against what
  was actually on disk, not what 05 §4 described at the time it was written).
- **`packages/contexts/insights/src/index.ts`** — WP 5.9's export block was appended at the very end of the
  file, after every existing block (including the pre-existing, unlabelled `read.ts`/`store.ts`/
  `policy/cooldown.ts` blocks, which were left untouched rather than merged into). If WP 5.7 also appends
  its own labelled block, the two should not collide; if it does not need to, no action is needed. Flagged
  in case the orchestrator wants both blocks re-ordered for readability once both land — the file works
  correctly as three-way-split as it stands.

## 8. `just check`

Posted before the final run, per the phase's rule.

**`just check` result:** `timeout 600 just check` was run once, in the foreground, after this report was
drafted. It stopped at the `lint` recipe's `eslint .` step, red on:

```
packages/contexts/insights/scratch-debug-s1.mjs
  10:3  error  Unexpected console statement  no-console
  20:1  error  Unexpected console statement  no-console
  27:1  error  Unexpected console statement  no-console

packages/contexts/insights/scratch-gen-schemas.mjs
  9:3  error  Unexpected console statement  no-console
```

Both files are untracked (`git status --short` marks them `??`), timestamped 00:17 and 00:55 on the day of
this session — during this session, not before it — and neither is named anywhere in this report's file
list. `scratch-gen-schemas.mjs` (schema regeneration) and `scratch-debug-s1.mjs` (S1, the anomaly rule
WP 5.7 owns) read as WP 5.7's own debugging scratch work, left in `packages/contexts/insights/` — a
directory this package shares with WP 5.7 for the phase — rather than deleted before their own `just
check`. Not deleted here: an untracked file with no name in this WP's Owns list is not this agent's to
remove, and a scratch file mid-edit by a concurrent agent is exactly the kind of collision the phase's
"disjoint path ownership" rule exists to keep an agent from touching. `just check` therefore did not reach
its `test` step in this run; per the phase rule ("if the test step cannot finish inside it, run your
vitest projects in foreground groups and say so"), the groups below are what stands in for it, and every
one of them is green.

**Foreground groups, run in full before the `just check` attempt above:**

- `pnpm run typecheck` — clean (one transient failure against a concurrent agent's scratch `.tmp.ts` file,
  re-run clean; §7).
- `pnpm run lint:format` (prettier --check) — clean for every WP 5.9 file; ten pre-existing files flagged,
  all under WP 5.5's or WP 5.7's ownership (`packages/contexts/planning/**`,
  `packages/contexts/insights/src/advisors/builtin/anomaly/anomaly.ts`).
- `pnpm exec eslint <every WP 5.9 file>` — clean.
- `node scripts/check-schema-ownership.ts` — ok, 106 claimed / 93 defined (after adding `insight_outcomes`
  to `OWNERSHIP.md`).
- `node scripts/check-ci-projects.ts` — PASS, 42/42 (WP 5.2's `advisor-local-model` project already
  landed; nothing WP 5.9 adds needs a new project).
- `packages/db/test/migrate.test.ts` (`db` project) — 10/10.
- `packages/contexts/insights/test/feedback.test.ts`, `test/ranking.test.ts` (`insights` project) — 15/15
  and 10/10.
- `packages/contexts/insights/test/db/outcomes.test.ts`,
  `packages/contexts/insights/test/db/feedback-migration.test.ts` (`insights-db` project) — 2/2 and 1/1.
- `apps/api/test/db/insights-routes.test.ts` (`api-db` project) — 13/13 (12 pre-existing + 1 new).
- Full `insights`/`insights-db`/`db` projects together — 298/303, 4 files red, all named in §7 as WP 5.7's.

_`just check`'s actual output, if the orchestrator runs it against the landed commit, belongs here._
