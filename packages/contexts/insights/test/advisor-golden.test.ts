// SPDX-License-Identifier: MIT
/**
 * Per-rule golden tests: each rule fires on the seed case it was designed for,
 * says the sentence we expect it to say, and is silent on the control.
 *
 * The control half is the half that catches things. "It fires" is easy to
 * satisfy by accident — a threshold inverted, an `&&` that should be an `||`,
 * a window that is always true — and every one of those bugs produces a rule
 * that fires on the healthy case too. So each assertion below is a pair.
 *
 * The expected sentences are written out in full rather than matched loosely.
 * A rule's copy is the product; a snapshot test of it means a reviewer sees the
 * exact words change in a diff, which is the only review that catches "would
 * have earned" quietly becoming "will earn" (07 §7.2's banned list) or a figure
 * silently gaining a digit.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { BUILTIN_CATALOGUE } from '../src/advisors/catalogue.ts';
import type { AdvisorSnapshot } from '../src/contract/snapshot.ts';
import { TODAY, USD, seedSnapshot, type SeedCase } from './advisors/seed.ts';

function evaluate(ruleId: string, snapshot: AdvisorSnapshot) {
  const entry = BUILTIN_CATALOGUE.find((item) => item.ruleId === ruleId);
  if (entry === undefined) throw new Error(`no rule ${ruleId}`);
  return entry.rule.evaluate({ snapshot, today: TODAY, period: '2026-09', baseCurrency: USD });
}

interface Golden {
  readonly ruleId: string;
  readonly seedCase: SeedCase;
  /** Every key the rule should produce on that case, in order. */
  readonly keys: readonly string[];
  /** The sentence the first insight should carry, exactly. */
  readonly summary: string;
  readonly severity: string;
  /** `null` when the rule claims no dollar figure. Minor units. */
  readonly annualized: string | null;
  readonly oneTime?: string | null;
}

