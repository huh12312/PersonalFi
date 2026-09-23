# WP 3.3 — portfolio analytics (pure)

Package `@ctx/investments`, directory `src/analytics/**`. **No tables, no migrations, no I/O, no
clock**: every function takes explicit inputs — dated valuations, external flows, classified
holdings with their prices and staleness verdicts, targets — and returns a value. That is what
makes the whole module checkable against a committed spreadsheet, and what keeps this arithmetic
out of WP 3.9's route handlers.

Ten modules, ten test files, **55 tests** (of the investments project's 200), zero database.

---

## 1. The numeric-type decision (D3 at the analytics boundary)

D3 governs _stored_ values: `BIGINT` minor units for money, `NUMERIC(38,18)` for quantities, no
float near either. Analytics stores nothing and returns ratios, so the boundary needed a decision
of its own. It is in `src/analytics/types.ts` and every consumer inherits it:

| Answer                                                | Type                                                                          | Why                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fee drag, dollar gain, rebalance size, idle cash      | `Money` (bigint minor units)                                                  | Money is money. Rounded once, half-even, at the boundary — `Money.multiplyByDecimal`, never a float multiply.                                                                                                                                                                                                                                                                                                        |
| Weights, returns, expense ratios, Herfindahl          | **`Ratio`** — a branded plain decimal string at **exactly 10 decimal places** | 04 §2.3 permits floats for ratios and it is right that the precision is not needed. But a `number` here is a `number` that gets multiplied by a portfolio value two calls later, and D3's boundary rule ("floats may never flow back into a `*_minor` column") is far cheaper to enforce when there is no float to flow. A canonical string also makes equality a string comparison rather than an epsilon argument. |
| Drift gaps, the 5-point band, the 10% noise threshold | **`Points`** — a second branded decimal string at 4 places                    | `0.051` and `5.1` are both "the drift". A function given the wrong one is off by 100× and looks completely normal. The drift band is compared against `Points`; there is no overload that takes a ratio.                                                                                                                                                                                                             |
| Days, lot counts, holding counts, solver iterations   | `number`                                                                      | They are counts.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Charting                                              | `ratioToNumberApproximate` / `pointsToNumberApproximate`                      | The only two functions in the module that produce a float, named for what they cost, documented as never re-entrant into a `Ratio`, `Quantity` or `Money`.                                                                                                                                                                                                                                                           |

**No new dependency.** `@core/kernel`'s `Quantity` is already an arbitrary-precision decimal with
the repo's rounding policy baked in, so ratio arithmetic runs on it. `Quantity` has no `pow`, and
both TWR annualisation and XIRR discounting need a fractional one, so `decimalPow` is built from
`ln` and `exp` series over the same type (range-reduced by powers of two; ~25 terms each). There is
no `Math.pow` in the module and no intermediate is ever a float.

`grep -rn 'Math\.\(pow\|round\|abs\)\|toFixed(\|parseFloat' packages/contexts/investments/src/analytics/*.ts`
→ no hits outside `*.test.ts` (tests use `Number()` to _assert_ against a float reference, which is
the direction that is safe).

### The saturation, written down rather than left as a magic number

`MAX_DECIMAL_EXPONENT = 25`. XIRR evaluates its NPV at the bracket endpoint `r = −0.9999`, where
the true discount factors are ~1e40 and overflow `NUMERIC(38,18)`. Only the **sign** of that
evaluation is used (it is a bracket test), so `decimalExp` saturates at `e^±25 ≈ 7.2e10`, which
leaves ten integer digits of headroom for the cash flow it multiplies. Pinned by
`types.test.ts` → `'saturates instead of overflowing at the bracket endpoint'`.

---

## 2. The return-shape type rule

07 §4.2: _"Never put a TWR next to a dollar gain, and never benchmark an MWR. That's the whole
rule."_ Implemented as three disjoint types, not as a convention:

| Shape                 | Carries                                                                                                | Structurally cannot carry                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `TimeWeightedReturn`  | `periodReturn`, `annualized`, sub-periods, `benchmarkComparable: true`                                 | `gain`, `dollarGain`, `marketValue`, `costBasis` (all declared `?: never`) |
| `MoneyWeightedReturn` | `periodReturn`/`annualized` or a typed `unavailable`, solver diagnostics, `benchmarkComparable: false` | `benchmark`, `gain`, `dollarGain`                                          |
| `DollarGain`          | `gain`, `marketValue`, `costBasis` — or `unavailable` with the reason                                  | `periodReturn`, `annualized`, `benchmarkComparable`                        |

`PerformanceReport` holds all three in three separate fields, so WP 3.9's response inherits the
rule without restating it.

With `exactOptionalPropertyTypes` on, a `?: never` field rejects the property both as a fresh
literal and — the part that matters — as a **non-fresh value**. Excess-property checking already
catches `{ ...twr, gain }` written inline; it does _not_ catch the realistic failure, which is a
route handler that merges two engines' output into a variable and then returns it. Only the
`never` field refuses that one.

The enforcement point is **`tsc`, not vitest**: vitest transpiles without type-checking, so the
five `@ts-expect-error` directives in `types.test.ts` → `'a TWR and a dollar gain cannot be placed
in the same return shape'` are checked by `pnpm exec tsc -b --noEmit`, and if any of them stopped
being an error, `tsc` fails on the unused directive:

```ts
// @ts-expect-error — a time-weighted return may not carry a dollar gain.
const _twrWithGain: TimeWeightedReturn = { ...TWR, gain: gain.gain };
const merged = { ...TWR, gain: gain.gain };
// @ts-expect-error — and it is still refused once it stops being a literal.
const _twrWithGainIndirect: TimeWeightedReturn = merged;
// @ts-expect-error — nor a market value, which is the same mistake in a hat.
const _twrWithValue: TimeWeightedReturn = { ...TWR, marketValue: gain.marketValue };
// @ts-expect-error — and a dollar gain may not carry a return ratio.
const _gainWithReturn: DollarGain = { ...gain, periodReturn: TWR.periodReturn };
// @ts-expect-error — "never benchmark an MWR": there is no field for one.
benchmark: ratio('0.10'),
```

**Sabotage (third one, and the one that found a weakness).** Deleting `readonly gain?: never` from
`TimeWeightedReturn` was tried first against the _literal_ case alone and `tsc` stayed green — the
excess-property check was doing the work and the `never` field was, on that line, decoration. The
non-fresh assignment above was added for exactly that reason, and with it the sabotage is observed
red:

```
$ # readonly gain?: never  ->  /* SABOTAGE: rule removed */
$ pnpm exec tsc -b --noEmit
packages/contexts/investments/src/analytics/types.test.ts(65,5): error TS2578: Unused '@ts-expect-error' directive.
```

Reverted; `tsc -b --noEmit` clean.

---

## 3. TWR vs MWR on one worked portfolio

The portfolio (`src/analytics/twr.test.ts`, and the same numbers below are the engine's output):

| Date       | What happened                                        | Portfolio value |
| ---------- | ---------------------------------------------------- | --------------- |
| 2025-01-01 | opening                                              | $100,000.00     |
| 2025-07-01 | +20% over the half-year, **then a $100,000 deposit** | $220,000.00     |
| 2026-01-01 | −10% over the half-year                              | $198,000.00     |

### TWR — sub-period linking

The flow convention is stated once, in `twr.ts`: `r_j = (MV_end,j − CF_j)/MV_begin,j − 1` subtracts
the flow from the **end** value, so a flow lands at the end of the sub-period it closes and the
valuation on a flow date is _after_ the flow.

| Sub-period              | MV begin   | MV end     | CF          | `r_j`                                                |
| ----------------------- | ---------- | ---------- | ----------- | ---------------------------------------------------- |
| 2025-01-01 → 2025-07-01 | 100,000.00 | 220,000.00 | +100,000.00 | `(220,000 − 100,000)/100,000 − 1` = **0.2000000000** |
| 2025-07-01 → 2026-01-01 | 220,000.00 | 198,000.00 | 0.00        | `198,000/220,000 − 1` = **−0.1000000000**            |

`TWR = 1.20 × 0.90 − 1 = ` **0.0800000000**. Span 365 days, so `annualized = 0.0800000000`.

The control: the same two sub-period returns with **no deposit** (100,000 → 120,000 → 108,000) give
`periodReturn = 0.0800000000` — identical. A deposit four times the portfolio's size (→ $520,000,
→ $468,000) also gives **0.0800000000**. That is `'a mid-period deposit does not change TWR'`.

### MWR — XIRR of the investor's own flows

Same portfolio, flows in XIRR's convention (the single inversion happens in `mwr.ts`: into the
portfolio is out of the investor's pocket):

```
2025-01-01  −100,000.00     (opening value: capital already committed)
2025-07-01  −100,000.00     (the deposit)
2026-01-01  +198,000.00     (closing value)
```

Solved: **periodReturn = −0.0132821454**, `annualized = −0.0132821454` (span exactly 365 days),
solver `newton`, 5 Newton steps, 0 bisection steps, residual `0.000000`.

### The divergence, explained

**+8.00% and −1.33% on the same portfolio, and both are right.**

TWR asks "did the _investments_ do well?" and answers by deliberately deleting the effect of when
money arrived: a 20% half-year followed by a −10% half-year compounds to +8% no matter how much
money was present for each. MWR asks "how did _I_ do?" and cannot delete it: $100,000 was exposed
to the good half and $220,000 to the bad one, so $200,000 went in and $198,000 came out. The gap is
not an error in either number — it **is** the timing, and it is the only thing the two numbers
disagree about.

Which is exactly why 07 §4.2 forbids pairing a TWR with a dollar gain (a reader will multiply 8% by
their balance and get a number that never existed) and forbids benchmarking an MWR (the index had
no deposits, so the difference would be attributed to skill). Section 2's types make both
impossible rather than discouraged.

### Modified Dietz — the flagged `approximate` fallback

Same portfolio with the **1 July valuation removed** (a CSV-imported account: month-end statements,
a deposit on the 1st). Sub-period linking is impossible, so the engine falls back automatically:

```
R = (EMV − BMV − ΣCF) / (BMV + Σ w_i·CF_i),  w_i = (D − d_i)/D
  = (198,000 − 100,000 − 100,000) / (100,000 + (365−181)/365 × 100,000)
  = −2,000 / 150,410.96 = −0.0132969035
```

Returned as `method: 'modified_dietz'`, `approximate: true`, with a warning naming the dates that
forced it (`valuation_dates_missing`) — and, notably, −1.3297% is close to the **MWR**, not to the
TWR, because Modified Dietz is a money-weighted approximation. A caller that would rather fail than
approximate passes `allowApproximateFallback: false` and gets an `AnalyticsInputError`.

---

## 4. The spreadsheet fixture (the §5 exit criterion, the v0.5 rung)

**Provenance.** No committed spreadsheet check existed before this work package — `docs/` and
`packages/` were searched for one (`fixture` + `allocation`). So one was authored:

- `packages/contexts/investments/test/fixtures/allocation-portfolio.csv` — eleven positions, with
  the spreadsheet formulas written in `#` comment lines at the top of the file so they travel with
  the data rather than in a README that drifts;
- `packages/contexts/investments/test/fixtures/allocation-expected.csv` — every expected slice
  value and weight, for both valuation bases;
- `packages/contexts/investments/test/fixtures/portfolio.ts` — the loader (shared, so four suites
  read one fixture).

**The expectations were computed with an independent decimal implementation (Python `decimal`,
`ROUND_HALF_EVEN`), not with the TypeScript engine they pin.** A fixture generated by the code
under test asserts only that the code is self-consistent. The transcript is §4.3 below.

### 4.1 The formulas, as committed

```
expected_market_value = ROUND(quantity * price, 2)        -- banker's rounding, once, at the boundary
total(last_known)     = SUM(expected_market_value)        -- every priced holding, CASH INCLUDED
total(as_of_now)      = SUMIF(staleness, "FRESH", expected_market_value)
weight(key)           = SUMIF(<dimension>, key, expected_market_value) / total
unclassified_pct      = weight("UNCLASSIFIED") [asset_class] / weight("UNKNOWN") [region, sector]
```

Weights are evaluated at 18 dp and reported at the `Ratio` scale of 10 dp, half-even at each step —
the same two roundings the engine performs, so the fixture pins the rounding _policy_ and not just
the arithmetic.

### 4.2 The portfolio, chosen for its failure modes rather than its tidiness

| id   | symbol | class           | qty        | price     | value     | note                                                |
| ---- | ------ | --------------- | ---------- | --------- | --------- | --------------------------------------------------- |
| h-01 | VTI    | US_EQUITY       | 152.3456   | 268.42    | 40,892.61 | same security as h-11, other account                |
| h-02 | VXUS   | INTL_DEV_EQUITY | 310.5      | 61.37     | 19,055.38 |                                                     |
| h-03 | BND    | US_BOND         | 480        | 72.15     | 34,632.00 |                                                     |
| h-04 | VWO    | EM_EQUITY       | 125.25     | 44.08     | 5,521.02  |                                                     |
| h-05 | AAPL   | US_EQUITY       | 90         | 228.52    | 20,566.80 | expense ratio `0`, meaning _charges nothing_        |
| h-06 | BTC    | CRYPTO          | 0.31415926 | 63,250.10 | 19,870.60 | 18-dp quantity; **no cost basis, no expense ratio** |
| h-07 | CASH   | CASH            | 12,500     | 1.00      | 12,500.00 | **must be in the denominator**                      |
| h-08 | VNQ    | REAL_ESTATE     | 60         | 92.33     | 5,539.80  |                                                     |
| h-09 | XYZQ   | UNCLASSIFIED    | 200        | 15.40     | 3,080.00  | drives `unclassifiedPct`                            |
| h-10 | OLDCO  | US_EQUITY       | 40         | 51.25     | 2,050.00  | **STALE price**                                     |
| h-11 | VTI    | US_EQUITY       | 47.6544    | 268.42    | 12,791.39 |                                                     |

`total(last_known)` = **176,499.60** · `total(as_of_now)` = **174,449.60** (the $2,050.00 stale
holding leaves _both_ numerator and denominator).

### 4.3 Independent recomputation

```
$ python3  # decimal, ROUND_HALF_EVEN — not the engine under test
h-01 VTI 40892.61      h-02 VXUS 19055.38     h-03 BND 34632.00
h-04 VWO 5521.02       h-05 AAPL 20566.80     h-06 BTC 19870.60
h-07 CASH 12500.00     h-08 VNQ 5539.80       h-09 XYZQ 3080.00
h-10 OLDCO 2050.00     h-11 VTI 12791.39
last_known TOTAL 176499.60
as_of_now  TOTAL 174449.60
```

Asset-class slices, `last_known` (all three dimensions and both bases are in the CSV and all are
asserted):

| class            | value     | weight           |
| ---------------- | --------- | ---------------- |
| US_EQUITY        | 76,300.80 | 0.4323001299     |
| US_BOND          | 34,632.00 | 0.1962157421     |
| CRYPTO           | 19,870.60 | 0.1125815583     |
| INTL_DEV_EQUITY  | 19,055.38 | 0.1079627376     |
| CASH             | 12,500.00 | 0.0708216902     |
| REAL_ESTATE      | 5,539.80  | 0.0313870400     |
| EM_EQUITY        | 5,521.02  | 0.0312806375     |
| **UNCLASSIFIED** | 3,080.00  | **0.0174504645** |

`allocation.test.ts` → `'allocation matches the committed spreadsheet fixture to the cent'` asserts
every holding's value, both totals, and every slice's value **and** weight, across both bases and
all three dimensions — 2 bases × 3 dimensions, exact string equality on the weights.

Weight sums are asserted to `slices × 1e-10` of 1, and the tolerance is _stated_: each weight is
rounded to ten places independently, so the sum can be one ulp per slice away from 1 (observed:
`1.0000000001` on the eight-slice asset-class report). An unstated "approximately 1" is where a
real error would hide.

### 4.4 Derived numbers the same fixture pins

| Number                                     | Value                                                                                   | Test                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------- | ----------------------- |
| Fee drag `Σ(value × ER)`                   | **$52.81/yr** over $141,049.00 of covered value                                         | `fees.test.ts`          |
| Weighted expense ratio                     | 0.0003744089 (3.74bp)                                                                   | `fees.test.ts`          |
| Expense-ratio coverage                     | 0.7991462870 — **the drag is a lower bound**                                            | `fees.test.ts`          |
| Top holding (VTI, **two accounts summed**) | $53,684.00 = 0.3041593295                                                               | `concentration.test.ts` |
| Herfindahl over 10 securities              | 0.1763411515 (`1/n` = 0.1)                                                              | `concentration.test.ts` |
| Effective positions `1/HHI`                | 5.6708260749                                                                            | `concentration.test.ts` |
| Cash weight                                | 0.0708216902                                                                            | `cash.test.ts`          |
| Portfolio dollar gain                      | **`unavailable / basis_unknown`**, positions `['h-06']`, market value still $176,499.60 | `allocation.test.ts`    |

---

## 5. XIRR: Newton, bisection, and the fixture that breaks Newton

### 5.1 The committed sign-flipping fixture

An account topped up heavily after a loss — a shape a real portfolio produces, not a curiosity:

```
2024-01-01  −1,000.00
2025-01-01  −9,100.00
2026-01-01  +5,000.00
```

At the standard `guess = 0.1` the NPV curve is almost flat: `NPV(0.1) ≈ −$5,139` with a derivative
of about **+18**. Newton's first step is therefore `0.1 − (−5139/18) ≈ +288.4` — not merely wrong,
but outside the `[−0.9999, 100]` bracket, where there is no root to find and, a little further on,
no discount function at all.

### 5.2 Convergence table (engine output)

| Fixture                               | Answer                            | Solver                   | Newton steps | Bisection steps | `newtonDiverged` | Residual | **Plain Newton (`newtonOnly`, no fallback)**                                        |
| ------------------------------------- | --------------------------------- | ------------------------ | ------------ | --------------- | ---------------- | -------- | ----------------------------------------------------------------------------------- |
| simple 10%, one year                  | 0.1000000000                      | newton                   | 1            | 0               | false            | 0.000000 | converged, 1 iteration                                                              |
| **sign-flipping fixture**             | **−0.4801889654**                 | newton (after bisection) | 20           | **7**           | **true**         | 0.000000 | **diverged: `left_bracket` at iteration 1, first iterate `288.434886636746786542`** |
| worked portfolio MWR                  | −0.0132821454                     | newton                   | 5            | 0               | false            | 0.000000 | converged, 5 iterations                                                             |
| nine months (period basis, 274 d)     | 0.0800000000                      | newton                   | 4            | 0               | false            | 0.000000 | converged, 4 iterations                                                             |
| five flows over two years             | 0.0902238078                      | newton                   | 4            | 0               | false            | 0.000000 | converged, 4 iterations                                                             |
| contributions only, no terminal value | **n/a** `no_sign_change_in_flows` | —                        | —            | —               | —                | —        | diverged: `left_bracket`                                                            |
| two roots (−1,000 / +2,500 / −1,200)  | **n/a** `no_bracket`              | —                        | —            | —               | —                | —        | converged — **to one of two roots**                                                 |

Two rows are worth reading twice. The sign-flipping fixture is the only one where the bisection
fallback does any work, and it is the only one where plain Newton fails outright: bisection rescues
the bracket in 7 halvings and Newton then finishes it — which is the design, and why `solver`
reports the step that produced the _accepted_ iterate while `newtonDiverged` records that the
fallback was needed. The "two roots" row is the case where Newton looks _successful_ and is
untrustworthy: it converges happily to 0.8521 while a second root exists at −0.3520, and the
production solver refuses both and answers `n/a` rather than picking one.

**Cross-check.** The sign-flipping root was verified against an independent double-precision
bisection run outside this codebase: `−0.4801889654314656`, `npv = −3.6e−12`. The engine's decimal
answer agrees to all ten reported places, and the test pins the string exactly.

### 5.3 A defect this table found

The first run of this table reported `newtonDiverged: true` and 38 bisection steps for **every**
fixture, including the well-behaved ones. Cause: accepting a Newton iterate narrows the bracket _to
that iterate_, so the next pass through the loop saw `r === lo` and a strict `lo < r < hi` guard —
transcribed faithfully from 07 §4.2's pseudocode — declared divergence. The reference
implementation has the same quirk and still returns the right number through its bisection tail,
which is exactly why it survives unnoticed. Fixed by testing the _iterate_ against a closed
interval and keeping the strict test for the new tangent, with the deviation and its reason written
into `xirr.ts`. The answers did not change; the diagnostics went from meaningless to load-bearing,
and the residual on the sign-flipping fixture improved from `0.000001` to `0.000000`.

### 5.4 The three ways this returns no number

| Reason                    | When                                                                   | Why not 0                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `single_flow`             | fewer than two non-zero flows                                          | one flow cannot define a rate                                                                                           |
| `no_sign_change_in_flows` | every flow points the same way                                         | 07 §4.2: _"no sign change: undefined, show 'n/a'"_. A `0` reads as "you broke even", which is the opposite of the truth |
| `no_bracket`              | flows change sign but NPV does not cross zero in `[−99.99%, +10,000%]` | several sign changes can give two roots or none; reporting one of several as _the_ return is a coin toss                |

`MoneyWeightedReturn`'s `unavailable` variant has no `periodReturn` field at all, so a UI cannot
render a number it was not given.

---

## 6. Never annualise under one year

One constant (`MIN_ANNUALIZATION_DAYS = 365`), one comparison, both engines.

- **TWR**: `annualized = null` and `annualizationWithheld = 'period_under_one_year'` below the
  threshold; `(1 + TWR)^(365/days) − 1` above it (731 days at +21% → 0.0998... per year, _not_
  10.5%).
- **MWR**: an XIRR **is** an annual rate — discounting on `days/365` is what makes it one — so the
  solve itself is changed: below a year the flows are discounted on `days/spanDays`, producing the
  return **of that period** and nothing else. A $10,000 → $10,800 nine-month account answers
  `periodReturn = 0.0800000000`, `annualized = null`. Annualising it would print **10.796%**, which
  is §7.2's sabotage output.

---

## 7. Sabotage

Three sabotages, each applied to the shipped code, observed red, and reverted; the suite and the
type-check are green at the end of this note. The third (the return-shape type rule) is in §2,
where it belongs with the rule it breaks — and it is the one that found a real weakness rather than
confirming a strength.

### 7.1 Drop cash from the allocation denominator

One line in `valueHoldings` (`allocation.ts`): `if (holding.isCashEquivalent) continue;`.

```
 FAIL  allocation.test.ts > allocation matches the committed spreadsheet fixture to the cent
 AssertionError: expected '163999.60' to be '176499.60'
 FAIL  allocation.test.ts > keeps cash in the denominator, which is what the fixture pins
 AssertionError: expected '163999.60' to be '176499.60'
 FAIL  allocation.test.ts > unclassifiedPct is returned whenever any holding is UNCLASSIFIED
 AssertionError: expected '0.0187805336' to be '0.0174504645'
 FAIL  allocation.test.ts > a STALE price is excluded from an as-of-now allocation
 AssertionError: expected '161949.60' to be '174449.60'
 FAIL  cash.test.ts > finds the cash in a portfolio of holdings, sweep funds included
 AssertionError: expected '0.00' to be '12500.00'
 FAIL  concentration.test.ts > aggregates a security across accounts before measuring it
 AssertionError: expected '0.3273422618' to be '0.3041593295'
 FAIL  concentration.test.ts > computes a Herfindahl index the fixture pins
 AssertionError: expected '0.1984374916' to be '0.1763411515'
 Test Files  6 failed | 4 passed (10)
      Tests  18 failed | 37 passed (55)
```

Eighteen tests red across six files. The point is the _size_ of the silent error it would
otherwise cause: US_EQUITY reads **46.52%** instead of **43.23%** — 3.3 percentage points of pure
artefact, two thirds of the 5-point drift band, from a sweep balance that is 7% of the portfolio.
`drift.test.ts` → `'measures drift against the full portfolio, cash included'` demonstrates the
consequence directly: a 54.55% equity sleeve inside a 55% target reads as 60% and a trade is
proposed for something that never drifted.

Reverted; `55 passed (55)`.

### 7.2 Annualise a nine-month return

Three edits: `annualise = true` in `mwr.ts`, the `spanDays < MIN_ANNUALIZATION_DAYS` guard removed
from `annualizedOf` in `twr.ts`, and `annualizationWithheldFor` neutered in `types.ts`.

```
 FAIL  xirr.test.ts > a nine-month return is not annualized
 AssertionError: expected '0.1079606740' to be null
 FAIL  twr.test.ts > a period of exactly one year annualises and a shorter one does not
 AssertionError: expected '0.1079606740' to be null
 FAIL  properties.test.ts > TWR of zero flows equals simple return
 Caused by: AssertionError: expected false to be true
 Test Files  3 failed | 7 passed (10)
      Tests  3 failed | 52 passed (55)
```

`0.1079606740` is 07 §4.2's embarrassing bug in the flesh: an 8% nine-month return printed as
10.80% a year. The property test is red too, which is the useful part — the guard is checked across
the whole generated range of spans, not only at the one example.

Reverted; `55 passed (55)`.

---

## 8. Properties (`fast-check`, 200 runs each)

| Property                                   | What it holds                                                                                                                                                                   | Test                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| **TWR of zero flows equals simple return** | over random begin/end values (1¢ … $1M) and spans (1 … 3,650 days), `TWR == MV_end/MV_begin − 1` exactly at the ratio scale — and `annualized === null` iff `days < 365`        | `properties.test.ts` |
| **allocation sums to 100% ± unclassified** | `Σ weights` within `slices × 1e-10` of 1; the classified share equals `1 − unclassifiedPct` within the same bound; `unclassifiedPct` is zero **iff** no holding is unclassified | `properties.test.ts` |
| **Herfindahl in [1/n, 1]**                 | plus `topHoldingPct ≥ 1/n` and `1 ≤ 1/HHI ≤ n`, over 1–12 holdings across 6 securities                                                                                          | `properties.test.ts` |
| single-holding degenerate case             | weight exactly `1`, HHI exactly `1`                                                                                                                                             | `properties.test.ts` |

---

## 9. What propagates rather than being coerced

| Upstream fact                                 | What analytics does                                                                                                                                                                                                    | Test                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Basis `null` (WP 3.2)                         | portfolio gain is `unavailable / basis_unknown` with the position ids and the market value, which _is_ knowable — **never a gain from zero, and never a partial total over the positions that happen to have a basis** | `types.test.ts`, `allocation.test.ts`         |
| Price `STALE` (WP 3.4, computed at read time) | excluded from **both** numerator and denominator of an `as_of_now` answer and named in `excluded`; `last_known` keeps it and says so                                                                                   | `allocation.test.ts`, `concentration.test.ts` |
| Price absent                                  | `price_unknown` exclusion; never valued at 0                                                                                                                                                                           | `allocation.test.ts`                          |
| Expense ratio `null`                          | excluded from fee drag, named in `holdingsMissingExpenseRatio`, report flagged `isLowerBound` with `coveragePct`. A fund that genuinely charges nothing is `'0'`, and the distinction is preserved                     | `fees.test.ts`                                |
| `UNCLASSIFIED`                                | `unclassifiedPct` on **every** allocation, drift, fee and concentration report, present as an explicit zero when nothing is unclassified                                                                               | all four                                      |

One rule was added beyond the brief, for the same reason the others exist: a drift report whose
valuation is incomplete (a stale or unpriced holding) returns `proposalsWithheld:
'incomplete_valuation'` and **no proposals**, while still returning the rows and gaps. Without it, a
bond sleeve whose only fund has a stale price reads as 0%, and the engine would propose a five-
figure trade against a number that does not exist.

---

## 10. Modules and tests

| Module             | What it owns                                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `types.ts`         | `Ratio`, `Points`, `decimalPow`, the three return shapes, `portfolioDollarGain`, the `AnalyticsHolding` vocabulary |
| `twr.ts`           | sub-period linking, Modified Dietz fallback, annualisation                                                         |
| `xirr.ts`          | NPV, Newton + bisection, `newtonOnly` diagnostic, the three `n/a` reasons                                          |
| `mwr.ts`           | the portfolio-facing MWR, the single sign inversion, the sub-year period basis                                     |
| `allocation.ts`    | `valueHoldings`, allocation by asset class / region / sector, `unclassifiedPct`                                    |
| `drift.ts`         | the 5-point absolute band, proposals, `noisy`, `proposalsWithheld`                                                 |
| `fees.ts`          | `Σ(value × ER)`, coverage, I2's 0.50% flag                                                                         |
| `concentration.ts` | per-security aggregation, top holding, Herfindahl, investable denominator                                          |
| `cash.ts`          | idle cash (I3's three conditions), cash by account, cash weight                                                    |
| `index.ts`         | the barrel; re-exported additively from `src/index.ts`                                                             |

| Test file               | Tests  | Named by the dispatch                                                                                                                                                                                  |
| ----------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `twr.test.ts`           | 8      | `'a mid-period deposit does not change TWR'`, `'the same flows give a materially different MWR'`                                                                                                       |
| `xirr.test.ts`          | 6      | `'Newton diverges and bisection converges on the sign-flipping fixture'`, `'flows with no sign change return n/a rather than a number'`, `'a nine-month return is not annualized'`                     |
| `allocation.test.ts`    | 6      | `'allocation matches the committed spreadsheet fixture to the cent'`, `'unclassifiedPct is returned whenever any holding is UNCLASSIFIED'`, `'a STALE price is excluded from an as-of-now allocation'` |
| `drift.test.ts`         | 6      | `'a 4.9-point gap proposes nothing and a 5.1-point gap proposes a trade'`                                                                                                                              |
| `types.test.ts`         | 9      | `'a TWR and a dollar gain cannot be placed in the same return shape'`, `'an unavailable basis makes the gain unavailable, not zero'`                                                                   |
| `properties.test.ts`    | 4      | the three `fast-check` properties                                                                                                                                                                      |
| `fees.test.ts`          | 4      |                                                                                                                                                                                                        |
| `concentration.test.ts` | 5      |                                                                                                                                                                                                        |
| `cash.test.ts`          | 5      |                                                                                                                                                                                                        |
| `index.test.ts`         | 2      | guards the `export *` re-export against silent shadowing                                                                                                                                               |
| **Total**               | **55** |                                                                                                                                                                                                        |

```
$ pnpm exec vitest run --project investments
 Test Files  22 passed (22)
      Tests  200 passed (200)      # 55 of them WP 3.3's; no database needed

$ pnpm exec tsc -b --noEmit        # clean
$ pnpm exec eslint packages/contexts/investments   # clean
```

---

## 11. Open items

1. **Benchmark series are not in this WP.** `TimeWeightedReturn` is the shape a benchmark comparison
   may attach to, but nothing here fetches an index return. Whoever adds one must keep it on the
   TWR side; the types make the wrong choice a compile error.
2. **Look-through is fund-level only**, by design (07 §4.3, v1). `classify()` already walks
   fund-of-funds to depth 3 with cycle detection; analytics does not re-derive it and must not.
3. **`idleDays` is an input.** Idle cash needs "how long has this balance sat?", which is a question
   about `holdings_snapshots`. WP 3.9 or WP 3.10 supplies it; a pure module cannot.
4. **Employer-stock concentration (I5)** needs an employer tag on the security, which no table
   carries yet. `EMPLOYER_STOCK_TRIGGER` is exported and the measurement is the same one I4 uses.
5. **Multi-currency.** Every entry point asserts one currency and refuses a mixture rather than
   converting. When WP 3.8's dual native+base storage lands, conversion belongs on the way _in_,
   not here (D4: converting on read is wrong).
