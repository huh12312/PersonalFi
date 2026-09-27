// SPDX-License-Identifier: MIT
/**
 * **R3 — the Roth-conversion window before required distributions.**
 *
 * 07 §3.3: *"Age within 10 years of RMD age, with large tax-deferred
 * balance"* → *"RMDs start at {age} ({year}). Your projected first RMD is
 * ~${amt}; the years before then are the widest Roth-conversion window."*
 *
 * ## The half of 07's sentence this rule does not say
 *
 * *"Your projected first RMD is ~${amt}"* is the tax-deferred balance carried
 * forward to the start age at an assumed return, divided by a life-table
 * factor. That is a speculative return compounded into a headline dollar
 * figure — exactly what 07 §3.2 and the dispatch forbid — so it is left out
 * and the caveat says why. What remains is statutory and observed: the start
 * age SECURE 2.0 sets for the holder's birth year (WP 4.2's file, never a
 * constant here), the year that lands in, and how much of what the plan starts
 * from is tax-deferred.
 *
 * ## "Large", made a share
 *
 * `plan.projection` carries no balance, by design; the tax-deferred bucket
 * crosses as a *share* of the plan's starting assets. "Large" is therefore
 * "at least half": the case where required distributions dominate
 * retirement income and the conversion window matters most. A holder with a
 * small tax-deferred share has little to convert and is not told to look.
 *
 * ## No dollar figure
 *
 * 07's impact is `tax_bracket_arbitrage × converted` — a conversion amount the
 * holder has not chosen and a bracket in years not yet reached. Both are
 * forecasts. The finding stands on the dates and the share.
 */
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
import {
  ADVISORY_DISCLAIMER,
  decimalOf,
  differenceOf,
  formatRatioText,
  formatWhole,
  integerOf,
  projectionOf,
  projectionRef,
} from './shared.ts';

/** 07 R3: "within 10 years of RMD age". */
const WINDOW_YEARS = 10;
/** "Large", as a share of the plan's starting assets. See the header. */
const LARGE_SHARE = decimal.parseDecimal('0.5') as decimal.Decimal;

const NOTHING: RuleOutput = Object.freeze({ insights: [], warnings: [] });

export const retirementRmdWindow: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.retirement.rmd_window',
    displayName: 'The years before required distributions begin',
    purpose:
      'Reports the years left before required minimum distributions start, when at least ' +
      'half of what the retirement plan starts from is tax-deferred.',
    scopes: ['plan.projection'],
    maxSeverity: 'notable',
    producesImpact: false,
    maxInsights: 1,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const projection = projectionOf(snapshot);
    if (projection === null) return NOTHING;
    const rmd = projection.rmd;
    if (typeof rmd !== 'object' || rmd === null) return NOTHING;
    const ages = projection.ages as typeof projection.ages | undefined;
    const current = integerOf(ages?.current);
    const startAge = integerOf(rmd.start_age);
    const startYear = integerOf(rmd.start_year);
    if (current === null || startAge === null || startYear === null) return NOTHING;
    if (current >= startAge || current < startAge - WINDOW_YEARS) return NOTHING;
    const share = decimalOf(rmd.tax_deferred_share);
    if (share === null || share < LARGE_SHARE) return NOTHING;

    const years = differenceOf(
      snapshot,
      'years_until_rmd',
      projectionRef('rmd.start_age'),
      projectionRef('ages.current'),
      'The age distributions start, less your age now.',
    );
    if (years === null) return NOTHING;
    const yearsText = formatWhole(years.value);
    const shareText = formatRatioText(rmd.tax_deferred_share);
    if (yearsText === null || shareText === null) return NOTHING;
    const unit = yearsText === '1' ? 'year' : 'years';

    return {
      insights: [
        insightOf({
          key: `retirement.rmd_window.${String(startYear)}`,
          period: context.period,
          type: 'retirement.rmd_window',
          severity: 'notable',
          title: 'The years before required distributions begin',
          summary:
            `Required minimum distributions start at age ${String(startAge)}, in ` +
            `${String(startYear)}. ${shareText} of what the retirement plan starts from is ` +
            `tax-deferred, and the ${yearsText} ${unit} before then are the widest window for ` +
            'Roth conversions, while how much comes out each year is still your choice.',
          confidence: 1,
          horizon: 'long_term',
          annualized: null,
          basis:
            'No dollar figure: what a conversion saves depends on an amount not yet chosen and ' +
            'on tax brackets in years not yet reached.',
          derivationId: years.derivation.id,
          derivations: [years.derivation],
          evidence: [
            metric('The age distributions start', projectionRef('rmd.start_age'), null),
            metric('The year that falls in', projectionRef('rmd.start_year'), null),
            metric('Your age now', projectionRef('ages.current'), null),
            metric('The tax-deferred share', projectionRef('rmd.tax_deferred_share'), null),
          ],
          actions: [
            suggest(
              'Look at the tax-deferred share',
              'A conversion is taxed as income in the year it is made, so its cost depends on ' +
                'that year’s bracket and on the rest of that year’s income.',
            ),
          ],
          caveats: [
            'No estimate of a first distribution is given: it would carry today’s balance ' +
              'forward at an assumed return, and this catalogue never puts one in a headline.',
            ADVISORY_DISCLAIMER,
          ],
        }),
      ],
      warnings: [],
    };
  },
};
