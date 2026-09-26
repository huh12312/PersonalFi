<!-- SPDX-License-Identifier: MIT -->

# WP 4.1 — Goals, contribution plans, risk profile, cash earmarks

_Phase 4's serial gate. Migration **0020**; four `@ctx/planning` tables. Dispatch:
`docs/plan/04-phase-4-dispatch.md` §3 "WP 4.1", §5. Decisions D3, D6; 02 §3 (the Wealthfront Path row,
"risk questionnaire with a consistency penalty"); 07 I3 and Appendix A; 08 §1.3 #8, §1.6, §4.2.
Written at HEAD `6391428` on `main`, working tree shared with WP 4.2 and WP 4.12a._

---

## 1. What shipped

| File                                                                             | What it is                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/db/migrations/0020_planning_goals.sql`                                 | `goals`, `goal_contributions`, `risk_profile`, `cash_earmarks`; composite `(goal_id, user_id)` foreign keys; `risk_profile_answers_are_well_formed()`; `goals_one_live_retirement_idx` |
| `packages/contexts/planning/schema/goals.ts` (new)                               | Drizzle types for the four tables, and the vocabularies (`GOAL_KINDS`, `CONTRIBUTION_CADENCES`, `RISK_TOLERANCES`, …)                                                                  |
| `packages/contexts/planning/src/risk-profile.ts` (new)                           | The instrument (`risk-v1`), the pure `deriveTolerance(answers)`, `taxBracketBand(income, schedule)`, `buildRiskProfileRecord`, and the `answerRiskProfile` service                     |
| `packages/contexts/planning/src/goals.ts` (new)                                  | `validateNewGoal` (pure) and the goal + contribution-plan services; `FundingAccountsReader = Pick<BalancesReader, 'accounts'>`                                                         |
| `packages/contexts/planning/src/contributions.ts` (new)                          | `EscalationPct` (branded decimal string), `parseEscalationPct`, the exact `escalatedAmount`, plan validation                                                                           |
| `packages/contexts/planning/src/earmarks.ts` (new)                               | `createEarmark`, `releaseEarmark`, `listEarmarks`, `liveEarmarksByAccount` (WP 4.7's I3 input)                                                                                         |
| `packages/contexts/planning/src/goals-store.ts` (new)                            | The sole reader/writer of the four tables, raw SQL in `src/store.ts`'s style, one `user_id` predicate per statement and no joins                                                       |
| `packages/contexts/planning/src/errors.ts` (new)                                 | `PlanningError` with a code → `{status, family}` table WP 4.8 can map without judgement                                                                                                |
| `packages/contexts/planning/src/events.ts`                                       | `planning.GoalCreated`, `planning.RiskProfileAnswered`, appended to `PLANNING_EVENTS`                                                                                                  |
| `packages/contexts/planning/src/index.ts`                                        | One appended export block                                                                                                                                                              |
| `packages/contexts/planning/schema/index.ts`                                     | One line: `export * from './goals.ts';`                                                                                                                                                |
| `packages/contexts/planning/OWNERSHIP.md`                                        | `cash_earmarks` claimed (the other three were already claimed)                                                                                                                         |
| `test/risk-profile.test.ts`, `test/goals.test.ts`, `test/db/goals.test.ts` (new) | The six named exit tests plus three supporting tests                                                                                                                                   |
| `test/ports.test.ts`                                                             | **One pin updated** — `PLANNING_EVENTS` now lists four types (WP 4.1's two and WP 4.2's one), each checked against 0003's `event_type` CHECK. See §10.                                 |

---

## 2. The questionnaire, both framings side by side

Instrument `risk-v1`. Three **dispositions**, each asked twice: a **stated** framing (a hypothetical or a
self-description) and a **revealed** framing (what the holder has actually done, or actually holds).
Every option is worth 1–5 points, 1 most conservative. Option ids are what is stored; labels are
presentation and may be reworded, but **points may not change without a new instrument version**.

### Falls in value (`drawdown`)

| Pts | Stated — _"Suppose your long-term investments fell 25% over a few months, and nobody could tell you whether they would fall further. What would you do?"_ | Revealed — _"Think of the last time investments you held fell sharply — 2022, March 2020, or any fall of 20% or more. What did you actually do at the time?"_ |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `sell_all` Sell everything and move to cash                                                                                                               | `sold_all` I sold all or most of it                                                                                                                           |
| 2   | `sell_some` Sell some of it to limit further losses                                                                                                       | `sold_some` I sold some of it                                                                                                                                 |
| 3   | `hold_pause` Hold, but stop adding new money until it recovers                                                                                            | `paused` I kept it but stopped or cut my contributions                                                                                                        |
| 4   | `hold` Hold and keep contributing as planned                                                                                                              | `held` I changed nothing                                                                                                                                      |
| 5   | `buy_more` Invest extra while prices are lower                                                                                                            | `bought` I added money on purpose because prices had fallen                                                                                                   |
| —   |                                                                                                                                                           | `no_evidence` I haven't held investments through a fall like that                                                                                             |

### Range of outcomes (`volatility`)

| Pts | Stated — _"You invest $10,000 for one year. Which range of possible outcomes would you choose? Wider ranges have higher average outcomes."_ | Revealed — _"Roughly what share of your long-term savings is in stocks or stock funds today, counting retirement accounts?"_ |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | `range_narrowest` $9,800 to $10,600                                                                                                         | `stocks_under_20` Less than a fifth                                                                                          |
| 2   | `range_narrow` $9,200 to $11,000                                                                                                            | `stocks_20_to_40` A fifth to two fifths                                                                                      |
| 3   | `range_middle` $8,500 to $11,500                                                                                                            | `stocks_40_to_60` About half                                                                                                 |
| 4   | `range_wide` $7,500 to $12,200                                                                                                              | `stocks_60_to_80` Three fifths to four fifths                                                                                |
| 5   | `range_widest` $6,500 to $13,000                                                                                                            | `stocks_over_80` More than four fifths                                                                                       |
| —   |                                                                                                                                             | `no_evidence` I don't have long-term savings invested yet                                                                    |

### Attitude to risk (`risk_identity`)

| Pts | Stated — _"How would you describe yourself when it comes to financial risk?"_ | Revealed — _"Over the last few years, when you had money to set aside, where did most of it actually go?"_ |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | `avoid` I avoid it wherever I can                                             | `cash` A savings account or cash                                                                           |
| 2   | `cautious` I accept a little, reluctantly                                     | `mostly_safe` Mostly cash or bonds, a little in stocks                                                     |
| 3   | `balanced` I weigh it against the reward, case by case                        | `split` Roughly even between safe savings and stock investments                                            |
| 4   | `willing` I am comfortable with it for a better long-run return               | `mostly_stocks` Mostly stock investments                                                                   |
| 5   | `seek` I look for it; higher risk is how returns are earned                   | `concentrated` Individual stocks, crypto, or other concentrated bets                                       |
| —   |                                                                               | `no_evidence` I have not had money to set aside                                                            |

`test/risk-profile.test.ts` → `'every disposition is asked in a stated and a revealed framing'` pins the
shape: each disposition has exactly one of each framing, each item offers points 1–5 exactly once, and
only a revealed framing may offer "no evidence".

---

## 3. The penalty arithmetic

For a disposition with stated points `s` and revealed points `r`:

```
unpenalised_d = s + r            what averaging the two framings credits, doubled
credited_d    = 2 × min(s, r)    the more conservative framing, doubled
penalty_d     = |s − r|          = unpenalised_d − credited_d
```

Doubling keeps every quantity an integer (a mean of 3.5 is 7 points). Summed over three dispositions:
composite 6–30, penalty 0–12. Tolerance from the composite: 6–10 `conservative`, 11–15
`moderate_conservative`, 16–20 `moderate`, 21–25 `moderate_aggressive`, 26–30 `aggressive`.

**"No evidence"** on a revealed framing is credited `r = min(s, 3)`: a stated answer at or below the
midpoint stands unpenalised; one above it is credited at the midpoint until behaviour confirms it.

All four sets below are the literal output of `deriveTolerance` on the stored document (run with
`node` against `src/risk-profile.ts` at the landing tree), not hand arithmetic.

### Set A — consistent

| Disposition   | s   | r   | s + r  | 2·min  | penalty |
| ------------- | --- | --- | ------ | ------ | ------- |
| drawdown      | 4   | 4   | 8      | 8      | 0       |
| volatility    | 4   | 4   | 8      | 8      | 0       |
| risk_identity | 4   | 4   | 8      | 8      | 0       |
| **total**     |     |     | **24** | **24** | **0**   |

`moderate_aggressive` either way. Explanation: _"Total 24 of 30: moderate_aggressive. Your answers were
consistent."_

### Set B — one disagreement (the exit test's case, and the planted `planning-db` row)

| Disposition   | s   | r   | s + r  | 2·min  | penalty |
| ------------- | --- | --- | ------ | ------ | ------- |
| drawdown      | 5   | 1   | 6      | 2      | 4       |
| volatility    | 4   | 4   | 8      | 8      | 0       |
| risk_identity | 4   | 4   | 8      | 8      | 0       |
| **total**     |     |     | **22** | **18** | **4**   |

Averaging: 22 → `moderate_aggressive`. Credited: 18 → **`moderate`**. The explanation line the holder
sees: _"Falls in value: you said "Invest extra while prices are lower" (5), but what you have actually
done or hold is "I sold all or most of it" (1). The score takes the more conservative answer, 1, not the
average, 3. Penalty 4."_ then _"Total 18 of 30: moderate. Averaging the two framings would have given 22
(moderate_aggressive); the 4-point consistency penalty is the difference."_

### Set C — maximally inconsistent

| Disposition   | s   | r   | s + r  | 2·min | penalty |
| ------------- | --- | --- | ------ | ----- | ------- |
| drawdown      | 5   | 1   | 6      | 2     | 4       |
| volatility    | 5   | 1   | 6      | 2     | 4       |
| risk_identity | 5   | 1   | 6      | 2     | 4       |
| **total**     |     |     | **18** | **6** | **12**  |

This is the case the feature exists for. **Averaging gives 18 — `moderate`, a confident middle score** —
for someone who says "buy more", "widest range", "I look for risk" and has actually sold at the bottom,
holds under a fifth in stocks and keeps savings in cash. Credited: 6 → **`conservative`**. The 12-point
penalty is the maximum the instrument can produce.

### Set D — no evidence (not inconsistency, not confirmation)

| Disposition   | s   | r (credited)      | s + r  | 2·min  | penalty |
| ------------- | --- | ----------------- | ------ | ------ | ------- |
| drawdown      | 5   | 3 (`no_evidence`) | 8      | 6      | 2       |
| volatility    | 4   | 3 (`no_evidence`) | 7      | 6      | 1       |
| risk_identity | 2   | 2 (`no_evidence`) | 4      | 4      | 0       |
| **total**     |     |                   | **19** | **16** | **3**   |

`moderate` either way here; the explanation says why in words: _"you said "Invest extra while prices are
lower" (5), and there is no past behaviour to confirm it yet, so it is credited at the midpoint (3) until
there is. Penalty 2."_ The cautious stated answer (2) is not penalised for the absence of evidence.

### Re-derivable from the row alone

`risk_profile.answers` holds `{"instrument": "risk-v1", "items": {"<disposition>.<framing>": "<option id>"}}`
and nothing else; `deriveTolerance` reads nothing else. The row also stores `composite_score`,
`unpenalised_score` and `consistency_penalty`, and the CHECK `risk_profile_penalty_is_the_difference`
makes the three agree in the database. The stored Set-B row, read back from Postgres:
`"tolerance":"moderate"`, `"composite_score":18`, `"unpenalised_score":22`, `"consistency_penalty":4`,
`"tax_bracket_band":"22-32"`.

---

## 4. The band, and the income that produced each boundary

`taxBracketBand(taxableIncome, schedule)` returns the band of the **marginal** bracket. Three bands,
following 08 §4.2's own example (`'22-32'`): brackets 0–1 → `10-12`, 2–4 → `22-32`, 5–6 → `35-37`. A
schedule without exactly seven brackets is refused rather than banded by guess.

The schedule is **an argument, not a constant in `src/`**: 07 Appendix A says the thresholds are _"keyed
by year, never inlined in code"_ and they are WP 4.2's file. The table below uses 07 Appendix A's 2026
single-filer thresholds (Rev. Proc. 2025-32), which the tests carry as a cited fixture. Rev. Proc.'s
phrasing is "22% > $50,400", so an income **exactly** on a threshold stays in the lower bracket.

| Taxable income  | Marginal bracket | Band        |
| --------------- | ---------------- | ----------- |
| $0.00           | 10%              | `10-12`     |
| $12,400.00      | 10%              | `10-12`     |
| $12,400.01      | 12%              | `10-12`     |
| $50,400.00      | 12%              | `10-12`     |
| **$50,400.01**  | 22%              | **`22-32`** |
| $105,700.01     | 24%              | `22-32`     |
| $201,775.01     | 32%              | `22-32`     |
| $256,225.00     | 32%              | `22-32`     |
| **$256,225.01** | 35%              | **`35-37`** |
| $640,600.01     | 37%              | `35-37`     |

Rate → percent is exact string arithmetic (`'0.22'` → `'22'`), no float. A negative income, or one in a
currency the schedule is not in, is `planning.risk_income_invalid`; a declined income is a `null` band.

**Why the income cannot reach the row.** `RiskProfileRecord` has ten fields and none of them can hold
it; `insertRiskProfile` writes each field of that record and no other value; the exit test serialises
the record and asserts neither `8400000` nor `84000` nor the word `income` appears, and a fast-check
property shows every income in the middle band (5,040,001 to 25,622,500 minor units, 200 runs) produces
the **identical** record bar id and time — the band carries no residue of the figure. In the database,
the band CHECK refuses `'84000'` and `risk_profile_answers_are_well_formed` refuses both an answers
value that is not an option id starting with a letter (`"84000"`) and any extra top-level key
(`{"income": …}`); both are observed by constraint name in `test/db/goals.test.ts`.

---

## 5. Every column's type, and no `number` at a `Money` or a rate

| Table                | Column                                                        | SQL type                                 | TypeScript                                   |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------- |
| `goals`              | `target_minor`, `currency`                                    | `BIGINT`, `CHAR(3)`                      | `Money` (`bigint` minor)                     |
|                      | `target_date`                                                 | `DATE`                                   | `DateOnly`                                   |
|                      | `priority`                                                    | `SMALLINT` 1–5                           | `number` (a rank)                            |
|                      | `funded_from_account_ids`                                     | `UUID[]` ≤ 32                            | `readonly string[]`                          |
|                      | `kind`, `name`, `status`                                      | `TEXT` + CHECK                           | string unions / `string`                     |
| `goal_contributions` | `amount_minor`, `currency`                                    | `BIGINT`, `CHAR(3)`                      | `Money`                                      |
|                      | `escalation_pct`                                              | `NUMERIC(7,4)` 0–100                     | `EscalationPct` (branded decimal **string**) |
|                      | `starts_on`, `ends_on`, `derived_as_of`                       | `DATE`                                   | `DateOnly`                                   |
|                      | `cadence`, `source`                                           | `TEXT` + CHECK                           | string unions                                |
| `risk_profile`       | `composite_score`, `unpenalised_score`, `consistency_penalty` | `SMALLINT`                               | `number` (instrument points)                 |
|                      | `horizon_years`                                               | `SMALLINT` 0–100                         | `number` (years)                             |
|                      | `tax_bracket_band`                                            | `TEXT` + CHECK `^[0-9]{1,2}-[0-9]{1,2}$` | `string \| null`                             |
|                      | `tolerance`, `liquidity_need`                                 | `TEXT` + CHECK                           | string unions                                |
|                      | `answers`                                                     | `JSONB` + CHECK                          | `RiskAnswers`                                |
|                      | `answered_at`                                                 | `TIMESTAMPTZ`                            | `Date`                                       |
| `cash_earmarks`      | `amount_minor`, `currency`                                    | `BIGINT`, `CHAR(3)`                      | `Money`                                      |
|                      | `account_id`, `goal_id`                                       | `UUID`                                   | `string`                                     |
|                      | `released_at`                                                 | `TIMESTAMPTZ`                            | `Date \| null`                               |

Every table also has `id UUID`, `user_id UUID NOT NULL REFERENCES users ON DELETE CASCADE`,
`created_at TIMESTAMPTZ` and (except append-only `risk_profile`) `updated_at TIMESTAMPTZ`.

The grep, over every WP 4.1 source file:

```
$ F="…/src/goals.ts …/src/goals-store.ts …/src/contributions.ts …/src/risk-profile.ts
     …/src/earmarks.ts …/src/errors.ts …/schema/goals.ts"
