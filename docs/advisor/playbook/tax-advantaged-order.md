---
key: tax-advantaged-order
title: The order of operations for tax-advantaged space
version: 1
status: draft
sources:
  - id: irs-notice-2025-67
    title: 'IRS, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500" (Notice 2025-67)'
    url_or_citation: https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500
    accessed: 2026-10-28
  - id: irs-pub-590a
    title: 'IRS Publication 590-A, "Contributions to Individual Retirement Arrangements (IRAs)"'
    url_or_citation: https://www.irs.gov/publications/p590a
    accessed: 2026-10-28
  - id: irs-pub-969
    title: 'IRS Publication 969, "Health Savings Accounts and Other Tax-Favored Health Plans"'
    url_or_citation: https://www.irs.gov/publications/p969
    accessed: 2026-10-28
---

## The rule

After an emergency fund and any high-interest debt, one common order for filling tax-advantaged space is:

- **The employer match.** Contributions to a workplace plan at least up to the level that earns the full employer match.
- **A health savings account,** when the holder is covered by a high-deductible health plan: up to {{param:tax.us.2026.hsa.self_only}} with self-only coverage or {{param:tax.us.2026.hsa.family}} with family coverage, plus {{param:tax.us.2026.hsa.catch_up_age_55}} from age 55[^irs-pub-969].
- **An IRA,** up to {{param:tax.us.2026.retirement.ira_contribution}}, plus {{param:tax.us.2026.retirement.ira_catch_up_age_50}} from age 50[^irs-notice-2025-67].
- **The rest of the workplace plan,** up to the elective deferral limit of {{param:tax.us.2026.retirement.elective_deferral}}, plus a catch-up of {{param:tax.us.2026.retirement.catch_up_age_50}} from age 50, or {{param:tax.us.2026.retirement.catch_up_age_60_to_63}} at ages 60 to 63[^irs-notice-2025-67].
- **A taxable account** for anything beyond.

## Why

Each step is ranked by what a dollar earns there before any market return. An employer match is part of pay: a dollar not contributed up to the match leaves compensation unclaimed. An HSA is deductible going in, grows untaxed, and comes out untaxed when spent on qualified medical costs[^irs-pub-969]. An IRA usually offers a wider and cheaper choice of funds than a workplace plan, and the workplace plan's higher limit then takes what the IRA cannot.

Traditional or Roth is a separate question inside each step: a deduction now and tax later, or tax now and none later. It turns on today's marginal rate against the rate expected in retirement, and the app treats it as a comparison with both costs stated, not a rule. Two limits shape it. Direct Roth IRA contributions phase out across modified AGI of {{param:tax.us.2026.retirement.roth_ira_phase_out.single_or_hoh}} for single filers and {{param:tax.us.2026.retirement.roth_ira_phase_out.mfj}} for joint filers[^irs-pub-590a]. A catch-up contribution by someone whose prior-year FICA wages from that employer exceeded {{param:tax.us.2026.retirement.mandatory_roth_catch_up_wage_threshold}} is made as Roth[^irs-notice-2025-67].

## When it does not apply

- **No match, or a costly plan.** Without a match, or where the workplace plan's funds carry high fees, one common approach fills the IRA before the workplace plan.
- **No high-deductible plan.** An HSA exists only alongside one; whether to choose such a health plan is an insurance decision, outside the playbook.
- **Income above the Roth phase-out.** A direct Roth IRA contribution is not available; other routes exist, with rules (the pro-rata rule among them) worth reviewing with a qualified professional.
- **Money needed soon.** Savings for a near-term goal, such as a house deposit, may belong outside retirement accounts, where an early withdrawal can carry tax and a penalty.
- **Self-employment.** Self-employed plans have their own limits, not covered here.

## Sources

[^irs-notice-2025-67]: IRS, "401(k) limit increases to $24,500 for 2026, IRA limit increases to $7,500", IR-2025-111 / Notice 2025-67, https://www.irs.gov/newsroom/401k-limit-increases-to-24500-for-2026-ira-limit-increases-to-7500 (accessed 2026-10-28).

[^irs-pub-590a]: IRS Publication 590-A, "Contributions to Individual Retirement Arrangements (IRAs)", https://www.irs.gov/publications/p590a (accessed 2026-10-28).

[^irs-pub-969]: IRS Publication 969, "Health Savings Accounts and Other Tax-Favored Health Plans", https://www.irs.gov/publications/p969 (accessed 2026-10-28).
