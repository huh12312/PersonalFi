<!-- SPDX-License-Identifier: MIT -->

# The advisor's playbook

One short page per topic: the general rule, why it holds, when it does not apply, and its sources. These pages are the advisor's knowledge of _rules_. The figures they rest on (limits, rates, ages) come from the parameter store, never from a page and never from a model's memory. The design is in [12 §2.2](../../research/12-ask-personalfi-advisor-expansion.md). These are reviewed general rules, not personal advice: the advisor applies them to the holder's own numbers, which the deterministic engines compute.

| Page                                                        | Topic                                            |
| ----------------------------------------------------------- | ------------------------------------------------ |
| [emergency-fund](emergency-fund.md)                         | Sizing and keeping an emergency fund             |
| [debt-order](debt-order.md)                                 | The order to pay debts down                      |
| [tax-advantaged-order](tax-advantaged-order.md)             | The order of operations for tax-advantaged space |
| [rebalancing-with-new-money](rebalancing-with-new-money.md) | Rebalancing with contributions before trades     |
| [tax-location](tax-location.md)                             | Which holdings sit in which kind of account      |
| [claiming-age](claiming-age.md)                             | Social Security claiming-age trade-offs          |
| [guardrail-withdrawal](guardrail-withdrawal.md)             | Guardrail withdrawals in retirement              |
| [subscription-audit](subscription-audit.md)                 | Auditing recurring charges                       |

## The format

Each page is a markdown file named `<key>.md`, with frontmatter and then exactly four sections:

```markdown
---
key: debt-order
title: The order to pay debts down
version: 1
status: draft
sources:
  - id: cfpb-reduce-debt
    title: 'Consumer Financial Protection Bureau, "How to reduce your debt"'
    url_or_citation: https://www.consumerfinance.gov/about-us/blog/how-reduce-your-debt/
    accessed: 2026-10-28
---

## The rule

## Why

## When it does not apply

## Sources

[^cfpb-reduce-debt]: Consumer Financial Protection Bureau, "How to reduce your debt", …
```

- **`sources`** are primary sources: IRS notices and publications, SSA, the CFR and the statutes, the Federal Reserve, the FDIC, the CFPB, FINRA, and journal articles for the withdrawal research. A secondary pointer (the Bogleheads wiki) may sit beside a primary source but is never the only source for a number. No blogs, and no vendor marketing. `accessed` is the date the drafter last checked the source. For a URL, that means the page was fetched. For a printed citation (a statute, a regulation, a journal article), it means the citation was confirmed against the publication's own reference or the repository's cited parameter store.
- **Every number is cited.** A figure the parameter store holds is written as a placeholder, `{{param:tax.us.2026.retirement.ira_contribution}}`. It is rendered from the store when the page is read, so the page never types a limit. Any other numeral must sit in a sentence that carries a source marker, `[^id]`, naming one of the frontmatter sources. The same applies to a figure spelled out with a scale or currency word ("two thousand dollars"). The generator refuses a page that breaks this.
- **The language rules** are the app's own (07 §7.2, the insight copy linter): "consider", "one common approach", the cost beside the recommendation. A page never says "you should", "must" or "guaranteed", and never opens a sentence with an instruction. Out of scope on every page: security selection, market timing, tax filing, insurance and estate planning (12 §1).
- **Length**: 150–600 words across the first three sections. The target is 250–450.

The parameter keys are listed by `parameterCatalogue()` in `packages/contexts/planning/src/parameters.ts`. A key names its tax year (`tax.us.2026.…`). A page moves to a new year by an edit and a version bump, once the store holds that year. A key for a year the store does not hold is refused, never substituted.

## The review gate

A page is `status: draft` until Chris has read it. **Nothing in a draft page reaches a model.** The knowledge base (`packages/contexts/insights/src/knowledge/playbook.ts`) refuses any page that is not `reviewed`, with the error `playbook.unreviewed`. The generator refuses a `reviewed` page that lacks any of the three review fields.

To mark a page reviewed, after reading it:

1. Run `pnpm run playbook -- --digest` and copy the page's digest.
2. In the page's frontmatter, set:

   ```yaml
   status: reviewed
   reviewed_by: Chris
   reviewed_on: 2026-11-02
   reviewed_digest: sha256:…
   ```

3. Run `pnpm run playbook`. It regenerates `packages/contexts/insights/data/playbook.ts`. Commit both files.

`reviewed_digest` records the exact body that was reviewed. If the body changes afterwards, the generator refuses the page until it goes back to review.

## Changing a page and bumping its version

Any change to a page's body (its four sections) after it has been reviewed is a new version:

1. Edit the body.
2. Increase `version` by one.
3. Set `status: draft` and remove `reviewed_by`, `reviewed_on` and `reviewed_digest`.
4. Run `pnpm run playbook`.

The page is then out of the advisor's reach until it is reviewed again. A narration records the version and digest of every page it was sent. An old narration therefore always names the text it read.

A frontmatter-only change (a source's `accessed` date, the title) does not move the digest. It still needs `pnpm run playbook`.

## The drift check

`packages/contexts/insights/data/playbook.ts` is generated, and the api reads only that module; the image ships no `docs/`. `pnpm run playbook -- --check` (also `just playbook-check`) fails when the module differs from what the markdown generates. CI runs it in the lint job.