$ grep -nE "(amount|target|minor|escalation|rate|income)[A-Za-z]*\??\s*:\s*number" -i $F
no number-typed amount/target/minor/escalation/rate/income

$ grep -nE "Number\(|parseFloat|toFixed\(" $F
goals-store.ts:134:    priority: Number(raw.priority),
goals-store.ts:168:    // NUMERIC(7,4) reads back as '3.2500'; canonicalised, never Number()ed.
goals-store.ts:234:    compositeScore: Number(raw.composite_score),
goals-store.ts:235:    unpenalisedScore: Number(raw.unpenalised_score),
goals-store.ts:236:    consistencyPenalty: Number(raw.consistency_penalty),
goals-store.ts:237:    horizonYears: Number(raw.horizon_years),
```

Every `: number` in those files (listed in full by `grep -nE ":\s*number\b"`) is a priority, an
instrument score, a year count, a bracket index, a decimal-place count or a tax year — none a magnitude.
`node scripts/check-numeric-boundaries.ts` passes over the tree with **no exemption used in any WP 4.1
file** (`--explain` lists none under these paths).

**Where rate meets amount.** `escalatedAmount(amount, pct, years)` computes
`amount × (10^k + u)^n / 10^(k·n)` as a `bigint` numerator, places the decimal point in a string, and
hands it to `Money.multiplyByDecimal`, which rounds **once**, half-even. The fast-check property
(1,000 runs, amounts 1 to 10^15 minor units, rates 0–100 with 0–4 decimals, 0–40 years) compares it to
an independent exact-rational reference written in the test. A worked case a float gets wrong:
$9,007,199,254,740.99 at 3.1% for 30 years — `Math.round(Number(minor) * 1.031 ** 30)` differs from the
exact result, and the test asserts that it does. `parseEscalationPct(3.25)` is a
`planning.contribution_escalation_invalid`, never a conversion.

---

## 6. Why `cash_earmarks` lives in Planning, not Investments

07 I3 fires on brokerage cash that has sat uninvested "> 14 days **and not earmarked**". The earmark is
the holder saying "this $6,000 in that account is the house deposit".

1. **It is a statement about a goal.** The row carries `goal_id` by composite foreign key; goals are
   Planning's. An earmark without its goal is a label with no reason attached.
2. **08 §1.6's arrows point `planning → investments`, never back.** If Investments owned the earmark it
   would need to reference `goals`, which is a table it may not read. Planning owning it costs nothing:
   Planning may depend on Investments, and doesn't even need to here.
3. **The I3 composition happens where both are visible.** WP 4.7's dwell analytic stays Investments'
   (it reads `holdings_snapshots`); the earmark stays Planning's; the composition root — which may read
   both through its assemblers (08 §1.3 #9) — composes them in `createInsightsInvestmentsPort`.
   `liveEarmarksByAccount(executor, userId): Map<accountId, Money>` is the read it composes with.
4. **Over-earmarking is deliberately not a rule here.** Balances move daily and an earmark is an
   intention; WP 4.7's composition caps the earmarked amount at the observed cash on the day it
   evaluates, the only place both numbers are known at once. Released, never deleted, so a past I3
   verdict remains checkable against what was earmarked on the day.

---

## 7. Cross-user scoping (§5 item 8)

`test/db/goals.test.ts` → `'every new table carries user_id and refuses another user's row'` runs
against scratch database `personalfi_wp41_goals` with **Alice and Bob each holding one row in every
table**, asserted by count before anything else. Three layers:

