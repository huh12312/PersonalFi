<!-- SPDX-License-Identifier: MIT -->

# WP 4.3 — Revealed behaviour, rolling 12 months

_A pure derivation over injected ports. No migration, no event. Dispatch:
`docs/plan/04-phase-4-dispatch.md` §3 "WP 4.3", §4 (shared files), §5 (gate standard). Normative
source: 09 GOAL-4 and E10's edge cases; 07 §5.2 (the four tax buckets), §5.6
(`floor_spending = essential_spend`); 08 §1.6 (plan → ledger, plan → invest, **no** plan → budg).
Written at HEAD `322683e` on `main`, working tree shared with WP 4.4 (`src/engine/**`) and WP 4.7
(`@ctx/investments`, migration 0023)._

---

## 1. What shipped

| File                                                          | What it is                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contexts/planning/src/revealed.ts` (new)            | `deriveRevealedBehavior(ports, input)` = `gatherRevealedFacts` (the only I/O) + `computeRevealedBehavior` (pure). Income, contributions per tax bucket, savings rate, essential / discretionary / unclassified / non-savings spend, the named exclusion list, `derivedContributionPlan` (into WP 4.1's `DERIVED` rows)             |
| `packages/contexts/planning/src/windows.ts` (new)             | Trailing windows of whole calendar months, observed spans, exact half-even rational scaling, the bigint one-off detector (`separateOneOffs`, `clearsOneOffThresholds`)                                                                                                                                                             |
| `packages/contexts/planning/src/ports.ts`                     | Appended: `TAX_BUCKETS`, `defaultTaxBucketFor`, `CashflowAccount`, `CashflowInflow`, `CashflowReader` (plan → ledger), `SpendingLine`/`SpendingPeriod`/`SpendingBudget`/`SpendingPeriodSummary`/`SpendingReader` (bound at the root; no arrow), `RevealedPorts`. One `import type` line added at the top. Nothing existing changed |
| `packages/contexts/planning/src/index.ts`                     | One export block appended (§8.3)                                                                                                                                                                                                                                                                                                   |
| `packages/contexts/planning/test/revealed.test.ts` (new)      | The four named exit tests, plus one supporting test for the other exclusion reasons                                                                                                                                                                                                                                                |
| `packages/contexts/planning/test/ports.test.ts`               | One `describe` appended: `'the SpendingReader binding is assignable from @ctx/budgeting's reader with no adapter'`                                                                                                                                                                                                                 |
| `packages/contexts/planning/test/revealed-seed.test.ts` (new) | The §3 seed walk, every number computed from the seed's raw rows beside a literal pin                                                                                                                                                                                                                                              |
| `packages/contexts/planning/test/windows.test.ts` (new)       | The detector's prose claims, each held to a test (§5)                                                                                                                                                                                                                                                                              |
| `packages/contexts/planning/test/revealed-fixtures.ts` (new)  | In-memory port fakes and the seed → ports adapter                                                                                                                                                                                                                                                                                  |

No other file was touched. `git diff --cached --name-only` is empty.

---

## 2. Decisions, each with its reason

### 2.1 Two ports, five methods — not four ports

The dispatch says "four injected ports". The derivation needs two readers, because there are two owners:

| Port             | Methods                                                                                  | Reads (at the root)                                                                                                                                                                                                  | Arrow it respects                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `CashflowReader` | `accounts(userId, asOf)`, `historyStarts(userId, ids)`, `inflows(userId, ids, from, to)` | `@ctx/ledger`: `listAccounts`, `transactions`, `transfer_links`; plus WP 3.8's `BalancesReader.accounts()` for the roster and `onBudget` (which itself reads `@ctx/budgeting`'s off-budget list, as it already does) | **plan → ledger** (08 §1.6 draws it)                                                                                                         |
| `SpendingReader` | `listBudgets`, `listPeriods`, `getPeriod`                                                | `@ctx/budgeting`: the three functions of the same names                                                                                                                                                              | **none** — 08 §1.6 draws no plan → budg arrow, so this is bound in `apps/api/src/domain.ts` and `@ctx/planning` never names `@ctx/budgeting` |

`CashflowReader` is the dispatch's "ContributionsReader". It is named for what it returns, because the same inflows answer income as well as contributions. Nothing in revealed behaviour needs `@ctx/investments` today (§9 item 3 says why that is a known gap).

### 2.2 What an "internal transfer" is

Phase 1's pairing (`transfer_links`) labels **every** matched transfer, including checking → brokerage, which is exactly the contribution GOAL-4 wants counted. So "exclude internal transfers" cannot mean "exclude every paired row". Here it means: **an arrival in a tax-bucketed account whose paired outflow left from another tax-bucketed account**, such as brokerage → Roth or a 401(k) rollover into an IRA. That money was already saved and is changing wrappers, so counting it would count one dollar twice. A paired arrival from a cash account is a contribution (`origin: linked_account`). An unpaired arrival (a payroll deferral, an employer match, a deposit from an unlinked bank) is a contribution too (`origin: external`). The internal-transfer check runs **before** the one-off check, so a $25,000 rollover is named `internal_transfer`, not `one_off`.

For income, any paired arrival in a cash account is an internal transfer (checking → savings is not income), and it is named.

### 2.3 "Gross income" is not derivable from a ledger, and is not claimed

A ledger never sees withholding. `income.total` is **take-home deposits into on-budget cash accounts plus contributions that arrived from outside the linked accounts**. A 401(k) deferral never passes through checking, so without it the savings rate's denominator would leave out exactly the pay that was saved. So the figure is net of tax and gross of saving. The string `INCOME_BASIS` says so on every result. Whoever consumes this for Social Security's AIME (WP 4.4) must not read it as gross wages.

