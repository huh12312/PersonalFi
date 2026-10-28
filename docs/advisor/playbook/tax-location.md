---
key: tax-location
title: Which holdings sit in which kind of account
version: 1
status: draft
sources:
  - id: irs-topic-403
    title: 'IRS Tax Topic 403, "Interest received"'
    url_or_citation: https://www.irs.gov/taxtopics/tc403
    accessed: 2026-10-28
  - id: irs-topic-404
    title: 'IRS Tax Topic 404, "Dividends and other corporate distributions"'
    url_or_citation: https://www.irs.gov/taxtopics/tc404
    accessed: 2026-10-28
  - id: irs-topic-409
    title: 'IRS Tax Topic 409, "Capital gains and losses"'
    url_or_citation: https://www.irs.gov/taxtopics/tc409
    accessed: 2026-10-28
  - id: irs-topic-559
    title: 'IRS Tax Topic 559, "Net investment income tax"'
    url_or_citation: https://www.irs.gov/taxtopics/tc559
    accessed: 2026-10-28
---

## The rule

When a household holds both taxable and tax-advantaged accounts, one common approach places the holdings whose returns are taxed most heavily each year in the tax-advantaged accounts, and the holdings taxed most lightly in the taxable account. Taxable bond funds, real estate investment trusts and funds that distribute large gains are the usual candidates for the tax-advantaged side; broad index equity funds, whose dividends are mostly qualified and whose gains are mostly unrealized, are the usual candidates for the taxable side.

The household's target mix does not change. Only where each part of it sits changes.

## Why

The three kinds of return are taxed differently. Interest is taxable income in the year it becomes available[^irs-topic-403]. Ordinary dividends are taxed as ordinary income, while qualified dividends are taxed at the lower capital gain rates[^irs-topic-404]. A capital gain is taxed only when it is realized, and at the lower long-term rates once the holding has been kept more than a year[^irs-topic-409]. Above modified AGI of {{param:tax.us.2026.income_tax.net_investment_income_tax.threshold.single}} for a single filer or {{param:tax.us.2026.income_tax.net_investment_income_tax.threshold.mfj}} for joint filers, a further {{param:tax.us.2026.income_tax.net_investment_income_tax.rate}} applies to net investment income[^irs-topic-559].

So a bond fund in a taxable account loses part of its return to tax every year, while an index equity fund in the same account defers most of its tax until a sale the holder chooses the timing of. Swapping their places leaves the mix as it was and lowers the household's yearly tax.

## When it does not apply

- **One kind of account.** If everything fits in tax-advantaged accounts, or everything is taxable, there is nothing to place.
- **Tax-exempt bonds.** Interest on bonds issued by a state, the District of Columbia or a U.S. territory is reportable but not taxable at the federal level[^irs-topic-403]; such bonds gain nothing from a tax-advantaged account.
- **Fixing it costs more than it saves.** Moving existing holdings can realize gains in the taxable account. One common approach corrects placement through new money and through exchanges inside tax-advantaged accounts only, and leaves taxable holdings with large gains in place.
- **Money needed early.** The taxable account may need to hold what the household could need before retirement-account withdrawals are possible without a penalty, whatever its tax treatment.
- **Not a filing position.** This is a general placement rule; how any one return is reported is a tax filing question, outside the playbook.

## Sources

[^irs-topic-403]: IRS Tax Topic 403, "Interest received", https://www.irs.gov/taxtopics/tc403 (accessed 2026-10-28).

[^irs-topic-404]: IRS Tax Topic 404, "Dividends and other corporate distributions", https://www.irs.gov/taxtopics/tc404 (accessed 2026-10-28).

[^irs-topic-409]: IRS Tax Topic 409, "Capital gains and losses", https://www.irs.gov/taxtopics/tc409 (accessed 2026-10-28).

[^irs-topic-559]: IRS Tax Topic 559, "Net investment income tax", https://www.irs.gov/taxtopics/tc559 (accessed 2026-10-28).
