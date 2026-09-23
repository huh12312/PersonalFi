// SPDX-License-Identifier: MIT
/**
 * **D1 — two ways to order a payoff** and **D5 — a certain return against an
 * uncertain one.** The two rules in this family whose 07 §3.3 form asks for a
 * number this app is not able to defend, and which therefore say the true part.
 *
 * ## D1 without the amortisation
 *
 * 07's D1 is *"Avalanche pays off in {m_a} months for ${i_a} interest;
 * snowball takes {m_s} for ${i_s}. Avalanche saves ${d}."* Four of those five
 * numerals come from running a repayment schedule month by month, and the
 * derivation grammar cannot express a loop — by design, because its whole
 * purpose is that the validator re-computes every claim rather than trusting
 * it (see `payments.ts`'s header for the same wall under D3).
 *
 * What is left, and it is not nothing, is the **ordering fact**: which balance
 * carries the highest rate and which is smallest, both cited, with the
 * trade-off between the two orderings stated in words. That is the decision the
 * user actually makes. The figures that would rank the two orderings against
 * each other are owed to a payoff-schedule mechanism, named in the evidence doc.
 *
 * ## D5 states one return and refuses to state the other
 *
 * 07's D5 compares extra principal (`a guaranteed {apr}%`) with an expected
 * portfolio return (`{r}% with risk`). The first is an observed term of a
 * contract. The second is a forecast, and 07 §3.2 forbids compounding one into
 * a headline; there is also no assumptions source in any scope this work
 * package was given. So D5 states the certain side, names the uncertain side as
 * uncertain, and claims no impact — which is exactly "show both paths" minus
 * the number nobody can stand behind.
 *
 * It fires only when a **cushion already exists**. Extra principal out of an
 * emergency fund is not a trade-off, it is a worse position, and 07's D5
 * trigger says "extra cash available" for that reason.
 */
import type { Insight } from '../../../contract/response.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  formatMinor,
  formatMoneyJson,
  formatPercent,
  insightOf,
  metric,
  snapshotRef,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { liabilityRef, productOf } from '../shared.ts';
import { kindLabel } from './labels.ts';

/** 07 §3.3 D5's "extra cash available": a cushion past the usual guidance. */
const COMFORTABLE_CUSHION_MONTHS = 6;

export const debtPayoffOrder: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.debt.payoff_order',
    displayName: 'Two ways to order a payoff',
    purpose:
      'When more than one balance carries a rate, names the highest-rate balance and the ' +
      'smallest one, and states what each ordering optimises for.',
    scopes: ['liabilities.terms'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const liabilities = context.snapshot.liabilities_terms?.liabilities ?? [];
    const rated = liabilities
      .map((liability, index) => ({ liability, index }))
      .filter(
        (row) => row.liability.apr !== null && BigInt(row.liability.current_balance.minor) > 0n,
      );
    if (rated.length < 2) return { insights: [], warnings: [] };

    // First by position on a tie, so two runs over one snapshot cite the same
    // pair and the insight is an upsert rather than a new row every night.
    const highest = rated.reduce((best, row) =>
      (row.liability.apr ?? 0) > (best.liability.apr ?? 0) ? row : best,
    );
    const smallest = rated.reduce((best, row) =>
      BigInt(row.liability.current_balance.minor) < BigInt(best.liability.current_balance.minor)
        ? row
        : best,
    );

    const highestApr = formatPercent(highest.liability.apr ?? 0);
    const highestBalance = formatMoneyJson(highest.liability.current_balance);
    const smallestBalance = formatMoneyJson(smallest.liability.current_balance);
    const smallestApr = formatPercent(smallest.liability.apr ?? 0);
    if (
      highestApr === null ||
      highestBalance === null ||
      smallestBalance === null ||
      smallestApr === null
    ) {
      return { insights: [], warnings: [] };
    }

    const sameRow = highest.index === smallest.index;

    return {
      insights: [
        insightOf({
          key: 'debt.payoff_order',
          period: context.period,
          type: 'debt.payoff_order',
          severity: 'notable',
          title: 'More than one balance is carrying a rate',
          summary:
            `The highest rate you carry is ${highestApr}, on a ` +
            `${kindLabel(highest.liability.kind)} balance of ${highestBalance}. ` +
            (sameRow
              ? 'That is also the smallest balance you carry, so both orderings point at the ' +
                'same account.'
              : `The smallest balance is ${smallestBalance}, on a ` +
                `${kindLabel(smallest.liability.kind)} at ${smallestApr}. ` +
                'Clearing the highest rate first costs less in interest overall; clearing the ' +
                'smallest first closes an account sooner, which some people find easier to ' +
                'keep up.'),
          confidence: 1,
          horizon: 'this_year',
          basis:
            'The rates and balances themselves. Neither ordering is costed: that needs a ' +
            'month-by-month repayment schedule, and this app shows its working or says nothing.',
          evidence: [
            metric('The highest rate you carry', liabilityRef(highest.index, 'apr'), null),
            metric(
              'The balance behind it',
              liabilityRef(highest.index, 'current_balance'),
              highestBalance,
            ),
            metric(
              'The smallest balance you carry',
              liabilityRef(smallest.index, 'current_balance'),
              smallestBalance,
            ),
            metric('The rate on that one', liabilityRef(smallest.index, 'apr'), null),
          ],
          actions: [
            suggest(
              'Compare the two orderings',
              'The difference between them is interest against momentum. Both clear the debt; ' +
                'one costs less and the other feels faster.',
            ),
          ],
          caveats: [
            'No payoff time or interest total is shown here. This app states a figure only when ' +
              'it can show the arithmetic behind it, and a repayment schedule is not arithmetic ' +
              'it can show.',
          ],
        }),
      ],
      warnings: [],
    };
  },
};

