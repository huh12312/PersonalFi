// SPDX-License-Identifier: MIT
/**
 * **I2 — a fund charging more than its comparable** and **I3 — cash sitting
 * uninvested**. The two costs a portfolio pays without anybody deciding to.
 *
 * ## I2 claims a saving; I3 deliberately does not
 *
 * The difference is 07 §3.2's rule about speculative returns, applied twice and
 * coming out differently:
 *
 *   * I2's figure is a **fee spread** — `value × (expense_ratio −
 *     peer_expense_ratio)`. Both rates are observed facts about funds that
 *     exist, the difference is charged every year regardless of what markets
 *     do, and it is the same shape as C2's yield spread. It is claimed.
 *   * I3's figure in 07 is `x × (expected_return − sweep_apy)`, and
 *     `expected_return` is a forecast. *"Never compound speculative returns
 *     into the headline number"* forbids it outright, and there is no
 *     expected-return assumption in any scope this work package was given
 *     anyway. So I3 reports **how much and for how long**, claims no impact,
 *     and is ranked on severity like C3 and C7 before it.
 *
 * ## Where the trigger is evaluated
 *
 * `high_fee` and the whole of `idle_cash` arrive pre-triggered from the
 * snapshot, mirroring WP 3.3's `FeeRow.high` and `IdleCashReport` — which
 * compute 07's `max($1,000, 2% of account)` per account. That threshold needs a
 * per-account denominator, and `holdings.aggregate` carries no per-account row
 * by design, so the only place it *can* be applied is upstream. The rule then
 * reads a total that already means "the part that qualifies".
 */
import type { Insight } from '../../../contract/response.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  clampImpact,
  formatMoneyJson,
  formatPercent,
  insightOf,
  metric,
  suggest,
  yieldSpread,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { aggregateRef, detailRef } from '../shared.ts';
import { symbolKeyPart } from '../symbol-key.ts';

/** 07 §3.3 I2: an expense ratio over half a point, on its own. */
const HIGH_EXPENSE_RATIO = 0.005;
/** 07 §3.3 I2: or a fifth of a point over a comparable index fund. */
const EXPENSE_RATIO_SPREAD = 0.002;
/** Above this annual difference the finding is a warning rather than a note. */
const FEE_WARNING_MINOR = 10_000n;

