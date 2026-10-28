---
key: subscription-audit
title: Auditing recurring charges
version: 1
status: draft
sources:
  - id: cfpb-stop-automatic-payments
    title: 'Consumer Financial Protection Bureau, "How do I stop automatic payments from my bank account?"'
    url_or_citation: https://www.consumerfinance.gov/ask-cfpb/how-do-i-stop-automatic-payments-from-my-bank-account-en-2023/
    accessed: 2026-10-28
---

## The rule

One common approach is a periodic subscription audit: list every recurring charge, state each one as a yearly cost, and decide for each whether to keep it, move to a cheaper plan, or end it. The yearly figure matters because a monthly price hides its size; a small monthly charge is twelve of them by the end of the year.

PersonalFi does the listing. It finds the recurring streams in the holder's own transactions, states each one's yearly cost, and flags the changes worth a look: a price that went up, two services of the same kind, and a subscription total that has grown large against income. The decision, and the cancellation itself, are always the holder's.

## Why

Recurring charges are easy to start and easy to forget. A price rise arrives quietly, a trial converts on a date nobody wrote down, and two services that do the same job can run side by side for years. A list with the yearly cost beside each line turns that into a decision the holder can make in minutes.

PersonalFi cannot see whether a service is used: it has transactions, not usage. So it never claims a subscription is unused; whether a service earns its price is the holder's judgement.

Ending a charge is a step the holder takes with the company and, if needed, the bank. The CFPB describes it: tell the company that permission for automatic payments is withdrawn, tell the bank, and follow up in writing; a stop payment order is another option, though banks usually charge for one, and a payment the company takes after permission was withdrawn can be disputed with the bank as an error[^cfpb-stop-automatic-payments]. The app never cancels anything itself.

## When it does not apply

- **Bills that vary.** Utilities, insurance premiums and loan payments recur, but they are bills rather than subscriptions; the budget covers them.
- **Annual plans.** A charge paid once a year is already its own yearly figure; setting money aside for it each month, in a sinking fund, may matter more than the price.
- **Shared or bundled services.** A service paid for someone else, or two services sold as one bundle, are not duplicates, even when the app lists them as two services of the same kind; dismissing the finding says so.
- **Contracts with terms.** A plan with a minimum term or a cancellation fee saves only what is left after the fee, which the app does not know.

## Sources

[^cfpb-stop-automatic-payments]: Consumer Financial Protection Bureau, "How do I stop automatic payments from my bank account?", https://www.consumerfinance.gov/ask-cfpb/how-do-i-stop-automatic-payments-from-my-bank-account-en-2023/ (accessed 2026-10-28).