1. **Structure** — `user_id` is `NOT NULL uuid` referencing `users` with `confdeltype = 'c'` on all four
   tables; `goal_contributions_goal_is_the_same_users` and `cash_earmarks_goal_is_the_same_users` are
   over `(goal_id, user_id)`, read out of `pg_constraint`.
2. **The database refuses a mixed row** — raw-SQL inserts of a Bob-stamped contribution and earmark
   pointing at Alice's goal are 23503 naming those constraints. No service code runs.
3. **The store** — every read returns only the caller's rows (both directions for "newest profile");
   nine write attempts by Bob against Alice's ids are typed refusals; Alice's **and** Bob's rows are
   byte-identical (`row_to_json` text) afterwards; `updateGoalRow` is also called directly, below the
   service's scoped pre-read; and Alice's live retirement goal does not block Bob's.

`src/goals-store.ts` never joins, so each statement has exactly one scoping predicate. Each was dropped
(replaced by `true`) one at a time, then all together:

| #     | Predicate dropped                     | Result                         | First assertion to fail                                    |
| ----- | ------------------------------------- | ------------------------------ | ---------------------------------------------------------- |
| P1    | `findGoal` — `user_id = $caller`      | red                            | `findGoal(bob, aliceGoal)` expected null, got Alice's goal |
| P2    | `listGoals`                           | red                            | Bob's list had 2 goals                                     |
| P3    | `hasLiveRetirementGoal`               | red                            | Bob's retirement goal refused because of **Alice's**       |
| P4    | `updateGoalRow`                       | red                            | direct `updateGoalRow(bob, aliceGoal)` returned a row      |
| P5    | `deleteGoalRow`                       | red                            | Bob's delete of Alice's goal succeeded                     |
| P6    | `listContributionRows`                | red                            | Bob saw Alice's plan                                       |
| P7    | `deleteContributionRow`               | red                            | Bob's delete of Alice's plan succeeded                     |
| P8    | `latestRiskProfile`                   | **green first**, red after fix | see below                                                  |
| P9    | `riskProfileHistory`                  | red                            | Bob's history had 2 rows                                   |
| P10   | `listEarmarkRows`                     | red                            | Bob's earmarks had 2 rows                                  |
| P11   | `releaseEarmarkRow`                   | red                            | Bob released Alice's earmark                               |
| P1+P4 | the update path's two layers together | red                            | `findGoal` assertion                                       |
| ALL   | all eleven together                   | red                            | Bob's list had 2 goals                                     |