export const investingExpenseRatio: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.investing.expense_ratio',
    displayName: 'A fund charging more than its comparable',
    purpose:
      'Reports a holding whose expense ratio is high on its own or high against a comparable ' +
      'index fund, with what the difference costs in a year.',
    scopes: ['holdings.detail'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 10,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const positions = snapshot.holdings_detail?.positions ?? [];
    if (positions.length === 0) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const [index, position] of positions.entries()) {
      const expense = position.expense_ratio;
      if (expense === null) continue;
      const peer = position.peer_expense_ratio;
      const overPeer = peer !== null && expense - peer > EXPENSE_RATIO_SPREAD;
      if (!position.high_fee && expense <= HIGH_EXPENSE_RATIO && !overPeer) continue;

      const expenseText = formatPercent(expense);
      const valueText = formatMoneyJson(position.market_value);
      if (expenseText === null || valueText === null) continue;

      // The saving exists only where a comparable exists. A high ratio with no
      // comparable is a cost, not a difference, and 07's `val × (er − alt)` has
      // no `alt` to subtract.
      const spread =
        peer === null
          ? null
          : yieldSpread(
              snapshot,
              'fee_spread_over_a_year',
              detailRef(index, 'market_value.minor'),
              detailRef(index, 'expense_ratio'),
              detailRef(index, 'peer_expense_ratio'),
              'This holding at the fee it pays, less the same holding at what a comparable ' +
                'index fund charges.',
            );

      let annualised = null;
      let spreadSentence = '';
      if (spread !== null && peer !== null) {
        const verdict = clampImpact(
          spread.value,
          position.market_value.currency,
          `expense ratio spread on ${position.symbol}`,
        );
        if (verdict.kind === 'withheld') {
          warnings.push(verdict.warning);
        } else if (BigInt(verdict.money.minor) > 0n) {
          const peerText = formatPercent(peer);
          const spreadText = formatMoneyJson(verdict.money);
          if (peerText !== null && spreadText !== null) {
            annualised = verdict.money;
            spreadSentence =
              ` Comparable index funds charge about ${peerText}, a difference of roughly ` +
              `${spreadText} a year on this position.`;
          }
        }
      }

      const cost = position.annual_fee_cost;
      const costText = cost === null ? null : formatMoneyJson(cost);

      insights.push(
        insightOf({
          key: `investing.expense_ratio.${symbolKeyPart(position.symbol)}`,
          period: context.period,
          type: 'investing.expense_ratio',
          severity:
            annualised !== null && BigInt(annualised.minor) >= FEE_WARNING_MINOR
              ? 'warning'
              : 'notable',
          title: 'One holding charges more than its comparable',
          summary:
            `${position.symbol} charges ${expenseText} a year` +
            (costText === null ? '' : ` — about ${costText} on ${valueText}`) +
            `.${spreadSentence} ` +
            (position.account_type === 'taxable'
              ? 'Selling it here would realise whatever gain its lots hold, which is a ' +
                'one-off cost against a recurring difference.'
              : 'It is held in an account where a change realises nothing, so the fee is ' +
                'the whole of what it costs.'),
          confidence: 1,
          horizon: 'this_year',
          annualized: annualised,
          basis:
            annualised === null
              ? 'The fee this holding pays in a year. No comparable is recorded for it, so no ' +
                'difference is claimed.'
              : 'This holding at its own fee, less the same holding at a comparable fund’s.',
          derivationId: spread === null ? null : spread.derivation.id,
          derivations: spread === null ? [] : [spread.derivation],
          evidence: [
            metric('What this holding is worth', detailRef(index, 'market_value'), valueText),
            metric('What it charges', detailRef(index, 'expense_ratio'), null),
            ...(peer === null
              ? []
              : [
                  metric('What a comparable charges', detailRef(index, 'peer_expense_ratio'), null),
                ]),
            ...(cost === null || costText === null
              ? []
              : [metric('The fee in a year', detailRef(index, 'annual_fee_cost'), costText)]),
          ],
          actions: [
            suggest(
              'Compare this fund with its index',
              'Inside a tax-deferred or tax-free account the change costs nothing in tax; ' +
                'inside a taxable one it realises the lots’ gain.',
            ),
          ],
          caveats: [
            'A fee difference is recurring and a realised gain is one-off. Which wins depends ' +
              'on how long the holding stays.',
          ],
        }),
      );
    }

    return { insights, warnings };
  },
};

export const investingIdleCash: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.investing.idle_cash',
    displayName: 'Cash uninvested in a brokerage account',
    purpose:
      'Reports brokerage cash that has been above its account’s threshold, unearmarked, for ' +
      'longer than a fortnight.',
    scopes: ['holdings.aggregate'],
    maxSeverity: 'warning',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const aggregate = context.snapshot.holdings_aggregate;
    const idle = aggregate?.idle_cash;
    if (aggregate === undefined || idle === undefined) return { insights: [], warnings: [] };
    if (BigInt(idle.total.minor) <= 0n) return { insights: [], warnings: [] };

    const totalText = formatMoneyJson(idle.total);
    const floorText = formatMoneyJson(idle.floor);
    if (totalText === null || floorText === null) return { insights: [], warnings: [] };
    const days = String(idle.longest_idle_days);

    return {
      insights: [
        insightOf({
          key: 'investing.idle_cash',
          period: context.period,
          type: 'investing.idle_cash',
          severity: 'warning',
          title: 'Cash has been sitting uninvested in a brokerage account',
          summary:
            `${totalText} of brokerage cash is above the ${floorText} floor, unearmarked, ` +
            `and the longest-standing part of it has been there ${days} days.`,
          confidence: 1,
          horizon: 'this_period',
          basis:
            'The cash that cleared its account’s own threshold. No figure is claimed for what ' +
            'it might have earned: that would need an expected return, which is a forecast.',
          evidence: [
            metric('Cash over the threshold', aggregateRef('idle_cash.total'), totalText),
            metric('The floor it cleared', aggregateRef('idle_cash.floor'), floorText),
            metric(
              'Days the longest-standing part has sat',
              aggregateRef('idle_cash.longest_idle_days'),
              days,
            ),
          ],
          actions: [
            suggest(
              'Review the brokerage sweep',
              'A sweep rate and a money-market fund are different things, and which one this ' +
                'cash is in is a setting at the broker.',
            ),
          ],
          caveats: [
            'Cash you have earmarked for something is excluded upstream, so anything here is ' +
              'cash nothing is waiting on.',
          ],
        }),
      ],
      warnings: [],
    };
  },
};
