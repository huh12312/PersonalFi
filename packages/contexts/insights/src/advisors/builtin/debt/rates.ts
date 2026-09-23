// SPDX-License-Identifier: MIT
/**
 * **D2 — a rate above what comparable borrowing costs** and **D4 — a
 * promotional rate about to end**. The two debt rules that need a *market*
 * number, and the first two consumers of `market.rates` after C1 and C2.
 *
 * ## Why the market rate had to arrive before these could
 *
 * D2's message in 07 §3.3 is *"{acct} is at {apr}%. Current typical rates are
 * around {mkt}%"*, and its impact is `bal × (apr − mkt) − fees`. Without an
 * observed `mkt` the sentence has a hole in it and the arithmetic has no second
 * operand — which is the same wall C1 and C2 hit in Phase 2, for the same
 * reason, and it is why `market.rates` exists.
 *
 * `− fees` is dropped rather than guessed. A balance-transfer fee is a term of
 * an offer nobody has made yet; subtracting an assumed one would make the
 * saving smaller by an invented amount, which is not more conservative, it is
 * just wrong in a direction that feels safe.
 *
 * ## Choosing a series by kind, never by id
 *
 * A rule naming `'DGS10'` would be a series id hardcoded in a rule — the cousin
 * of the hardcoded 4%, and broken the day a deployment tracks a different
 * series for the same idea. `market.rates[].kind` is the join: a card is
 * compared with `credit_card_apr`, a mortgage with `mortgage_30y`, and
 * everything else with `ten_year_treasury`, which 07 §3.3 calls "current
 * market" for installment debt.
 *
 * A stale observation is refused outright rather than shown with a label. A
 * stale *price* on a holding still tells you roughly what you own; a stale
 * *rate* used as the benchmark in a comparison produces a spread that is wrong
 * by however much rates moved, and the whole insight is that spread.
 */
import type { Insight } from '../../../contract/response.ts';
import type { AdvisorSnapshot, MarketRateKind } from '../../../contract/snapshot.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  clampImpact,
  daysBetween,
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
import { liabilityRef, productOf, rateRef } from '../shared.ts';
import { isRevolving, kindLabel } from './labels.ts';

/** 07 §3.3 D2: any card APR over twelve points is high on its own. */
const CARD_APR_CEILING = 0.12;
/** 07 §3.3 D2: installment debt, a point and a half over the market. */
const INSTALLMENT_SPREAD = 0.015;
/** 07 §3.3 D4: a promotional rate ending inside ninety days. */
const PROMO_WINDOW_DAYS = 90;

type Liability = NonNullable<AdvisorSnapshot['liabilities_terms']>['liabilities'][number];

/** Which published rate a liability of this kind is compared against. */
function benchmarkFor(kind: Liability['kind']): MarketRateKind {
  switch (kind) {
    case 'credit_card':
    case 'line_of_credit':
      return 'credit_card_apr';
    case 'mortgage':
      return 'mortgage_30y';
    default:
      return 'ten_year_treasury';
  }
}

interface Benchmark {
  readonly index: number;
  readonly rate: number;
  readonly seriesId: string;
  readonly observationDate: string;
}

function benchmark(snapshot: AdvisorSnapshot, kind: MarketRateKind): Benchmark | null {
  const rates = snapshot.market_rates?.rates ?? [];
  const index = rates.findIndex((row) => row.kind === kind && !row.stale);
  if (index === -1) return null;
  const row = rates[index];
  if (row === undefined) return null;
  return {
    index,
    rate: row.rate,
    seriesId: row.series_id,
    observationDate: row.observation_date,
  };
}

/** The attribution sentence, as a caveat. A licence condition, not a courtesy. */
function attributionCaveat(snapshot: AdvisorSnapshot): readonly string[] {
  const attribution = snapshot.market_rates?.attribution;
  return attribution === undefined ? [] : [attribution];
}

