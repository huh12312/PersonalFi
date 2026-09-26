<!-- SPDX-License-Identifier: MIT -->

# `reference-projection.csv` — formulas and provenance

The independent reference for WP 4.4's deterministic engine and the dispatch §5 exit criterion
_"deterministic output within 1% of an independent reference calculator on the shipped fixtures"_
(reference (a) in the §5 risk table: a spreadsheet model of 07 §5.2's recursions driven by
`FV`/`PMT`, with the literal formula text beside it).

## How the numbers were produced

- **Tool:** `reference-projection.py` in this directory, Python 3.14.7, `decimal` module at 50
  significant digits, rounded half-even to the cent only when printed. It implements the
  OpenDocument OpenFormula definitions of `FV` and `PMT` (ODF 1.2 Part 2, §6.12.20 and
  §6.12.36 — the definitions LibreOffice Calc implements) and evaluates **each checkpoint as one
  closed-form expression**. There is no loop over years in it, and it imports nothing from the
  TypeScript engine; the engine iterates `B_{t+1} = B_t(1+r) + C_t(1+r)^0.5` year by year. Two
  different computations of the same mathematics.
- **Run:** `python3 reference-projection.py > reference-projection.csv`, 2026-09-26.
- **Why not LibreOffice itself:** LibreOffice is not installed on the build host this WP ran on.
  The formulas below are written so that pasting them into a Calc sheet with the named cells
  defined reproduces the CSV; doing exactly that once, and recording the result, is an open item
  for WP 4.14 (which owns `test/reference/**`) or the gate.
- **Inputs:** 07 §5.5's defaults as WP 4.2's assumptions file carries them —
  `capitalMarket.usEquity.expectedReturn` 0.065, `capitalMarket.usAggregateBonds.expectedReturn`
  0.045, `capitalMarket.inflation.mean` 0.025, `capitalMarket.wageGrowth.spreadOverInflation` 0.005.
  Copied by hand, so a change to the file's defaults turns the test red until the reference is
  re-derived — which is the point.

## Named cells

| Name     | Formula                                                              | Meaning                                                          |
| -------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `EQ`     | `0.065`                                                              | US equity nominal expected return                                |
| `BD`     | `0.045`                                                              | US aggregate bonds nominal expected return                       |
| `INF`    | `0.025`                                                              | inflation                                                        |
| `SPREAD` | `0.005`                                                              | wage growth over inflation                                       |
| `rA`     | `=(1+EQ)/(1+INF)-1`                                                  | case A real return, static 100% equity (07 §5.2 `r_real`)        |
| `rB`     | `=(1+0.6*EQ+0.4*BD)/(1+INF)-1`                                       | case B real return, static 60/40                                 |
| `gB`     | `=(1+INF+SPREAD)/(1+INF)-1`                                          | case B real wage growth (07 §5.2 `g_real`)                       |
| `rC`     | `=(1+0.8*EQ+0.2*BD)/(1+INF)-1`                                       | case C real return, static 80/20                                 |
| `BretA`  | `=FV(rA; 30; -15000*SQRT(1+rA); -50000; 0)`                          | case A wealth at retirement                                      |
| `BretB`  | `=100000*(1+rB)^30 + 12000*SQRT(1+rB)*((1+rB)^30-(1+gB)^30)/(rB-gB)` | case B wealth at retirement                                      |
| `B66`    | `=FV(rB; 2; 60000/(1-0.15); -BretB; 1)`                              | case B wealth after two retirement years, before Social Security |

## Columns (the `formula` field of each CSV row)

Every case: born 1 Jan 1991, projected from 1 Jan 2026 (age 35), retirement at 65, plan to 95,
annual steps, today's dollars. `n` / `k` is the number of years in the checkpoint.

| `formula` | Rows (`age_in_final_year`)  | Literal Calc formula                                              | What it is                                                                                                                                                                                                                         |
| --------- | --------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `A_acc`   | 44, 54, 64 (n = 10, 20, 30) | `=FV(rA; n; -15000*SQRT(1+rA); -50000; 0)`                        | Accumulation, `TAXABLE`, $50,000 start, **flat** $15,000/yr real, mid-year convention: the payment `C·(1+r)^0.5` compounded as an ordinary annuity is exactly `Σ C(1+r)^0.5 (1+r)^(n−1−t)`                                         |
| `A_dec`   | 74, 84, 94 (k = 10, 20, 30) | `=FV(rA; k; 50000; -BretA; 1)`                                    | Decumulation, $50,000/yr real at the **start** of each year (`type = 1`, annuity due) — 07 §5.2's `(B_t − W_t)(1 + r)`                                                                                                             |
| `B_acc`   | 44, 54, 64 (n = 10, 20, 30) | `=100000*(1+rB)^n + 12000*SQRT(1+rB)*((1+rB)^n-(1+gB)^n)/(rB-gB)` | Accumulation, `TAX_DEFERRED`, $100,000 start, $12,000/yr growing at `g_real` (07 §5.2 `C_t = C_0(1+g)^t`): the growing-annuity FV. `FV()` has no growth argument, so this column is the closed form itself                         |
| `B_dec1`  | 66 (k = 2)                  | `=FV(rB; 2; 60000/(1-0.15); -BretB; 1)`                           | Ages 65–66: $60,000 spending, no income yet, withdrawn from `TAX_DEFERRED` **grossed up** by the 15% blended rate (07 §5.7 phase 1)                                                                                                |
| `B_dec2`  | 74, 84, 94 (k = 8, 18, 28)  | `=FV(rB; k; (60000-2500*12)/(1-0.15); -B66; 1)`                   | From 67: Social Security of $2,500.00/month (a statement PIA claimed at FRA 67, factor 1.00, floored to the dollar = $30,000/yr) offsets spending: `W = 60000 − 30000`, grossed up                                                 |
| `C_pmt`   | 64 (n = 30)                 | `=PMT(rC; 30; 25000; -1000000; 0)/SQRT(1+rC)/12`                  | Required **additional monthly** saving to reach $1,000,000 (today's dollars) at the end of age 64 from $25,000, static 80/20: the end-of-year annuity `PMT` gives, divided by `(1+r)^0.5` to undo the mid-year convention, over 12 |

## What each case exercises

- **A** — the mid-year convention in accumulation (worth ~1.6% of wealth at 65 here, so dropping
  it moves the 1% criterion), the start-of-year withdrawal timing, one bucket's own `r`.
- **B** — real wage growth on contributions, the tax-deferred gross-up, a Social Security income
  stream starting mid-plan, a different allocation.
- **C** — the solver (`solveRequiredSavings`) against `PMT`, through the Money boundary both ways.
