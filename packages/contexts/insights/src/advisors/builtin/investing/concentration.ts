// SPDX-License-Identifier: MIT
/**
 * **I4 — one position is most of the portfolio** and **I5 — that position is
 * also the paycheck**. The two P0s the dispatch names in this family.
 *
 * ## Why they are two rules and not one with a flag
 *
 * They fire on the same shape of data and they are not the same finding. I4 is
 * *idiosyncratic risk*: one company's bad quarter moves a fifth of the
 * portfolio. I5 is *correlated* risk of a different kind — the position and the
 * income depend on the same employer, so the year the shares fall is also the
 * year the bonus does and possibly the year the job does. 07 §3.3 sets I5's
 * threshold at half I4's for exactly that reason, and a single rule with a
 * boolean would have to pick one threshold and one sentence.
 *
 * ## Every recommendation is paired with its cost
 *
 * 07 §7.2: *"Always pair a recommendation with its cost. 'Consider selling X'
 * without 'which realizes $Y of gains and $Z of tax' is the hallmark of bad
 * automated advice."* Both rules therefore declare `holdings.detail` as well as
 * `holdings.aggregate`: the aggregate block says the position is 24% of the
 * portfolio, and the detail block is the only place the *unrealised gain* that
 * trimming it would realise can be read. When the detail block is absent the
 * sentence about cost is absent too — the rule says what it can defend and
 * stops, rather than recommending a trim whose price it cannot state.
 *
 * ## Neither claims a dollar impact
 *
 * 07's impact column for both is "(risk)". `val × p × idiosyncratic_vol` needs
 * a volatility this app does not have, and the value at stake is not a saving —
 * nobody gets $45,000 by diversifying. `produces_impact: false` on both
 * manifests, so the pipeline would refuse a figure even if a template grew one.
 */
import type { Insight } from '../../../contract/response.ts';
import type { AdvisorSnapshot } from '../../../contract/snapshot.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  formatMoneyJson,
  formatPercent,
  insightOf,
  metric,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { aggregateRef, detailRef, positionRef } from '../shared.ts';
import { symbolKeyPart } from '../symbol-key.ts';

/** 07 §3.3 I4: `> 20% of investable assets`. */
const CONCENTRATION_THRESHOLD = 0.2;
/** 07 §3.3 I5: `> 10%`, half I4's, because the paycheck is the other half. */
const EMPLOYER_STOCK_THRESHOLD = 0.1;

/**
 * The gain a trim in a taxable account would realise, and the ref behind it.
 *
 * `null` when `holdings.detail` was not granted, when the symbol is not in it,
 * when the account is not taxable, or when the basis is unknown — four
 * different reasons for the same answer, which is "say nothing about the cost".
 * An unknown basis in particular must not become a zero one: that would print a
 * gain equal to the whole position and make the trim look maximally expensive.
 */
function realisableGain(
  snapshot: AdvisorSnapshot,
  symbol: string,
): { readonly text: string; readonly ref: string } | null {
  const positions = snapshot.holdings_detail?.positions ?? [];
  const index = positions.findIndex(
    (row) => row.symbol === symbol && row.account_type === 'taxable',
  );
  if (index === -1) return null;
  const position = positions[index];
  if (position === undefined || position.unrealized === null) return null;
  if (BigInt(position.unrealized.minor) <= 0n) return null;
  const text = formatMoneyJson(position.unrealized);
  return text === null ? null : { text, ref: detailRef(index, 'unrealized') };
}

