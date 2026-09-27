// SPDX-License-Identifier: MIT
/**
 * **R1 — saving less than the plan assumes.**
 *
 * 07 §3.3: *"Savings rate < target for the plan"*, impact `Δ% × income`.
 *
 * ## What "the target for the plan" is, here
 *
 * The plan's own assumption. A baseline either **states** its contributions
 * (the holder typed them) or leaves them to WP 4.3's revealed behaviour; the
 * run records which (`PlanSources.contributions`). When they are stated, the
 * projection — and the success probability R2 reads — is computed from money
 * the holder said they would save, and R1 is the check that they are saving
 * it. When they are derived, the plan *is* the observation and the two rates
 * agree by construction, so the rule is silent (`plan_source: 'derived'`).
 *
 * The alternative reading — "the rate that keeps the plan on track", solved
 * for — was weighed and not taken: the only solver a snapshot could afford is
 * the deterministic one, whose "on track" is the median path, and printing
 * "{t}% keeps this plan on track" beside R2's 80% target would be two
 * different definitions of on track in one feed.
 *
 * ## No dollar figure, and why that is the minimisation working
 *
 * 07's impact is the gap times income. `plan.projection` carries two rates
 * over one income and **not the income** — the same choice `risk.profile`
 * makes with a band — so the figure is not computable from what this rule is
 * granted, and computing it would require a scope that carries exactly what
 * 08 §4.2 keeps out. The gap is stated in points instead.
 *
 * ## Severity
 *
 * 07 marks R1 P0. It ships at `warning`: R1 is a cause and R2 is its effect,
 * and a holder whose plan is failing because they under-save would otherwise
 * see two urgent findings for one problem. Recorded in the evidence table.
 */
import type { Insight } from '../../../contract/response.ts';
import * as decimal from '../../../validate/decimal.ts';
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
  projectionOf,
  projectionRef,
} from './shared.ts';

/**
 * One percentage point. Below it the two rates agree to within what a year of
 * rounding and a month's timing can move them, and a finding would be noise.
 */
const TOLERANCE = decimal.parseDecimal('0.01') as decimal.Decimal;

const NOTHING: RuleOutput = Object.freeze({ insights: [], warnings: [] });

export const retirementSavingsRate: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.retirement.savings_rate',
    displayName: 'Saving less than the plan assumes',
    purpose:
      'Compares the savings rate a retirement plan was built on with the rate the linked ' +
      'accounts show, when the plan states its own contributions.',
    scopes: ['plan.projection'],
    maxSeverity: 'warning',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const projection = projectionOf(snapshot);
    if (projection === null) return NOTHING;
    const savings = projection.savings_rate;
    if (typeof savings !== 'object' || savings === null) return NOTHING;
    if (savings.plan_source !== 'stated') return NOTHING;

    const plan = decimalOf(savings.plan);
    const observed = decimalOf(savings.observed);
    if (plan === null || observed === null) return NOTHING;
    const shortfall = decimal.subtract(plan, observed);
    if (shortfall === null || shortfall < TOLERANCE) return NOTHING;

    const gap = pointsGap(
      snapshot,
      'savings_rate_gap_points',
      projectionRef('savings_rate.plan'),
      projectionRef('savings_rate.observed'),
      'The savings rate the plan assumes, less the rate observed, in percentage points.',
    );
    if (gap === null) return NOTHING;

    const planText = formatRatioText(savings.plan);
    const observedText = formatRatioText(savings.observed);
    const gapText = formatPoints(gap.value);
    if (planText === null || observedText === null || gapText === null) return NOTHING;

    const insight: Insight = insightOf({
      key: 'retirement.savings_rate.baseline',
      period: context.period,
      type: 'retirement.savings_rate',
      severity: 'warning',
      title: 'Saving less than the retirement plan assumes',
      summary:
        `The retirement plan assumes contributions of ${planText} of your income. The months ` +
        `this app has observed show ${observedText}, which is ${gapText} below it. The plan’s ` +
        'success probability is computed from the rate it assumes, so it reads higher than ' +
        'your recent saving supports.',
      confidence: 0.9,
      horizon: 'this_year',
      annualized: null,
      basis:
        'No dollar figure: the gap is in points of income, and this scope carries two rates ' +
        'over your income rather than the income itself.',
      derivationId: gap.derivation.id,
      derivations: [gap.derivation],
      evidence: [
        metric('The savings rate the plan assumes', projectionRef('savings_rate.plan'), null),
        metric('The savings rate observed', projectionRef('savings_rate.observed'), null),
        metric(
          'Where the plan’s contributions come from',
          projectionRef('savings_rate.plan_source'),
          'stated',
        ),
      ],
      actions: [
        suggest(
          'Compare the two rates on the plan screen',
          'A scenario at the observed rate, beside the baseline, shows how far the success ' +
            'probability moves between the two.',
        ),
      ],
      caveats: [
        'Both rates are measured against the same income, derived from your linked accounts; ' +
          'saving that happens outside them is not counted.',
        ADVISORY_DISCLAIMER,
      ],
    });
    return { insights: [insight], warnings: [] };
  },
};