const GOLDEN: readonly Golden[] = [
  {
    ruleId: 'U2',
    seedCase: 'drift',
    keys: ['subscription.price_increase.MERCHANT_6fbb93c8e9d3.2026-06-01'],
    summary: 'A subscription went from $15.99 to $18.99 on 2026-06-01 — about $36.00 more a year.',
    severity: 'notable',
    annualized: '3600',
  },
  {
    ruleId: 'U3',
    seedCase: 'drift',
    keys: ['subscription.duplicate_service.entertainment.streaming'],
    summary:
      'You have two entertainment.streaming subscriptions running at once. ' +
      'Keeping only the cheapest would free about $227.88 a year.',
    severity: 'notable',
    annualized: '22788',
  },
  {
    ruleId: 'U7',
    seedCase: 'drift',
    keys: ['subscription.share_of_income'],
    summary: 'Your subscriptions come to about $632.98 a month. Income in 2026-08 was $5,400.00.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'C1',
    seedCase: 'drift',
    keys: ['cash.idle_above_cushion'],
    // WP 3.10: the sentence C1 has been withholding since Phase 2. The rate is
    // a dated FRED observation from `market.rates`, not a constant.
    summary:
      'About $21,701.67 more than three months of recent spending is held in cash, ' +
      'earning 0.81% across those accounts. A published rate for cash was 4.25% ' +
      'on 2026-09-15.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'C2',
    seedCase: 'drift',
    keys: ['cash.yield_spread.acct-checking'],
    // WP 3.10: the benchmark is now the published rate rather than the best
    // account the user already holds. The arithmetic and the key are unchanged;
    // with no `market.rates` block the rule falls back to the Phase 2 sentence.
    summary:
      'One account holds $21,235.00 at 0%, while a published rate was 4.25% on ' +
      '2026-09-15. At that rate the same balance would have earned about $902.49 ' +
      'over a year.',
    severity: 'warning',
    annualized: '90249',
  },
  {
    ruleId: 'C3',
    seedCase: 'tight',
    keys: ['cash.projected_shortfall'],
    summary:
      'Recurring charges of about $2,250.00 fall due in the next two weeks, ' +
      'and your cash accounts hold $1,884.20 today.',
    severity: 'urgent',
    annualized: null,
  },
  {
    ruleId: 'C4',
    seedCase: 'tight',
    keys: ['cash.emergency_fund_short'],
    summary:
      'Cash on hand covers about 0.6 months of recent spending. ' +
      'A cushion of three to six months is the usual guidance.',
    severity: 'warning',
    annualized: null,
  },
  {
    ruleId: 'C7',
    seedCase: 'tight',
    keys: ['cash.large_bill_due.series-rent', 'cash.large_bill_due.series-power'],
    summary:
      'A recurring charge of about $1,450.00 is due on 2026-09-24, ' +
      'and your cash accounts hold $1,884.20.',
    severity: 'warning',
    annualized: null,
  },
  {
    ruleId: 'S2',
    seedCase: 'drift',
    keys: ['spending.category_creep.dining.restaurants'],
    summary:
      'dining.restaurants has run about $450.00 a month lately, against $262.50 a month ' +
      'across the trailing year — about $2,250.00 a year at the new pace.',
    severity: 'notable',
    annualized: '225000',
  },
  {
    ruleId: 'S3',
    seedCase: 'drift',
    keys: ['spending.uncategorised'],
    summary:
      'Some recent transactions have not been categorised, so budgets and these insights ' +
      'are incomplete until they are. The evidence panel lists them.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'S6',
    seedCase: 'drift',
    keys: ['spending.duplicate_charge.txn-market-first.txn-market-second'],
    summary:
      'Two outgoing charges at the same merchant landed on 2026-09-04 and 2026-09-06, ' +
      'both in the 50-200 band.',
    severity: 'urgent',
    annualized: null,
  },
  {
    ruleId: 'S7',
    seedCase: 'drift',
    keys: ['spending.fees'],
    summary:
      'Bank, card and ATM charges came to about $184.00 across the last year of transactions.',
    severity: 'warning',
    annualized: '18400',
  },
  {
    ruleId: 'S9',
    seedCase: 'drift',
    keys: ['spending.negative_month.2026-08'],
    summary: 'In 2026-08, spending ran about $700.00 ahead of income.',
    severity: 'warning',
    annualized: null,
    oneTime: '70000',
  },
  {
    ruleId: 'S10',
    seedCase: 'drift',
    keys: ['spending.annual_bills_ahead'],
    summary:
      'About $7,650.00 of yearly and half-yearly bills fall due in the next three months, ' +
      'which is large next to a normal month of spending.',
    severity: 'notable',
    annualized: null,
  },
  // --- WP 3.10. Every summary below is the exact sentence the rule emits on
  // the `drift` case; the control case has no portfolio, liabilities or rates
  // block at all, so each of these is also asserted silent there. 07 §7.2's
  // banned list is what makes writing them out in full worth the space: a
  // reviewer sees 'would have earned' become 'will earn' in a diff. ------
  {
    ruleId: 'D1',
    seedCase: 'drift',
    keys: ['debt.payoff_order'],
    summary:
      'The highest rate you carry is 23.99%, on a credit card balance of $4,820.00. The ' +
      'smallest balance is $3,100.00, on a credit card at 18.99%. Clearing the highest rate ' +
      'first costs less in interest overall; clearing the smallest first closes an account ' +
      'sooner, which some people find easier to keep up.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'D2',
    seedCase: 'drift',
    keys: ['debt.rate_above_market.LIAB_a1b2c3d4e5f6', 'debt.rate_above_market.LIAB_c3d4e5f6a1b2'],
    summary:
      'A credit card balance of $4,820.00 carries 23.99%, while the TERMCBCCALLNS series was ' +
      '21.24% on 2026-09-01. On this balance the difference is about $132.55 a year. Any ' +
      'transfer or refinance fee comes out of that, and this app does not know what one would ' +
      'be.',
    severity: 'warning',
    annualized: '13255',
  },
  {
    ruleId: 'D3',
    seedCase: 'drift',
    keys: ['debt.minimum_only.LIAB_a1b2c3d4e5f6'],
    summary:
      'The last 5 payments on a credit card went out at the minimum, against a balance of ' +
      '$4,820.00 carrying 23.99% with a minimum of $145.00. A minimum is sized to keep the ' +
      'account current, not to clear the balance.',
    severity: 'warning',
    annualized: null,
  },
  {
    ruleId: 'D4',
    seedCase: 'drift',
    keys: ['debt.promo_ending.LIAB_b2c3d4e5f6a1'],
    summary:
      'The promotional rate on a credit card ends on 2026-11-20 with $3,100.00 still owing. ' +
      'At that point the balance carries 18.99%, which is about $588.69 a year on what is ' +
      'left of it.',
    severity: 'warning',
    annualized: '58869',
  },
  {
    ruleId: 'D5',
    seedCase: 'drift',
    keys: [
      'debt.principal_against_market.LIAB_a1b2c3d4e5f6',
      'debt.principal_against_market.LIAB_b2c3d4e5f6a1',
      'debt.principal_against_market.LIAB_c3d4e5f6a1b2',
    ],
    summary:
      'You hold $26,235.00 in cash, about 6.9 months of recent spending, while a credit card ' +
      'balance of $4,820.00 carries 23.99% \u2014 roughly $1,156.32 of interest over a year at ' +
      'that rate. Principal put against that balance earns the rate itself, with certainty. ' +
      'What the same money might do in markets is not a figure this app holds, and it is not ' +
      'going to estimate one.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'D6',
    seedCase: 'drift',
    keys: ['debt.missed_payment.LIAB_a1b2c3d4e5f6'],
    summary:
      'A credit card carrying $4,820.00 was due on 2026-09-10, and the most recent payment it ' +
      'can see is from 2026-08-08. A late payment costs a fee and, separately and for longer, ' +
      'a mark on your credit file.',
    severity: 'warning',
    annualized: null,
  },
  {
    ruleId: 'I1',
    seedCase: 'drift',
    keys: ['investing.drift.US_EQUITY', 'investing.drift.US_BOND', 'investing.drift.CRYPTO'],
    summary:
      'US_EQUITY is 45% of the portfolio against a 52% target \u2014 7.0pp below it. With 2% of ' +
      'the portfolio unclassified, that gap is measured over what could be classified and no ' +
      'further.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'I2',
    seedCase: 'drift',
    keys: ['investing.expense_ratio.OLDFUND'],
    summary:
      'OLDFUND charges 0.89% a year \u2014 about $311.50 on $35,000.00. Comparable index funds ' +
      'charge about 0.04%, a difference of roughly $297.50 a year on this position. It is ' +
      'held in an account where a change realises nothing, so the fee is the whole of what it ' +
      'costs.',
    severity: 'warning',
    annualized: '29750',
  },
  {
    ruleId: 'I3',
    seedCase: 'drift',
    keys: ['investing.idle_cash'],
    summary:
      '$12,000.00 of brokerage cash is above the $1,000.00 floor, unearmarked, and the ' +
      'longest-standing part of it has been there 47 days.',
    severity: 'warning',
    annualized: null,
  },
  {
    ruleId: 'I4',
    seedCase: 'drift',
    keys: ['investing.concentration.VTI'],
    summary:
      'VTI is 26% of investable assets \u2014 $130,000.00 of $500,000.00. A bad year for this one ' +
      'holding moves that share of the portfolio on its own, whatever the rest of it does. ' +
      'Reducing it inside a taxable account would realise about $32,000.00 of gains, and the ' +
      'tax on that depends on your bracket and on how long each lot has been held.',
    severity: 'urgent',
    annualized: null,
  },
  {
    ruleId: 'I5',
    seedCase: 'drift',
    keys: ['investing.employer_stock.ACME'],
    summary:
      'ACME is 12% of investable assets \u2014 $60,000.00 \u2014 and you have it tagged as your ' +
      'employer. The year those shares fall is also the year the bonus does, and possibly the ' +
      'year the job does. What reducing the position would cost is not stated here: this app ' +
      'cannot see taxable lots carrying a gain for it.',
    severity: 'urgent',
    annualized: null,
  },
  {
    ruleId: 'I6',
    seedCase: 'drift',
    keys: ['investing.loss_lot.ACME.0'],
    summary:
      'One ACME lot, opened 520 days ago and now long-term, is worth $35,000.00 and is ' +
      '$10,500.00 below its cost. Realising a loss in a taxable account can offset gains ' +
      'elsewhere, within limits this app does not know for you.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'X1',
    seedCase: 'drift',
    keys: ['crypto.net_worth_share'],
    summary:
      'Crypto is worth $100,000.00 against a net worth of $530,700.00, and 20% of the ' +
      'portfolio. If it fell by half from where it is today, about $50,000.00 would go with ' +
      'it. That is a stress applied to the position you hold now, not a forecast of anything.',
    severity: 'urgent',
    annualized: null,
  },
  {
    ruleId: 'X2',
    seedCase: 'drift',
    keys: ['crypto.exchange_custody'],
    summary:
      '$60,000.00 of crypto sits with an exchange against $40,000.00 in self-custody. An ' +
      'exchange balance is a claim on a company rather than a coin you control, and that ' +
      'distinction only matters on the day the company has a problem.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'X3',
    seedCase: 'drift',
    keys: ['crypto.idle_stablecoins.USDC'],
    summary:
      '$20,000.00 sits in USDC. A published short-term rate was 5.12% on 2026-09-18, which on ' +
      'that amount is about $1,024.00 over a year. The balance is also not covered by deposit ' +
      'insurance, and the peg is a promise rather than a guarantee.',
    severity: 'notable',
    annualized: '102400',
  },
  {
    ruleId: 'X5',
    seedCase: 'drift',
    keys: ['crypto.loss_lot.BTC.0'],
    summary:
      'One BTC lot, opened 730 days ago, is worth $80,000.00 and is $12,000.00 below its ' +
      'cost.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'X6',
    seedCase: 'drift',
    keys: ['crypto.missing_basis.USDC'],
    summary:
      '$20,000.00 of USDC has no recorded cost basis. Basis is now expected to be tracked per ' +
      'wallet rather than pooled across all of them, and a reconstruction gets harder every ' +
      'year it is left \u2014 exchanges close, and their export files go with them.',
    severity: 'notable',
    annualized: null,
  },
  // --- WP 4.9, the retirement wave. R1 fires on `tight` (a young saver whose
  //     stated plan outruns the observed rate); the other five on `drift` (a
  //     66-year-old retiree). The control carries a healthy plan, so its half of
  //     each pair is a real negative rather than an empty snapshot.
  {
    ruleId: 'R1',
    seedCase: 'tight',
    keys: ['retirement.savings_rate.baseline'],
    summary:
      'The retirement plan assumes contributions of 15% of your income. The months this app ' +
      'has observed show 8.5%, which is 6.5pp below it. The plan\u2019s success probability is ' +
      'computed from the rate it assumes, so it reads higher than your recent saving supports.',
    severity: 'warning',
    annualized: null,
  },
  {
    ruleId: 'R2',
    seedCase: 'drift',
    keys: ['retirement.success_probability.baseline'],
    summary:
      'In 10,000 simulations of market returns, this plan lasted through age 95 in 71.3% of ' +
      'them. The plan is measured against 80%, so it sits 8.7pp short. Retiring later, saving ' +
      'more and spending less each move that share; the plan screen compares them side by side.',
    severity: 'urgent',
    annualized: null,
  },
  {
    ruleId: 'R3',
    seedCase: 'drift',
    keys: ['retirement.rmd_window.2035'],
    summary:
      'Required minimum distributions start at age 75, in 2035. 62% of what the retirement plan ' +
      'starts from is tax-deferred, and the 9 years before then are the widest window for Roth ' +
      'conversions, while how much comes out each year is still your choice.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'R4',
    seedCase: 'drift',
    keys: ['retirement.claiming_age.67_0'],
    summary:
      'The retirement plan claims Social Security at 67. Claiming at seventy instead makes each ' +
      'monthly payment 24% larger, for life and in today\u2019s dollars, in exchange for the ' +
      'payments that would have arrived in between.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'R6',
    seedCase: 'drift',
    keys: ['retirement.goal_pace.GOAL_6deb4f359d91'],
    summary:
      'The goal \u201cHouse deposit\u201d needs about $1,500.00 a month to reach $20,000.00 in 12 ' +
      'months. The contributions planned for it come to $500.00 a month, about $12,000.00 a ' +
      'year short of that pace.',
    severity: 'warning',
    annualized: '1200000',
  },
  {
    ruleId: 'R7',
    seedCase: 'drift',
    keys: ['retirement.withdrawal_guardrail.above'],
    summary:
      'This year the plan draws 6.12% of the portfolio, above the 3.6% to 5.4% guardrail band ' +
      'around a 4.5% starting rate. Under the guardrail method, a rate above the band is the ' +
      'point at which planned spending is trimmed by a tenth, so the portfolio is not drawn ' +
      'down faster than it can sustain.',
    severity: 'urgent',
    annualized: null,
  },
];