export const investingConcentration: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.investing.concentration',
    displayName: 'One position dominates the portfolio',
    purpose:
      'Reports any single security worth more than a fifth of investable assets, with the ' +
      'gain that trimming it in a taxable account would realise.',
    scopes: ['holdings.aggregate', 'holdings.detail'],
    maxSeverity: 'urgent',
    producesImpact: false,
    maxInsights: 8,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const aggregate = context.snapshot.holdings_aggregate;
    if (aggregate === undefined) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    for (const [index, position] of aggregate.top_positions.entries()) {
      if (position.weight <= CONCENTRATION_THRESHOLD) continue;

      const weightText = formatPercent(position.weight);
      const valueText = formatMoneyJson(position.value);
      const totalText = formatMoneyJson(aggregate.investable_total);
      if (weightText === null || valueText === null || totalText === null) continue;

      const gain = realisableGain(context.snapshot, position.symbol);
      const costSentence =
        gain === null
          ? 'What reducing it would cost is not stated here: this app cannot see taxable ' +
            'lots carrying a gain for it.'
          : `Reducing it inside a taxable account would realise about ${gain.text} of ` +
            'gains, and the tax on that depends on your bracket and on how long each lot ' +
            'has been held.';

      insights.push(
        insightOf({
          key: `investing.concentration.${symbolKeyPart(position.symbol)}`,
          period: context.period,
          type: 'investing.concentration',
          severity: 'urgent',
          title: 'One position is a large share of the portfolio',
          summary:
            `${position.symbol} is ${weightText} of investable assets — ${valueText} of ` +
            `${totalText}. A bad year for this one holding moves that share of the ` +
            `portfolio on its own, whatever the rest of it does. ${costSentence}`,
          confidence: 1,
          horizon: 'this_year',
          basis:
            'A share of investable assets. No saving is claimed: concentration is a risk ' +
            'statement, and diversifying does not put money in an account.',
          evidence: [
            metric('What this position is worth', positionRef(index, 'value'), valueText),
            metric('Its share of investable assets', positionRef(index, 'weight'), null),
            metric('Investable assets', aggregateRef('investable_total'), totalText),
            ...(gain === null
              ? []
              : [metric('Unrealised gain in the taxable lots', gain.ref, gain.text)]),
          ],
          actions: [
            suggest(
              'Read about concentration risk',
              'Directing new contributions elsewhere lowers a position’s share without a ' +
                'disposal, and so without realising anything.',
            ),
          ],
          caveats: [
            'Share is measured against investable assets, which is neither net worth nor the ' +
              'total of everything held.',
            ...(gain === null
              ? []
              : [
                  'The gain shown is what the taxable lots hold today. Lots in a tax-deferred ' +
                    'or tax-free account are not counted in it.',
                ]),
          ],
        }),
      );
    }

    return { insights, warnings: [] };
  },
};

export const investingEmployerStock: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.investing.employer_stock',
    displayName: 'Employer stock and the paycheck',
    purpose:
      'Reports employer stock worth more than a tenth of investable assets, where the ' +
      'position and the income depend on the same company.',
    scopes: ['holdings.aggregate', 'holdings.detail'],
    maxSeverity: 'urgent',
    producesImpact: false,
    maxInsights: 4,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const aggregate = context.snapshot.holdings_aggregate;
    if (aggregate === undefined) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    for (const [index, position] of aggregate.top_positions.entries()) {
      // The tag is the user's own. This app never infers an employer from a
      // symbol, a payroll descriptor or an account name — a wrong guess here
      // would tell someone their savings and their job are the same bet when
      // they are not.
      if (!position.employer_stock) continue;
      if (position.weight <= EMPLOYER_STOCK_THRESHOLD) continue;

      const weightText = formatPercent(position.weight);
      const valueText = formatMoneyJson(position.value);
      if (weightText === null || valueText === null) continue;

      const gain = realisableGain(context.snapshot, position.symbol);

      insights.push(
        insightOf({
          key: `investing.employer_stock.${symbolKeyPart(position.symbol)}`,
          period: context.period,
          type: 'investing.employer_stock',
          severity: 'urgent',
          title: 'Your savings and your income depend on one company',
          summary:
            `${position.symbol} is ${weightText} of investable assets — ${valueText} — and ` +
            'you have it tagged as your employer. The year those shares fall is also the ' +
            'year the bonus does, and possibly the year the job does. ' +
            (gain === null
              ? 'What reducing the position would cost is not stated here: this app cannot ' +
                'see taxable lots carrying a gain for it.'
              : `Reducing it in a taxable account would realise about ${gain.text} of gains.`),
          confidence: 1,
          horizon: 'this_year',
          basis:
            'A share of investable assets held in the company that also pays you. No saving ' +
            'is claimed; this is a statement about what one company’s year does to you.',
          evidence: [
            metric('What this position is worth', positionRef(index, 'value'), valueText),
            metric('Its share of investable assets', positionRef(index, 'weight'), null),
            metric('Tagged as employer stock', positionRef(index, 'employer_stock'), 'true'),
            ...(gain === null
              ? []
              : [metric('Unrealised gain in the taxable lots', gain.ref, gain.text)]),
          ],
          actions: [
            suggest(
              'Read about single-company exposure',
              'Plan rules, blackout windows and a written trading plan all shape what can be ' +
                'done here and when, and none of them is something this app can see.',
            ),
          ],
          caveats: [
            'Restricted stock, unvested grants and plan blackout windows change what is ' +
              'possible and when. None of them is visible to this app.',
          ],
        }),
      );
    }

    return { insights, warnings: [] };
  },
};
