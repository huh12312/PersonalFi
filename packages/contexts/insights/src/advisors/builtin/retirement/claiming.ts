// SPDX-License-Identifier: MIT
/**
 * **R4 — the claiming-age comparison, from 55.**
 *
 * 07 §3.3: *"Age ≥ 55, no claiming strategy set"* → *"Claiming at 70 instead
 * of 62 raises your monthly benefit from ${a} to ${b} (inflation-adjusted)."*
 *
 * ## "No claiming strategy set" is not observable, so the rule is re-read
 *
 * A baseline that models Social Security always carries a claim age — WP 4.6's
 * profile makes it required, and a plan with no claim age has no benefit in it
 * at all. So the condition 07 names never occurs as a stored fact. What *does*
 * occur, and is what 07's comparison exists for, is a plan that claims before
 * seventy without the holder having seen the difference. The rule therefore
 * fires from 55 whenever the plan claims before seventy, and dismissal (WP 2.6's
 * cooldown ladder) is how a holder who has seen it and chosen says so.
 *
 * ## Factors, not dollars
 *
 * 07 prints two monthly benefits. A benefit is the holder's primary insurance
 * amount times a statutory factor, and the PIA is a function of a lifetime of
 * earnings — income by another name, which `plan.projection` is shaped not to
 * carry. The **ratio** of the two factors is the whole comparison and carries
 * no earnings at all: `($0 / $1 - 1) * 100` is how much larger each payment
 * would be at seventy. The comparison is against the plan's own claim age
 * rather than 62, because that is the choice actually in front of the holder.
 *
 * ## No dollar figure
 *
 * 07's impact is `PV(70) − PV(62)`: a discount rate and a lifespan, both
 * forecasts, and the one quantity a claiming decision actually turns on.
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
  factorUplift,
  formatPercentValue,
  integerOf,
  projectionOf,
  projectionRef,
} from './shared.ts';

/** 07 R4: "Age ≥ 55". */
const FROM_AGE = 55;
/** SSA's delayed retirement credits end at seventy; there is nothing later to compare. */
const LATEST_CLAIM_AGE = 70;

const NOTHING: RuleOutput = Object.freeze({ insights: [], warnings: [] });

export const retirementClaimingAge: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.retirement.claiming_age',
    displayName: 'Claiming Social Security at seventy instead',
    purpose:
      'From age 55, compares the Social Security benefit at the plan’s claim age with the ' +
      'benefit at seventy, as the statutory adjustment between the two.',
    scopes: ['plan.projection'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const projection = projectionOf(snapshot);
    if (projection === null) return NOTHING;
    const social = projection.social_security;
    if (typeof social !== 'object' || social === null) return NOTHING;
    const ages = projection.ages as typeof projection.ages | undefined;
    const current = integerOf(ages?.current);
    const claimYears = integerOf(social.claim_age_years);
    const claimMonths = integerOf(social.claim_age_months);
    if (current === null || claimYears === null || claimMonths === null) return NOTHING;
    if (current < FROM_AGE || current >= LATEST_CLAIM_AGE) return NOTHING;
    if (claimYears >= LATEST_CLAIM_AGE) return NOTHING;
    const atClaim = decimalOf(social.claim_factor);
    const atSeventy = decimalOf(social.factor_at_70);
    if (atClaim === null || atSeventy === null || atClaim <= 0n || atSeventy <= atClaim) {
      return NOTHING;
    }

    const uplift = factorUplift(
      snapshot,
      'benefit_uplift_at_seventy',
      projectionRef('social_security.factor_at_70'),
      projectionRef('social_security.claim_factor'),
      'The benefit factor at seventy over the factor at the plan’s claim age, less one, in percent.',
    );
    if (uplift === null) return NOTHING;
    const upliftText = formatPercentValue(uplift.value);
    if (upliftText === null) return NOTHING;
    const claimText =
      claimMonths === 0
        ? String(claimYears)
        : `${String(claimYears)} and ${String(claimMonths)} ${claimMonths === 1 ? 'month' : 'months'}`;

    return {
      insights: [
        insightOf({
          key: `retirement.claiming_age.${String(claimYears)}_${String(claimMonths)}`,
          period: context.period,
          type: 'retirement.claiming_age',
          severity: 'notable',
          title: 'Claiming Social Security at seventy instead',
          summary:
            `The retirement plan claims Social Security at ${claimText}. Claiming at seventy ` +
            `instead makes each monthly payment ${upliftText} larger, for life and in today’s ` +
            'dollars, in exchange for the payments that would have arrived in between.',
          confidence: 1,
          horizon: 'long_term',
          annualized: null,
          basis:
            'No dollar figure: which age pays more in total depends on how long benefits are ' +
            'collected, and no rule can know that.',
          derivationId: uplift.derivation.id,
          derivations: [uplift.derivation],
          evidence: [
            metric('Your age now', projectionRef('ages.current'), null),
            metric('The plan’s claim age', projectionRef('social_security.claim_age_years'), null),
            metric(
              'The benefit factor at that age',
              projectionRef('social_security.claim_factor'),
              null,
            ),
            metric(
              'The benefit factor at seventy',
              projectionRef('social_security.factor_at_70'),
              null,
            ),
          ],
          actions: [
            suggest(
              'Compare claim ages on the plan screen',
              'A scenario with a later claim age runs the same plan under the same random ' +
                'draws, so the success probabilities of the two can be read side by side.',
            ),
          ],
          caveats: [
            'The factors are the Social Security Administration’s own adjustment for the ' +
              'claiming age, and assume the benefit formula stays as legislated.',
            ADVISORY_DISCLAIMER,
          ],
        }),
      ],
      warnings: [],
    };
  },
};