export const debtPrincipalAgainstMarket: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.debt.principal_against_market',
    displayName: 'A certain return against an uncertain one',
    purpose:
      'When a cash cushion is already comfortable, states what extra principal on a loan ' +
      'returns with certainty, and why the market comparison is not quantified.',
    // `cashflow.monthly` as well as `cash.summary`: the builder leaves
    // `emergency_fund_months` null unless it has a monthly expense figure to
    // divide by, and that is the field this rule's whole trigger rests on.
    // `catalog.test.ts` catches an under-declared manifest by building a
    // snapshot from only the declared scopes — which is how this one was found.
    scopes: ['liabilities.terms', 'cash.summary', 'cashflow.monthly'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 4,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const cash = snapshot.cash_summary;
    const liabilities = snapshot.liabilities_terms?.liabilities ?? [];
    if (cash === undefined || cash.emergency_fund_months === null) {
      return { insights: [], warnings: [] };
    }
    if (cash.emergency_fund_months <= COMFORTABLE_CUSHION_MONTHS) {
      return { insights: [], warnings: [] };
    }

    const cashText = formatMoneyJson(cash.total);
    if (cashText === null) return { insights: [], warnings: [] };
    const monthsText = String(cash.emergency_fund_months);

    const insights: Insight[] = [];
    for (const [index, liability] of liabilities.entries()) {
      const apr = liability.apr;
      if (apr === null || apr <= 0) continue;
      if (BigInt(liability.current_balance.minor) <= 0n) continue;

      const interest = productOf(
        snapshot,
        'interest_over_a_year',
        liabilityRef(index, 'current_balance.minor'),
        liabilityRef(index, 'apr'),
        'This balance at its own rate, for a year, with nothing assumed about repayment.',
      );
      if (interest === null) continue;

      const aprText = formatPercent(apr);
      const balanceText = formatMoneyJson(liability.current_balance);
      const interestText = formatMinor(interest.value);
      if (aprText === null || balanceText === null || interestText === null) continue;

      insights.push(
        insightOf({
          key: `debt.principal_against_market.${liability.liability_ref}`,
          period: context.period,
          type: 'debt.principal_against_market',
          severity: 'notable',
          title: 'A certain return sits next to an uncertain one',
          summary:
            `You hold ${cashText} in cash, about ${monthsText} months of recent spending, ` +
            `while a ${kindLabel(liability.kind)} balance of ${balanceText} carries ` +
            `${aprText} — roughly ${interestText} of interest over a year at that rate. ` +
            'Principal put against that balance earns the rate itself, with certainty. What ' +
            'the same money might do in markets is not a figure this app holds, and it is not ' +
            'going to estimate one.',
          confidence: 1,
          horizon: 'this_year',
          basis:
            'The balance at its own rate over a year. The market side of the comparison is ' +
            'deliberately absent: it would be a forecast, not a measurement.',
          derivationId: interest.derivation.id,
          derivations: [interest.derivation],
          evidence: [
            metric('Cash held', snapshotRef('cash_summary.total'), cashText),
            metric(
              'Months of cover',
              snapshotRef('cash_summary.emergency_fund_months'),
              monthsText,
            ),
            metric('The balance', liabilityRef(index, 'current_balance'), balanceText),
            metric('The rate it carries', liabilityRef(index, 'apr'), null),
          ],
          actions: [
            suggest(
              'Weigh the two sides',
              'A rate paid is certain and a return earned is not. That asymmetry is the whole ' +
                'of the comparison.',
            ),
          ],
          caveats: [
            'The interest figure assumes the balance stays where it is for a year. Every ' +
              'payment reduces it.',
            'Cash set aside for something specific is still counted in the total above.',
          ],
        }),
      );
    }

    return { insights, warnings: [] };
  },
};
