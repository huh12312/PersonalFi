// SPDX-License-Identifier: MIT
/**
 * **X3 — stablecoins sitting idle**, **X5 — a crypto lot at a loss**, and
 * **X6 — a crypto position with no cost basis behind it.**
 *
 * ## X3 is the fourth consumer of `market.rates`
 *
 * 07 §3.3 X3: *"${x} in {stable} isn't FDIC-insured and doesn't earn the
 * ~{apy}% a bank/T-bill would."* `{apy}` is a market rate, so this rule was
 * unwritable for the same reason C1 and C2 were, and became writable for the
 * same reason they did. It compares against a short-term risk-free series
 * rather than a savings series when both exist, because a T-bill is the thing
 * a dollar-pegged balance is actually being measured against.
 *
 * ## X5 and the dated flag
 *
 * 07 §4.4 is explicit that §1091's non-application to digital assets belongs in
 * *a dated config flag, not a hardcoded branch*, because bills to change it
 * recur. `CRYPTO_WASH_SALE_WATCH` in `../shared.ts` carries the flag and the
 * date it was last checked; the caveat quotes the date so a reader can tell a
 * current statement from a stale one. The day the flag flips, this rule's
 * caveat changes and nothing else does.
 *
 * As with I6, no tax figure is claimed: `loss × MTR` needs a marginal rate, and
 * a tax-bracket *band* — which is all any scope carries, deliberately — is not
 * a rate.
 *
 * ## X6 is about an obligation, not an opportunity
 *
 * Every other rule in this catalogue is about money. X6 is about a *record*:
 * per-wallet basis tracking became the expected treatment for digital assets
 * from the start of 2025, and a position with no basis behind it is a
 * reconstruction job that gets harder every year it is left. The rule names the
 * value with no basis and nothing else, because "how much work is this" is the
 * only quantity involved and it is not a dollar figure.
 */
import type { Insight } from '../../../contract/response.ts';
import type { AdvisorSnapshot } from '../../../contract/snapshot.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  clampImpact,
  formatMoneyJson,
  formatPercent,
  insightOf,
  metric,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { CRYPTO_WASH_SALE_WATCH, detailRef, lotRef, productOf, rateRef } from '../shared.ts';
import { symbolKeyPart } from '../symbol-key.ts';

/** 07 §3.3 X3: more than $5,000 of stablecoins, in minor units. */
const STABLECOIN_FLOOR_MINOR = 500_000n;
/** 07 §3.3 X5: a crypto lot more than $500 below cost, in minor units. */
const CRYPTO_LOSS_FLOOR_MINOR = 50_000n;

/**
 * The rate an idle dollar-pegged balance is measured against.
 *
 * Short-term risk-free first, a savings series second. Both are dated
 * observations; neither is a rate anyone has offered the user.
 */
function idleBenchmark(
  snapshot: AdvisorSnapshot,
): { readonly index: number; readonly rate: number; readonly date: string } | null {
  const rates = snapshot.market_rates?.rates ?? [];
  for (const kind of ['short_term_risk_free', 'savings_apy'] as const) {
    const index = rates.findIndex((row) => row.kind === kind && !row.stale);
    if (index === -1) continue;
    const row = rates[index];
    if (row === undefined) continue;
    return { index, rate: row.rate, date: row.observation_date };
  }
  return null;
}

export const cryptoIdleStablecoins: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.crypto.idle_stablecoins',
    displayName: 'Stablecoins sitting idle',
    purpose:
      'Reports a stablecoin balance above a floor, with what a published short-term rate ' +
      'would have paid on the same amount over a year.',
    scopes: ['holdings.detail', 'market.rates'],
    maxSeverity: 'notable',
    producesImpact: true,
    maxInsights: 8,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const positions = snapshot.holdings_detail?.positions ?? [];
    const benchmark = idleBenchmark(snapshot);
    if (positions.length === 0 || benchmark === null) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const [index, position] of positions.entries()) {
      if (!position.is_stablecoin) continue;
      if (BigInt(position.market_value.minor) < STABLECOIN_FLOOR_MINOR) continue;

      const forgone = productOf(
        snapshot,
        'at_the_published_rate',
        detailRef(index, 'market_value.minor'),
        rateRef(benchmark.index, 'rate'),
        'This balance at a published short-term rate, for a year.',
      );
      if (forgone === null) continue;

      const verdict = clampImpact(
        forgone.value,
        position.market_value.currency,
        `stablecoin balance in ${position.symbol}`,
      );
      if (verdict.kind === 'withheld') {
        warnings.push(verdict.warning);
        continue;
      }
      if (BigInt(verdict.money.minor) <= 0n) continue;

      const valueText = formatMoneyJson(position.market_value);
      const rateText = formatPercent(benchmark.rate);
      const forgoneText = formatMoneyJson(verdict.money);
      if (valueText === null || rateText === null || forgoneText === null) continue;

      insights.push(
        insightOf({
          key: `crypto.idle_stablecoins.${symbolKeyPart(position.symbol)}`,
          period: context.period,
          type: 'crypto.idle_stablecoins',
          severity: 'notable',
          title: 'A dollar-pegged balance is earning nothing',
          summary:
            `${valueText} sits in ${position.symbol}. A published short-term rate was ` +
            `${rateText} on ${benchmark.date}, which on that amount is about ` +
            `${forgoneText} over a year. The balance is also not covered by deposit ` +
            'insurance, and the peg is a promise rather than a guarantee.',
          confidence: 1,
          horizon: 'this_year',
          annualized: verdict.money,
          basis: 'The balance at a dated published short-term rate, over a year.',
          derivationId: forgone.derivation.id,
          derivations: [forgone.derivation],
          evidence: [
            metric('The balance', detailRef(index, 'market_value'), valueText),
            metric('The published rate', rateRef(benchmark.index, 'rate'), null),
            metric(
              'When that rate was observed',
              rateRef(benchmark.index, 'observation_date'),
              benchmark.date,
            ),
          ],
          actions: [
            suggest(
              'Compare the alternatives',
              'A bank account and a short-dated government bill both pay something and both ' +
                'carry their own terms.',
            ),
          ],
          caveats: [
            'A published rate is not an offer anyone has made you, and moving a balance out of ' +
              'a token and into a bank is itself a taxable event in some cases.',
            ...(snapshot.market_rates === undefined ? [] : [snapshot.market_rates.attribution]),
          ],
        }),
      );
    }

    return { insights, warnings };
  },
};