Income is **not** one-off filtered. A bonus is income, and no detector can tell a bonus from an inheritance. The holder's 09 TX-10 exclusion is honoured and named (`user_excluded`).

### 2.4 The one-off rule: a conjunction, leave-one-out, largest first, repeated

The dispatch reads "more than `k` σ above the trailing distribution, **or** exceeding a stated multiple of the median". I chose **both, as a conjunction**. Each half alone fails on data this derivation will see:

- **σ alone, candidate included, cannot fire on small samples.** By Samuelson's inequality no point among `n` is more than `√(n−1)` population σ from the mean. So with ten or fewer observations nothing is ever 3σ out. Twelve $500s plus a $40,000 is z = √12 ≈ 3.46, the maximum possible.
- **σ alone, leave-one-out, fires on noise.** Twelve identical $500 deferrals have σ = 0, so a $520 after a raise is infinitely many σ out. `windows.test.ts` shows this: with `m = '0'` (σ only) the raise is struck.
- **The median multiple alone ignores spread.** A $100–$1,500 habit has its $1,500 at 6× the $250 median. σ (2.6) keeps it. `windows.test.ts` shows `k = '0'` (median only) striking it.

Defaults are **`m = '4'`, `k = '3'`, `oneOffMinimumPeers = 3`**, all parameters (`REVEALED_DEFAULTS`). Thresholds are decimal strings; a `number` is refused. Setting `k = '0'` gives the median test alone and `m = '0'` gives the σ test alone, so either reading of the dispatch is one parameter away. Both tests are exact bigint inequalities (`x > m·median ⇔ 2·x·m_den > m_num·(2·median)`; `x − μ > kσ ⇔ d > 0 ∧ d²·k_den² > k_num²·V`, with `d = n′x − S`, `V = n′Q − S²`), never a float compare.

The detector runs **per series and never pooled**: a bucket's contributions against that bucket's others, and a category's spend against that category's other non-zero periods. **Largest first, repeated**, so two one-offs cannot mask each other (tested with a $40k and a $30k in the same year). With fewer than `oneOffMinimumPeers` peers nothing is judged, and the result says `too_few_peers` rather than guessing.

**Why not `@ctx/recurring`'s `medianMinor`/`madMinor`.** It is the kernel candidate the brief asked me to check. It cannot be imported: it is another context, planning has no arrow to it, and it is not on that package's public surface. It also rounds an even-count median to a whole minor unit, where the test above needs the exact `2 × median`. Lifting a shared robust-stats module into `@core/kernel` is the right end state (§9 item 5).

### 2.5 History: whole months, the earliest start, a minimum of six

- The window is the **12 complete calendar months** on or before `asOf`. A month in progress is never in it.
- A group's observed span starts at the first _whole_ month on or after its **earliest** history start. Rows in a part month are named `partial_month`.
- **Earliest, not latest.** The first draft used the latest start, and `'an internal transfer never counts as a contribution'` caught it. A rollover IRA opened in February 2026 shrank the whole year to six months and the Roth rate to six observations (`expected 6 to be 12`, reproduced as sabotage S10). An account opened inside the window is new, not a sign that the ledger was blind before it. Annualising over the earliest start spreads a new account's arrivals over the whole span: it can understate a brand-new habit and can never inflate one. A $6,000 opening deposit a month ago reads as $6,000 a year here, not $72,000.
- Below **`minimumMonths = 6`** (a parameter) the answer is `insufficient_history`, which **carries no `annual`, `monthly` or `rate` field at all**. Six is half the window: four months of a twice-yearly contribution can hold zero of them or two, and neither annualises to the truth.
- Annualising: `annual = total × 12 / monthsObserved` and `monthly = total / monthsObserved` for ledger series. For spending it is `total × windowDays / coveredDays` (day-weighted, because a budget grid need not be monthly). Each is rounded **once**, half-even, straight from the exact total.

### 2.6 Absence is not zero

- A bucket with **no account in it** is `not_derivable` ("no ROTH account is linked"), never a derived `$0`. "$0 a year into a Roth" would claim the holder has a Roth and puts nothing in it (sabotage S7).
- No budget → spending `not_derivable`. **No NEED-classed category → essential `not_derivable`**, never `nonSavings − discretionary` and never a default share. Unclassified lines are their own total and are never apportioned to either class. SAVINGS-class lines are reported as `savingsClass` so their omission from spending is visible. Card-payment lines are never spending.
- A foreign-currency row is named `currency_mismatch` rather than converted at a guessed rate (D4). Without the screen, the kernel's `Money.sum` throws `CurrencyMismatchError` (sabotage S12). That is loud but fatal; the screen makes the row named instead of the derivation dead.

### 2.7 Tax buckets: there is no enum to find

The brief asked me to find the `TAX_DEFERRED`/`ROTH`/`TAXABLE`/`HSA` enum. **It does not exist anywhere in the tree.** `accounts` carries a provider `subtype` (`401k`, `roth`, `hsa`, …) and no tax-treatment column, exactly as it carries `include_in_net_worth` and none of 07 §4.1's other booleans. So `defaultTaxBucketFor(kind, subtype)` in `ports.ts` is the interim derivation, following `defaultFlagsFor`'s precedent one table up:

- Only `investment`-kind accounts have a bucket.
- Roth and TFSA subtypes → `ROTH`; HSA → `HSA`; 401(k)/403(b)/457(b)/IRA/SEP/SIMPLE/pension/RRSP… → `TAX_DEFERRED`.
- Education accounts (529, ESA, UGMA/UTMA) → `null`.
- Everything else invested → `TAXABLE`, the conservative reading.