**P8 was green on the first try — a real test defect, found by the sabotage.** The test asserted only
`currentRiskProfile(bob)`. Bob's profile was planted after Alice's, so it is the newest row in the whole
table and an unscoped "newest" query returns it anyway: the assertion proved ordering, not scoping. The
test now also asserts `currentRiskProfile(alice)` is Alice's, with a comment saying why both directions
are needed; re-run, P8 is red (`expected '…b92cb' to be '…e28f6'`). This is exactly the S1 pattern one
level down — a "newest row" read that is right by accident for whichever holder wrote last.

Every file was restored byte-identically after every sabotage; the harness compares SHA-256 before and
after (`goals-store.ts` `9ad62226…` before and after the full P run).

---

## 8. Every other control, sabotaged once

Harness: `/tmp/wp41-sabotage.py` (one edit set, run the named test file, restore, SHA-256 compare). All
red on the first valid attempt except P8 above; every restore byte-identical.

| #   | Control                                                     | Sabotage                                         | Test that went red                                                                 | First failure                                                                                                 |
| --- | ----------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| R1  | conservative framing, not the mean                          | `credited = stated + revealed`                   | `'two framings … moves conservative, not to the mean'` (and the re-derivable test) | drawdown row did not match `{stated 5, revealed 1, …}`                                                        |
| R2  | stored tolerance is the derived one                         | record stores `toleranceIfAveraged`              | `'the consistency penalty is stored and the score is re-derivable …'`              | property failed after 1 run                                                                                   |
| R3  | unknown instrument version refused                          | version check disabled                           | same                                                                               | `risk-v0` document did not throw                                                                              |
| R4  | band, never figure                                          | band := `income.minor.toString()`                | `'tax_bracket_band is a band and the exact income never reaches the row'`          | `expected '8400000' to be '22-32'`                                                                            |
| R5  | income never on the record                                  | `taxableIncomeMinor` added to the record         | same                                                                               | record JSON contained `8400000`                                                                               |
| C1  | escalation exact, never a float                             | `Number(minor) * (1 + Number(pct)/100) ** years` | `'a goal target is Money and a contribution escalation never becomes a float'`     | property failed after 2 runs                                                                                  |
| C2  | a numeric rate is refused                                   | `typeof value === 'number'` → `String(value)`    | same                                                                               | `parseEscalationPct(3)` did not throw                                                                         |
| G1  | past date refused, not clamped                              | `return today`                                   | `'a target date in the past refuses with a domain error rather than clamping'`     | reached the write instead of a `PlanningError`                                                                |
| G2  | missing funding account refused                             | `continue` past the refusal                      | same                                                                               | no refusal for `…a0ff`                                                                                        |
| G3  | "today" is the holder's zone                                | `todayIn(clock, 'UTC')` in `createGoal`          | same                                                                               | message named 2026-09-26, not the holder's 2026-09-25                                                         |
| S1  | `addContribution` reads the goal through the caller's scope | pre-read replaced by an unscoped stub            | `'every new table …'`                                                              | raw 23503 from the composite FK instead of `goal_not_found` — the DB backstop held, the typed refusal did not |
| S2  | one live retirement goal — service                          | pre-check disabled                               | `'a goal, its plan and its event …'`                                               | raw 23505 from the index instead of `goal_retirement_already_live`                                            |
| M1  | contributions' composite FK                                 | `FOREIGN KEY (goal_id) REFERENCES goals (id)`    | `'every new table …'`                                                              | constraint columns `goal_id` ≠ `goal_id,user_id`                                                              |
| M2  | earmarks' composite FK                                      | same shape                                       | same                                                                               | same                                                                                                          |
| M3  | `ON DELETE CASCADE` on `user_id`                            | removed from `risk_profile`                      | same                                                                               | `on_delete: 'a'` ≠ `'c'`                                                                                      |
| M4  | band CHECK                                                  | removed                                          | `'the stored risk profile carries its penalty and band, and no income'`            | `'84000'` accepted                                                                                            |
| M5  | answers carry option ids only                               | option-id pattern removed from the function      | same                                                                               | `"84000"` as an answer accepted                                                                               |
| M6  | `risk_profile_penalty_is_the_difference`                    | removed                                          | same                                                                               | `consistency_penalty = 0` accepted                                                                            |
| M7  | `goals_one_live_retirement_idx`                             | made non-unique                                  | `'a goal, its plan and its event …'`                                               | second live retirement insert accepted                                                                        |
| E1  | `GoalCreated` carries ids, never the name                   | `name` added to schema and payload               | same                                                                               | payload contained `House deposit`                                                                             |

