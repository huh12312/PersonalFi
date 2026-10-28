---
key: claiming-age
title: Social Security claiming-age trade-offs
version: 1
status: draft
sources:
  - id: cfr-404-310
    title: '20 CFR 404.310, "When am I entitled to old-age benefits?"'
    url_or_citation: https://www.govinfo.gov/content/pkg/CFR-2025-title20-vol2/xml/CFR-2025-title20-vol2-sec404-310.xml
    accessed: 2026-10-28
  - id: cfr-404-409
    title: '20 CFR 404.409, "What is full retirement age?"'
    url_or_citation: https://www.govinfo.gov/content/pkg/CFR-2025-title20-vol2/xml/CFR-2025-title20-vol2-sec404-409.xml
    accessed: 2026-10-28
  - id: cfr-404-410
    title: '20 CFR 404.410, "How does SSA reduce my benefits when my entitlement begins before full retirement age?"'
    url_or_citation: https://www.govinfo.gov/content/pkg/CFR-2025-title20-vol2/xml/CFR-2025-title20-vol2-sec404-410.xml
    accessed: 2026-10-28
  - id: cfr-404-313
    title: '20 CFR 404.313, "What are delayed retirement credits and how do they increase my old-age benefit amount?"'
    url_or_citation: https://www.govinfo.gov/content/pkg/CFR-2025-title20-vol2/xml/CFR-2025-title20-vol2-sec404-313.xml
    accessed: 2026-10-28
---

## The rule

Retirement benefits can start at any month from age 62[^cfr-404-310]. Full retirement age is 67 for anyone born in 1960 or later[^cfr-404-409], and each year of waiting beyond it adds {{param:tax.us.2026.social_security.delayed_retirement_credit_per_year}} to the benefit until the credits stop at age 70[^cfr-404-313].

One common approach treats the claiming age as a trade between the size of each check and the number of checks: claiming early takes a smaller benefit for more years, waiting takes a larger one for fewer. PersonalFi's claiming-age finding shows how much larger each payment would be if the plan's claim moved to age 70[^cfr-404-313], and the plan can be projected at any claim age to see the trade in the holder's own figures.

## Why

The early reduction is permanent. For someone whose full retirement age is 67, claiming at 62 lowers the monthly benefit by 30%: five-ninths of one percent for each of the first 36 months before full retirement age, and five-twelfths of one percent for each month beyond that[^cfr-404-410]. The delayed credits are just as permanent in the other direction[^cfr-404-313]. Every benefit then rises each year with the cost-of-living adjustment, most recently {{param:tax.us.2026.social_security.cola}}, so a larger starting benefit is a larger inflation-adjusted income for life.

That is why waiting matters most for whoever lives longest. For a married couple, the higher earner's benefit becomes the survivor's benefit, so the higher earner's claiming age shapes the income of whichever spouse outlives the other. Claiming later is paid for by living on savings, or on wages, in the meantime, and the app states that cost in the same plan.

PersonalFi can also run the plan with benefits cut to {{param:assumptions.social_security_stress.payable_ratio}} of the scheduled amount from {{param:assumptions.social_security_stress.from_calendar_year}}, a stress lever rather than a forecast.

## When it does not apply

- **Health and family history.** With a shorter expected lifespan, an earlier claim can pay more in total.
- **No savings to bridge the gap.** Waiting requires income until the later claim; a plan that cannot fund the wait does not gain from it.
- **Other benefit types.** Spousal, divorced-spouse, survivor and disability benefits, and the earnings test that applies before full retirement age, follow their own rules; the holder's own estimate from the Social Security Administration is the reference.
- **Whether to keep working.** The claiming age is not the retirement age; this page compares claiming ages only.

## Sources

[^cfr-404-310]: 20 CFR 404.310, "When am I entitled to old-age benefits?", https://www.govinfo.gov/content/pkg/CFR-2025-title20-vol2/xml/CFR-2025-title20-vol2-sec404-310.xml (accessed 2026-10-28).

[^cfr-404-409]: 20 CFR 404.409, "What is full retirement age?", https://www.govinfo.gov/content/pkg/CFR-2025-title20-vol2/xml/CFR-2025-title20-vol2-sec404-409.xml (accessed 2026-10-28); Social Security Act §216(l), 42 U.S.C. 416(l), which the parameter store cites for `tax.us.2026.social_security.full_retirement_age`.

[^cfr-404-410]: 20 CFR 404.410, "How does SSA reduce my benefits when my entitlement begins before full retirement age?", https://www.govinfo.gov/content/pkg/CFR-2025-title20-vol2/xml/CFR-2025-title20-vol2-sec404-410.xml (accessed 2026-10-28).

[^cfr-404-313]: 20 CFR 404.313, "What are delayed retirement credits and how do they increase my old-age benefit amount?", https://www.govinfo.gov/content/pkg/CFR-2025-title20-vol2/xml/CFR-2025-title20-vol2-sec404-313.xml (accessed 2026-10-28).