No Ledger column was added. That is Ledger's migration and 09 AC-7's user-facing half (§9 item 1).

### 2.8 `onBudget` reuses `defaultFlagsFor`

`isIncomeAccount` is `kind === 'cash' && flags.onBudget`, and the binding's roster **is** WP 3.8's `BalancesReader.accounts()`: `defaultFlagsFor(kind)` narrowed by budgeting's off-budget list. There is no second derivation.

### 2.9 Which budget

The oldest one, which is the choice `createInsightsBudgetPort` already makes. Two budgets over the same accounts would double every purchase if summed. `spending.budgetId` names the choice.

---

## 3. The twelve-month window walked on the seed

`generateDemoData(1)` (the Phase 0/1 household), `asOf = 2026-08-31` → window **2025-09-01 … 2026-08-31**, 12 months, 365 days. The seed predates `@ctx/budgeting`, so `test/revealed-seed.test.ts` builds monthly budget periods from the seed's merchant categories with one stated mapping (`SEED_CATEGORY_CLASS`: groceries, housing, utilities, insurance, health, transport → NEED; dining, shopping, entertainment, travel, subscriptions → WANT). Transfer pairing is the seed's own ground truth (`labels.transfers`), which is what Phase 1's pairing is graded against. §7 repeats the walk through the **real** ledger and the real pairing heuristic, with identical results.

### 3.1 Accounts as the derivation sees them

| Account            | Kind       | Tax bucket | onBudget |
| ------------------ | ---------- | ---------- | -------- |
| Everyday Checking  | cash       | —          | true     |
| High-Yield Savings | cash       | —          | true     |
| Rewards Visa       | credit     | —          | true     |
| Brokerage          | investment | TAXABLE    | false    |
| Crypto Exchange    | investment | TAXABLE    | false    |
| Home Mortgage      | loan       | —          | false    |

### 3.2 The numbers, by hand beside the derivation

| Quantity                                       | By hand from the seed's raw rows                                                              | Derived                                                              | Observations |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------ |
| Take-home                                      | 26 biweekly payroll deposits × $3,100.00 = **$80,600.00** (first 2025-09-02, last 2026-08-18) | `income.takeHome.total` = 80600.00, annual 80600.00, monthly 6716.67 | 26           |
| Contributions from outside the linked accounts | none (both brokerage arrivals are paired from savings)                                        | `income.fromContributions` = 0.00                                    | 0            |
| Contributions, TAXABLE                         | savings → brokerage on 2025-10-05 and 2026-04-05, $2,000.00 each = **$4,000.00**              | `contributions.byBucket.TAXABLE.total` = 4000.00, monthly 333.33     | 2            |
| TAX_DEFERRED / ROTH / HSA                      | no such account                                                                               | `not_derivable` ("no … account is linked")                           | —            |
| **Savings rate**                               | 4,000.00 ÷ (80,600.00 + 0.00) = 0.049627… → **0.0496**                                        | `savingsRate.rate` = `'0.0496'`                                      | 28           |
| Essential (NEED)                               | Σ NEED-class activity = **$46,355.91**                                                        | 46355.91                                                             | 60           |
| Discretionary (WANT)                           | Σ WANT-class activity = $19,914.21, less the one named one-off 930.44 = **$18,983.77**        | 18983.77                                                             | 55           |
| Non-savings                                    | 46,355.91 + 18,983.77 + 0 unclassified                                                        | 65339.68                                                             | 115          |

The savings rate is contributions into the four tax buckets over income. The household's $500/month sweep into the High-Yield Savings account is **not** in it. That is correct under §2.2 (a savings account is `savings` in 09 AC-7's role vocabulary, not a tax bucket), but a reader should know it: the cash-flow saving rate of this household is higher than 4.96%.

The one-off detector abstained on the brokerage (`too_few_peers`: two observations) and on insurance (one observation, an annual-ish premium that is never judged and never struck).

### 3.3 Every excluded row and its reason (15)

| #    | Derivation | Reason            | Date                                       | Amount      | Row                                                       | Why, as the derivation words it                                                                                                                                                                                             |
| ---- | ---------- | ----------------- | ------------------------------------------ | ----------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | income     | refund            | 2025-09-04                                 | 43.11       | REFUND KAISER PERMANENTE                                  | a refund returns money already spent; it is not income                                                                                                                                                                      |
| 2    | income     | refund            | 2025-09-16                                 | 35.74       | REFUND LYFT                                               | same                                                                                                                                                                                                                        |
| 3–14 | income     | internal_transfer | the 28th of every month, 2025-09 … 2026-08 | 500.00 each | TRANSFER FROM EVERYDAY CHECKING (into High-Yield Savings) | paired by Phase 1's transfer matching with an outflow from Everyday Checking; a transfer between your own accounts is not income                                                                                            |
| 15   | spending   | one_off           | 2026-04-01                                 | 930.44      | shopping, 2026-04-01 to 2026-04-30                        | 930.44 USD is more than 4× the median of the other 11 periods of shopping in the window (220.45 USD) and more than 3σ above their mean (291.31 USD, σ 175.29 USD); a one-off is excluded rather than annualised into a rate |

Reconciliation asserted in the test: every positive posted row in the window on the two cash accounts is either counted (26) or named (14), so 40 = 26 + 14. Every NEED and WANT dollar is either in its total or in a named exclusion: `essential + named NEED = 4,635,591` minor units and `discretionary + named WANT = 1,991,421`.

### 3.4 The 09 E10 house-deposit case (it is not on the seed)