export const debtRateAboveMarket: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.debt.rate_above_market',
    displayName: 'A rate above what comparable borrowing costs',
    purpose:
      'Compares each liability’s APR with a dated, attributed published rate for its kind, ' +
      'and reports what the difference costs in a year.',
    scopes: ['liabilities.terms', 'market.rates'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 10,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const liabilities = snapshot.liabilities_terms?.liabilities ?? [];
    if (liabilities.length === 0) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const [index, liability] of liabilities.entries()) {
      const apr = liability.apr;
      if (apr === null) continue;
      const balance = BigInt(liability.current_balance.minor);
      if (balance <= 0n) continue;

      const market = benchmark(snapshot, benchmarkFor(liability.kind));
      if (market === null) continue;
      if (apr <= market.rate) continue;

      const triggered = isRevolving(liability.kind)
        ? apr > CARD_APR_CEILING
        : apr - market.rate > INSTALLMENT_SPREAD;
      if (!triggered) continue;

      const spread = yieldSpread(
        snapshot,
        'rate_spread_over_a_year',
        liabilityRef(index, 'current_balance.minor'),
        liabilityRef(index, 'apr'),
        rateRef(market.index, 'rate'),
        'This balance at the rate it carries, less the same balance at the published rate.',
      );
      if (spread === null) continue;

      const verdict = clampImpact(
        spread.value,
        liability.current_balance.currency,
        `debt rate spread on ${liability.kind}`,
      );
      if (verdict.kind === 'withheld') {
        warnings.push(verdict.warning);
        continue;
      }
      if (BigInt(verdict.money.minor) <= 0n) continue;

      const aprText = formatPercent(apr);
      const marketText = formatPercent(market.rate);
      const balanceText = formatMoneyJson(liability.current_balance);
      const spreadText = formatMoneyJson(verdict.money);
      if (aprText === null || marketText === null || balanceText === null || spreadText === null) {
        continue;
      }

      insights.push(
        insightOf({
          key: `debt.rate_above_market.${liability.liability_ref}`,
          period: context.period,
          type: 'debt.rate_above_market',
          severity: 'warning',
          title: 'One balance carries a rate above the published one',
          summary:
            `A ${kindLabel(liability.kind)} balance of ${balanceText} carries ${aprText}, while the ` +
            `${market.seriesId} series was ${marketText} on ${market.observationDate}. On ` +
            `this balance the difference is about ${spreadText} a year. Any transfer or ` +
            'refinance fee comes out of that, and this app does not know what one would be.',
          confidence: 1,
          horizon: 'this_year',
          annualized: verdict.money,
          basis:
            'This balance at its own rate, less the same balance at a published rate for ' +
            'comparable borrowing. Fees are not subtracted, because none is known.',
          derivationId: spread.derivation.id,
          derivations: [spread.derivation],
          evidence: [
            metric('The balance', liabilityRef(index, 'current_balance'), balanceText),
            metric('The rate it carries', liabilityRef(index, 'apr'), null),
            metric('The published rate', rateRef(market.index, 'rate'), null),
            metric(
              'When that rate was observed',
              rateRef(market.index, 'observation_date'),
              market.observationDate,
            ),
          ],
          actions: [
            suggest(
              'Compare the terms',
              'A lower rate on a transfer usually carries a fee and a window, and both change ' +
                'the arithmetic above.',
            ),
          ],
          caveats: [
            'The published rate is a national series, not an offer anyone has made you. What ' +
              'you would actually be charged depends on your credit and on the lender.',
            ...attributionCaveat(snapshot),
          ],
        }),
      );
    }

    return { insights, warnings };
  },
};

export const debtPromoEnding: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.debt.promo_ending',
    displayName: 'A promotional rate is about to end',
    purpose:
      'Reports a liability whose promotional rate ends within ninety days while a balance ' +
      'remains, and what the standing rate would cost on that balance in a year.',
    scopes: ['liabilities.terms'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 8,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const liabilities = snapshot.liabilities_terms?.liabilities ?? [];
    if (liabilities.length === 0) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const [index, liability] of liabilities.entries()) {
      const end = liability.promo_apr_end_date;
      const apr = liability.apr;
      if (end === null || apr === null) continue;
      const days = daysBetween(context.today, end);
      if (days === null || days < 0 || days > PROMO_WINDOW_DAYS) continue;
      const balance = BigInt(liability.current_balance.minor);
      if (balance <= 0n) continue;

      const cost = productOf(
        snapshot,
        'balance_at_the_standing_rate',
        liabilityRef(index, 'current_balance.minor'),
        liabilityRef(index, 'apr'),
        'What remains, at the rate that takes over when the promotional one ends.',
      );
      if (cost === null) continue;

      const verdict = clampImpact(
        cost.value,
        liability.current_balance.currency,
        `promotional rate ending on ${liability.kind}`,
      );
      if (verdict.kind === 'withheld') {
        warnings.push(verdict.warning);
        continue;
      }

      const balanceText = formatMoneyJson(liability.current_balance);
      const aprText = formatPercent(apr);
      const costText = formatMoneyJson(verdict.money);
      if (balanceText === null || aprText === null || costText === null) continue;

      insights.push(
        insightOf({
          key: `debt.promo_ending.${liability.liability_ref}`,
          period: context.period,
          type: 'debt.promo_ending',
          severity: 'warning',
          title: 'A promotional rate ends while a balance remains',
          summary:
            `The promotional rate on a ${kindLabel(liability.kind)} ends on ${end} with ${balanceText} ` +
            `still owing. At that point the balance carries ${aprText}, which is about ` +
            `${costText} a year on what is left of it.`,
          confidence: 1,
          horizon: 'next_quarter',
          annualized: verdict.money,
          basis: 'What remains, at the rate that takes over. Nothing is assumed about repayment.',
          derivationId: cost.derivation.id,
          derivations: [cost.derivation],
          evidence: [
            metric('What is still owing', liabilityRef(index, 'current_balance'), balanceText),
            metric(
              'When the promotional rate ends',
              liabilityRef(index, 'promo_apr_end_date'),
              end,
            ),
            metric('The rate that takes over', liabilityRef(index, 'apr'), null),
          ],
          actions: [
            suggest(
              'Plan the balance down to the date',
              'The figure above is what a full year at the standing rate costs. Clearing the ' +
                'balance before the date avoids all of it.',
            ),
          ],
          caveats: [
            'The annual figure assumes the balance stays where it is. Every payment before the ' +
              'date reduces it.',
          ],
        }),
      );
    }

    return { insights, warnings };
  },
};