(M1/M2's first failure is the structural assertion; the behavioural one — the raw mixed insert — sits
later in the same test and is what S1 shows holding.)

---

## 9. Tests and check results

| Project       | File                        | Tests                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `planning`    | `test/risk-profile.test.ts` | 4 — instrument shape; **`'two framings of the same question disagree and the score moves conservative, not to the mean'`** (+ 500-run property); **`'the consistency penalty is stored and the score is re-derivable from the stored answers alone'`** (+ 200-run property, 5 refusals); **`'tax_bracket_band is a band and the exact income never reaches the row'`** (+ 200-run band-invariance property, 11 boundaries) |
| `planning`    | `test/goals.test.ts`        | 2 — **`'a goal target is Money and a contribution escalation never becomes a float'`** (1,000-run property + type-level + float witness); **`'a target date in the past refuses with a domain error rather than clamping'`** (zone case, funding-account refusals)                                                                                                                                                         |
| `planning-db` | `test/db/goals.test.ts`     | 3 — **`'every new table carries user_id and refuses another user's row'`**; the stored risk row and its four CHECKs by name; the event pair, NUMERIC read-back as a string, and the retirement invariant at both layers                                                                                                                                                                                                    |
| `planning`    | `test/ports.test.ts`        | pin updated (`PLANNING_EVENTS` now four types), no new test                                                                                                                                                                                                                                                                                                                                                                |