describe('each rule on the seed case it was designed for', () => {
  it('covers every rule in the catalogue', () => {
    expect(GOLDEN.map((row) => row.ruleId).sort()).toEqual(
      BUILTIN_CATALOGUE.map((entry) => entry.ruleId).sort(),
    );
  });

  for (const golden of GOLDEN) {
    it(`${golden.ruleId} fires on the ${golden.seedCase} case and not on the control`, async () => {
      const snapshot = await seedSnapshot(golden.seedCase);
      const output = evaluate(golden.ruleId, snapshot);

      expect(output.insights.map((insight) => insight.key)).toEqual(golden.keys);
      const first = output.insights[0];
      expect(first).toBeDefined();
      if (first === undefined) return;
      expect(first.summary_md).toBe(golden.summary);
      expect(first.severity).toBe(golden.severity);
      expect(first.impact.annualized?.minor ?? null).toBe(golden.annualized);
      expect(first.impact.one_time?.minor ?? null).toBe(golden.oneTime ?? null);
      expect(first.confidence_basis).toBe('deterministic');
      expect(first.requires_review).toBe(true);

      const control = await seedSnapshot('control');
      expect(evaluate(golden.ruleId, control).insights).toEqual([]);
    });
  }
});

describe('a rule is a pure function of its context', () => {
  /**
   * Determinism over *arbitrary* snapshots, not just the seed.
   *
   * A rule that sorted on an object key, reached for `Date.now()`, or let a
   * `Map`'s insertion order decide a tie would pass every golden test above and
   * still produce two different feeds from one night's data — and the upsert key
   * `(advisor_id, key, period)` would then churn rows instead of updating them.
   * The arbitrary half also gives totality: a malformed snapshot must be an
   * empty result, never a thrown worker.
   */
  it('produces identical output twice, on the seed and on arbitrary input', async () => {
    const seeds = await Promise.all(
      (['drift', 'tight', 'control'] as const).map((name) => seedSnapshot(name)),
    );

    for (const entry of BUILTIN_CATALOGUE) {
      for (const snapshot of seeds) {
        const context = { snapshot, today: TODAY, period: '2026-09', baseCurrency: USD };
        expect(entry.rule.evaluate(context)).toEqual(entry.rule.evaluate(context));
      }
    }

    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.jsonValue()),
        fc.string(),
        (shape: Record<string, unknown>, today: string) => {
          const context = {
            snapshot: shape as AdvisorSnapshot,
            today,
            period: '2026-09',
            baseCurrency: USD,
          };
          for (const entry of BUILTIN_CATALOGUE) {
            const first = entry.rule.evaluate(context);
            const second = entry.rule.evaluate(context);
            expect(second).toEqual(first);
          }
          return true;
        },
      ),
      { numRuns: 120 },
    );
  });
});
