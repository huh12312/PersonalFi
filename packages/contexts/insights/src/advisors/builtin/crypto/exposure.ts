// SPDX-License-Identifier: MIT
/**
 * **X1 — crypto is a large share of net worth** (P0) and **X2 — most of it is
 * held by somebody else.**
 *
 * ## X1: drawdown framing, never a projection
 *
 * 07 §3.3 X1 reads *"Crypto is {p}% of net worth (${val}). A {dd}% drawdown —
 * which has happened repeatedly — would be ${loss}."* The dispatch repeats the
 * constraint in its own words: *"X1 uses drawdown framing, never a
 * projection."*
 *
 * There is no drawdown series in any scope this work package was given, and a
 * hardcoded `dd` would be the hardcoded 4% in different clothes — a numeral
 * nothing in the snapshot accounts for, rejected at the validator's step 7, and
 * rightly so. What *is* expressible, and is what "drawdown framing" means, is a
 * **stated conditional over the position that exists today**: if this fell by
 * half, this much of net worth goes with it. `$0 * 0.5` is a declared
 * derivation the validator re-computes and the UI can show the working for. It
 * claims nothing about frequency, nothing about history, and nothing about
 * what happens next. It is a stress, and the copy calls it one.
 *
 * `produces_impact` is `false` and the manifest says so: the amount at risk in
 * a stress is not a saving, and the alert budget's floor exemption for an
 * insight that claims nothing (`policy/alert-budget.ts`) is exactly the case
 * this is — it ranks on severity, above every saving in the catalogue, which is
 * what P0 means here.
 *
 * ## X2: custody without naming a venue
 *
 * `crypto_custody` splits value three ways — exchange, self-custody, unknown —
 * and names no wallet, no exchange and no address. The finding is about *who
 * can move the coins*, which the split answers completely; which exchange it is
 * adds nothing to the advice and is an identifier the snapshot has no business
 * carrying.
 */
import { builtinManifest } from '../../manifest.ts';
import {
  formatMinor,
  formatMoneyJson,
  formatPercent,
  insightOf,
  metric,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { aggregateRef, halfOf, netWorthRef } from '../shared.ts';

/** 07 §3.3 X1's default `T`: a tenth of net worth. */
const CRYPTO_SHARE_THRESHOLD = 0.1;
/** 07 §3.3 X2: more than half the crypto value held by somebody else. */
const EXCHANGE_CUSTODY_THRESHOLD = 2n;

/** The asset-class key 07 §4.3's taxonomy uses. */
const CRYPTO_ASSET_CLASS = 'CRYPTO';

export const cryptoNetWorthShare: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.crypto.net_worth_share',
    displayName: 'Crypto as a share of net worth',
    purpose:
      'Reports crypto worth more than a tenth of net worth, and frames the exposure as what ' +
      'a fall of half would take with it.',
    scopes: ['holdings.aggregate', 'networth.summary'],
    maxSeverity: 'urgent',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const aggregate = snapshot.holdings_aggregate;
    const netWorth = snapshot.networth_summary;
    if (aggregate === undefined || netWorth === undefined) return { insights: [], warnings: [] };

    const index = aggregate.by_asset_class.findIndex(
      (row) => row.asset_class === CRYPTO_ASSET_CLASS,
    );
    if (index === -1) return { insights: [], warnings: [] };
    const crypto = aggregate.by_asset_class[index];
    if (crypto === undefined) return { insights: [], warnings: [] };

    const cryptoMinor = BigInt(crypto.value.minor);
    const netWorthMinor = BigInt(netWorth.net_worth.minor);
    if (cryptoMinor <= 0n || netWorthMinor <= 0n) return { insights: [], warnings: [] };
    // Against net worth, which is what 07 X1 asks for — not against investable
    // assets, which is I4's denominator. The two differ by every liability and
    // every asset that is not a holding, and using the wrong one here would
    // understate the exposure for anyone carrying a mortgage.
    if (cryptoMinor * 10n <= netWorthMinor) return { insights: [], warnings: [] };

    const share = Number(cryptoMinor) / Number(netWorthMinor);
    if (!Number.isFinite(share) || share <= CRYPTO_SHARE_THRESHOLD) {
      return { insights: [], warnings: [] };
    }

    const stress = halfOf(
      snapshot,
      'crypto_at_half',
      `${aggregateRef(`by_asset_class[${String(index)}].value.minor`)}`,
      'What this holding is worth today, halved. A stated stress, not a forecast.',
    );
    if (stress === null) return { insights: [], warnings: [] };

    const valueText = formatMoneyJson(crypto.value);
    const netWorthText = formatMoneyJson(netWorth.net_worth);
    const weightText = formatPercent(crypto.weight);
    const stressText = formatMinor(stress.value);
    if (valueText === null || netWorthText === null || weightText === null || stressText === null) {
      return { insights: [], warnings: [] };
    }

    return {
      insights: [
        insightOf({
          key: 'crypto.net_worth_share',
          period: context.period,
          type: 'crypto.net_worth_share',
          severity: 'urgent',
          title: 'Crypto is a large share of what you own',
          summary:
            `Crypto is worth ${valueText} against a net worth of ${netWorthText}, and ` +
            `${weightText} of the portfolio. If it fell by half from where it is today, ` +
            `about ${stressText} would go with it. That is a stress applied to the position ` +
            'you hold now, not a forecast of anything.',
          confidence: 1,
          horizon: 'long_term',
          basis:
            'The holding halved. No claim is made about how often that happens or whether it ' +
            'will; the figure is what today’s position would leave behind if it did.',
          derivationId: stress.derivation.id,
          derivations: [stress.derivation],
          evidence: [
            metric(
              'What the crypto is worth',
              aggregateRef(`by_asset_class[${String(index)}].value`),
              valueText,
            ),
            metric(
              'Its share of the portfolio',
              aggregateRef(`by_asset_class[${String(index)}].weight`),
              null,
            ),
            metric('Net worth', netWorthRef('net_worth'), netWorthText),
          ],
          actions: [
            suggest(
              'Set a band you are comfortable with',
              'A band you decided on in advance is the thing that survives a week when the ' +
                'price is moving; a decision taken during one usually is not.',
            ),
          ],
          caveats: [
            'Net worth here is rounded, so the share is approximate at the edges.',
            'The stress is a round number chosen to be legible. It is not drawn from any ' +
              'history and it is not a prediction.',
          ],
        }),
      ],
      warnings: [],
    };
  },
};