The seed has no one-off contribution, so the E10 case is a fixture (`'a $40,000 one-off transfer is excluded and named, …'`). $500/month from checking into the brokerage, plus $40,000 from savings on 2026-03-20. Result: TAXABLE monthly **$500.00**, annual $6,000.00, 12 observations, identical to the cent to the same year without the deposit. The savings rate is unchanged too. The single exclusion reads: _"40000.00 USD is more than 4× the median of the other 12 TAXABLE contributions in the window (500.00 USD) and more than 3σ above their mean (500.00 USD, σ 0.00 USD); a one-off is excluded rather than annualised into a rate."_

---

## 4. The `insufficient_history` path

`'four months of history returns insufficient_history and not an annualised number'`: accounts linked in May 2026, so May–August is all the ledger holds, with $1,000/month into the brokerage and a four-period budget. Every answer comes back as

```json
{
  "status": "insufficient_history",
  "source": "DERIVED",
  "minimumMonths": 6,
  "observationCount": 4,
  "window": {
    "from": "2025-09-01",
    "to": "2026-08-31",
    "months": 12,
    "observedFrom": "2026-05-01",
    "monthsObserved": 4
  }
}
```

That holds for contributions (total and TAXABLE), take-home, income, the savings rate, and all spending totals. There is no `annual`, `monthly` or `rate` key on any of them, and `derivedContributionPlan` returns `null`, so WP 4.1 gets no `DERIVED` row. The control in the same test: the same habit observed for six months (March–August) derives $1,000.00/month, $12,000.00/year over 6 observed months.

---

## 5. Every control, sabotaged once

Each mutation was applied with `sed` to one line and the named test file(s) were run from the repo root. The file was then restored from a byte copy and confirmed with `cmp` ("restored byte-identical" after every row). **All 13 were red on the first valid attempt.** A first batch of S1–S3 was invalid: the helper ran vitest from the package directory, where the `planning` project does not resolve. It printed nothing and proved nothing, and it was re-run from the root. It is recorded here because a silent run is what the gate lessons warn about.