export const cryptoLossLot: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.crypto.loss_lot',
    displayName: 'A crypto lot below what it cost',
    purpose:
      'Reports a crypto lot whose market value is below its cost basis by more than a floor, ' +
      'with the wash-sale position as of the date it was last checked.',
    scopes: ['holdings.detail'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 10,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const positions = context.snapshot.holdings_detail?.positions ?? [];
    if (positions.length === 0) return { insights: [], warnings: [] };

    // The flag is dated in code (`CRYPTO_WASH_SALE_WATCH.asOf`) and the date is
    // deliberately **not** printed: it is not a snapshot value, so the numeral
    // tracer could not account for it and the insight would be rejected at step
    // 7 — correctly, since the check cannot tell a statutory date from an
    // invented one. The copy says "as this app last checked" instead, and the
    // constant is where a reviewer reads the date.
    const washSaleCaveat = CRYPTO_WASH_SALE_WATCH.appliesToDigitalAssets
      ? 'The wash-sale rule is treated here as reaching digital assets, as this app last ' +
        'checked. That treatment changes by legislation rather than gradually.'
      : 'The wash-sale rule does not reach digital assets as this app last checked, because ' +
        'they are treated as property rather than as stocks or bonds. Bills to change that recur, ' +
        'so this is a statement with a date on it rather than a standing one.';

    const insights: Insight[] = [];
    for (const [index, position] of positions.entries()) {
      if (!position.is_crypto) continue;

      for (const [lotIndex, lot] of position.lots.entries()) {
        if (lot.unrealized === null) continue;
        const unrealised = BigInt(lot.unrealized.minor);
        if (unrealised >= 0n) continue;
        if (-unrealised <= CRYPTO_LOSS_FLOOR_MINOR) continue;

        const lossText = formatMoneyJson(lot.unrealized);
        const valueText = formatMoneyJson(lot.market_value);
        if (lossText === null || valueText === null) continue;
        const age = String(lot.opened_days);

        insights.push(
          insightOf({
            key: `crypto.loss_lot.${symbolKeyPart(position.symbol)}.${String(lotIndex)}`,
            period: context.period,
            type: 'crypto.loss_lot',
            severity: 'notable',
            title: 'A crypto lot is below what it cost',
            summary:
              `One ${position.symbol} lot, opened ${age} days ago, is worth ${valueText} ` +
              `and is ${lossText} below its cost.`,
            confidence: 1,
            horizon: 'this_year',
            basis:
              'The lot’s own unrealised loss. No tax figure is claimed: that needs a marginal ' +
              'rate, and a bracket band is not a rate.',
            evidence: [
              metric('What the lot is worth', lotRef(index, lotIndex, 'market_value'), valueText),
              metric('How far below cost it is', lotRef(index, lotIndex, 'unrealized'), lossText),
              metric('Days since the lot was opened', lotRef(index, lotIndex, 'opened_days'), age),
            ],
            actions: [
              suggest(
                'Read about realising a crypto loss',
                'The treatment differs from stocks and bonds, and it is the kind of difference that ' +
                  'changes without much warning.',
              ),
            ],
            caveats: [washSaleCaveat],
          }),
        );
      }
    }

    return { insights: insights.slice(0, 10), warnings: [] };
  },
};

export const cryptoMissingBasis: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.crypto.missing_basis',
    displayName: 'Crypto with no cost basis recorded',
    purpose:
      'Reports crypto holdings with no cost basis behind them, which is a record-keeping ' +
      'obligation rather than a saving.',
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
      if (!position.is_crypto || position.basis_known) continue;
      if (BigInt(position.market_value.minor) <= 0n) continue;

      const valueText = formatMoneyJson(position.market_value);
      if (valueText === null) continue;

      insights.push(
        insightOf({
          key: `crypto.missing_basis.${symbolKeyPart(position.symbol)}`,
          period: context.period,
          type: 'crypto.missing_basis',
          severity: 'notable',
          title: 'A crypto holding has no cost basis behind it',
          summary:
            `${valueText} of ${position.symbol} has no recorded cost basis. Basis is now ` +
            'expected to be tracked per wallet rather than pooled across all of them, and a ' +
            'reconstruction gets harder every year it is left — exchanges close, and their ' +
            'export files go with them.',
          confidence: 1,
          horizon: 'this_year',
          basis:
            'The value with no basis recorded against it. No tax figure is claimed; this is a ' +
            'record, not a saving.',
          evidence: [
            metric('The holding', detailRef(index, 'market_value'), valueText),
            metric('Whether a basis is recorded', detailRef(index, 'basis_known'), 'false'),
          ],
          actions: [
            suggest(
              'Import or reconstruct the basis',
              'Exchange exports, wallet history and your own records are the three sources, ' +
                'and the first one stops being available the day the exchange does.',
            ),
          ],
          caveats: [
            'A holding shown with no basis may simply not have been imported yet. This app ' +
              'reports what it holds, not what you have.',
          ],
        }),
      );
    }

    return { insights: insights.slice(0, 10), warnings: [] };
  },
};