export const cryptoExchangeCustody: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.crypto.exchange_custody',
    displayName: 'Crypto held by somebody else',
    purpose:
      'Reports when more than half of crypto value sits with an exchange rather than in ' +
      'self-custody.',
    scopes: ['holdings.aggregate'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const custody = context.snapshot.holdings_aggregate?.crypto_custody;
    if (custody === undefined) return { insights: [], warnings: [] };

    const onExchange = BigInt(custody.exchange_value.minor);
    const selfCustody = BigInt(custody.self_custody_value.minor);
    const unknown = BigInt(custody.unknown_value.minor);
    const total = onExchange + selfCustody + unknown;
    if (total <= 0n || onExchange <= 0n) return { insights: [], warnings: [] };
    if (onExchange * EXCHANGE_CUSTODY_THRESHOLD <= total) return { insights: [], warnings: [] };

    const exchangeText = formatMoneyJson(custody.exchange_value);
    const selfText = formatMoneyJson(custody.self_custody_value);
    if (exchangeText === null || selfText === null) return { insights: [], warnings: [] };

    return {
      insights: [
        insightOf({
          key: 'crypto.exchange_custody',
          period: context.period,
          type: 'crypto.exchange_custody',
          severity: 'notable',
          title: 'Most of your crypto is held by somebody else',
          summary:
            `${exchangeText} of crypto sits with an exchange against ${selfText} in ` +
            'self-custody. An exchange balance is a claim on a company rather than a coin ' +
            'you control, and that distinction only matters on the day the company has a ' +
            'problem.',
          confidence: 1,
          horizon: 'long_term',
          basis:
            'A split of value by who holds the keys. No figure is claimed for the risk: ' +
            'counterparty failure is not something this app can put a number on.',
          evidence: [
            metric(
              'Held with an exchange',
              aggregateRef('crypto_custody.exchange_value'),
              exchangeText,
            ),
            metric(
              'Held in self-custody',
              aggregateRef('crypto_custody.self_custody_value'),
              selfText,
            ),
          ],
          actions: [
            suggest(
              'Read about self-custody',
              'Self-custody moves the risk rather than removing it: a lost key is as final as ' +
                'a failed exchange, and this app will never ask you for one.',
            ),
          ],
          caveats: [
            'Anything this app could not attribute to a wallet or an exchange is counted in ' +
              'neither figure above.',
          ],
        }),
      ],
      warnings: [],
    };
  },
};