Commands, all foreground (results appended in §11 after the final run):

```
$ pnpm exec tsc -b --noEmit
$ pnpm exec eslint packages/contexts/planning packages/db
$ pnpm exec prettier --check <every WP 4.1 file>
$ node scripts/check-numeric-boundaries.ts
$ pnpm run lint:schema-ownership
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project planning --project planning-db --project db
```

---

## 10. For the orchestrator

### Tables (0020), for `packages/db/test/migrate.test.ts`

`cash_earmarks`, `goal_contributions`, `goals`, `risk_profile` — alphabetical positions: after
`budgets`; after `fx_rates` (`goal_contributions` then `goals`); after `rejected_transfer_pairs`. **The
list and a 0020 attribution block were already present in the working tree when this WP ran** (someone
applied them ahead of the report) and the `db` project is green against them. If the block is to be
re-worded, the load-bearing mechanisms to name are: the composite `(goal_id, user_id)` foreign keys
`goal_contributions_goal_is_the_same_users` / `cash_earmarks_goal_is_the_same_users` against
`goals_id_user_key`; `risk_profile_answers_are_well_formed` (IMMUTABLE function, option ids only, no
extra keys) and `risk_profile_penalty_is_the_difference`; the band CHECK
`^[0-9]{1,2}-[0-9]{1,2}$`; `goals_one_live_retirement_idx`; and that "target date not in the past" is
deliberately **not** a CHECK (a CHECK against the clock would invalidate every goal on its own target
date).

