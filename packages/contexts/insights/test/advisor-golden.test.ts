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
    summary:
      'About $21,701.67 more than three months of recent spending is held in cash, ' +
      'earning 0.81% across those accounts.',
    severity: 'notable',
    annualized: null,
  },
  {
    ruleId: 'C2',
    seedCase: 'drift',
    keys: ['cash.yield_spread.acct-checking'],
    summary:
      'One account holds $21,235.00 at 0%, while another of your own earns 4.25%. ' +
      'At the higher rate that balance would have earned about $902.49 over a year.',
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
