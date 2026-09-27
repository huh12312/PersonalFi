// SPDX-License-Identifier: MIT
/**
 * **R7 — a withdrawal rate outside the guardrail band.**
 *
 * 07 §3.3: *"(Decumulation) withdrawal rate outside guardrails"* → *"Your
 * withdrawal rate is {w}% vs the {lo}–{hi}% guardrail band."*, impact
 * `Δspend`, action *"Guyton-Klinger adjustment"*.
 *
 * ## Where the band comes from
 *
 * 07 §5.6: `UPPER = initial_wr × 1.20`, `LOWER = initial_wr × 0.80`, with
 * `initial_wr = 0.045 # user-settable`. The multiples are WP 4.4's
 * `GUYTON_KLINGER`; the reference rate is 07's default, applied by the
 * composition root, and both bounds cross in the block — so every percentage
 * this rule prints is a snapshot value and none is a constant here. The block
 * exists only in **decumulation** (the holder is at or past the plan's
 * retirement age and the portfolio funds some of this year's spending); an
 * accumulating holder has no withdrawal rate to be outside anything.
 *
 * ## Two severities
 *
 * Above the band is 07's capital-preservation case — the method would cut
 * planned spending by a tenth — and is `urgent`, the P0 07 marks it. Below
 * the band is the prosperity case — spending *may* rise by a tenth — which is
 * good news and ships at `info`. One rule, because it is one measurement.
 *
 * ## No dollar figure
 *
 * `Δspend` is a change in what the holder spends, not a saving; ranking it as
 * an annual impact would put a spending cut in the same column as a fee
 * avoided. And the spending figure itself does not cross `plan.projection`.
 * "A tenth" is the method's own step, stated in words.
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
import {
  ADVISORY_DISCLAIMER,
  decimalOf,
  formatRatioText,
  projectionOf,
  projectionRef,
} from './shared.ts';

const NOTHING: RuleOutput = Object.freeze({ insights: [], warnings: [] });

export const retirementWithdrawalGuardrail: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.retirement.withdrawal_guardrail',
    displayName: 'A withdrawal rate outside the guardrail band',
    purpose:
      'In retirement, compares this year’s portfolio withdrawal rate with the guardrail band ' +
      'around the method’s starting rate, and says which way it falls outside.',
    scopes: ['plan.projection'],
    maxSeverity: 'urgent',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const projection = projectionOf(snapshot);
    if (projection === null) return NOTHING;
    const rails = projection.guardrail;
    if (typeof rails !== 'object' || rails === null) return NOTHING;

    const rate = decimalOf(rails.withdrawal_rate);
    const lower = decimalOf(rails.lower);
    const upper = decimalOf(rails.upper);
    if (rate === null || lower === null || upper === null || lower >= upper) return NOTHING;
    // Decided from the three figures, and required to agree with the port's
    // label: a block whose `position` contradicts its own numbers is a bug
    // upstream, and neither reading of it is safe to print.
    const position = rate > upper ? 'above' : rate < lower ? 'below' : 'within';
    if (position === 'within' || rails.position !== position) return NOTHING;

    const rateText = formatRatioText(rails.withdrawal_rate);
    const lowerText = formatRatioText(rails.lower);
    const upperText = formatRatioText(rails.upper);
    const referenceText = formatRatioText(rails.reference_rate);
    if (rateText === null || lowerText === null || upperText === null || referenceText === null) {
      return NOTHING;
    }

    const above = position === 'above';
    return {
      insights: [
        insightOf({
          key: `retirement.withdrawal_guardrail.${position}`,
          period: context.period,
          type: 'retirement.withdrawal_guardrail',
          severity: above ? 'urgent' : 'info',
          title: above
            ? 'Withdrawals are above the guardrail band'
            : 'Withdrawals are below the guardrail band',
          summary:
            `This year the plan draws ${rateText} of the portfolio, ${position} the ${lowerText} ` +
            `to ${upperText} guardrail band around a ${referenceText} starting rate. ` +
            (above
              ? 'Under the guardrail method, a rate above the band is the point at which planned ' +
                'spending is trimmed by a tenth, so the portfolio is not drawn down faster than ' +
                'it can sustain.'
              : 'Under the guardrail method, a rate below the band is the point at which planned ' +
                'spending may rise by a tenth.'),
          confidence: 1,
          horizon: 'this_year',
          annualized: null,
          basis:
            'No dollar figure: the adjustment is a change in what you spend, not a saving, and ' +
            'your spending does not cross this scope.',
          evidence: [
            metric('This year’s withdrawal rate', projectionRef('guardrail.withdrawal_rate'), null),
            metric('The lower guardrail', projectionRef('guardrail.lower'), null),
            metric('The upper guardrail', projectionRef('guardrail.upper'), null),
            metric('The starting rate', projectionRef('guardrail.reference_rate'), null),
          ],
          actions: [
            suggest(
              'Review retirement spending on the plan screen',
              'The plan’s withdrawal policy and its spending floor are both on the plan screen, ' +
                'and a scenario shows the success probability with the adjustment made.',
            ),
          ],
          caveats: [
            'The band is drawn around the guardrail method’s default starting rate; a ' +
              'retirement that began at a different rate has a different band.',
            ADVISORY_DISCLAIMER,
          ],
        }),
      ],
      warnings: [],
    };
  },
};