### A pinned test outside this WP's ownership will go red

`apps/api/test/phase3-registration.test.ts:192` — `expect(PLANNING_EVENTS).toHaveLength(1)` — is the
pin that exists so an added event is noticed. With WP 4.2 integrated it must become **4**, with the
comment "one from planning" → "four from planning (`NetWorthSnapshotTaken`; WP 4.1's `GoalCreated`,
`RiskProfileAnswered`; WP 4.2's `AssumptionsOverridden`)". Registration itself needs no change:
`modules.ts:533` registers `events: PLANNING_EVENTS`, so the new types are registered the moment the list
grows; the same test's loop over `PLANNING_EVENTS` checks each
against the `event_type` CHECK and the `planning.` prefix.

`packages/contexts/planning/test/ports.test.ts`'s equivalent pin was updated in this WP (§1), because
it is inside `@ctx/planning` and would otherwise have left the `planning` project red.

### Shared lines — already applied, noted so nobody re-applies them

Including **WP 4.2's four integration edits** (`wp4.2-assumptions.md` §9 items 2–4), applied here at the
orchestrator's request because this WP owned the files this wave:

- `packages/contexts/planning/schema/index.ts`: `export * from './goals.ts';` then
  `export * from './assumptions.ts';` — two lines, nothing else (the file's header comment still says
  "One table today", a one-line prose fix for whoever commits the pair).
- `packages/contexts/planning/src/index.ts`: WP 4.2's block, verbatim from its §9 item 3, directly
  after the original `// --- events ---` line; WP 4.1's block appended at the end, headed
  `// --- WP 4.1: goals, contribution plans, risk profile, cash earmarks`.
