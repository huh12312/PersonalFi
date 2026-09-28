<!-- SPDX-License-Identifier: MIT -->

# `independent-cases.csv` — formulas and provenance

WP 4.14's second independent reference (dispatch §3 WP 4.14, §5 risk table row "within 1% of an
independent reference is asserted rather than measured" — *"at least two more independent cases"*
beyond the WP 4.4 fixture). Same method as `test/engine/fixtures/reference-projection.{py,md}`,
written fresh: a closed-form spreadsheet model, no loop over years, no import of the TypeScript
engine and no import of WP 4.4's script.

## How the numbers were produced

- **Tool:** `independent-cases.py` in this directory, Python 3.14.7, `decimal` module at 50
  significant digits, rounded half-even to the cent only when printed. Implements the OpenDocument
  OpenFormula `FV` / `PMT` definitions (ODF 1.2 Part 2, §6.12.20 and §6.12.36).
- **Run:** `python3 independent-cases.py > independent-cases.csv`, 2026-09-27.
- **Why not LibreOffice itself:** not installed on this build host either (checked again for WP
  4.14, same result as the WP 4.4 evidence recorded — see `wp4.14-quality.md`). The formulas below
  reproduce the CSV if pasted into a Calc sheet with the named cells defined.
- **Inputs:** the same 07 §5.5 defaults as the WP 4.4 fixture —
  `capitalMarket.usEquity.expectedReturn` 0.065, `capitalMarket.usAggregateBonds.expectedReturn`
  0.045, `capitalMarket.inflation.mean` 0.025 — copied by hand, so a change to the assumptions
  file's defaults turns this reference red too, until re-derived.

## What each case exercises that A/B/C (WP 4.4) do not

- **D** — a **CPI-indexed pension** (`packages/contexts/planning/src/engine/pension.ts`'s `cola:
  'cpi'` branch) offsetting retirement spending. `pension.ts`'s own header: *"cpi — indexed to
  inflation from its start: a constant real stream, worth `nominal / (1 + i)^(years until it
  starts)` in today's dollars."* Because the pension starts exactly at retirement here, that value
  is the same number every retirement year, which is what keeps this case closed-form: no loop is
  needed to fold a changing income offset into the withdrawal annuity. Chosen so the portfolio
  stays positive through age 94 (`D,94` is $427,497.54, not a depletion) — a case that ran the real
  bucket to zero would test the engine's shortfall floor (`withdrawn[b] = min(available, …)`), a
  different and untested-here code path, not the closed form below.
- **E** — the solver's **`nominal`** target basis. `boundary.ts#toEngineTarget`: *"a nominal target
  is deflated before it is compared, never compared as if real"* — `target_real = target_nominal /
  (1 + inflation)^years`. WP 4.4's case C only exercises `basis: 'real'`.

## Named cells

| Name       | Formula                                                              | Meaning                                                    |
| ---------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `EQ`       | `0.065`                                                                | US equity nominal expected return                           |
| `BD`       | `0.045`                                                                | US aggregate bonds nominal expected return                  |
| `INF`      | `0.025`                                                                | inflation                                                    |
| `rD`       | `=(1+0.5*EQ+0.5*BD)/(1+INF)-1`                                         | case D real return, static 50/50                             |
| `PenR`     | `=35000/(1+INF)^30`                                                    | case D pension, today's dollars (CPI-indexed, starts age 65) |
| `NeedD`    | `=40000-PenR`                                                         | case D annual withdrawal need before tax gross-up             |
| `GrossD`   | `=NeedD/(1-0.15)`                                                     | case D withdrawal grossed up for the 15% blended tax rate     |
| `DretD`    | `=FV(rD; 30; -11000*SQRT(1+rD); -90000; 0)`                            | case D wealth at retirement                                  |
| `rE`       | `=(1+0.9*EQ+0.1*BD)/(1+INF)-1`                                         | case E real return, static 90/10                              |
| `TargetE`  | `=2000000/(1+INF)^30`                                                  | case E target, deflated from nominal to today's dollars       |

## Columns (the `formula` field of each CSV row)

Both cases: born 1 Jan 1991, projected from 1 Jan 2026 (age 35), retirement at 65, plan to 95,
annual steps, today's dollars. `n` / `k` is the number of years in the checkpoint.

| `formula` | Rows (`age_in_final_year`)  | Literal Calc formula                            | What it is                                                                                                     |
| --------- | ---------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `D_acc`   | 44, 54, 64 (n = 10, 20, 30)  | `=FV(rD; n; -11000*SQRT(1+rD); -90000; 0)`         | Accumulation, `TAX_DEFERRED`, $90,000 start, flat $11,000/yr real, mid-year convention — identical shape to case A's `A_acc` |
| `D_dec`   | 74, 84, 94 (k = 10, 20, 30)  | `=FV(rD; k; GrossD; -DretD; 1)`                    | Decumulation: $40,000/yr spending offset by the CPI pension, grossed up for tax, withdrawn at the start of each year |
| `E_pmt`   | 64 (n = 30)                  | `=PMT(rE; 30; 40000; -TargetE; 0)/SQRT(1+rE)/12`   | Required additional monthly saving from $40,000 (`TAXABLE`, static 90/10) to a **nominal** $2,000,000 target at age 65, deflated to `TargetE` before `PMT` sees it |
