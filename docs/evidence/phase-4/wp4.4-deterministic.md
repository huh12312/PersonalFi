<!-- SPDX-License-Identifier: MIT -->

# WP 4.4 — Deterministic projection engine (pure)

Package `@ctx/planning`, directory `src/engine/**`. **No database, no I/O, no clock**: every
function takes a plan, WP 4.2's assumptions and (for history) a return series, and returns a value.
Money enters and leaves through one named pair of functions in `boundary.ts`; the interior is
`number`; results re-enter as `Money` rounded half-even exactly once.

Eight modules, five test files, **33 tests** (of the planning project's 97 on the final run), zero
database. Fixtures under `test/engine/fixtures/`: the independent reference model (CSV + formula
text + the Python that computed it), SSA's own 2026 worked example, and three historical
Guyton-Klinger cohorts with their published claims.

Written 2026-09-26 on `main` at `322683e` plus the uncommitted Wave B work of WP 4.3 and WP 4.7 in
the same tree.

---

## 1. The numeric boundary

### 1.1 The pair, quoted

`packages/contexts/planning/src/engine/boundary.ts`:

```ts
export function toEngineAmount(money: Money, expected: CurrencyCode, field = 'amount'): EngineDollars {
  if (money.currency !== expected) {
    throw new ProjectionInputRefused('planning.projection_currency_mismatch', field, …);
  }
  const minor = money.minor;
  if (minor > BigInt(MAX_EXACT_MINOR) || minor < -BigInt(MAX_EXACT_MINOR)) {
    throw new ProjectionInputRefused('planning.projection_amount_out_of_range', field, …);
  }
  return Number(minor) / 10 ** minorUnitScale(money.currency);
}

export function fromEngineAmount(dollars: EngineDollars, code: CurrencyCode, field = 'result'): Money {
  if (!Number.isFinite(dollars)) {
    throw new ProjectionInputRefused('planning.projection_amount_out_of_range', field, …);
  }
  const scaled = dollars * 10 ** minorUnitScale(code);
  if (Math.abs(scaled) > MAX_EXACT_MINOR) {
    throw new ProjectionInputRefused('planning.projection_amount_out_of_range', field, …);
  }
  return Money.of(BigInt(roundHalfEven(scaled)), code);
}
```

`MAX_EXACT_MINOR = Number.MAX_SAFE_INTEGER`. `roundHalfEven` is banker's rounding on a float,
exact because `x − Math.floor(x)` carries no rounding error below 2^52 (CONVENTIONS: "Rounding is
banker's (half-even) by default and must be an explicit act").

**Why the round trip is exact to 1e15 minor units.** `Number(minor)` is exact to 2^53 − 1; the
division adds at most ½ ulp; the multiplication back adds at most another ½ ulp. At 1e15 minor
units (USD $10 trillion) the two together are ≤ 100 × ½ulp(1e13) + ½ulp(1e15) ≈ 0.098 + 0.0625 ≈
0.16 of a minor unit — inside the ½ that half-even tolerates. Past 2^53 − 1 the input is refused,
not rounded. Proven by the fast-check property below, 2,000 runs per direction.

The other crossings, all in the same file: `toEngineRate(decimal)` (decimal string → `number`,
validated against WP 4.2's `DECIMAL_PATTERN`), `fromEngineRatio(ratio, places)` (a dimensionless
result → canonical decimal string), `ageOn(birthDate, asOf)` and `wholeYearsFrom(from, to)`
(`DateOnly` → whole years), and the solver's five named helpers (`monthlyFromAnnual`,
`annualFromMonthly`, `toEngineTarget`, `toEngineCeiling`, `solverMoney`), each a one-line call to
the pair.

### 1.2 Every call site

`grep -rn 'toEngineAmount\|fromEngineAmount' packages apps --include=*.ts`, test files aside —
**every production call is in `boundary.ts`**; `index.ts` only re-exports the names:

| Line | Function                  | Call                                                                     | What crosses                                                                                                                                                                                                                                                                          |
| ---- | ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 131  | —                         | `export function toEngineAmount(`                                        | definition                                                                                                                                                                                                                                                                            |
| 158  | —                         | `export function fromEngineAmount(`                                      | definition                                                                                                                                                                                                                                                                            |
| 401  | `socialSecurityRulesFrom` | `toEngineAmount(ss.bendPoints.first.value, …)`                           | 2026 first bend point, from WP 4.2's file                                                                                                                                                                                                                                             |
| 402  | `socialSecurityRulesFrom` | `toEngineAmount(ss.bendPoints.second.value, …)`                          | second bend point                                                                                                                                                                                                                                                                     |
| 416  | `socialSecurityRulesFrom` | `toEngineAmount(ss.taxableWageBase.value, …)`                            | wage base                                                                                                                                                                                                                                                                             |
| 452  | `socialSecurityOf`        | `toEngineAmount(ss.monthlyPia, …)`                                       | a statement PIA                                                                                                                                                                                                                                                                       |
| 467  | `socialSecurityOf`        | `toEngineAmount(row.earnings, …)`                                        | each year of an earnings record                                                                                                                                                                                                                                                       |
| 476  | `socialSecurityOf`        | `toEngineAmount(ss.futureAnnualEarnings, …)`                             | projected covered earnings                                                                                                                                                                                                                                                            |
| 541  | `toEnginePlan`            | `toEngineAmount(bucket.startingBalance, …)`                              | each bucket's start                                                                                                                                                                                                                                                                   |
| 545  | `toEnginePlan`            | `toEngineAmount(bucket.annualContribution, …)`                           | each bucket's contribution                                                                                                                                                                                                                                                            |
| 567  | `toEnginePlan`            | `toEngineAmount(plan.annualSpending, …)`                                 | retirement spending                                                                                                                                                                                                                                                                   |
| 585  | `toEnginePlan`            | `toEngineAmount(plan.withdrawalPolicy.spendingFloor, …)`                 | the guardrail floor                                                                                                                                                                                                                                                                   |
| 636  | `toEnginePlan`            | `toEngineAmount(pension.annualBenefit, …)`                               | each pension                                                                                                                                                                                                                                                                          |
| 649  | `toEnginePlan`            | `toEngineAmount(stream.annual, …)`                                       | each other-income stream                                                                                                                                                                                                                                                              |
| 741  | `toProjectionResult`      | `const out = (dollars, field) => fromEngineAmount(dollars, code, field)` | every Money in a result — `out(` at lines 754–757 (per bucket: start, contribution, withdrawal, end), 766–768 (start, end, end-nominal), 770–775 (tax, Social Security, pension, other income, spending, shortfall), 798 (total shortfall), 805–806, 810 (AIME, PIA, monthly benefit) |
| 826  | `monthlyFromAnnual`       | `fromEngineAmount(annual / 12, …)`                                       | the solved monthly saving                                                                                                                                                                                                                                                             |
| 831  | `annualFromMonthly`       | `toEngineAmount(monthly, …) * 12`                                        | the rounded answer, back in for re-verification                                                                                                                                                                                                                                       |
| 847  | `toEngineTarget`          | `toEngineAmount(target, …)`                                              | a goal target                                                                                                                                                                                                                                                                         |
| 852  | `toEngineCeiling`         | `toEngineAmount(maxMonthly, …) * 12`                                     | the solver's ceiling                                                                                                                                                                                                                                                                  |
| 857  | `solverMoney`             | `fromEngineAmount(dollars, …)`                                           | the gap at the ceiling; zero for `already_met`                                                                                                                                                                                                                                        |

**Rounded once.** Each `out(…)` takes the float the recursion produced — `endWealth` is the float
sum of the bucket floats, never the sum of four rounded Money — and rounds it once. The test
`'a result re-enters as Money rounded once from its float, never re-summed from rounded parts'`
asserts it for all 60 years of reference case B, and that year _t_'s end and year _t + 1_'s start
are the same Money because they are the same float.

### 1.3 The structural test, and a limitation of the repo check

`boundary.test.ts` → `'the engine interior is reachable only through toEngineAmount and
fromEngineAmount'` (the WP 3.5 `no-trade-surface` pattern). Over every non-test `.ts` in
`src/engine/`, comments and string literals stripped, every file except `boundary.ts` must not:
call the pair; read `.minor`; call `Number(`, `parseFloat(`, `parseInt(`, `BigInt(` or `.toFixed(`;
value-import `@core/kernel` or `../assumptions.ts` (type-only imports are allowed); or **spell any
identifier like a magnitude** (`/amount|balance|price|value|cost|quantity/i`, whatever its type).
It also pins the list of engine files (a rename cannot drop one from the scan), that each of the
pair is defined exactly once, and that `index.ts` only re-exports. A second test plants each
violation in a string and asserts it is caught, so the grep is not vacuous.

`node scripts/check-numeric-boundaries.ts` →
`PASS — 734 file(s) scanned, 0 violations, 71 exempt identifier(s)`; `--explain | grep engine` →
**no exemptions used anywhere under `src/engine/` or `test/engine/`**. That is by naming, not by the
exemption mechanism: the interior says `wealth`, `contribution`, `spending`, `withdrawal`,
`shortfall`, never a magnitude word (two renames were needed on the way — `primaryInsuranceAmount`
→ `piaFromAime`, and a `value` parameter → `age`).

**The limitation, stated rather than exploited.** `toEngineAmount` returns `EngineDollars`, an alias
for `number`. The script is syntactic and does not resolve aliases, so it does not see that
`toEngineAmount` (a name matching `/amount/`) returns a float. Had the return type been written
`number`, the script would flag it, and the documented exemption is an `ALLOW_LIST` entry — in the
script, which this WP may not edit. Dispatch §5 already assigns exactly that edit to WP 4.14 ("the
ALLOW_LIST gains one entry per crossing function with its reason"). The stricter in-package rule
above is what stops the alias being used as a loophole in the interior. See §10.

---

## 2. One worked 30-year path

Reference case A (the committed fixture's first case): born 1 Jan 1991, projected from 1 Jan 2026,
one `TAXABLE` bucket at $50,000, a flat $15,000/yr real contribution, static 100% equity, 07 §5.5's
defaults from WP 4.2's file.

- `r_real = (1 + 0.065) / (1 + 0.025) − 1 = 0.03902439…` (07 §5.2).
- `(1 + r)^0.5 = 1.019325…`, so each contribution enters as `15,000 × 1.019325 = 15,289.88`.
- Each row: `B_{t+1} = B_t × (1 + r) + C_t × (1 + r)^0.5`. The float column is the engine's
  interior value; the Money column is `fromEngineAmount` of it; the nominal column is the display
  toggle's `endWealth × 1.025^(t+1)`, computed from the same float and stored nowhere.

| t   | age | B_t (start) | r_real     | B_t × (1+r) | C_t       | C_t × (1+r)^0.5 | B_{t+1} (engine float) | end, Money | end, nominal display |
| --- | --- | ----------- | ---------- | ----------- | --------- | --------------- | ---------------------- | ---------- | -------------------- |
| 0   | 35  | 50,000.00   | 0.03902439 | 51,951.22   | 15,000.00 | 15,289.88       | 67241.101389           | 67241.10   | 68922.13             |
| 1   | 36  | 67,241.10   | 0.03902439 | 69,865.14   | 15,000.00 | 15,289.88       | 85155.026247           | 85155.03   | 89466.00             |
| 2   | 37  | 85,155.03   | 0.03902439 | 88,478.15   | 15,000.00 | 15,289.88       | 103768.031099          | 103768.03  | 111746.82            |
| 3   | 38  | 103,768.03  | 0.03902439 | 107,817.52  | 15,000.00 | 15,289.88       | 123107.397116          | 123107.40  | 135887.53            |
| 4   | 39  | 123,107.40  | 0.03902439 | 127,911.59  | 15,000.00 | 15,289.88       | 143201.470100          | 143201.47  | 162019.32            |
| 5   | 40  | 143,201.47  | 0.03902439 | 148,789.82  | 15,000.00 | 15,289.88       | 164079.702029          | 164079.70  | 190282.15            |
| 6   | 41  | 164,079.70  | 0.03902439 | 170,482.81  | 15,000.00 | 15,289.88       | 185772.694229          | 185772.69  | 220825.36            |
| 7   | 42  | 185,772.69  | 0.03902439 | 193,022.36  | 15,000.00 | 15,289.88       | 208312.242222          | 208312.24  | 253808.24            |
| 8   | 43  | 208,312.24  | 0.03902439 | 216,441.50  | 15,000.00 | 15,289.88       | 231731.382332          | 231731.38  | 289400.74            |
| 9   | 44  | 231,731.38  | 0.03902439 | 240,774.56  | 15,000.00 | 15,289.88       | 256064.440105          | 256064.44  | 327784.13            |
| 10  | 45  | 256,064.44  | 0.03902439 | 266,057.20  | 15,000.00 | 15,289.88       | 281347.080620          | 281347.08  | 369151.75            |
| 11  | 46  | 281,347.08  | 0.03902439 | 292,326.48  | 15,000.00 | 15,289.88       | 307616.360764          | 307616.36  | 413709.81            |
| 12  | 47  | 307,616.36  | 0.03902439 | 319,620.90  | 15,000.00 | 15,289.88       | 334910.783549          | 334910.78  | 461678.21            |
| 13  | 48  | 334,910.78  | 0.03902439 | 347,980.47  | 15,000.00 | 15,289.88       | 363270.354540          | 363270.35  | 513291.50            |
| 14  | 49  | 363,270.35  | 0.03902439 | 377,446.76  | 15,000.00 | 15,289.88       | 392736.640496          | 392736.64  | 568799.76            |
| 15  | 50  | 392,736.64  | 0.03902439 | 408,062.95  | 15,000.00 | 15,289.88       | 423352.830295          | 423352.83  | 628469.66            |
| 16  | 51  | 423,352.83  | 0.03902439 | 439,873.92  | 15,000.00 | 15,289.88       | 455163.798232          | 455163.80  | 692585.55            |
| 17  | 52  | 455,163.80  | 0.03902439 | 472,926.29  | 15,000.00 | 15,289.88       | 488216.169796          | 488216.17  | 761450.61            |
| 18  | 53  | 488,216.17  | 0.03902439 | 507,268.51  | 15,000.00 | 15,289.88       | 522558.390006          | 522558.39  | 835388.07            |
| 19  | 54  | 522,558.39  | 0.03902439 | 542,950.91  | 15,000.00 | 15,289.88       | 558240.794419          | 558240.79  | 914742.54            |
| 20  | 55  | 558,240.79  | 0.03902439 | 580,025.80  | 15,000.00 | 15,289.88       | 595315.682908          | 595315.68  | 999881.42            |
| 21  | 56  | 595,315.68  | 0.03902439 | 618,547.51  | 15,000.00 | 15,289.88       | 633837.396313          | 633837.40  | 1091196.33           |
| 22  | 57  | 633,837.40  | 0.03902439 | 658,572.51  | 15,000.00 | 15,289.88       | 673862.396094          | 673862.40  | 1189104.78           |
| 23  | 58  | 673,862.40  | 0.03902439 | 700,159.47  | 15,000.00 | 15,289.88       | 715449.347087          | 715449.35  | 1294051.80           |
| 24  | 59  | 715,449.35  | 0.03902439 | 743,369.32  | 15,000.00 | 15,289.88       | 758659.203484          | 758659.20  | 1406511.75           |
| 25  | 60  | 758,659.20  | 0.03902439 | 788,265.42  | 15,000.00 | 15,289.88       | 803555.298180          | 803555.30  | 1526990.27           |
| 26  | 61  | 803,555.30  | 0.03902439 | 834,913.55  | 15,000.00 | 15,289.88       | 850203.435595          | 850203.44  | 1656026.27           |
| 27  | 62  | 850,203.44  | 0.03902439 | 883,382.11  | 15,000.00 | 15,289.88       | 898671.988129          | 898671.99  | 1794194.15           |
| 28  | 63  | 898,671.99  | 0.03902439 | 933,742.11  | 15,000.00 | 15,289.88       | 949031.996372          | 949032.00  | 1942106.09           |
| 29  | 64  | 949,032.00  | 0.03902439 | 986,067.39  | 15,000.00 | 15,289.88       | 1001357.273229         | 1001357.27 | 2100414.55           |

Check one row by hand, t = 0: `50,000 × 1.03902439 = 51,951.22`; `+ 15,289.88 = 67,241.10` ✓.

Retirement begins at 65 and the recursion changes to `B_{t+1} = (B_t − W_t − tax_t)(1 + r)`
(`TAXABLE`: no tax in 07 §5.7 phase 1), $50,000 real per year at the start of the year:

| t   | age | B_t          | W_t       | B_t − W_t  | × (1 + r)  | end        |
| --- | --- | ------------ | --------- | ---------- | ---------- | ---------- |
| 30  | 65  | 1,001,357.27 | 50,000.00 | 951,357.27 | 1.03902439 | 988,483.41 |
| 31  | 66  | 988,483.41   | 50,000.00 | 938,483.41 | 1.03902439 | 975,107.15 |
| 32  | 67  | 975,107.15   | 50,000.00 | 925,107.15 | 1.03902439 | 961,208.90 |
| 33  | 68  | 961,208.90   | 50,000.00 | 911,208.90 | 1.03902439 | 946,768.27 |
| 34  | 69  | 946,768.27   | 50,000.00 | 896,768.27 | 1.03902439 | 931,764.10 |

---

## 3. The reference comparison (the §5 exit criterion)

`test/engine/fixtures/reference-projection.csv`, computed by `reference-projection.py` (Python
3.14.7, `decimal` at 50 digits) from the **closed-form** OpenFormula `FV`/`PMT` definitions — one
expression per checkpoint, no loop over years, no import of anything but `decimal`. The literal
LibreOffice formula for every column is in `reference-projection.md`. Engine vs reference, on the
final run:

| case | age in final year | years | formula  | reference  | engine     | difference | % difference |
| ---- | ----------------- | ----- | -------- | ---------- | ---------- | ---------- | ------------ |
| A    | 44                | 10    | `A_acc`  | 256064.44  | 256064.44  | 0.00       | 0.000000%    |
| A    | 54                | 20    | `A_acc`  | 558240.79  | 558240.79  | 0.00       | 0.000000%    |
| A    | 64                | 30    | `A_acc`  | 1001357.27 | 1001357.27 | 0.00       | 0.000000%    |
| A    | 74                | 40    | `A_dec`  | 847489.77  | 847489.77  | 0.00       | 0.000000%    |
| A    | 84                | 50    | `A_dec`  | 621855.87  | 621855.87  | 0.00       | 0.000000%    |
| A    | 94                | 60    | `A_dec`  | 290982.54  | 290982.54  | 0.00       | 0.000000%    |
| B    | 44                | 10    | `B_acc`  | 279423.24  | 279423.24  | 0.00       | 0.000000%    |
| B    | 54                | 20    | `B_acc`  | 530575.58  | 530575.58  | 0.00       | 0.000000%    |
| B    | 64                | 30    | `B_acc`  | 879629.90  | 879629.90  | 0.00       | 0.000000%    |
| B    | 66                | 32    | `B_dec1` | 787554.02  | 787554.02  | 0.00       | 0.000000%    |
| B    | 74                | 40    | `B_dec2` | 682089.50  | 682089.50  | 0.00       | 0.000000%    |
| B    | 84                | 50    | `B_dec2` | 507992.49  | 507992.49  | 0.00       | 0.000000%    |
| B    | 94                | 60    | `B_dec2` | 271235.65  | 271235.65  | 0.00       | 0.000000%    |
| C    | 64                | 30    | `C_pmt`  | 1471.97    | 1471.97    | 0.00       | 0.000000%    |

**Worst case: 0.000000% — all fourteen checkpoints agree to the cent.** The test asserts the
dispatch's 1% _and_ a one-cent tolerance, so drift inside the 1% band is still red. Case B covers
wage-growing contributions, a `TAX_DEFERRED` gross-up at 15%, and a Social Security stream from 67;
case C is the solver against `PMT`, through the Money boundary both ways.

**Honest limit:** LibreOffice is not installed on this host, so the numbers come from Python
implementing the same function definitions LibreOffice implements, not from Calc itself. Pasting
the `.md`'s formulas into a Calc sheet once and recording the result is an open item (§10).

---

## 4. Social Security against SSA's own example

SSA OACT, _Benefit Calculation Examples for Workers Retiring in 2026_
(`ssa.gov/oact/progdata/retirebenefit1.html`, `…/retirebenefit2.html`), fetched 2026-09-26 through
the Internet Archive because `ssa.gov` returned HTTP 403 to a direct request. Inputs, published
outputs and URLs are in `test/engine/fixtures/ssa-2026-examples.json`. Parameters come from WP 4.2's
file through `socialSecurityRulesFrom(assumptions, 2026)`; this WP writes none of them down.

**Case A — born 1964, first eligible (62) in 2026, claims at 62.**

| 07 §5.8 step                                                               | SSA published                               | Engine                                         | Where                           |
| -------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- | ------------------------------- |
| 1. Index to the AWI of the year the worker turns 60 (2024: 69,846.57)      | 1986: $16,196 × 4.0323 = $65,307            | `indexEarnings` → 65,307 (rounded for display) | test `'…to the dollar'`         |
| 1. Highest 35 indexed years                                                | $2,446,845                                  | 2,446,845 (Σ rounded)                          | same                            |
| 2. AIME = ⌊2,446,845 / 420⌋                                                | **$5,825**                                  | **5,825**                                      | `averageIndexedMonthlyEarnings` |
| 3. PIA formula, 2026 bend points $1,286 / $7,749 (from the file)           | .9(1286) + .32(5825 − 1286) = **$2,609.88** | 2609.88 before truncation                      | `piaFromAime`                   |
| 3. Truncate to the dime                                                    | **$2,609.80**                               | **2,609.80**                                   | `truncateToDime`                |
| 4. FRA, born 1960+ (from the file)                                         | 67                                          | 804 months                                     | `fullRetirementAgeMonths`       |
| 5. 60 months early: 36 × 5/9% + 24 × 5/12% = 30% (fractions from the file) | reduced to **$1,826.00**                    | factor 0.7 → ⌊2,609.80 × 0.7⌋ = **1,826**      | `claimFactor`, `monthlyBenefit` |
| 6. COLA                                                                    | none: eligible and retiring in 2026         | none applied                                   | —                               |
| 7. Wage base                                                               | $184,500 (caps future earnings)             | from the file                                  | `socialSecurityRulesFrom`       |

The same case through the **Money-facing** path (`projectDeterministic` with a raw earnings record
and SSA's AWI series as decimal strings) reports `aime` $5,825.00, `pia` $2,609.80,
`monthlyBenefit` $1,826.00, `claimFactor` `'0.7'`, and $21,912 in the first year.

**Claiming at 62, 67 and 70 on the same PIA** (`'claiming at 62 and at 70 straddle FRA by exactly
the published adjustment'`): 62 → factor 0.70 → $1,826 (SSA's figure); 64 → 0.80 (the 36-month
boundary between the two reduction rates); 67 → 1.00 → $2,609; 67y6m → 1.04; 70 → 1.24 → $3,236;
72 → still 1.24 (no credit after 70); 61y11m → refused.

**Case B — step 6, COLAs.** Born 1959, eligible 2021, AIME $11,463 on SSA's 2021 bend points
($996 / $6,002, SSA's bend-point table): .9(996) + .32(6002 − 996) + .15(11463 − 6002) = $3,317.47 →
$3,317.40; COLAs 5.9, 8.7, 3.2, 2.5, 2.8%, truncating after each → **$4,152.40**, paid **$4,152**
— both SSA's published figures, reproduced exactly.

**Rounding on floats.** SSA truncates to the dime and floors to the dollar; a float can land a hair
below an exact boundary. `ROUNDING_GUARD = 1e-6` is added before flooring, and
`social-security.ts`'s header proves it cannot move a true value across a boundary: every value
floored is a rational whose distance from the next boundary is zero or ≥ 4.1e-4 (the reduction
factors are (180 − m)/180, (192 − (m − 36))/240 and (150 + m)/150), against float error ~1e-11.

**The stress toggle** (07 §5.8, "75% benefit after 2034"): the year and the ratio come from the
file's `socialSecurityStress`; the test shows the benefit unchanged through 2033 and exactly 75% of
it from 2034 ($24,000 → $18,000).

---

## 5. Guardrails: a bad first decade with the cap binding

Guyton-Klinger per 07 §5.6 in real dollars: ±20% rails, ±10% adjustments, the preservation cut off
in the final 15 years, the COLA skipped after a negative nominal year when the frozen rate exceeds
the initial rate, the COLA capped at 6% (G-K 2006), then **`spending = max(spending, floor,
(1 − 0.20) × initialSpending)`**. A skipped COLA and a 10% cut both count toward the cap — both cost
purchasing power. The rate is the _portfolio_ withdrawal rate, `(spending − income) / portfolio`.

The 1973 cohort — the "perfect storm" Guyton & Klinger chose it for — at their own 5.8% on 50/50,
$1,000,000, annual Damodaran S&P 500 and 10-year Treasury total returns and BLS CPI (fixture
provenance in `guyton-klinger-cohorts.json`), run through the engine's own `runPath → stepYear`.
Capped (07 §5.6) beside unmodified:

| year      | S&P 500 | 10y T-bond | CPI   | capped: portfolio at start (real) | capped: rate | capped: spending ÷ initial | capped: decisions                                  | unmodified: spending ÷ initial | unmodified: decisions               |
| --------- | ------- | ---------- | ----- | --------------------------------- | ------------ | -------------------------- | -------------------------------------------------- | ------------------------------ | ----------------------------------- |
| 1973      | -14.31% | 3.66%      | 6.2%  | 1,000,000                         | 5.80%        | 1.0000                     | —                                                  | 1.0000                         | —                                   |
| 1974      | -25.90% | 1.99%      | 11.1% | 839,773                           | 6.50%        | 0.9416                     | inflation_skipped                                  | 0.9416                         | inflation_skipped                   |
| 1975      | 37.00%  | 3.61%      | 9.1%  | 622,226                           | 7.46%        | **0.8000**                 | inflation_skipped, preservation_cut, **cap_bound** | 0.7628                         | inflation_skipped, preservation_cut |
| 1976      | 23.83%  | 15.98%     | 5.7%  | 634,965                           | 7.31%        | 0.8000                     | inflation_capped, preservation_cut, cap_bound      | 0.7411                         | inflation_capped                    |
| 1977      | -6.98%  | 1.29%      | 6.5%  | 667,663                           | 6.95%        | 0.8000                     | —                                                  | 0.7411                         | —                                   |
| 1978      | 6.51%   | -0.78%     | 7.6%  | 566,749                           | 8.19%        | 0.8000                     | inflation_skipped, preservation_cut, cap_bound     | 0.6263                         | inflation_skipped, preservation_cut |
| 1979      | 18.52%  | 0.67%      | 11.3% | 497,451                           | 9.33%        | 0.8000                     | inflation_capped, preservation_cut, cap_bound      | 0.6170                         | inflation_capped                    |
| 1980      | 31.74%  | -2.99%     | 13.5% | 444,141                           | 10.45%       | 0.8000                     | inflation_capped, preservation_cut, cap_bound      | 0.5288                         | inflation_capped, preservation_cut  |
| 1981      | -4.70%  | 8.20%      | 10.3% | 400,807                           | 11.58%       | 0.8000                     | inflation_capped, preservation_cut, cap_bound      | 0.4939                         | inflation_capped                    |
| 1982      | 20.42%  | 32.81%     | 6.1%  | 326,935                           | 14.19%       | 0.8000                     | inflation_capped, preservation_cut, cap_bound      | 0.4272                         | inflation_capped, preservation_cut  |
| 1983      | 22.34%  | 3.20%      | 3.2%  | 334,778                           | 13.86%       | 0.8000                     | inflation_capped, preservation_cut, cap_bound      | 0.4268                         | inflation_capped                    |
| 1984      | 6.15%   | 13.73%     | 4.3%  | 315,120                           | 14.72%       | 0.8000                     | preservation_cut, cap_bound                        | 0.4268                         | —                                   |
| 1985      | 31.24%  | 25.71%     | 3.5%  | 283,251                           | 16.38%       | 0.8000                     | preservation_cut, cap_bound                        | 0.4268                         | —                                   |
| 1986      | 18.49%  | 24.28%     | 1.9%  | 294,004                           | 15.78%       | 0.8000                     | preservation_cut, cap_bound                        | 0.4268                         | —                                   |
| 1987      | 5.81%   | -4.96%     | 3.7%  | 294,951                           | 15.73%       | 0.8000                     | preservation_cut, cap_bound                        | 0.4695                         | prosperity_raise                    |
| 1988      | 16.54%  | 8.22%      | 4.1%  | 240,701                           | 19.28%       | 0.8000                     | — (final 15 years: no cut rule)                    | 0.4695                         | —                                   |
| 1989      | 31.48%  | 17.69%     | 4.8%  | 209,756                           | 22.12%       | 0.8000                     | —                                                  | 0.4695                         | —                                   |
| 1990      | -3.06%  | 6.24%      | 5.4%  | 194,195                           | 23.89%       | 0.8000                     | —                                                  | 0.5164                         | prosperity_raise                    |
| 1991      | 30.23%  | 15.00%     | 4.2%  | 142,453                           | 32.57%       | 0.8000                     | —                                                  | 0.5164                         | —                                   |
| 1992      | 7.49%   | 9.36%      | 3.0%  | 113,028                           | 41.05%       | 0.8000                     | —                                                  | 0.5164                         | —                                   |
| 1993      | 9.97%   | 14.21%     | 3.0%  | 70,137                            | 66.16%       | 0.8000                     | —                                                  | 0.5164                         | —                                   |
| 1994      | 1.33%   | -8.04%     | 2.6%  | 25,832                            | 179.62%      | 0.8000                     | **shortfall $20,568**                              | 0.5680                         | prosperity_raise                    |
| 1995      | 37.20%  | 23.48%     | 2.8%  | 0                                 | —            | 0.8000                     | shortfall $46,400                                  | 0.5680                         | —                                   |
| 1996–2002 | …       | …          | …     | 0                                 | —            | 0.8000                     | shortfall $46,400 a year                           | 0.62 → 0.76                    | raises 1996, 1998, 1999             |

What this shows, and what the tests assert:

- **The cap binds from year 3 and never lets go.** Planned real spending never falls below 80% of
  the first year's, which is the 07 §5.6 promise — worst cut 20.00%, against **57.3% unmodified**.
- **The cap has a price, and the engine reports it instead of hiding it.** Holding spending at 80%
  through the 1970s drains the portfolio: it is empty in 1994 (age 86), and from then on the path
  keeps running (07 §5.4 detail 2) with **$391,768 of unfunded real spending** reported as a
  shortfall. Unmodified G-K survives the 30 years (Guyton's published result for 5.8% / 50%) by
  cutting spending by more than half. That is precisely the trade-off 07 §5.6 asks the output to
  show: success _and_ "worst-case spending cut". A 20% cap and a 5.8% start are not compatible in
  1973; a lower start is.
- The fast-check property `'cumulative real cuts never exceed 20% and never breach the spending
floor'` (300 runs: 30 random market years each, random start rate, floor 0–100% of spending,
  equity share, pension income) holds for every year of every path, and a companion test shows the
  same crash **exceeds** 20% with the cap removed, so the bound — not the data — is doing the work.

### 5.1 The cohort goldens: published claims, reproduced

| Cohort               | Published claim (source, quoted in the fixture)                                                                                                            | Reproduced here                                                                                                    | Asserted                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| 1973, 5.8%, 50/50    | Guyton's maximum sustainable initial rate for the period (G-K 2006 p. 2)                                                                                   | survives 30 years, terminal real $728k                                                                             | ✓ survives                                      |
| 1973                 | cuts from "a severe market decline in the initial retirement years combined with inflation in the first decade" (G-K 2006 p. 2)                            | preservation cuts 1975, 1978, 1980, 1982; first raise 1987                                                         | ✓ every cut ≤ 1982, first raise ≥ 1983          |
| 1973 vs 2000         | "a 1973 retiree [was] in a more financially uncertain position after five years … at the end of 1977 than a 2000 retiree found after 2004" (G-K 2006 p. 2) | real wealth after five years at a constant 5.8%: 0.528 vs 0.738 of the start; spending already cut to 0.63 vs 0.86 | ✓ both                                          |
| 2000, 5.8%, 50/50    | "hit its lower guardrail 3 times, ultimately bottoming out at 36% below the planned spending level" (Kitces 2024, 1999 retiree, 4.3%, 60/40)               | 3 cuts: 2003, 2006, 2009; worst 39.2%                                                                              | ✓ 3 cuts, first 2003, last 2009, within 36% ± 5 |
| 1965/66, 4.3%, 60/40 | "spending falling to 54% below initially planned spending" (Kitces 2024; 07 §5.6 "~54%")                                                                   | 56.3% (January 1966 start)                                                                                         | ✓ within 54% ± 5                                |
| all three, capped    | 07 §5.6: cap cumulative real cuts at 20%                                                                                                                   | exactly 0.2000, `cap_bound` recorded; unmodified > 0.20 in all three                                               | ✓                                               |
| 2000                 | Jeske (cited by Kitces): January-2000 retirees at 4/5/6% "all … over 50% cumulative pay cuts"                                                              | 25.3% (4.3%, 60/40) to 39.2% (5.8%, 50/50)                                                                         | **not asserted** — recorded as not reproduced   |

Two published figures do **not** reproduce on annual data, and are written down rather than
dropped: Jeske's "over 50%" for 2000 (above), and Kitces' GFC example — "3 cuts … 28% below" for a
2007 retiree at 4.3%, 60/40 — where this engine's annual run makes one cut (2009) for 13.3%. Both
sources use monthly series; this fixture uses calendar-year S&P 500 and 10-year Treasury total
returns, whose 2008 Treasury gain (+20.1%) cushions a 60/40 portfolio more than an intermediate or
aggregate bond series would. After the assertions, the fixture pins the engine's full reproduced
path (every year's spending ratio, every cut and raise year, the worst cut, the depletion year) so
a change that moves any of it is red — that pin is the engine's own output, **not** an independent
reference; the quoted claims are.

---

## 6. Solve-for-required-savings

Bisection over the deterministic engine keeping `met(hi) && !met(lo)`, stopping at a cent a year,
guarded at `MAX_ITERATIONS = 200` (WP 3.3's XIRR house style). Reference case C solves in **24
iterations** to **$1,471.97/month — the `PMT` reference to the cent**. The answer is then rounded
to Money and **run back through the whole boundary**; if the rounded cent falls short it is raised
by a cent (at most three times) and otherwise the solver throws rather than return a number that
does not close the gap. The test re-projects with the answer added as an ordinary contribution and
shows it reaches $1,000,000, and that one cent a month less does not.

`unreachable` names its binding constraint (`'a gap no contribution can close returns unreachable
and names the binding constraint'`):

- `no_contribution_window` — already retired and overspending (`sustain_to_plan_end` with
  `retirementAge` = today's age), or a target date less than a year away: _"no additional saving can
  reach this objective — only spending, the retirement age or the target date can"_. No `monthly`
  field exists on the result.
- `monthly_ceiling` — $500/month cannot reach $1M; the result carries the ceiling and the **gap at
  the ceiling in today's dollars**, and the test re-projects at $500 to show that gap is real (to
  the cent).
- A target date beyond the plan is a refused _input_ (`ProjectionInputRefused`), not an unreachable
  gap. A nominal target is deflated before comparison (the nominal $1M in 2056 needs well under half
  the saving).

---

## 7. Sabotage

Each control broken once in production code, the named test run, output observed, the file restored
from its saved bytes and its SHA-256 re-checked. **All eleven red on the first attempt; all eleven
restored byte-identical.**

| #   | Sabotage (production code)                                                          | File                 | Red tests                                                                                 | First failure                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | **mid-year convention dropped**: `+ c * Math.sqrt(1 + r)` → `+ c`                   | `deterministic.ts`   | reference fixture within 1%; real/nominal never mix                                       | `A age 44: engine 25259979 vs reference 25606444: expected 0.0135 to be less than 0.01` — the 1% criterion itself catches it                                                    |
| S2  | **real/nominal mixed**: `expectedMarket` returns the nominal rates as real          | `deterministic.ts`   | reference within 1%; zero returns constant; real/nominal never mix; each bucket its own r | `A age 44 … expected 0.1823 to be less than 0.01`                                                                                                                               |
| S3  | **cap removed**: `capped = 0` in the lower bound                                    | `guardrails.ts`      | cohort shapes; cuts never exceed 20% (property); which bound bound                        | `expected '0.5732' to be '0.2000'`; property failed after 2 runs                                                                                                                |
| S4  | **boundary rounds twice**: `roundHalfEven(roundHalfEven(scaled / 10) * 10)`         | `boundary.ts`        | round trip to 1e15; half-even on exact halves                                             | property failed after 1 run, counterexample `[11160771n, "USD"]`                                                                                                                |
| S5  | spending floor removed from the bound                                               | `guardrails.ts`      | cuts/floor property; which bound bound                                                    | property failed after 1 run (15% inflation years with a high floor)                                                                                                             |
| S6  | a float conversion leaks into the interior: `Number('0.005')` in `deterministic.ts` | `deterministic.ts`   | interior reachable only through the pair                                                  | `expected [ Array(1) ] to deeply equal []`                                                                                                                                      |
| S7  | SSA dime truncation dropped                                                         | `social-security.ts` | case A to the dollar; Money-facing PIA; case B COLAs                                      | `expected 2609.88 to be 2609.8`                                                                                                                                                 |
| S8  | early reduction at 5/9% for every month                                             | `social-security.ts` | case A; Money-facing; 62/70 straddle                                                      | `expected 1739 to be 1826`                                                                                                                                                      |
| S9  | solver's ceiling check removed                                                      | `solve.ts`           | unreachable names its constraint                                                          | the **re-verification** threw: _"the bisected amount did not verify after rounding; refusing to return a number that does not close the gap"_ — the second line of defence held |
| S10 | G-K COLA reads this year's inflation instead of last year's                         | `deterministic.ts`   | cohort shapes                                                                             | `expected [2003, 2006, 2009, 2010] to have a length of 3`                                                                                                                       |
| S11 | preservation rule left on in the final 15 years                                     | `guardrails.ts`      | cohort shapes; worst cut reported; final-15-years rule                                    | `expected [2003, 2006, 2009, 2019, 2023] to have a length of 3`                                                                                                                 |

The four the brief names at minimum are S1, S2, S3 and S4.

---

## 8. Supplementary cross-checks (not committed)

**Bengen's 4% rule** (07 §8.4 item 1), run through the same `stepYear` over every 30-year window
starting 1928–1996 on Damodaran's full annual series with BLS annual-average CPI, constant real
withdrawals:

| Equity | Initial rate | Failing windows                  | Worst-case sustainable rate |
| ------ | ------------ | -------------------------------- | --------------------------- |
| 50%    | 4.0%         | 4 of 69 (1965, 1966, 1968, 1969) | 3.72% (1966)                |
| 60%    | 4.0%         | 4 of 69                          | 3.79% (1966)                |
| 75%    | 4.0%         | 3 of 69 (1966, 1968, 1969)       | 3.86% (1966)                |

The worst year is **1966, as in Bengen**, but the worst-case rate is 3.7–3.9% against Bengen's
~4.15%. The cause is the data, not the recursion (which matches its closed form to the cent, §3):
Bengen used Ibbotson SBBI with intermediate-term government bonds and December-to-December CPI;
this run uses 10-year Treasury total returns and _annual-average_ CPI, which lags the 1970s
inflation into later years. The formal Bengen golden belongs on WP 4.5's vendored Shiller series
(dispatch §5 assigns it to WP 4.14); these numbers are recorded so that golden has something to be
compared with.

**cFIREsim / FI Calc** (reference (c) in dispatch §5): **not run.** Both are browser tools and this
WP ran without a browser session; dispatch §5 assigns the dated cross-tool record to WP 4.14.

---

## 9. Modules and tests

| File                            | Role                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/engine/boundary.ts`        | The pair, rate/date crossings, `ProjectionInputRefused` (10 codes), the Money-side plan and result types, `toEnginePlan`, `toProjectionResult`, `socialSecurityRulesFrom`, the solver's crossings |
| `src/engine/deterministic.ts`   | Interior: `EnginePlan`, `preparePlan`, `PathState`, **`stepYear`** (the shared per-period step), `runPath`, `runDeterministic`, `ENGINE_VERSION = 'personalfi.deterministic/1'`                   |
| `src/engine/glidepath.ts`       | 07 §5.9: age-based (default), target-date (Vanguard knots), rising-equity bond tent, static                                                                                                       |
| `src/engine/social-security.ts` | 07 §5.8's seven steps, SSA rounding, the stress toggle                                                                                                                                            |
| `src/engine/pension.ts`         | Pensions with a COLA flag (`none`/`cpi`/`fixed`), other income streams                                                                                                                            |
| `src/engine/guardrails.ts`      | G-K rails, inflation rule, floor, cap; bit-set decisions; `GUYTON_KLINGER` with sources                                                                                                           |
| `src/engine/solve.ts`           | Bisection, typed `unreachable`, re-verification through the boundary                                                                                                                              |
| `src/engine/project.ts`         | `projectDeterministic` — convert once, run, convert back once (kept apart so `deterministic.ts` has no import of the boundary and no cycle)                                                       |
| `src/engine/index.ts`           | The public surface                                                                                                                                                                                |
| `test/engine/support.ts`        | Plan builders for the reference cases; the CSV reader                                                                                                                                             |
| `test/engine/fixtures/*`        | `reference-projection.{csv,md,py}`, `ssa-2026-examples.json`, `guyton-klinger-cohorts.json`                                                                                                       |

Tests (the dispatch's names verbatim where it names one):

- `boundary.test.ts` (6) — `'Money survives a round trip through the engine boundary for every
amount up to 1e15 minor units'`, `'the engine interior is reachable only through toEngineAmount
and fromEngineAmount'`, plus half-even, refusals, rounded-once, planted violations.
- `deterministic.test.ts` (10) — `'the projection matches the committed reference-calculator fixture
within 1%'`, `'zero returns and zero contributions leave the balance constant'` (fast-check, 60
  runs, three inflation levels with nominal = inflation), `'real and nominal never mix: a nominal
display toggle changes no stored value'` (byte-identical stored series + an independent
  nominal-terms oracle), per-bucket r, withdrawal order and gross-up, failure does not stop, pension
  COLA, glidepaths, refusals.
- `social-security.test.ts` (6) — `'the published 2026 bend points reproduce a known AIME to PIA
case to the dollar'`, `'claiming at 62 and at 70 straddle FRA by exactly the published
adjustment'`, Money-facing case A, case B COLAs, FRA refusal, stress toggle.
- `guardrails.test.ts` (6) — `'the 1973 and 2000 Guyton-Klinger cohort paths reproduce their
published shape'`, `'cumulative real cuts never exceed 20% and never breach the spending floor'`
  (fast-check, 300 runs), the uncapped control, which bound bound, the final-15-years rule, worst cut
  reported.
- `solve.test.ts` (5) — `'a gap no contribution can close returns unreachable and names the binding
constraint'`, minimality to the cent, nominal targets, `already_met`, target beyond the plan.

---

## 10. For the orchestrator

**The index line** (WP 4.3 owns `src/index.ts` this wave):

```ts
export * from './engine/index.ts';
```

No name in `src/engine/index.ts` collides with a current `src/index.ts` export (checked against the
file at the time of writing); bucket names are deliberately `PROJECTION_BUCKETS` /
`ProjectionBucket` because WP 4.3's `ports.ts` is adding `TAX_BUCKETS` / `TaxBucket` with the same
four values — unify them (a one-line alias in `boundary.ts`) once both are committed.

**`vitest.config.ts` — the one legitimate edit.** The `planning` project's `include` is
`['src/**/*.test.ts', 'test/*.test.ts']`, which does **not** cover `test/engine/**`. Per the brief,
the five suites therefore live at `src/engine/*.test.ts` and run today. To move them to the
dispatch's paths: widen the include to `['src/**/*.test.ts', 'test/*.test.ts',
'test/engine/**/*.test.ts']` (WP 4.5's `test/engine/reproducible.test.ts` et al. need the same
edit), `git mv src/engine/<name>.test.ts test/engine/<name>.test.ts` for the five, and rewrite
their imports: `'./x.ts'` → `'../../src/engine/x.ts'`, `'../assumptions.ts'` →
`'../../src/assumptions.ts'`, `'../../test/engine/support.ts'` → `'./support.ts'`. Then
`boundary.test.ts`'s `ENGINE` directory constant must point at `../../src/engine`.

**Numeric-boundary exemptions used: none.** No `ALLOW_LIST` entry, no `DIMENSIONLESS` match under
`src/engine/` or `test/engine/` (`--explain | grep engine` is empty). The mechanism could not have
expressed the crossing anyway — `ALLOW_LIST` lives in the script this WP may not edit — so the
crossing function returns the alias `EngineDollars`, which the syntactic checker does not resolve.
**Reported, not relied on:** WP 4.14 should (a) add `ALLOW_LIST` entries for `toEngineAmount` and
`fromEngineAmount` in `packages/contexts/planning/src/engine/boundary.ts` with the reason "the named
Money ↔ float boundary of the projection engine (dispatch §3 WP 4.4)", and (b) consider resolving a
same-file type alias to `number`, since today `type X = number` hides a crossing from the check. The
in-package structural test (§1.3) forbids magnitude-spelled identifiers in the engine interior
regardless of type, so the alias cannot be reused there.

**What WP 4.5's Monte Carlo must reuse, so the two engines cannot drift:**

1. **`stepYear(prepared, state, t, market, extra, record = false)`** — the whole per-year recursion,
   glidepath → per-bucket return → contributions (mid-year) or spending policy → withdrawal order →
   gross-up → growth, and the guardrails. Feed it a drawn `MarketYear { equityReal, bondReal,
inflation }` per year. It allocates nothing with `record = false` (scratch buffers live on
   `PathState`). Then 07 §8.4 invariant 1 (zero volatility ⇒ MC median = deterministic path) holds
   by construction.
2. `toEnginePlan` + `preparePlan` once per request (income schedules and glidepath functions are
   resolved there, not in the loop); `newPathState(plan)` per path.
3. `fromEngineAmount` for every percentile that re-enters as Money, `fromEngineRatio` for success
   probability and the worst cut (a decimal string — WP 4.8 must never serialise a float).
4. `state.guard.worstCut` per path gives 07 §5.6's "worst-case spending cut in the 5th-percentile
   path"; `state.shortfallTotal` and `state.depletedAtAge` give 07 §5.4 detail 2's magnitude.
5. Annual steps: the recursion is annual (07 §5.2). A monthly bootstrap (07 §5.4) should compound
   twelve drawn monthly returns into the year's `MarketYear` rather than add a second, monthly
   recursion. If WP 4.5 needs a genuinely monthly step, it should generalise `stepYear` here, not
   fork it.
6. Known limitation to carry: pension income without a COLA is deflated at the plan's _expected_
   inflation in `preparePlan`; under stochastic inflation WP 4.5 should recompute that one schedule
   per path (or accept the approximation and say so).

**Candidates for WP 4.2's assumptions file** (statute/method constants that live beside their
method today, each cited in code): earliest claim age 62 (§202(a)), 35 computation years
(§215(b)(2)(A)), indexing age 60 (§215(b)(3)); the G-K parameters (`GUYTON_KLINGER`); the glidepath
knots. None is an Appendix A parameter; all are overridable per plan where it matters.

**Licence note (D15):** `guyton-klinger-cohorts.json` carries 60 annual rows each of Damodaran's
S&P 500 and 10-year Treasury total returns and BLS CPI (via the Minneapolis Fed), with provenance.
They are published statistics and a test fixture, but they are third-party data in the repo; fold
the check into the dispatch §6 Q3 decision for WP 4.5's vendored series.

**Open items**

1. Run `reference-projection.md`'s formulas in LibreOffice Calc once and record the result (no Calc
   on this host) — WP 4.14 or the gate.
2. The Bengen golden on WP 4.5's Shiller series, and the dated cFIREsim/FI Calc record — WP 4.14 by
   the dispatch.
3. RMDs, bracket-filling and taxable-gains tax are not modelled (dispatch §1 cut line 1, 07 §5.7
   phase 1). HSA is treated as tax-free and last in order.
4. Social Security for a worker first eligible before the file's year needs that year's bend points,
   which the file does not carry; case B passes SSA's 2021 figures as test inputs. Workers eligible
   after 2026 get "today's dollars" bend points (SSA's own estimator convention) — stated in
   `social-security.ts`.
5. `tsc -b --noEmit` currently reports errors in `packages/contexts/investments/src/dwell.ts` and
   `apps/api/src/routes/investments.ts` — WP 4.7's in-flight files, not this WP's; `src/engine/**`
   and `test/engine/**` are clean.

---

## 11. Verification

Run before this document's report was posted:

- `pnpm exec vitest run --project planning` → **18 files, 97 tests passed** (33 of them this WP's).
- `pnpm exec eslint packages/contexts/planning/src/engine packages/contexts/planning/test/engine` →
  clean.
- `pnpm exec tsc -b --noEmit` → no error in any WP 4.4 file (the only errors are WP 4.7's, §10 item
  5).
- `node scripts/check-numeric-boundaries.ts` → `PASS — 734 file(s) scanned, 0 violations`.
- `git diff --cached --name-only` → empty.

Final re-run after the report: appended below.

### 11.1 Final re-run (2026-09-26 16:48, after the report was written)

- `pnpm exec vitest run --project planning` → `Test Files 18 passed (18)`, `Tests 97 passed (97)`.
- `pnpm exec eslint packages/contexts/planning/src/engine packages/contexts/planning/test/engine` →
  exit 0.
- `pnpm exec tsc -b --noEmit` → 0 errors under `packages/contexts/planning/` (the remaining errors
  are WP 4.7's in-flight investments files).
- `node scripts/check-numeric-boundaries.ts` →
  `PASS — 734 file(s) scanned, 0 violations, 71 exempt identifier(s)`.
- `pnpm exec prettier --check` over every WP 4.4 file → all formatted.
- `git diff --cached --name-only` → empty (nothing staged; no git state changed).
