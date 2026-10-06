// SPDX-License-Identifier: MIT
/**
 * **I6 — a taxable lot sitting at a loss.**
 *
 * ## What it says, and the three things it will not say
 *
 * 07 §3.3 I6's impact is `min(loss, gains + 3000) × MTR`. Three of those four
 * terms are unavailable here and the fourth is the only one this rule states:
 *
 *   * **`MTR`** — the marginal rate. `risk.profile` carries a tax-bracket
 *     *band*, deliberately (07 §4.2, and the scope row says so), and no reader
 *     behind it exists yet. A band is not a rate and multiplying by the middle
 *     of one would be inventing the figure that matters most.
 *   * **`gains`** — realised gains year to date. No scope carries a disposal.
 *   * **the `$3,000` ordinary-income cap** — a statutory constant, which is a
 *     numeral nothing in the snapshot accounts for, and printing it would fail
 *     step 7 exactly as a hardcoded market rate would.
 *
 * So the rule reports **the loss the lot is carrying and how old it is**, both
 * of which are snapshot values, and claims no impact. What it would need to
 * claim one is named in the evidence doc rather than estimated here.
 *
 * ## `POSSIBLE_WASH_SALE`, never `WASH_SALE`
 *
 * 07 §4.4 is explicit that the determination is facts-and-circumstances and
 * that the scan has to cross every account including IRAs — which this scope
 * cannot do, because it carries no account identity at all. So I6 carries the
 * caution as a caveat and I7 is *not* implemented: a wash-sale rule that could
 * only see some of the accounts would produce confident false negatives, which
 * is worse than the gap. `CATALOGUE_GAPS` records the field it needs.
 */
import type { Insight } from '../../../contract/response.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  formatMoneyJson,
  insightOf,
  metric,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { detailRef, lotRef } from '../shared.ts';
import { symbolKeyPart } from '../symbol-key.ts';

/** 07 §3.3 I6: a loss over `max($500, 2% of position)`, in minor units. */
const LOSS_FLOOR_MINOR = 50_000n;
const LOSS_POSITION_NUMERATOR = 2n;
const LOSS_POSITION_DENOMINATOR = 100n;

export const investingLossLot: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.investing.loss_lot',
    displayName: 'A taxable lot carrying a loss',
    purpose:
      'Reports a lot in a taxable account whose market value is below its cost basis by more ' +
      'than the larger of a floor and a share of the position.',
    scopes: ['holdings.detail'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 10,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const positions = context.snapshot.holdings_detail?.positions ?? [];
    if (positions.length === 0) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    for (const [index, position] of positions.entries()) {
      // A loss is only a tax event in a taxable account. Harvesting inside a
      // tax-deferred or tax-free one does nothing at all, and saying otherwise
      // would be the most expensive kind of wrong.
      if (position.account_type !== 'taxable') continue;
      // A crypto lot at a loss is X5's, not this rule's. The two findings read
      // almost identically and their caveats are opposites — the wash-sale rule
      // reaches securities and does not currently reach digital assets — so a
      // position appearing under both would put two contradictory cautions in
      // one feed.
      if (position.is_crypto) continue;
      const positionValue = BigInt(position.market_value.minor);
      const threshold =
        (positionValue * LOSS_POSITION_NUMERATOR) / LOSS_POSITION_DENOMINATOR > LOSS_FLOOR_MINOR
          ? (positionValue * LOSS_POSITION_NUMERATOR) / LOSS_POSITION_DENOMINATOR
          : LOSS_FLOOR_MINOR;

      for (const [lotIndex, lot] of position.lots.entries()) {
        if (lot.unrealized === null) continue;
        const unrealised = BigInt(lot.unrealized.minor);
        if (unrealised >= 0n) continue;
        if (-unrealised <= threshold) continue;

        const lossText = formatMoneyJson(lot.unrealized);
        const lotValueText = formatMoneyJson(lot.market_value);
        if (lossText === null || lotValueText === null) continue;
        const age = String(lot.opened_days);
        const term = lot.long_term ? 'long-term' : 'short-term';

        insights.push(
          insightOf({
            key: `investing.loss_lot.${symbolKeyPart(position.symbol)}.${String(lotIndex)}`,
            period: context.period,
            type: 'investing.loss_lot',
            severity: 'notable',
            title: 'A taxable lot is below what it cost',
            summary:
              `One ${position.symbol} lot, opened ${age} days ago and now ${term}, is worth ` +
              `${lotValueText} and is ${lossText} below its cost. Realising a loss in a ` +
              'taxable account can offset gains elsewhere, within limits this app does not ' +
              'know for you.',
            confidence: 1,
            horizon: 'this_year',
            basis:
              'The lot’s own unrealised loss. No tax figure is claimed: that needs a marginal ' +
              'rate and a year-to-date gains total, neither of which this app holds.',
            evidence: [
              metric(
                'What the lot is worth',
                lotRef(index, lotIndex, 'market_value'),
                lotValueText,
              ),
              metric('How far below cost it is', lotRef(index, lotIndex, 'unrealized'), lossText),
              metric('Days since the lot was opened', lotRef(index, lotIndex, 'opened_days'), age),
              metric('The account’s tax treatment', detailRef(index, 'account_type'), 'taxable'),
            ],
            actions: [
              suggest(
                'Read about realising a loss',
                'A replacement holding that is substantially identical can disallow the loss, ' +
                  'and what counts as substantially identical is a judgement rather than a rule.',
              ),
            ],
            caveats: [
              'A repurchase of a substantially identical security near a disposal can disallow ' +
                'the loss. This app can only ever call that possible: it does not see every ' +
                'account, and the test is one of facts and circumstances.',
              'The offset a realised loss gives you depends on your other gains and on a cap on ' +
                'ordinary income this app does not apply for you.',
            ],
          }),
        );
      }
    }

    return { insights: insights.slice(0, 10), warnings: [] };
  },
};
