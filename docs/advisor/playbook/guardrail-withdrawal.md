---
key: guardrail-withdrawal
title: Guardrail withdrawals in retirement
version: 1
status: draft
sources:
  - id: guyton-klinger-2006
    title: 'Jonathan T. Guyton and William J. Klinger, "Decision Rules and Maximum Initial Withdrawal Rates", Journal of Financial Planning, March 2006'
    url_or_citation: Journal of Financial Planning, March 2006
    accessed: 2026-10-28
  - id: bengen-1994
    title: 'William P. Bengen, "Determining Withdrawal Rates Using Historical Data", Journal of Financial Planning, October 1994'
    url_or_citation: Journal of Financial Planning, October 1994
    accessed: 2026-10-28
---

## The rule

Instead of a fixed withdrawal raised with inflation every year, one common approach in retirement sets a starting withdrawal rate and adjusts spending only when the portfolio has moved far from the plan. These are the Guyton-Klinger guardrails. PersonalFi draws the band around a reference rate of {{param:assumptions.withdrawal_policy.guardrail_reference_rate}}, which the holder can change.

Each year the current withdrawal rate is compared with the starting rate. When it has risen more than 20% above it, that year's withdrawal is cut by 10%; when it has fallen more than 20% below it, the withdrawal is raised by 10%[^guyton-klinger-2006]. In other years the withdrawal rises with inflation, except that the increase is skipped after a year of negative returns while the rate is above its start[^guyton-klinger-2006].

## Why

A fixed withdrawal ignores what the market has done. The classic study of US returns found that an initial withdrawal of 4%, raised with inflation each year, lasted at least 30 years in every historical period it tested with a mix of stocks and bonds[^bengen-1994]. That figure is a worst case under specific assumptions (a single country's history, a fixed mix, no fees and no taxes), not a law.

Guardrails trade some variability in spending for a higher starting rate: in the authors' tests, starting rates above the fixed-withdrawal figure held up with comparable failure rates because spending gave way a little in bad years[^guyton-klinger-2006][^bengen-1994]. The cost is the cuts themselves. In a long downturn they can repeat, and repeated cuts add up to a large fall in spending. PersonalFi's plan therefore adds a spending floor at the household's essential spending and a cap on the total cut, and reports how deep the cuts go in a bad market path beside the plan's success rate, because a plan that succeeds by halving spending has not succeeded.

## When it does not apply

- **Before retirement.** Guardrails govern withdrawals, not saving.
- **Spending that cannot fall.** If essential spending is already the whole withdrawal, there is nothing for a cut to come from; the guardrails then act only on discretionary spending above the floor.
- **Income that covers spending.** When Social Security or a pension covers spending, there is no portfolio withdrawal and no rate to guard.
- **Required minimum distributions.** A required distribution can exceed the guardrail amount; the distribution is required, and what is spent from it is a separate decision.
- **Near the end of the plan.** The authors drop the cut rule in the final 15 years of a plan[^guyton-klinger-2006], when a cut protects less of the future than it costs in the present.
- **Annuities and insurance.** Lifetime-income products are outside the playbook.

## Sources

[^guyton-klinger-2006]: Jonathan T. Guyton and William J. Klinger, "Decision Rules and Maximum Initial Withdrawal Rates", Journal of Financial Planning, March 2006 (accessed 2026-10-28: the citation, and the rules as PersonalFi's engine encodes them in `packages/contexts/planning/src/engine/guardrails.ts`).

[^bengen-1994]: William P. Bengen, "Determining Withdrawal Rates Using Historical Data", Journal of Financial Planning, October 1994 (accessed 2026-10-28: the citation, as 07 §5.6 states its finding).
