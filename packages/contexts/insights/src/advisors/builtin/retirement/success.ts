// SPDX-License-Identifier: MIT
/**
 * **R2 — Monte Carlo success below the plan's target.**
 *
 * 07 §3.3: *"Monte Carlo success < 80%"*, impact *"Δ success pp"*. The
 * dispatch: *"R2 reports probability points, not dollars"*, and 07 §7.2's
 * preferred form is the sentence this rule is built around — *"In 10,000
 * simulations using historical return sequences, this plan lasted through age
 * 95 in 86% of them."*
 *
 * ## The threshold is the plan's, not a constant here
 *
 * `success_target` crosses in the block (WP 4.5's `DEFAULT_SUCCESS_TARGET`,
 * `'0.80'`, 09 GOAL-7's default and dispatch §6 Q5's). Reading it rather than
 * restating `0.8` means the figure the sentence prints is a figure the snapshot
 * carries — the numeral tracer would refuse a hardcoded "80%" — and that the
 * day the target becomes a per-holder setting, R2 moves with it.
 *
 * ## Three refusals
 *
 *   * **A deterministic run is not a probability.** Its `success_probability`
 *     is `1` or `0` (one path, succeeded or not); reporting "0% of 1
 *     simulation" would be a category error presented as a measurement.
 *   * **A stale run is not reported.** Its assumptions are retired or have
 *     changed since, and WP 4.6 reads it back as it was rather than
 *     recomputing; alarming on it would be alarming on a plan the holder has
 *     already changed. The nightly refresh produces a current one.
 *   * **No "retiring {k} years later raises it to {p2}%".** 07's template has
 *     that clause, and each figure in it needs a second run under common
 *     random numbers. The snapshot carries one run, so the levers are named in
 *     words and the plan screen — which does run the compare — shows the figures.
 *
 * ## Severity
 *
 * `urgent`: a plan that fails in more simulations than its own target allows
 * is the one retirement finding that should reach the dashboard first.
 */
import { builtinManifest } from '../../manifest.ts';
import {
  insightOf,
  metric,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { formatPoints, pointsGap } from '../shared.ts';
import {
  ADVISORY_DISCLAIMER,
  decimalOf,
  formatRatioText,
  integerOf,
  projectionOf,
  projectionRef,
} from './shared.ts';

const NOTHING: RuleOutput = Object.freeze({ insights: [], warnings: [] });

/** `10000` → `10,000`. A count, grouped for reading; the tracer strips the comma. */
function grouped(count: number): string {
  return count.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export const retirementSuccessProbability: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.retirement.success_probability',
    displayName: 'A retirement plan below its success target',
    purpose:
      'Reports a Monte Carlo baseline whose share of successful simulations is below the ' +
      'target the plan is measured against, in probability points.',
    scopes: ['plan.projection'],
    maxSeverity: 'urgent',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const projection = projectionOf(snapshot);
    if (projection === null) return NOTHING;
    if (projection.method !== 'monte_carlo' || projection.stale !== false) return NOTHING;

    const success = decimalOf(projection.success_probability);
    const target = decimalOf(projection.success_target);
    if (success === null || target === null || success >= target) return NOTHING;
    const paths = integerOf(projection.paths);
    const ages = projection.ages as typeof projection.ages | undefined;
    const planEnd = integerOf(ages?.plan_end);
    if (paths === null || paths < 2 || planEnd === null) return NOTHING;

    const gap = pointsGap(
      snapshot,
      'success_gap_points',
      projectionRef('success_target'),
      projectionRef('success_probability'),
      'The success target less the share of simulations the plan survives, in points.',
    );
    if (gap === null || gap.value <= 0n) return NOTHING;

    const successText = formatRatioText(projection.success_probability);
    const targetText = formatRatioText(projection.success_target);
    const gapText = formatPoints(gap.value);
    if (successText === null || targetText === null || gapText === null) return NOTHING;

    return {
      insights: [
        insightOf({
          key: 'retirement.success_probability.baseline',
          period: context.period,
          type: 'retirement.success_probability',
          severity: 'urgent',
          title: 'The retirement plan falls short of its success target',
          summary:
            `In ${grouped(paths)} simulations of market returns, this plan lasted through age ` +
            `${String(planEnd)} in ${successText} of them. The plan is measured against ` +
            `${targetText}, so it sits ${gapText} short. Retiring later, saving more and ` +
            'spending less each move that share; the plan screen compares them side by side.',
          confidence: 1,
          horizon: 'long_term',
          annualized: null,
          basis:
            'Probability points, not dollars: the distance between the share of simulations ' +
            'this plan survives and the share it is measured against.',
          derivationId: gap.derivation.id,
          derivations: [gap.derivation],
          evidence: [
            metric(
              'Share of simulations the plan survives',
              projectionRef('success_probability'),
              null,
            ),
            metric('The target it is measured against', projectionRef('success_target'), null),
            metric('How many simulations were run', projectionRef('paths'), null),
            metric('The age the plan must last to', projectionRef('ages.plan_end'), null),
            metric(
              'The assumptions it ran under',
              projectionRef('assumptions_version'),
              projection.assumptions_version,
            ),
          ],
          actions: [
            suggest(
              'Compare scenarios on the plan screen',
              'A later retirement age, a higher savings rate and lower spending are each a ' +
                'scenario; the compare view runs them under the same random draws.',
            ),
          ],
          caveats: [
            'A simulation samples possible sequences of returns; it describes a range of ' +
              'outcomes, not a forecast of one.',
            ADVISORY_DISCLAIMER,
          ],
        }),
      ],
      warnings: [],
    };
  },
};
