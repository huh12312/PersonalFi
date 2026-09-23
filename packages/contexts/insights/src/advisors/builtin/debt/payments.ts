// SPDX-License-Identifier: MIT
/**
 * **D3 — paying the minimum, month after month** and **D6 — a due date that
 * passed with no payment behind it.**
 *
 * ## The sentence D3 cannot write, and what it writes instead
 *
 * 07 §3.3 D3 reads *"Paying the minimum on {card}, this balance takes {years}
 * years and ${int} interest."* Both numerals come from an amortisation — a loop
 * over months, each one's interest depending on the last one's balance. The
 * derivation grammar is `+ - * /` over snapshot refs with parentheses and a
 * closed literal set (`derivations.ts`), and that is deliberate: it exists so
 * the validator can *re-compute* every claim rather than trust it. A loop is
 * not expressible in it, so `{years}` and `${int}` are numerals nothing could
 * account for, and step 7 would reject the insight — correctly.
 *
 * This is the same wall `rules-cash.ts` hit with C3 and C7, resolved the same
 * way: the rule states **the observation** — how many recent months went out at
 * the minimum, on what balance, at what rate — in figures that are all snapshot
 * values, claims no impact, and ranks on severity. What a payoff projection
 * would need is a second mechanism (a declared schedule the validator can
 * replay), and that is named in the evidence doc rather than smuggled in here.
 *
 * ## D6 and the difference between "no payment" and "no payment *yet*"
 *
 * D6 fires only when a due date is **in the past** and the last payment on
 * record predates it. A liability with no due date produces nothing: no due
 * date means the app does not know when the payment was expected, and a rule
 * that treated "unknown" as "missed" would cry wolf on every manually-entered
 * loan. `payment_due_date === null` is a silence, not an alarm.
 */
import type { Insight } from '../../../contract/response.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  daysBetween,
  formatMoneyJson,
  formatPercent,
  insightOf,
  metric,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { liabilityRef } from '../shared.ts';
import { kindLabel } from './labels.ts';

/** 07 §3.3 D3: minimum-only payments detected for three months or more. */
const MINIMUM_ONLY_MONTHS = 3;

export const debtMinimumOnly: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.debt.minimum_only',
    displayName: 'Paying the minimum, month after month',
    purpose:
      'Reports a liability whose recent payments have all been at the minimum, with the ' +
      'balance and rate that combination is running against.',
    scopes: ['liabilities.terms'],
    maxSeverity: 'warning',
    producesImpact: false,
    maxInsights: 8,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const liabilities = context.snapshot.liabilities_terms?.liabilities ?? [];
    if (liabilities.length === 0) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    for (const [index, liability] of liabilities.entries()) {
      const months = liability.minimum_only_months;
      if (months === null || months < MINIMUM_ONLY_MONTHS) continue;
      if (BigInt(liability.current_balance.minor) <= 0n) continue;

      const balanceText = formatMoneyJson(liability.current_balance);
      if (balanceText === null) continue;
      const monthsText = String(months);
      const apr = liability.apr;
      const aprText = apr === null ? null : formatPercent(apr);
      const minimum = liability.minimum_payment;
      const minimumText = minimum === null ? null : formatMoneyJson(minimum);

      insights.push(
        insightOf({
          key: `debt.minimum_only.${liability.liability_ref}`,
          period: context.period,
          type: 'debt.minimum_only',
          severity: 'warning',
          title: 'Recent payments have all been the minimum',
          summary:
            `The last ${monthsText} payments on a ${kindLabel(liability.kind)} went out at ` +
            `the minimum, against a balance of ${balanceText}` +
            (aprText === null ? '' : ` carrying ${aprText}`) +
            (minimumText === null ? '' : ` with a minimum of ${minimumText}`) +
            '. A minimum is sized to keep the account current, not to clear the balance.',
          confidence: 1,
          horizon: 'this_year',
          basis:
            'A count of recent months and the balance behind them. No payoff time or interest ' +
            'total is claimed: that needs a month-by-month schedule this app cannot show you ' +
            'the working for.',
          evidence: [
            metric('The balance', liabilityRef(index, 'current_balance'), balanceText),
            metric(
              'Recent months paid at the minimum',
              liabilityRef(index, 'minimum_only_months'),
              monthsText,
            ),
            ...(apr === null ? [] : [metric('The rate', liabilityRef(index, 'apr'), null)]),
            ...(minimum === null || minimumText === null
              ? []
              : [
                  metric(
                    'What the minimum is',
                    liabilityRef(index, 'minimum_payment'),
                    minimumText,
                  ),
                ]),
          ],
          actions: [
            suggest(
              'Set a higher standing payment',
              'Anything above the minimum comes off the principal, and the difference compounds ' +
                'in your favour rather than the lender’s.',
            ),
          ],
          caveats: [
            'A minimum-only stretch is not in itself a problem. It becomes one when the rate is ' +
              'high and the balance is not moving.',
          ],
        }),
      );
    }

    return { insights, warnings: [] };
  },
};

export const debtMissedPayment: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.debt.missed_payment',
    displayName: 'A due date passed with no payment behind it',
    purpose:
      'Reports a liability whose payment due date has passed while the last payment on record ' +
      'predates that date.',
    scopes: ['liabilities.terms'],
    maxSeverity: 'warning',
    producesImpact: false,
    maxInsights: 8,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const liabilities = context.snapshot.liabilities_terms?.liabilities ?? [];
    if (liabilities.length === 0) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    for (const [index, liability] of liabilities.entries()) {
      const due = liability.payment_due_date;
      // No due date is a silence, not an alarm. See the header.
      if (due === null) continue;
      const overdue = daysBetween(due, context.today);
      if (overdue === null || overdue <= 0) continue;
      if (BigInt(liability.current_balance.minor) <= 0n) continue;

      const last = liability.last_payment_date;
      if (last !== null && last >= due) continue;

      const balanceText = formatMoneyJson(liability.current_balance);
      if (balanceText === null) continue;

      insights.push(
        insightOf({
          key: `debt.missed_payment.${liability.liability_ref}`,
          period: context.period,
          type: 'debt.missed_payment',
          severity: 'warning',
          title: 'A payment date has passed with nothing recorded against it',
          summary:
            `A ${kindLabel(liability.kind)} carrying ${balanceText} was due on ${due}, and ` +
            (last === null
              ? 'this app has no payment on record for it at all.'
              : `the most recent payment it can see is from ${last}.`) +
            ' A late payment costs a fee and, separately and for longer, a mark on your credit ' +
            'file.',
          confidence: last === null ? 0.7 : 0.9,
          horizon: 'immediate',
          basis:
            'A due date in the past with no later payment on record. No figure is claimed for ' +
            'a late fee: this app does not know what the lender charges.',
          evidence: [
            metric('The balance', liabilityRef(index, 'current_balance'), balanceText),
            metric('When it was due', liabilityRef(index, 'payment_due_date'), due),
            ...(last === null
              ? []
              : [
                  metric(
                    'The last payment on record',
                    liabilityRef(index, 'last_payment_date'),
                    last,
                  ),
                ]),
          ],
          actions: [
            suggest(
              'Check the account directly',
              'A payment made outside a linked account, or one that has not synced yet, looks ' +
                'exactly like this. The lender’s own record is the one that counts.',
            ),
          ],
          caveats: [
            'This app only sees payments that reached it. A payment made elsewhere, or one that ' +
              'has not synced, produces this message wrongly.',
          ],
        }),
      );
    }

    return { insights, warnings: [] };
  },
};