| #   | Control                                 | Mutation                                                                      | Red test(s) and the failure                                                                                                                                                                              |
| --- | --------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | internal transfer excluded (§2.2)       | `revealed.ts:623` bucketed-counterpart check → `if (false)`                   | `an internal transfer never counts as a contribution`: `expected 13 to be 12`                                                                                                                            |
| S2  | one-off exclusion                       | `windows.ts:383` `if (!clearsOneOffThresholds(…)) break;` → `break;`          | `a $40,000 one-off transfer…` (the $40k counted); seed walk `expected '19914.21' to be '18983.77'`; four `windows.test.ts` detector tests. 6 failed                                                      |
| S3  | no annualisation below the minimum      | `revealed.ts:463` `if (window.monthsObserved < minimumMonths)` → `if (false)` | `four months of history…`: `expected 'derived' to be 'insufficient_history'`                                                                                                                             |
| S4  | essential never a total minus a guess   | `revealed.ts:1004` NEED filter → `class !== 'SAVINGS' && class !== 'WANT'`    | `essential spend comes from NEED-class categories…`: essential ≠ 31,200                                                                                                                                  |
| S5  | no NEED class → `not_derivable`         | `revealed.ts:998` condition → `false`                                         | same test: `expected 'derived' to be 'not_derivable'`                                                                                                                                                    |
| S6  | port / binding drift                    | `ports.ts:444` `readonly activity: Money` → `bigint`                          | `the SpendingReader binding is assignable…`: `binding.ts` now has two TS diagnostics (`expected [ { file: 'binding.ts', … } ] to deeply equal []`)                                                       |
| S7  | absent bucket is not zero               | `revealed.ts:675` `!bucketed.some(…)` → `false`                               | seed walk: `expected 'derived' to be 'not_derivable'`                                                                                                                                                    |
| S8  | a paired transfer is never income       | `revealed.ts:736` → `if (false)`                                              | seed walk: `expected '86600.00' to be '80600.00'`                                                                                                                                                        |
| S9  | the conjunction (§2.4)                  | `windows.ts:355` `&&` → `\|\|` (the dispatch's literal "or")                  | seed walk: essential `44903.15` ≠ `46355.91` (ordinary NEED months struck as one-offs); `a raise is not a one-off`; `a genuinely wide distribution keeps its upper tail`; `k = 0 degenerates…`. 4 failed |
| S10 | coverage from the earliest start (§2.5) | `revealed.ts:425` `< 0` → `> 0` (the first draft)                             | `an internal transfer never counts…`: `expected 6 to be 12`                                                                                                                                              |
| S11 | TX-10 exclusion honoured                | `revealed.ts:556` `if (row.userExcluded)` → `if (false)`                      | `names a user exclusion, …`: `expected 13 to be 12`                                                                                                                                                      |
| S12 | foreign-currency row named, not summed  | `revealed.ts:549` → `if (false)`                                              | same test: `CurrencyMismatchError: cannot combine USD with EUR`                                                                                                                                          |
| S13 | a part month is never annualised        | `revealed.ts:542` → `if (false)`                                              | same test: `expected 12 to be 11`                                                                                                                                                                        |

S9 is the strongest evidence for §2.4. Under the dispatch's literal "or", the seed household's essential spend falls by $1,452.76, because ordinary NEED months get struck as one-offs, and that is the floor 07 §5.6 hands the guardrail rule.

---

## 6. The port table

| Port (declared in `@ctx/planning/src/ports.ts`)            | Binding (`apps/api/src/domain.ts`, §8.1)                                                                                                | Context read                                                                 | Arrow respected                                      | Proven by                                                                                                                                           |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CashflowReader.accounts`                                  | `planningCashflowReaderFor` → WP 3.8's `planningPortsFor(…).balances.accounts()` + `listAccounts` for `subtype` → `defaultTaxBucketFor` | `@ctx/ledger` (and budgeting's off-budget list, via the existing 3.8 reader) | plan → ledger                                        | type probe (§7.1); runtime over a real ledger (§7.2)                                                                                                |
| `CashflowReader.historyStarts`                             | same, `MIN(effective_date)` per account over posted, un-superseded, un-removed rows                                                     | `@ctx/ledger` `transactions`                                                 | plan → ledger                                        | §7.2                                                                                                                                                |
| `CashflowReader.inflows`                                   | same, positive rows with the counterpart account read through the row's own `transfer_link_id`                                          | `@ctx/ledger` `transactions`, `transfer_links`                               | plan → ledger                                        | §7.2 (precision 1, recall 1 pairing; 12 internal transfers named)                                                                                   |
| `SpendingReader.listBudgets` / `listPeriods` / `getPeriod` | `planningSpendingReaderFor`: budgeting's three functions, executor closed over, **no field mapped**                                     | `@ctx/budgeting`                                                             | **none: no plan → budg arrow**, so bound at the root | `test/ports.test.ts` compiles this exact code against both packages on every run, with a live drift control (S6); runtime over a real budget (§7.2) |

---

## 7. The bindings, run for real

### 7.1 Compiled against the real composition root

The §8.1 code was written to `/tmp/wp43-binding/binding.ts` with `node_modules` → `apps/api/node_modules`. It imports `planningPortsFor` and `PlanningPortOptions` from `apps/api/src/domain.ts` itself, and was compiled with the repo's `tsconfig.base.json` and the repo's `tsc` 6.0.3. Result: **exit 0**. The only diagnostics on the first attempt were in `apps/api/src/auth/*`, where the `@fastify/cookie` module augmentation that the app's own program pulls in was missing; adding `import '@fastify/cookie'` to the probe cleared them. None were ever in the binding.

### 7.2 Run over a scratch database with the real ledger and a real budget

`createTestDatabase` could not be used at this HEAD. It migrates the working tree, and WP 4.7's in-flight `0023_allocation_targets.sql` currently fails: `there is no unique constraint matching given keys for referenced table "securities"` (§9 item 7). The same steps were replicated against the **22 migrations committed at `322683e`** (0001–0021 and 0025). The script:

1. Scratch database `personalfi_wp43_revealed_binding`, migrated, one holder.
2. `@ctx/ledger`'s own `loadSeedDataset(generateDemoData(1))`, which runs the real write path, the real `pairTransfers` heuristic and `detectRefundHints`: 6 accounts, 982 transactions, 1 pending, **50 transfer links, pairing precision 1, recall 1**, 10 refund hints.
3. `deriveRevealedBehavior(planningRevealedPortsFor(db, { userId, timeZone: 'America/New_York' }), { asOf: 2026-08-31 })`.
4. `@ctx/budgeting`'s own `createBudget` and `openPeriod` for 2025-08 … 2026-08, then classified lines and actuals (Rent NEED $2,000; Dining WANT $300; Miscellaneous unclassified $150 a month). The out-of-window **2025-08 period was planted at 100×**, so reading it would show. Derive again.
5. The database was dropped.

```text
seed loaded through @ctx/ledger: {"accounts":6,"transactions":982,"pending":1,"transferLinks":50,"refundHints":10,"pairingPrecision":1,"pairingRecall":1}
takeHome       derived total=80600.00 annual=80600.00 monthly=6716.67 n=26 months=12
income total   derived total=80600.00 annual=80600.00 monthly=6716.67 n=26 months=12
contrib total  derived total=4000.00 annual=4000.00 monthly=333.33 n=2 months=12
  TAXABLE      derived total=4000.00 annual=4000.00 monthly=333.33 n=2 months=12
  TAX_DEFERRED not_derivable (no TAX_DEFERRED account is linked, so there is nothing to observe a contribution in)
  ROTH         not_derivable (no ROTH account is linked, …)
  HSA          not_derivable (no HSA account is linked, …)
savingsRate    "0.0496"
essential      not_derivable (no budget exists; spending is read from budget categories and never estimated)
budget periods read: true monthsObserved 12
essential      derived total=24000.00 annual=24000.00 monthly=2000.00 n=12 months=12
discretionary  derived total=3600.00 annual=3600.00 monthly=300.00 n=12 months=12
unclassified   derived total=1800.00 annual=1800.00 monthly=150.00 n=12 months=12
nonSavings     derived total=29400.00 annual=29400.00 monthly=2450.00 n=36 months=12
exclusions     {"income/refund":2,"income/internal_transfer":12}
```

The real ledger with the real heuristic gives exactly the fake-port walk of §3 (same totals, same 14 named rows; labels are the ledger's `effective_name`, e.g. "Transfer From Everyday Checking"). The 100× August period was not read. The script is not committed, because the binding lives in `apps/api`, which is not this package's. §8.4 asks the orchestrator to commit it as a test.

---

## 8. For the orchestrator (Wave B wiring batch)

### 8.1 `apps/api/src/domain.ts`: append after `planningPortsFor`

Import additions: to the existing `@ctx/planning` import block add `defaultTaxBucketFor`, `type CashflowAccount as PlanningCashflowAccount`, `type CashflowInflow as PlanningCashflowInflow`, `type CashflowReader as PlanningCashflowReader`, `type RevealedPorts as PlanningRevealedPorts`, `type SpendingReader as PlanningSpendingReader`. To the `@core/kernel` import add `isUuid`. Everything else (`DateOnly`, `Money`, `listAccounts`, `listBudgets`, `listPeriods`, `getPeriod`, `sql`, `planningPortsFor`, `PlanningPortOptions`, `PlanningExecutor`) is already in scope in `domain.ts` today.

```ts
// ---------------------------------------------------------------------------
// WP 4.3 — `@ctx/planning`'s two revealed-behaviour ports
// ---------------------------------------------------------------------------
//
// `docs/evidence/phase-4/wp4.3-revealed.md` §8. `CashflowReader` respects
// 08 §1.6's plan → ledger arrow; `SpendingReader` exists because there is **no**
// plan → budg arrow, so budgeting's NEED-class answer arrives here, at the one
// place both contexts are in scope.

/**
 * One bound `uuid[]` parameter, as a Postgres array literal. Drizzle's `sql`
 * template expands an interpolated JavaScript array into a row constructor, not
 * an array parameter (`packages/contexts/categorization/src/seed-taxonomy.ts`
 * found this the hard way), so the ids travel as one text parameter and are
 * checked to be UUIDs first.
 */
function uuidArrayParameter(ids: readonly string[]): string {
  for (const id of ids) {
    if (!isUuid(id)) throw new Error(`not a UUID: ${JSON.stringify(id)}`);
  }
  return `{${ids.join(',')}}`;
}

/**
 * `@ctx/planning`'s `CashflowReader`, over `@ctx/ledger`.
 *
 * The roster **is** WP 3.8's `BalancesReader.accounts()` — the same
 * `planningKindOf` mapping, the same `defaultFlagsFor` narrowed by budgeting's
 * off-budget list — plus the tax bucket, derived by `@ctx/planning`'s own
 * `defaultTaxBucketFor` from the provider subtype. Two derivations of
 * `onBudget` would be two answers to one question.
 *
 * Both queries drop what never moved money — pending rows, superseded
 * duplicates, provider tombstones — and keep what the user excluded and what
 * the pairing matched, because the derivation must *name* those and cannot name
 * what it never saw. The counterpart account is the other leg of the row's own
 * `transfer_link_id`, read through `transfer_links` exactly as Phase 1 wrote it.
 */
export function planningCashflowReaderFor(
  executor: PlanningExecutor,
  options: PlanningPortOptions,
): PlanningCashflowReader {
  const roster = planningPortsFor(executor, options).balances;
  return {
    async accounts(userId: string, asOf: string): Promise<readonly PlanningCashflowAccount[]> {
      const [accounts, rows] = await Promise.all([
        roster.accounts(userId, asOf),
        listAccounts(executor, { userId, includeClosed: true }),
      ]);
      const subtypeOf = new Map(rows.map((row) => [row.id, row.subtype] as const));
      return accounts.map((account) => ({
        ...account,
        taxBucket: defaultTaxBucketFor(account.kind, subtypeOf.get(account.accountId) ?? null),
      }));
    },

    async historyStarts(userId, accountIds) {
      if (accountIds.length === 0) return new Map();
      const result = await executor.execute<{ account_id: string; first_date: string }>(sql`
        SELECT account_id::text AS account_id,
               to_char(MIN(effective_date), 'YYYY-MM-DD') AS first_date
          FROM transactions
         WHERE user_id = ${userId}::uuid
           AND account_id = ANY(${uuidArrayParameter(accountIds)}::uuid[])
           AND pending = false
           AND superseded_by_id IS NULL
           AND removed_at IS NULL
         GROUP BY account_id
      `);
      return new Map(
        result.rows.map((row) => [row.account_id, DateOnly.parse(row.first_date)] as const),
      );
    },

    async inflows(userId, accountIds, from, to): Promise<readonly PlanningCashflowInflow[]> {
      if (accountIds.length === 0) return [];
      const result = await executor.execute<{
        id: string;
        account_id: string;
        effective_date: string;
        amount_minor: string;
        currency: string;
        label: string;
        user_excluded: boolean;
        is_refund: boolean;
        counterpart_account_id: string | null;
      }>(sql`
        SELECT t.id::text AS id,
               t.account_id::text AS account_id,
               to_char(t.effective_date, 'YYYY-MM-DD') AS effective_date,
               t.effective_amount_minor::text AS amount_minor,
               t.effective_currency AS currency,
               t.effective_name AS label,
               t.user_excluded,
               (t.refund_of_id IS NOT NULL) AS is_refund,
               other.account_id::text AS counterpart_account_id
          FROM transactions t
          LEFT JOIN transfer_links l
                 ON l.id = t.transfer_link_id
                AND l.user_id = t.user_id
          LEFT JOIN transactions other
                 ON other.user_id = t.user_id
                AND other.id = CASE WHEN l.inflow_transaction_id = t.id
                                    THEN l.outflow_transaction_id
                                    ELSE l.inflow_transaction_id END
         WHERE t.user_id = ${userId}::uuid
           AND t.account_id = ANY(${uuidArrayParameter(accountIds)}::uuid[])
           AND t.effective_date BETWEEN ${from}::date AND ${to}::date
           AND t.effective_amount_minor > 0
           AND t.pending = false
           AND t.superseded_by_id IS NULL
           AND t.removed_at IS NULL
         ORDER BY t.effective_date, t.id
      `);
      return result.rows.map((row) => ({
        transactionId: row.id,
        accountId: row.account_id,
        date: DateOnly.parse(row.effective_date),
        amount: Money.of(BigInt(row.amount_minor), row.currency),
        label: row.label,
        userExcluded: row.user_excluded,
        isRefund: row.is_refund,
        transferCounterpartAccountId: row.counterpart_account_id,
      }));
    },
  };
}

/**
 * `@ctx/planning`'s `SpendingReader`, over `@ctx/budgeting` — the executor
 * closed over and **no field mapped**. `packages/contexts/planning/test/ports.test.ts`
 * type-checks this exact shape against both packages on every run.
 */
export function planningSpendingReaderFor(executor: PlanningExecutor): PlanningSpendingReader {
  return {
    listBudgets: (input) => listBudgets(executor, input),
    listPeriods: (input) => listPeriods(executor, input),
    getPeriod: (input) => getPeriod(executor, input),
  };
}

/** Both revealed-behaviour ports, per transaction — `planningPortsFor`'s shape and reason. */
export function planningRevealedPortsFor(
  executor: PlanningExecutor,
  options: PlanningPortOptions,
): PlanningRevealedPorts {
  return {
    cashflow: planningCashflowReaderFor(executor, options),
    spending: planningSpendingReaderFor(executor),
  };
}
```

`PlanningExecutor` is passed to budgeting's functions exactly as `offBudgetAccountIds` already passes it to `listBudgets`. The §7.1 probe confirms the assignment compiles.

### 8.2 Who calls it

Nothing yet. Revealed behaviour has no route and no job in Wave B. Its consumers are WP 4.6 (the projection service: the baseline's contributions and spending floor) and WP 4.8 (`GET /plan/…` surfacing the numbers with their exclusions). Both should call `deriveRevealedBehavior(planningRevealedPortsFor(tx, { userId, timeZone }), { userId, asOf, baseCurrency })` inside the request's or job's transaction, like `planningPortsFor`. The `DERIVED` contribution rows WP 4.1 stores are written from `derivedContributionPlan(result.contributions.byBucket[bucket], startsOn)`, with `derivedAsOf` = the window's last day.

### 8.3 `packages/contexts/planning/src/index.ts`: what this WP appended

One block after WP 4.1's `schema/goals.ts` re-export (line 282 on):

- from `./ports.ts`: `TAX_BUCKETS`, `defaultTaxBucketFor`, and types `CashflowAccount`, `CashflowInflow`, `CashflowReader`, `RevealedPorts`, `SpendingBudget`, `SpendingClass`, `SpendingLine`, `SpendingPeriod`, `SpendingPeriodSummary`, `SpendingReader`, `TaxBucket`;
- from `./revealed.ts`: `INCOME_BASIS`, `REVEALED_DEFAULTS`, `RevealedParametersInvalid`, `computeRevealedBehavior`, `deriveRevealedBehavior`, `derivedContributionPlan`, `gatherRevealedFacts`, and types `DerivedAmount`, `DerivedAmountValue`, `DerivedRate`, `DerivedRateValue`, `ExclusionReason`, `InsufficientHistory`, `NotDerivable`, `OneOffTestOutcome`, `RevealedBehavior`, `RevealedExclusion`, `RevealedFacts`, `RevealedInput`, `RevealedParameters`, `RevealedWindow`, `SpendingCategorySummary`;
- from `./windows.ts`: `trailingWindow`, and types `OneOffThresholds`, `TrailingWindow`.

WP 4.4 was told to report its own line to you rather than edit this file. It will go after this block.

### 8.4 One test to commit with the wiring

`apps/api/test/db/revealed-ports.test.ts` (project `api-db`) is §7.2's script as a test: `loadSeedDataset(generateDemoData(1))` → `planningRevealedPortsFor` → assert take-home 80600.00, TAXABLE 4000.00, `savingsRate.rate === '0.0496'`, 12 `internal_transfer` + 2 `refund` income exclusions; then a real budget with a planted out-of-window period and assert essential 24000.00. That is the runtime twin of the type-level check in `test/ports.test.ts`. It belongs in `apps/api` because only the composition root can see both contexts.

### 8.5 Shared files: nothing else

No `vitest.config.ts` change: the new tests match `planning`'s existing `test/*.test.ts` include. No `ci.yml` change, no `eslint-boundaries.js` change (and specifically **no** `@ctx/budgeting` on planning's allow-list), no dependency, no migration.

---

## 9. Carried and open items

1. **A user-set tax bucket and account role (09 AC-7).** `defaultTaxBucketFor` guesses from a provider subtype. Which accounts are `TAX_DEFERRED` and which are `ROTH` is a fact about Chris's real accounts, and it moves the projection more than any assumption (dispatch §6 Q8). The end state is a Ledger-owned column the holder sets, outranking the default the way the off-budget list outranks `onBudget`. That is Ledger's migration.
2. **Gross-of-tax income** is not derivable (§2.3). If WP 4.4's Social Security AIME needs wages, it must come from the holder or the assumptions panel, never from `income.total`.
3. **Investment-side cash arrivals.** The binding reads ledger rows. A Plaid investment account reports deposits and contributions as `investment_transactions` (`CASH`, `TRANSFER_IN`) in `@ctx/investments`, which the binding does not read. So a payroll-funded 401(k) linked through Plaid Investments shows no contributions until it does. Plan → invest is an allowed arrow; adding a third method (or an investments read inside `inflows`) is the fix. It needs a real account to test against, which makes it dispatch §6 Q8's fifth real-data criterion. The mirror risk: a provider that posts **dividends** as ledger rows on an investment account would have them counted as `external` contributions.
4. **History start is the earliest posted row**, a proxy for "observed since". A connection with no backfill looks like a new household. A `linked_since` on the connection would be better, and is `@ctx/connections`'.
5. **Robust statistics in `@core/kernel`.** `@ctx/recurring`'s `stats.ts` and this WP's `windows.ts` each carry a bigint median. One kernel module (exact `twiceMedian`, MAD, the σ inequality) would serve both. This is a kernel change and not this WP's.
6. **Budget choice** is "the oldest" (§2.9) until there is a field for the holder to say which budget is the household's.
7. **WP 4.7's `0023_allocation_targets.sql` does not apply at this working tree** (`there is no unique constraint matching given keys for referenced table "securities"`, observed while building §7.2's scratch database). It is in flight and not mine; flagged because every `*-db` suite migrates the working tree.
8. **`node scripts/check-numeric-boundaries.ts` failed mid-session on WP 4.4's file**, not on this WP's: `packages/contexts/planning/src/engine/social-security.ts:137 — primaryInsuranceAmount() returns number`. It passes at the final run (§11). No file of this WP was ever flagged.

---

## 10. Tests

| File                         | Tests                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/revealed.test.ts`      | the four named exit tests; `'names a user exclusion, a foreign-currency row, a refund and a part-month row, and counts none of them'`                                                                                                                                                                                                                       |
| `test/ports.test.ts`         | `'the SpendingReader binding is assignable from @ctx/budgeting's reader with no adapter'` (plus the existing seven, unchanged)                                                                                                                                                                                                                              |
| `test/revealed-seed.test.ts` | `'walks the twelve-month window to the same numbers the seed gives by hand'`                                                                                                                                                                                                                                                                                |
| `test/windows.test.ts`       | window bounds; `a raise is not a one-off`; `a $40,000 among twelve $500s is a one-off`; `two one-offs in the same year do not mask each other`; `a genuinely wide distribution keeps its upper tail`; `a series with fewer than the minimum peers is never judged`; `k = 0 degenerates…`; `refuses a threshold given as a number`; `rounds once, half-even` |

**How the named SpendingReader test works, and why.** `scripts/eslint-boundaries.js` refuses `@ctx/budgeting` in planning's `test/` exactly as in `src/`: `crossContext` for the package name, `escapes` for a relative path. `@ctx/budgeting` is not a planning dependency, so pnpm would not resolve it either. WP 3.8's pattern, a plain typed assignment, works there only because `@ctx/investments` is on the allow-list. So the test does what the composition root does, from where it stands. It writes the exact §8.1 `planningSpendingReaderFor` into a scratch directory whose `paths` resolve both packages from source, and runs the repo's `tsc` with the repo's `tsconfig.base.json` (about 5 s). The same run compiles a `drift.ts` that assigns the identical binding to a port whose `activity` is `bigint`. The test requires `binding.ts` to have zero diagnostics, `drift.ts` to fail with TS2322 naming `activity` and `Money`. It deliberately does not require the rest of the pulled-in tree to compile: that is `tsc -b`'s job, and the first draft of this test, which did assert it, went red on WP 4.7's in-flight `dwell.ts` during the final run (§11). If resolution ever degraded to `any`, the drift file would compile and the test would go red. S6 is that control observed failing.

---

## 11. Results

_Final verification, run after this document and the report were written:_

Working tree shared with WP 4.4 and WP 4.7, both mid-edit. Machine load average about 8 during these runs.

| Check                                                               | Result                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm exec tsc -b --noEmit`                                         | exit 1, **5 errors, none in a WP 4.3 file**: `apps/api/src/routes/investments.ts` (1) and `packages/contexts/investments/src/dwell.ts` (3), both WP 4.7 in flight; `packages/contexts/planning/test/engine/support.ts` (1), WP 4.4 in flight. `grep` for any of `src/{revealed,windows,ports,index}.ts` or `test/{revealed*,windows,ports}` in the output: 0 lines |
| `pnpm exec eslint packages/contexts/planning`                       | exit 0, no findings                                                                                                                                                                                                                                                                                                                                                |
| `pnpm exec prettier --check` on every WP 4.3 file and this document | all formatted                                                                                                                                                                                                                                                                                                                                                      |
| `node scripts/check-numeric-boundaries.ts`                          | self-test PASS; **PASS, 734 files, 0 violations** (the earlier WP 4.4 `social-security.ts:137` finding in §9 item 8 has since been fixed on that side)                                                                                                                                                                                                             |
| `vitest run --project planning`                                     | **every WP 4.3 test green on every run after the fix below.** The WP 4.3 tests are the four named exit tests, the supporting exclusions test, the seed walk, nine `windows.test.ts` tests, and the SpendingReader probe (8,987 ms under load, about 5 s unloaded). Whole-project runs: 96/97, 97/97, 93/97                                                         |

**What went red in the final runs, and why.**

1. **My own probe test, once, fixed.** The first final run had `'the SpendingReader binding is assignable…'` red. The reason was not the binding: its third assertion required the whole pulled-in tree to compile, and through `@ctx/planning` → `@ctx/investments` that tree now includes WP 4.7's in-flight `dwell.ts` (TS2339 `compareDateOnly`). That assertion was over-broad (it is `tsc -b`'s job) and was removed; §10 explains. The two load-bearing assertions are unchanged, and S6's recorded red came from the first of them.
2. **WP 4.4's engine tests** (`src/engine/deterministic.test.ts` ×2, `src/engine/solve.test.ts`, `src/engine/guardrails.test.ts`): in flight, not WP 4.3's, and different ones red on different runs.
3. **WP 4.2's `'the content hash is identical across two separate node processes'`** timed out at 5,198 ms and 5,419 ms against vitest's 5,000 ms default, and passed on the run in between. It spawns two Node processes with no explicit timeout, so it is load-sensitive. My probe test adds about 9 s of multi-core `tsc` to the same project run, which plausibly contributes. **Recommendation for the orchestrator:** give that test an explicit timeout (it is WP 4.2's file, so I have not touched it), the way WP 4.3's probe declares `120_000`.

`git diff --cached --name-only` is empty. No `git add`, commit, stash, checkout or mv was run. No migration, dependency, `vitest.config.ts`, `ci.yml` or `scripts/**` change. Scratch database `personalfi_wp43_revealed_binding` was created and dropped (§7.2). Throwaway files live only under `/tmp/wp43-binding/` and `/tmp/wp43-*`.
