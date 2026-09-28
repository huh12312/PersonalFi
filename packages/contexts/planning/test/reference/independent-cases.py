#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
WP 4.14's second independent reference, additional to WP 4.4's
`test/engine/fixtures/reference-projection.py`.

Same method, a fresh script: OpenDocument OpenFormula `FV` / `PMT` (ODF 1.2
Part 2, §6.12.20 and §6.12.36 — the definitions LibreOffice Calc implements),
Python `decimal` at 50 significant digits, each checkpoint one closed-form
expression, no loop over years, no import from the TypeScript engine or from
`reference-projection.py`. Two cases neither WP 4.4 case touches:

  * **D** exercises a CPI-COLA'd pension offsetting retirement spending
    (`packages/contexts/planning/src/engine/pension.ts`) — a code path A/B/C
    never reach.
  * **E** exercises the solver's *nominal* target basis
    (`boundary.ts#toEngineTarget`: "a nominal target is deflated before it is
    compared, never compared as if real") — case C only exercises the `real`
    basis.

    python3 independent-cases.py > independent-cases.csv
"""
from decimal import Decimal as D, getcontext, ROUND_HALF_EVEN

getcontext().prec = 50

# 07 §5.5 via WP 4.2's assumptions file, copied by hand — identical inputs to
# reference-projection.py, so a change to the assumptions file's defaults
# turns both references red until re-derived.
US_EQUITY = D("0.065")
US_AGG_BONDS = D("0.045")
INFLATION = D("0.025")


def real(nominal):
    return (1 + nominal) / (1 + INFLATION) - 1


def fv(rate, nper, pmt, pv, typ):
    """OpenFormula FV: -(pv(1+r)^n + pmt(1+r*type)((1+r)^n - 1)/r)."""
    growth = (1 + rate) ** nper
    return -(pv * growth + pmt * (1 + rate * typ) * (growth - 1) / rate)


def pmt(rate, nper, pv, fvalue, typ):
    """OpenFormula PMT: -(pv(1+r)^n + fv) r / ((1+r*type)((1+r)^n - 1))."""
    growth = (1 + rate) ** nper
    return -(pv * growth + fvalue) * rate / ((1 + rate * typ) * (growth - 1))


def cents(x):
    return x.quantize(D("0.01"), rounding=ROUND_HALF_EVEN)


rows = []

# --- Case D: TAX_DEFERRED, static 50/50, FLAT real contributions, a
#     CPI-indexed pension of $18,000/yr nominal starting exactly at
#     retirement (age 65). `pension.ts`'s own header: "cpi — indexed to
#     inflation from its start: a constant real stream, worth
#     nominal / (1 + i)^(years until it starts) in today's dollars" — so in
#     today's dollars the pension is the SAME number every retirement year,
#     which is what keeps this a closed form (no loop needed to fold a
#     decaying income offset into the annuity).
r = real(D("0.5") * US_EQUITY + D("0.5") * US_AGG_BONDS)
b0, c0, spend, tau = D(90000), D(11000), D(40000), D("0.15")
acc_years = 30  # ages 35..64
pension_nominal_at_start = D(35000)
years_until_pension_starts = 30  # retirement age 65 minus plan-start age 35
pension_real = pension_nominal_at_start / (1 + INFLATION) ** years_until_pension_starts

for n in (10, 20, 30):
    # accumulation: FV(r; n; -C0*SQRT(1+r); -B0; 0) — identical shape to case
    # A's A_acc; the point of this case is the decumulation column, not this one.
    rows.append(("D", 34 + n, n, "wealth_end_real", fv(r, n, -c0 * (1 + r).sqrt(), -b0, 0), "D_acc"))
d_ret = fv(r, acc_years, -c0 * (1 + r).sqrt(), -b0, 0)

need = spend - pension_real  # W_t = spend_t - pension_t (07 §5.2), constant every year here
gross = need / (1 - tau)  # TAX_DEFERRED is the only funded bucket, so it carries the whole need
for k in (10, 20, 30):
    # decumulation: FV(r; k; grossW; -D_ret; 1) — withdrawal (and its tax) at
    # the start of each year, same shape as A_dec / B_dec2.
    rows.append(("D", 64 + k, acc_years + k, "wealth_end_real", fv(r, k, gross, -d_ret, 1), "D_dec"))

# --- Case E: TAXABLE, static 90/10, no baseline contribution, solve for the
#     required additional monthly saving to reach a target stated in
#     NOMINAL dollars (case C's target was `real`) — `toEngineTarget`
#     deflates it once before the solver ever sees it:
#     target_real = target_nominal / (1 + inflation)^years.
r = real(D("0.9") * US_EQUITY + D("0.1") * US_AGG_BONDS)
target_nominal = D(2000000)
years_to_target = 30  # 2026-01-01 -> 2056-01-01, the same target date case C uses
target_real = target_nominal / (1 + INFLATION) ** years_to_target
annual_end_of_year = pmt(r, 30, D(40000), -target_real, 0)  # PMT(r; 30; 40000; -target_real; 0)
monthly = annual_end_of_year / (1 + r).sqrt() / 12  # undo the mid-year convention
rows.append(("E", 64, 30, "required_monthly_real", monthly, "E_pmt"))

print("case,age_in_final_year,years_from_start,measure,reference,formula")
for case, age, years, measure, value, formula in rows:
    print(f"{case},{age},{years},{measure},{cents(value)},{formula}")
