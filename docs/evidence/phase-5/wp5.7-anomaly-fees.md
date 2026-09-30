<!-- SPDX-License-Identifier: MIT -->

# WP 5.7 — Anomaly and fee hunter

_Written while implementing, incrementally, per the phase-5 rule. Wave B, alongside WP 5.5 and WP 5.9._

## 1. What landed

- Advisor contract **1.4.0**: two new scopes, `transactions.anomalies` (sensitivity 8,
  `externalAllowed: false`) and `fees.summary` (sensitivity 5). Published schemas regenerated in the
  same commit (`packages/contracts/advisor/v1/*.schema.json`, `packages/contracts/advisor/advisor.schema.json`,
  `packages/contracts/src/index.ts`).
- Migration **0029_snapshot_grant_scopes_v1_4.sql**, widening `snapshot_grants_scope_check` for the two
  scopes — same commit as the contract bump (05 §4's non-negotiable rule).
- Both arms computed in `SnapshotBuilder` (`#transactionsAnomalies`, `#feesSummary`) from
  `LedgerPort.listTransactions`, with `accountId` added to `InsightsTransaction` (optional — see §7) and
  to the one select in `createInsightsLedgerPort` (`apps/api/src/domain.ts`).
- `packages/kernel/src/stats.ts`: exact bigint `medianMinor`, `twiceMedianMinor`, `madMinor`,
  `medianNumber`, `madNumber` — the third caller the dispatch names (`@ctx/recurring`'s and
  `@ctx/planning`'s own copies are unmoved; WP 5.14's to migrate).
- `builtin.spending.category_anomaly` (S1), `builtin.spending.new_merchant_high_charge` (S5),
  `builtin.spending.fee_hunter` (assigned `ruleId: 'S7'`, alongside the existing `builtin.spending.fees`)
  under `packages/contexts/insights/src/advisors/builtin/anomaly/**`.
- `catalogue.ts`: S1 and S5 moved out of `CATALOGUE_GAPS` into `BUILTIN_CATALOGUE`; a new `'anomalies'`
  wave; the whole `spending` wave (S2, S3, S6, S7, S9, S10) flipped `defaultEnabled: true`, reaching an
  existing install through WP 5.1's `enabled_source`.
- `policy/alert-budget.ts`: `rank()` gains a P0-safety term (`isP0Safety`), fixing wp4.9 §12 item 1.

## 2. Files touched, by path

Owned (per dispatch):

- `packages/contexts/insights/src/contract/{scopes.ts,snapshot.ts,version.ts,json-schema.ts}` (version.ts unchanged — the wire major stays 1)
- `packages/contexts/insights/src/snapshot/{builder.ts,ports.ts}`
- `packages/contexts/insights/src/advisors/builtin/anomaly/{index.ts,anomaly.ts,fees.ts}` (new)
- `packages/contexts/insights/src/advisors/catalogue.ts`
- `packages/contexts/insights/src/policy/alert-budget.ts` (the tie-break only)
- `packages/contexts/insights/src/index.ts` (WP 5.7's own appended block only)
- `packages/contexts/insights/test/{anomaly,fee-hunter,scope-minimization,contract-parity,alert-budget}.test.ts`
- `packages/kernel/src/{stats.ts,stats.test.ts,index.ts}`
- `packages/contracts/advisor/v1/*.schema.json`
- `packages/db/migrations/0029_snapshot_grant_scopes_v1_4.sql`
- `apps/api/src/domain.ts` (the one select in `createInsightsLedgerPort`)
- this file

Judgment calls, outside the literal ownership list, each a direct mechanical consequence of the above
(detailed with reasoning in §7):

- `packages/contracts/src/index.ts` (`ADVISOR_CONTRACT_VERSION`), `packages/contracts/advisor/advisor.schema.json`
  (`artefactVersion`, one added `rules[]` line) — required for contract-parity to hold at 1.4.0.
- `packages/contexts/insights/test/advisors/seed.ts` — five rows for S1's category baseline
  (`entertainment.movies`), two for the fee hunter's raw fee rows (`fees_and_services.atm_fees`); the
  seed-case doc table updated to name S1/S5.
- `packages/contexts/insights/test/catalog.test.ts` — the wave/count test rewritten (37 → 40 rules, all
  enabled; the premise "only spending is off" is obsolete).
- `packages/contexts/insights/test/alert-budget-wave.test.ts` — one assertion updated: R7, not S6, is now
  the one the retirement-wave-release test displaces (§5).

## 3. The 1.4.0 diff, additive

```diff
--- packages/contracts/advisor/v1/manifest.schema.json (1.3.0)
+++ packages/contracts/advisor/v1/manifest.schema.json (1.4.0)
   "artefactVersion": "1.3.0" -> "1.4.0"
           "plan.projection"
+          "transactions.anomalies",
+          "fees.summary"
```

`request.schema.json` gained 359 lines (two new optional block schemas + the enum members); `response.schema.json`
gained only the `artefactVersion` bump. Nothing existing moved, renamed or narrowed — `contract-parity.test.ts`'s
byte-for-byte comparison over the zod-emitted documents is what proves it, not a manual diff read.

## 4. The 0029 CHECK beside 0024's

```sql
-- 0024 (contract 1.3.0)                          -- 0029 (contract 1.4.0)
ADD CONSTRAINT snapshot_grants_scope_check        ADD CONSTRAINT snapshot_grants_scope_check
  CHECK (scope IN (                                 CHECK (scope IN (
  'networth.summary', 'cash.summary',               'networth.summary', 'cash.summary',
  'cashflow.monthly',  'budgets.status',             'cashflow.monthly', 'budgets.status',
  'recurring.list', 'goals.list',                    'recurring.list', 'goals.list',
  'risk.profile', 'market.watchlist',                'risk.profile', 'market.watchlist',
  'holdings.aggregate', 'holdings.detail',           'holdings.aggregate', 'holdings.detail',
  'transactions.summary', 'transactions.raw',        'transactions.summary', 'transactions.raw',
  'institutions.names',                              'institutions.names',
  'liabilities.terms', 'market.rates',                'liabilities.terms', 'market.rates',
  'plan.projection'));                               'plan.projection',
                                                      -- advisor contract 1.4.0 (WP 5.7)
                                                      'transactions.anomalies', 'fees.summary'));
```

References only `snapshot_grants` and the constraint 0019 named on it — 0012-era objects. No new table.
`apps/api/test/phase3-registration.test.ts` → `'every advisor scope can actually be granted'` reads the
**latest** file declaring the constraint; 0030–0034 (WP 5.9, WP 5.13) never touch it, so 0029 stays the
latest declaration regardless of landing order. Verified green (15/15) against the live tree.

## 5. Migration numbering and `packages/db/test/migrate.test.ts` — needs the orchestrator

`packages/db/test/migrate.test.ts` is WP 5.9's file this wave; not touched. It currently has attribution
comments for 0028 and 0030 with a gap where 0029 belongs (confirmed by reading the file at the time of
writing). The block to insert, matching the house style exactly, between the 0028 and 0030 comments:

```
// 0029_snapshot_grant_scopes_v1_4: no table. Re-declares
//   `snapshot_grants_scope_check` with advisor contract 1.4.0's two added
//   scopes (`transactions.anomalies` — S1/S5's exact-amount category
//   baseline, never bucketed like `transactions.raw` — and `fees.summary` —
//   the fee hunter's by-type/by-account breakdown). Ships in the same
//   commit as the contract bump (05 §4's non-negotiable pairing). Parity
//   with `ADVISOR_SCOPES` is asserted by apps/api's registration test,
//   which reads the latest CHECK across migrations — the 0019 lesson
//   mechanised, same as 0024's.
```

No table-list change: 0029 creates nothing, so the alphabetical `table_name` array needs no edit.

## 6. Both new rules, and the fee hunter, firing on the seed

Run against `test/advisors/seed.ts`'s `drift` case (the shared seed, extended — see §7):

**`transactions_anomalies` block** (identifiers already opaque — `builtin` kind reads raw transaction ids,
never tokenised, by design; `merchant_ref` is tokenised regardless of kind):

```json
{
  "as_of": "2026-09-19",
  "currency": "USD",
  "window_months": 12,
  "materiality_floor": { "minor": "2500", "currency": "USD" },
  "deviation_threshold": 3,
  "new_merchant_floor": { "minor": "25000", "currency": "USD" },
  "rows": [
    {
      "transaction_ref": "txn-software-0",
      "date": "2026-07-12",
      "category_slug": "subscriptions.software",
      "merchant_ref": "MERCHANT_3bb6a70b4a3f",
      "amount": { "minor": "-59900", "currency": "USD" },
      "baseline_median": null,
      "baseline_mad": null,
      "deviation_multiple": null,
      "first_seen_merchant": true,
      "duplicate_of": null,
      "fee_type": null
    },
    {
      "transaction_ref": "txn-movies-outlier",
      "date": "2026-09-15",
      "category_slug": "entertainment.movies",
      "merchant_ref": "MERCHANT_a7225af5b7e5",
      "amount": { "minor": "-15000", "currency": "USD" },
      "baseline_median": { "minor": "2050", "currency": "USD" },
      "baseline_mad": { "minor": "50", "currency": "USD" },
      "deviation_multiple": 259,
      "first_seen_merchant": false,
      "duplicate_of": null,
      "fee_type": null
    }
  ]
}
```

Only these two rows — the five identical $50.00 "movies" charges the baseline was computed over never
cross, and neither does any other transaction in the seed.

**`fees_summary` block**:

```json
{
  "as_of": "2026-09-19",
  "currency": "USD",
  "window_months": 12,
  "by_type": [
    {
      "type": "fees_and_services.atm_fees",
      "avoidable": true,
      "count": 2,
      "total": { "minor": "700", "currency": "USD" }
    }
  ],
  "by_account": [
    { "account_ref": "acct-checking", "count": 2, "total": { "minor": "700", "currency": "USD" } }
  ],
  "expense_ratio_drag": null
}
```

**Firings, each run through the real `validateResponse` pipeline (all accepted, zero rejected):**

| Rule                                           | Key                                                | Severity | Summary                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| S1 `builtin.spending.category_anomaly`         | `spending.category_anomaly.txn-movies-outlier`     | notable  | "A entertainment.movies charge of $150.00 on 2026-09-15 is well above the category's usual $20.50."     |
| S5 `builtin.spending.new_merchant_high_charge` | `spending.new_merchant_high_charge.txn-software-0` | warning  | "A $599.00 charge on 2026-07-12 is the first charge seen from this merchant in the last twelve months." |
| fee hunter `builtin.spending.fee_hunter`       | `spending.fee_hunter`                              | warning  | "Avoidable fees came to about $7.00 over the last year, led by ATM fees at $7.00."                      |

**The fee hunter's own table**, from `test/fee-hunter.test.ts`'s dedicated fixture (two ATM fees on
`acct-checking`, a foreign-transaction fee and a year of interest on `acct-card`):

| by_type                              | avoidable | count | total   |
| ------------------------------------ | --------- | ----- | ------- |
| `fees_and_services.atm_fees`         | true      | 2     | $7.00   |
| `fees_and_services.foreign_fees`     | true      | 1     | $6.25   |
| `fees_and_services.interest_charges` | **false** | 1     | $120.00 |

| by_account      | count | total                            |
| --------------- | ----- | -------------------------------- |
| `acct-checking` | 2     | $7.00                            |
| `acct-card`     | 2     | $126.25 (foreign fee + interest) |

Insight: `impact.annualized.minor = "1375"` ($7.00 + $6.25 — the interest never enters the sum), worst
offender named as "ATM fees at $7.00", `expense_ratio_drag` present only when `holdings.detail` is also
granted (a second test: `null` without it, `holdings.detail`'s own `annual_fee_cost` summed — `$90.00`
in the fixture — with it, never recomputed).

## 7. Judgment calls and why

**`InsightsTransaction.accountId` is optional, not required.** The dispatch says "with `accountId` added
to `InsightsTransaction`"; it does not say required. `test/advisors/seed.ts` constructs many
`InsightsTransaction` literals with no `accountId`, and that file is not mine — widening the field to
required would be a compile break in a file I do not own, for every existing DRIFT/CONTROL/TIGHT fixture
row. Optional, with `#feesSummary`'s by-account grouping excluding (never fabricating) a row whose
`accountId` is absent, is the null-safe convention this codebase already uses elsewhere
(`emergency_fund_months`, `cost_basis`). `createInsightsLedgerPort`'s one real select always supplies it.

**`builtin.spending.fee_hunter` carries `ruleId: 'S7'`, the same as the existing `builtin.spending.fees`.**
07 §3.3 has one fee rule, S7; the fee hunter is that rule read from a richer scope, not a new numbered one.
`catalog.test.ts`'s uniqueness check is on `advisorId`, not `ruleId` (verified by reading the test), so two
entries sharing a `ruleId` is not itself a violation. The cost of this choice is `advisor-golden.test.ts`
(§9) — its `ruleId`-keyed `evaluate()` helper cannot disambiguate two same-`ruleId` entries; giving up a
clean golden entry there for a semantically correct catalogue was the trade made.

**`test/advisors/seed.ts` extended, not left alone.** S1 needs five same-category outflows before a
baseline exists, and no existing DRIFT category had five; the fee hunter needs raw fee-category
transaction rows, which `categorySpend`'s aggregate fixture (the _existing_ `builtin.spending.fees`'
source) does not supply. Without the extension, `catalog.test.ts`'s `'every rule produces at least one
resolvable evidence ref on the seed'` — a pre-existing, generic, catalogue-wide test, not mine to skip —
goes red for S1 and for the fee hunter's `S7` entry (both observed red, see §8). The seven added rows are
in a **new** category (`entertainment.movies`) and a **new**, previously-absent fee category
(`fees_and_services.atm_fees` as raw rows, on a `0-10` amount band that is outside S6's
`DUPLICATE_BANDS`, so no accidental duplicate-charge finding). Full insights suite re-run after the
addition: 266 passed, 1 known failure (§9), 36 skipped (db-project tests, no local Postgres in this
session). Every scenario in `test/anomaly.test.ts` and `test/fee-hunter.test.ts` uses its own dedicated,
self-contained fixture via `inMemoryLedgerPort` and does **not** depend on `seed.ts` at all — the
extension is only for the pre-existing catalogue-wide test's sake.

**`catalog.test.ts`'s wave/count test rewritten.** `'ships every wave with a reader enabled, leaving only
spending off'` asserted `defaultEnabled === false` for the whole `spending` wave and a hardcoded count of
31/6. Releasing the spending wave (an explicit WP 5.7 deliverable) makes both assertions false by
construction — not a coincidental collision, a direct, single-purpose consequence of the one file I fully
own (`catalogue.ts`). Rewritten to `'ships every rule in the catalogue enabled'`, asserting 40/0. Verified
green.

**`alert-budget-wave.test.ts`'s retirement-wave-release test, one assertion changed.** That test builds
`existing` from `BUILTIN_CATALOGUE.filter(entry => entry.wave !== 'retirement')` and calls
`.rule.evaluate()` directly — independent of `defaultEnabled`, so it already included S6's proposal before
any catalogue flag changed. Before the P0-safety fix, R7 always made the post-release dashboard (the
alphabet: `S6`'s `'spending.'` key lost to it). After the fix, S6 rightfully keeps its seat and R7 — tied
on rank with X1/I4/I5, alphabetically last among the non-safety contenders — is the one displaced. This
is the exact, intended behaviour the fix exists for, observed as a side effect of running the whole suite
rather than sought out. One `expect(dashboard).toContain('R7')` became
`expect(dashboard).toContain('S6')`, with a comment tracing the reasoning back to this file's own header,
which already described the bug it now demonstrates being fixed.

**Packages/contracts version files, touched though not named path-by-path in the ownership list.**
`packages/contracts/advisor/v1/*.schema.json` is explicitly mine; `packages/contracts/src/index.ts`
(`ADVISOR_CONTRACT_VERSION`) and `packages/contracts/advisor/advisor.schema.json`'s `artefactVersion` are
not named individually, but `contract-parity.test.ts` — which _is_ mine to write and keep green — asserts
both against `ADVISOR_ARTEFACT_VERSION`. No other WP this wave touches `packages/contracts/`.

## 8. Sabotages, recorded as they happened

Every sabotage below was applied, run, observed red, restored, and the restore confirmed byte-identical
by `sha256sum` (`packages/contexts/insights/src/snapshot/builder.ts`,
`packages/contexts/insights/src/contract/scopes.ts` and `packages/kernel/src/stats.ts` each hashed before
the first sabotage and after the last restore — identical). No `git` command was used to restore; every
restore was a hand edit back to the original text.

| #    | Control                                                                 | Sabotage                                                                                                         | Test driven                                                                                                                         | Result                                 | First failure                                                                                                                                    |
| ---- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| SA-1 | The threshold is applied in-process; only flagged rows cross            | `const flagged = candidates.filter(...)` replaced with `const flagged = candidates;` in `#transactionsAnomalies` | `test/anomaly.test.ts` → `'an unflagged transaction never appears in the anomalies block'`                                          | **red**                                | `expected 6 to be 1` — all six candidates, flagged or not, crossed                                                                               |
| SA-2 | The $25 materiality floor gates S1                                      | `s1Flag = deviation > 3n * mad;` (the `&& deviation > materialityFloorMinor` clause dropped)                     | `test/anomaly.test.ts` → `'a $24 outlier and a 2.9-deviation charge raise nothing'`                                                 | **red**                                | the $24.00-deviation candidate (`test.floor_only`) was returned, `deviation_multiple: 160`                                                       |
| SA-3 | `transactions.anomalies` is never granted to `external`                 | `externalAllowed: false` → `true` on the scope row                                                               | `test/scope-minimization.test.ts` → `'transactions.anomalies is never emitted to an external advisor and carries no unflagged row'` | **red**                                | `expected true to be false` on the scope-row assertion                                                                                           |
| SA-4 | The median and MAD are exact bigint, never a float                      | `madMinor` rewritten to `BigInt(Math.abs(Number(value) - Number(centre)))`                                       | `packages/kernel/src/stats.test.ts` → `'the median and MAD are exact over bigint and never pass through a float'`                   | **red**                                | `expected 0n to be 3n` — a genuine spread (base ± 3, ± 11 past ten times `Number.MAX_SAFE_INTEGER`) collapsed to zero once cast through `Number` |
| SA-5 | S6, a P0-safety finding, is not dropped from the dashboard by key order | `rank()`'s `safetyTerm` hardcoded to `0`                                                                         | `test/alert-budget.test.ts` → `'an urgent finding with no impact is never dropped from the dashboard by key order'`                 | **red** (wp4.9 §12 item 1, reproduced) | S6's key missing from a five-slot dashboard that otherwise ties six `urgent`, zero-impact candidates                                             |

A first attempt at SA-4 (a 5-value fixture spanning `9_007_199_254_740_991n`–`…741_009n`) did **not** go
red — the sabotaged deviations happened to sort into the same rank order as the exact ones (float
deviations `[5,4,0,4,12]` vs exact `[6,4,0,4,12]`, same median position). Recorded rather than hidden: it
is the reason the final fixture uses a base ten times larger (`90_071_992_547_409_930n ± {3,11}`), found by
brute-force search until the corruption changed the _result_, not merely an intermediate value — a
reminder that "far beyond `MAX_SAFE_INTEGER`" is necessary but not sufficient for a float-exactness proof
to actually distinguish the two code paths.

## 9. `advisor-golden.test.ts` — needs the orchestrator

`test/advisor-golden.test.ts` is not in WP 5.7's ownership (not named, and not one of `WP 5.9`'s or `WP
5.5`'s either — an orphaned file this wave). Its `'covers every rule in the catalogue'` test requires
`GOLDEN`'s `ruleId` multiset to equal `BUILTIN_CATALOGUE`'s exactly, and fails now:

```
- "S1",
+ (absent)
- "S5",
+ (absent)
- "S7" (×1)
+ "S7" (×2)
```

Investigated, not attempted, for three reasons:

1. **The `ruleId`-keyed harness cannot address the fee hunter.** `evaluate(ruleId)` does
   `BUILTIN_CATALOGUE.find(item => item.ruleId === ruleId)`, which for `'S7'` always resolves to the
   _first_ match — `builtin.spending.fees`, never `builtin.spending.fee_hunter`. A golden row for the fee
   hunter through this exact mechanism is not expressible without changing the helper to key on
   `advisorId` (a logic change to an unowned file's test infrastructure, not a data addition).
2. **S1 is now addable** (`test/advisors/seed.ts`'s extension makes it fire on `drift`) — a
   straightforward addition once (1) is resolved, since `ruleId: 'S1'` has no collision.
3. **S5's golden entry cannot assert CONTROL silence as written.** Every `GOLDEN` row's test also asserts
   `evaluate(ruleId, control).insights` is `[]`. `CONTROL_LEDGER`'s `txn-ctl-rent` — a $2,000.00 charge,
   the first (and only) appearance of `merchant-ctl-landlord` in that fixture — legitimately clears S5's
   literal, unconditional trigger ("a first-time charge over $250 at a new merchant"). This is not a bug
   in S5; it is CONTROL's fixture never having been designed with a merchant-history-aware rule in mind.
   Fixing it means either special-casing S5 to exclude some class of charge (inventing scope the dispatch
   does not ask for) or editing `CONTROL_LEDGER` (an unowned, and semantically load-bearing, fixture —
   "a healthy financial life with nothing wrong" — that several _other_ rules' golden and control
   assertions also depend on staying exactly as it is).

Recommended, for whoever picks this up: give the fee hunter a distinct `ruleId` (e.g. `'S7B'`) so
`evaluate()`'s `.find()` is unambiguous, or make the helper `advisorId`-keyed; add an `S1` golden row on
`drift` (`spending.category_anomaly.txn-movies-outlier`, the exact summary text is in §6); and either
accept an `S5` golden row anchored on `tight` instead of `control` (`tight`'s own transactions would need
checking for the same conflict) or extend `CONTROL_LEDGER` with the awareness that every existing
control-silence assertion for every other rule must still hold. None of this is a WP 5.7 defect — S1, S5
and the fee hunter are proven, thoroughly, in their own dedicated fixtures (`test/anomaly.test.ts`,
`test/fee-hunter.test.ts`) and pass the real `validateResponse` pipeline on the shared seed (§6).

## 10. DB reads not taken

No `docker compose exec … psql` or `docker compose logs` run, per the rule. Nothing in this package needed
one — every proof above is against an in-memory port or the migration file's own text.

## 11. `just check` result

Run at the end, after this report. Appended below.

## 12. The golden coverage test

`test/advisor-golden.test.ts` was orphaned (§9): not WP 5.7's to own, but red because of WP 5.7's own
additions — two rules (S1, S5) with no golden row, and a fee hunter sharing `builtin.spending.fees`'s
`ruleId` (`'S7'`) with no way for the old `ruleId`-keyed harness to address it. Picked up here, as §9
recommended, with the harness change.

### The choice: `advisorId`-keyed harness, not a distinct `ruleId`

`catalogue.ts`'s `BuiltinCatalogueEntry.ruleId` is typed `string`, not a closed union, so nothing in the
type system would have stopped a fabricated `'S7B'`. What stopped it was 07 itself: `07-*.md` §5's rule
table has exactly one `S7`, and inventing a second identifier for it would assert a distinction 07 does
not draw between the two `S7` entries — `catalogue.ts`'s own comment beside them says the fee hunter "is
07's same rule, read from a richer scope, not a new numbered one." A test helper forcing a `ruleId` split
that the research file doesn't have would be the golden test inventing the fact it exists to check.

`advisorId` was already the correct key — `catalog.test.ts`'s own uniqueness check runs on `advisorId`, not
`ruleId`, which is precisely why two `S7` catalogue entries were never a catalogue defect. The fix moves
the golden harness onto the same invariant the rest of the suite already trusts:

- `evaluate(ruleId, snapshot)` → `evaluate(advisorId, snapshot)`, resolving
  `BUILTIN_CATALOGUE.find((item) => item.advisorId === advisorId)`.
- `Golden.ruleId` is kept — every row still carries its 07 label, useful in a diff and in the test title —
  but a new `Golden.advisorId` field is what `evaluate()` and the exhaustiveness check actually use. All 37
  pre-existing rows got their `advisorId` filled in mechanically (a small Python script, run once, matching
  each unique `ruleId: 'XX'` line against a `ruleId → advisorId` table built by reading every
  `builtinManifest({ advisorId: … })` call and each family's `_RULES` export-array order — `debt/index.ts`,
  `investing/index.ts`, `crypto/index.ts`, `retirement/index.ts`, `rules-cash.ts`, `rules-spending.ts`,
  `rules-subscriptions.ts` — since `catalogue.ts` destructures each family array positionally). The script
  refused to run twice over the same `ruleId` (a hard stop, not a silent overwrite), so the one true
  pre-existing ambiguity — `'S7'` — was still unique going in and caught nothing false.
- `'covers every rule in the catalogue'` now compares `GOLDEN.map((row) => row.advisorId).sort()` against
  `BUILTIN_CATALOGUE.map((entry) => entry.advisorId).sort()`, the same identity the harness now resolves
  by.

No file outside `advisor-golden.test.ts` was touched for this — `catalogue.ts` was read, not written;
`seed.ts` already carried every fixture row S1, S5 and the fee hunter need (see below), so it needed no
addition either.

### The three new rows

All three sit at `seedCase: 'drift'`, appended after R7 in `GOLDEN`'s WP 5.7 block, matching the order
`catalogue.ts` itself lists them in (after the retirement wave). No `seed.ts` fixture row was added,
edited or reordered — every transaction each rule fires on was already in the file from WP 5.7's own
extension (§6's `drift` case; §7's "extended, not left alone").

**S1**, `builtin.spending.category_anomaly` — fires once, on `txn-movies-outlier`:

```
keys: ['spending.category_anomaly.txn-movies-outlier']
summary: "A entertainment.movies charge of $150.00 on 2026-09-15 is well above the category's usual $20.50."
severity: notable · annualized: null (producesImpact: false)
```

Silent on `control` (`[]`): `control`'s `categorySpend`/`transactions` never give any one category five
outflows, the population floor `#transactionsAnomalies` requires before it will found a baseline at all —
confirmed by reading `builder.ts`'s `SNAPSHOT_WINDOWS.anomalyMinCategorySample` gate directly, not assumed.

**S5**, `builtin.spending.new_merchant_high_charge` — fires once, on `txn-software-0`, the first of three
`merchant-software` charges in the window (07-12, $599.00 — the later two, 08-12 and 09-12, are no longer
first-seen):

```
keys: ['spending.new_merchant_high_charge.txn-software-0']
summary: 'A $599.00 charge on 2026-07-12 is the first charge seen from this merchant in the last twelve months.'
severity: warning · annualized: null (producesImpact: false)
```

**Not silent on `control`** — this is the row §9 flagged, and the investigation confirmed the conflict is
real and, on `tight`, worse than suspected. `builder.ts`'s `#transactionsAnomalies` computes
`firstSeenMerchant` per merchant over the window's own raw rows (earliest date per `merchantId`), with no
special-casing for rent, landlords, or recurring bills — a literal, unconditional trigger, exactly as §9
described it and exactly as `test/anomaly.test.ts` proves it should behave.

- `control`: `txn-ctl-rent` ($2,000.00, 2026-09-02, `merchant-ctl-landlord`'s only appearance in
  `CONTROL_LEDGER`) clears both conditions — first-seen and over the $250 floor — so S5 fires there too.
  No other `CONTROL_LEDGER` row does (`txn-ctl-stream` $18.99, `txn-ctl-market` $91.00, `txn-ctl-fuel`
  $54.00 — all under the floor).
- `tight` was checked as the alternative anchor per the brief, and is **not** a clean substitute: it fires
  S5 **twice** — `txn-tight-rent` ($1,450.00, `merchant-landlord`'s only appearance) and `txn-tight-power`
  ($800.00, `merchant-power`'s only appearance) both clear first-seen-and-over-$250 (`txn-tight-shop` at
  $62.00 does not). Anchoring on `tight` would have swapped one documented conflict for a worse, two-row
  one, for no gain — `tight` is still not a case S5 was "designed for" (that's `drift`), so nothing was
  bought by moving the control check there.

The row does not force a false `[]`. A new optional field, `Golden.controlKeys` (documented on the
interface, defaulting to `undefined` → `[]` for every other row, so no other assertion changed shape),
lets this one row assert what S5 actually produces on `control`:

```
controlKeys: ['spending.new_merchant_high_charge.txn-ctl-rent']
```

with a comment on the row itself tracing the reasoning above. The test loop's title also changes shape for
this row only (`"S5 (...) fires on the drift case, and on the control for the reason recorded on the row"`
instead of `"... and not on the control"`), so a reader scanning test output sees the exception rather than
a title that lies. `CONTROL_LEDGER` itself was not touched — confirmed by `git diff` showing no change to
`test/advisors/seed.ts` at all.

**Fee hunter**, `builtin.spending.fee_hunter` — fires once, `key: 'spending.fee_hunter'`:

```
keys: ['spending.fee_hunter']
summary: 'Avoidable fees came to about $7.00 over the last year, led by ATM fees at $7.00.'
severity: warning · annualized: '700' (two $3.50 ATM fees, `producesImpact: true`)
```

Silent on `control`: no `fees_and_services.*` category appears anywhere in `CONTROL_LEDGER`'s
`categorySpend` or `transactions`, so `fees_summary.by_type` is empty and the rule's own early return
(`if (avoidable.length === 0) return { insights: [], warnings: [] };`) fires before any Money arithmetic
runs.

### Run output — `advisor-golden.test.ts` and the named files

```
$ timeout 300 pnpm exec vitest run --project insights packages/contexts/insights/test/advisor-golden.test.ts
 Test Files  1 passed (1)
      Tests  42 passed (42)

$ timeout 300 pnpm exec vitest run --project insights packages/contexts/insights/test/anomaly.test.ts packages/contexts/insights/test/fee-hunter.test.ts
 Test Files  2 passed (2)
      Tests  7 passed (7)

$ timeout 300 pnpm exec vitest run --project insights packages/contexts/insights/test/catalog.test.ts packages/contexts/insights/test/catalog-v2.test.ts packages/contexts/insights/test/catalog-v3.test.ts
 Test Files  3 passed (3)
      Tests  27 passed (27)
```

42 golden tests = 40 per-row tests (37 pre-existing + S1 + S5 + fee hunter) + `'covers every rule in the
catalogue'` + `'a rule is a pure function of its context'`.

### Sabotage: the fee hunter's row pointed at `builtin.spending.fees`

Control: the fee hunter's `GOLDEN` row carries `advisorId: 'builtin.spending.fee_hunter'`, distinct from
the pre-existing `S7` row's `advisorId: 'builtin.spending.fees'`.

Sabotage: changed the fee hunter row's `advisorId` to `'builtin.spending.fees'` (the same string as the
other `S7` row) and reran `advisor-golden.test.ts`.

Result: **red**, in exactly the two places a harness that had failed to disambiguate the two advisors
would have looked healthy:

```
FAIL  covers every rule in the catalogue
  AssertionError: expected [ …(40) ] to deeply equal [ …(40) ]
  -   "builtin.spending.fee_hunter",
  +   "builtin.spending.fees",
      "builtin.spending.fees",

FAIL  S7 (builtin.spending.fees) fires on the drift case and not on the control
  AssertionError: expected [ 'spending.fees' ] to deeply equal [ 'spending.fee_hunter' ]
```

The first failure is the exhaustiveness check catching that `GOLDEN` no longer covers
`builtin.spending.fee_hunter` at all (its multiset now has `'builtin.spending.fees'` twice). The second is
`evaluate('builtin.spending.fees', drift)` correctly resolving to the _other_ `S7` advisor and returning
its own key (`'spending.fees'`), not the fee hunter's — proof the harness is actually keyed on the
identifier it claims to be keyed on, not silently falling back to a `.find()` that would have papered over
the mistake by matching the first `S7` it saw. Restored by hand (one line, `advisorId:
'builtin.spending.fee_hunter'`), rerun, back to 42/42 green — confirmed identical to the pre-sabotage
version by `git diff` showing no residual change to the file.

### Final full-project run

Run after the report above was posted, per the rule.

```
$ timeout 300 pnpm exec vitest run --project insights
 Test Files  27 passed (27)
      Tests  270 passed (270)
   Duration  8.43s
```

Whole `insights` vitest project green: 27/27 files, 270/270 tests — `advisor-golden.test.ts`'s 42
(previously 39: 37 pre-existing rows + the two suite-level tests) included, no other file's count moved.
`test/advisor-golden.test.ts` is no longer orphaned-and-red; it is WP 5.7's last item, closed.
