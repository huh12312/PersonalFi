#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""
Independent reference for WP 4.4's deterministic engine.

Computes reference-projection.csv from the closed-form spreadsheet functions
(OpenDocument OpenFormula FV / PMT, ODF 1.2 Part 2 §6.12.20 and §6.12.36, the
definitions LibreOffice Calc implements) in Python `decimal` at 50 significant
digits. It shares no code with the TypeScript engine and uses no loop over
years: every checkpoint is one closed-form evaluation. The literal LibreOffice
formula text for every column is in reference-projection.md.

    python3 reference-projection.py > reference-projection.csv
"""
from decimal import Decimal as D, getcontext, ROUND_HALF_EVEN

getcontext().prec = 50

# 07 §5.5 via WP 4.2's assumptions file (capitalMarket.*.expectedReturn, inflation.mean,
# wageGrowth.spreadOverInflation) — copied here by hand as the reference's inputs.
US_EQUITY = D("0.065")
US_AGG_BONDS = D("0.045")
INFLATION = D("0.025")
WAGE_SPREAD = D("0.005")


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

# --- Case A: TAXABLE, static 100% equity, FLAT real contributions, constant real spending.
r = real(US_EQUITY)                   # 1.065/1.025 - 1
b0, c0, spend = D(50000), D(15000), D(50000)
acc_years = 30                         # ages 35..64
for n in (10, 20, 30):
    # accumulation: FV(r; n; -C0*SQRT(1+r); -B0; 0)
    rows.append(("A", 34 + n, n, "wealth_end_real", fv(r, n, -c0 * (1 + r).sqrt(), -b0, 0), "A_acc"))
b_ret = fv(r, acc_years, -c0 * (1 + r).sqrt(), -b0, 0)
for k in (10, 20, 30):
    # decumulation: FV(r; k; W; -B_ret; 1) — withdrawal at the start of each year
    rows.append(("A", 64 + k, acc_years + k, "wealth_end_real", fv(r, k, spend, -b_ret, 1), "A_dec"))

# --- Case B: TAX_DEFERRED, static 60/40, WAGE-GROWING contributions, 15% blended tax,
#     Social Security $2,500.00/month (statement PIA, claimed at FRA 67) from age 67.
r = real(D("0.6") * US_EQUITY + D("0.4") * US_AGG_BONDS)
g = (1 + INFLATION + WAGE_SPREAD) / (1 + INFLATION) - 1
b0, c0, spend, tau, ss = D(100000), D(12000), D(60000), D("0.15"), D(2500) * 12


def growing(n):
    # B0(1+r)^n + C0*SQRT(1+r)*((1+r)^n - (1+g)^n)/(r - g): the growing-annuity FV,
    # mid-year convention; the spreadsheet column is this formula literally.
    return b0 * (1 + r) ** n + c0 * (1 + r).sqrt() * ((1 + r) ** n - (1 + g) ** n) / (r - g)


for n in (10, 20, 30):
    rows.append(("B", 34 + n, n, "wealth_end_real", growing(n), "B_acc"))
b_ret = growing(30)
gross_before_ss = spend / (1 - tau)          # ages 65, 66
gross_after_ss = (spend - ss) / (1 - tau)    # ages 67..94
b_66 = fv(r, 2, gross_before_ss, -b_ret, 1)
rows.append(("B", 66, 32, "wealth_end_real", b_66, "B_dec1"))
for k in (8, 18, 28):
    rows.append(("B", 66 + k, 32 + k, "wealth_end_real", fv(r, k, gross_after_ss, -b_66, 1), "B_dec2"))

# --- Case C: required additional monthly saving to reach $1,000,000 (today's dollars)
#     at the end of age 64, from $25,000 in TAXABLE, static 80/20, no other contributions.
r = real(D("0.8") * US_EQUITY + D("0.2") * US_AGG_BONDS)
annual_end_of_year = pmt(r, 30, D(25000), -D(1000000), 0)   # PMT(r; 30; 25000; -1000000; 0)
monthly = annual_end_of_year / (1 + r).sqrt() / 12           # undo the mid-year convention
rows.append(("C", 64, 30, "required_monthly_real", monthly, "C_pmt"))

print("case,age_in_final_year,years_from_start,measure,reference,formula")
for case, age, years, measure, value, formula in rows:
    print(f"{case},{age},{years},{measure},{cents(value)},{formula}")