- `packages/contexts/planning/src/events.ts`: WP 4.1's two definitions; `import { AssumptionsOverridden }
from './assumptions.ts'` and a re-export (not a second definition — `saveOverrides` appends it in the
  same transaction as its row, so it is defined beside that code); `PLANNING_EVENTS` =
  `[NetWorthSnapshotTaken, GoalCreated, RiskProfileAnswered, AssumptionsOverridden]`.
- `packages/contexts/planning/test/ports.test.ts`: the pinned list carries all four.
- **One collision, resolved:** both WPs exported `FILING_STATUSES` / `FilingStatus` (mine
  `single | married_filing_jointly | …`, 4.2's `single | mfj | mfs | hoh`). `src/index.ts` cannot export
  both, and two vocabularies for one concept is the worse bug anyway, so `risk-profile.ts` now
  `import type { FilingStatus } from './assumptions.ts'` and the public name is 4.2's. The R sabotages
  (§8) were re-run after that edit: all five red, all restores byte-identical.
- `packages/contexts/planning/src/errors.ts` is new and holds `PlanningError`. WP 4.2 kept its own
  refusal classes (`isAssumptionsRefusal`); unifying them is a WP 4.8 mapping decision, not a blocker.

### For WP 4.8 (routes)

- `toDomainProblem` arm: `isPlanningError(error)` → `new AppError({ status: error.status, code:
error.code, family: error.family, … })`. The table is `PLANNING_ERROR_STATUS`; the two refusals the
  dispatch names are 422 `domain`.
- `createGoal` / `updateGoal` / `createEarmark` need `{ accounts: FundingAccountsReader }` — a
  `Pick<BalancesReader, 'accounts'>`, so the `BalancesReader` binding WP 3.8's wiring already put in
  `apps/api/src/domain.ts` satisfies it with no adapter — and a `timeZone` (the holder's).
- `answerRiskProfile` needs a `BracketSchedule` for the holder's tax year and filing status. That is
  WP 4.2's data, and the shapes already agree: a `brackets` node's `value` in `data/us-2026.ts` _is_
  `{ over: Money, rate: '0.22' }[]` with seven entries, and `FilingStatus` is 4.2's own type, so the
  adapter is `{ taxYear, filingStatus, brackets: node.value, source: node.source, asOf: node.asOf }`.
  The filing status is a new input the route must collect; this WP does not store it (it is not needed
  once the band is derived).
- Pass a transaction to every write: the row and its event are one fact or none.

### For WP 4.7 (I3)

`liveEarmarksByAccount(executor, userId)` → `ReadonlyMap<accountId, Money>` is the earmark side of the
composition. Cap it at the observed cash on the evaluation day; this WP does not.

### For WP 4.9 (the `risk.profile` / `goals.list` arms)

`currentRiskProfile` returns `tolerance`, `horizonYears`, `taxBracketBand` and `liquidityNeed` in exactly
the shape `RiskProfileSchema` (advisor contract 1.0.0) wants; `tolerance` values are ≤ 32 chars and the
band matches the contract's `'22-32'` example. A holder who declined income has `taxBracketBand: null`,
and the contract field is a required string — the arm must **omit the block or the field**, not invent
a band. `listGoals` gives name (≤ 96, the contract's limit), target `Money` and target date; the
progress ratio needs balances and is 4.9's derivation.

### Open items

1. **The revealed `volatility` framing is self-reported.** The holder's actual stock share is derivable
   from holdings; pre-filling (or cross-checking) that answer from `@ctx/investments` would make it
   genuinely revealed. Not done: it would put a holdings read inside a questionnaire, and the answer
   must still be the holder's to confirm.
2. **Only the single-filer schedule is exercised by the tests.** The band function is filing-status
   agnostic, and WP 4.2's file now carries all four statuses' seven-bracket schedules, so they will
   band without change; a test over the MFJ schedule belongs with the WP 4.8 adapter.
3. **A goal may be created with no funding accounts.** Allowed deliberately (a goal can precede the
   account that funds it); progress reads zero. WP 4.8/4.10 should say so on screen rather than show 0%.
4. **No over-earmark rule** (§6 item 4) — WP 4.7's to cap.
5. **The instrument's points are a design, not a validated psychometric scale.** They are pinned by
   version so a later recalibration is a `risk-v2`, never a silent re-score.

---

## 11. Results

_Written before the final full run; the run's output is appended below._

Final full run, after the evidence above was written and after WP 4.2's four integration edits (§10),
in the shared tree with WP 4.12a in flight:

```
$ DATABASE_URL=postgres://personalfi:personalfi@127.0.0.1:5433/personalfi_dev \
    pnpm exec vitest run --project planning --project planning-db --project db
 Test Files  17 passed (17)
      Tests  89 passed (89)

$ … --reporter=verbose test/goals.test.ts test/risk-profile.test.ts test/db/goals.test.ts test/ports.test.ts
 ✓ |planning| risk-profile › every disposition is asked in a stated and a revealed framing
 ✓ |planning| risk-profile › two framings of the same question disagree and the score moves conservative, not to the mean
 ✓ |planning| risk-profile › the consistency penalty is stored and the score is re-derivable from the stored answers alone
 ✓ |planning| risk-profile › tax_bracket_band is a band and the exact income never reaches the row
 ✓ |planning| goals › a goal target is Money and a contribution escalation never becomes a float
 ✓ |planning| goals › a target date in the past refuses with a domain error rather than clamping
 ✓ |planning| ports › namespaces its event to this context and registers it   (+ 6 unchanged)
 ✓ |planning-db| goals › every new table carries user_id and refuses another user's row
 ✓ |planning-db| goals › the stored risk profile carries its penalty and band, and no income
 ✓ |planning-db| goals › a goal, its plan and its event are written together, and the escalation reads back as a string

$ pnpm exec tsc -b --noEmit                                   # 0 errors
$ pnpm exec eslint packages/contexts/planning packages/db      # exit 0, no output
$ pnpm exec prettier --check <every WP 4.1 .ts/.md file>       # All matched files use Prettier code style!
$ node scripts/check-numeric-boundaries.ts | tail -1
check-numeric-boundaries: PASS — 706 file(s) scanned, 0 violations, 70 exempt identifier(s)
$ pnpm run lint:schema-ownership
schema-ownership: ok — 100 table(s) claimed across 14 package(s), 84 defined.
$ git diff --cached --name-only | wc -l
0
```

The `db` project is green because `migrate.test.ts` already carried the four 0020 names when this WP
ran (§10). The one red that remains outside this WP's projects is the pin in
`apps/api/test/phase3-registration.test.ts:192` (§10), which needs `toHaveLength(4)`.

WP 4.2's real schedules through `taxBracketBand`, with the adapter §10 describes (node, not a test):

```
path taxYears.2026.incomeTax
single 7 brackets   $84,000 → 22-32   $300,000 → 35-37
mfj    7 brackets   $84,000 → 10-12   $300,000 → 22-32
mfs    7 brackets   $84,000 → 22-32   $300,000 → 35-37
hoh    7 brackets   $84,000 → 22-32   $300,000 → 35-37
```
