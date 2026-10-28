// SPDX-License-Identifier: MIT
/**
 * **I1 — drift against a target allocation**, and the two things it refuses to
 * do.
 *
 * ## It refuses to invent a target
 *
 * 03-phase-3-dispatch.md §6 Q5: *"ask in onboarding; drift alerts suppressed
 * until it is set. WP 3.10's rules withhold rather than invent a 60/40. An
 * unset target never becomes an implied one."* So an empty
 * `target_allocation` produces no insight and no warning — there is nothing
 * wrong, there is simply nothing to compare against, and a rule that supplied a
 * benchmark would be telling the user what their plan is.
 *
 * ## It refuses to speak over an unclassified portfolio
 *
 * 07 §4.3, normative: *"If 18% of the portfolio is unclassified, a '7pp drift'
 * claim is noise, and rule I1 must suppress itself when `unclassified_pct >
 * 10%`."* This is the only rule in the catalogue that switches *itself* off on
 * a data-quality signal, and the reason is that its output is uniquely
 * vulnerable to one: every weight is a share of a denominator, so an
 * unclassified tenth does not add noise evenly — it moves every sleeve at once,
 * in the same direction, by an amount that looks exactly like drift.
 *
 * The suppression is **withholding, not clamping**. Zero insights, and a line
 * in `diagnostics.warnings` saying why — which lands on `advisor_runs`, is
 * never rendered, and is what distinguishes "I1 found nothing" from "I1 refused
 * to answer". `test/i1-suppression.test.ts` sabotages the threshold and watches
 * the withholding stop.
 *
 * ## Δσ, not dollars
 *
 * 07 §3.3's impact column for I1 says *"risk-adjusted, show `Δσ` not $"*. There
 * is no volatility series in any scope this work package was given, so the
 * honest reading of "not dollars" is the one this rule implements: the output
 * is a **difference in weight, in percentage points**, `produces_impact` is
 * `false`, and the manifest says so — which means the pipeline would refuse a
 * dollar figure from this rule even if a future edit tried to add one. What
 * `Δσ` would need, and does not have, is recorded in the evidence doc rather
 * than approximated here.
 */
import type { Insight } from '../../../contract/response.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  formatPercent,
  insightOf,
  metric,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import {
  aggregateRef,
  assetClassRef,
  formatPoints,
  pointsGap,
  targetRef,
  UNCLASSIFIED_SUPPRESSION_THRESHOLD,
} from '../shared.ts';

/** 07 §3.3 I1: `|actual_weight − target_weight| > 5pp`. */
export const DRIFT_BAND = 0.05;
/** Twice the band. Past it the sleeve is not drifting, it is somewhere else. */
const DRIFT_WARNING_BAND = 0.1;

export const investingDrift: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.investing.drift',
    displayName: 'Drift from your target allocation',
    purpose:
      'Compares each asset class against the target you set, in percentage points, and ' +
      'withholds entirely when too much of the portfolio is unclassified to measure.',
    scopes: ['holdings.aggregate'],
    maxSeverity: 'warning',
    producesImpact: false,
    maxInsights: 8,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const aggregate = snapshot.holdings_aggregate;
    if (aggregate === undefined) return { insights: [], warnings: [] };

    // An unset target is not a drift of zero and it is not a drift against a
    // default. It is a question nobody has answered.
    if (aggregate.target_allocation.length === 0) return { insights: [], warnings: [] };

    if (aggregate.unclassified_pct > UNCLASSIFIED_SUPPRESSION_THRESHOLD) {
      const coverage = formatPercent(aggregate.unclassified_pct) ?? 'an unknown share';
      return {
        insights: [],
        warnings: [
          `I1 withheld: ${coverage} of the portfolio is unclassified, over the one-tenth ` +
            'ceiling 07 §4.3 sets. Every weight shares that denominator, so a drift figure ' +
            'would be an artefact of the coverage.',
        ],
      };
    }

    const unclassifiedText = formatPercent(aggregate.unclassified_pct);
    if (unclassifiedText === null) return { insights: [], warnings: [] };

    const insights: Insight[] = [];
    for (const [targetIndex, target] of aggregate.target_allocation.entries()) {
      const actualIndex = aggregate.by_asset_class.findIndex(
        (row) => row.asset_class === target.asset_class,
      );
      // A class the user planned for and does not hold is a real drift of the
      // whole target weight, and `by_asset_class` has no row to cite for it.
      // Citing a ref that does not resolve would fail the pipeline, so the case
      // is skipped here and named in the evidence doc as owed to the builder,
      // which should emit a zero-weight row rather than omit the class.
      if (actualIndex === -1) continue;
      const actual = aggregate.by_asset_class[actualIndex];
      if (actual === undefined) continue;

      const gap = actual.weight - target.weight;
      if (Math.abs(gap) <= DRIFT_BAND) continue;

      const drift = pointsGap(
        snapshot,
        'drift_in_points',
        assetClassRef(actualIndex, 'weight'),
        targetRef(targetIndex, 'weight'),
        'What this sleeve holds now, less what you planned for it, in percentage points.',
      );
      if (drift === null) continue;

      const gapText = formatPoints(drift.value);
      const actualText = formatPercent(actual.weight);
      const targetText = formatPercent(target.weight);
      if (gapText === null || actualText === null || targetText === null) continue;

      const direction = gap > 0 ? 'above' : 'below';

      insights.push(
        insightOf({
          key: `investing.drift.${target.asset_class}`,
          period: context.period,
          type: 'investing.drift',
          severity: Math.abs(gap) >= DRIFT_WARNING_BAND ? 'warning' : 'notable',
          title: 'One sleeve has drifted from the target you set',
          summary:
            `${target.asset_class} is ${actualText} of the portfolio against a ` +
            `${targetText} target — ${gapText} ${direction} it. With ${unclassifiedText} ` +
            'of the portfolio unclassified, that gap is measured over what could be ' +
            'classified and no further.',
          confidence: 1,
          horizon: 'this_year',
          basis:
            'A difference in weight, in percentage points. No dollar figure is claimed: ' +
            'a weight gap is a risk statement, and turning it into money would need a ' +
            'volatility estimate this app does not hold.',
          derivationId: drift.derivation.id,
          derivations: [drift.derivation],
          evidence: [
            metric('What this sleeve holds now', assetClassRef(actualIndex, 'weight'), null),
            metric('The target you set for it', targetRef(targetIndex, 'weight'), null),
            metric(
              'Share of the portfolio that could not be classified',
              aggregateRef('unclassified_pct'),
              null,
            ),
          ],
          actions: [
            suggest(
              'Review the drift band',
              'Directing new contributions at the lighter sleeve narrows a gap without a ' +
                'disposal in a taxable account, and so without realising a gain.',
            ),
          ],
          caveats: [
            'A weight gap is not a saving. What correcting it costs depends on which account ' +
              'the trade happens in, and on the gain sitting in the lots involved.',
            'Fund look-through is at fund level only, so a fund holding several asset classes ' +
              'counts once, under its own.',
          ],
        }),
      );
    }

    return { insights, warnings: [] };
  },
};
