// SPDX-License-Identifier: MIT
/**
 * **R6 — a goal below its required-by-date pace.**
 *
 * 07 §3.3: *"Any goal's funded ratio < required-by-date pace"* → *"{goal}
 * needs ${m}/mo to reach ${target} by {date}; you're contributing ${c}."*,
 * impact `shortfall`.
 *
 * ## The verdict is WP 4.6's, not this rule's
 *
 * `evaluateGoalPace` (`@ctx/planning`, 07 R6 made exact) decides on and off
 * track from the unrounded amounts — funded plus planned against target — and
 * computes `m` (rounded *up* to the cent, so the stated pace does reach the
 * target) and `c`. They cross in `goals_list[].pace` as money, and this rule
 * reads the verdict rather than re-deriving it from a rounded progress ratio,
 * which would disagree with the goal-pace consumer's `GoalOffTrack` event at
 * the margin and make two parts of the app say two things.
 *
 * `{date}` becomes *"in {n} months"*: the block carries a month count and
 * never the target date, by the scope row's own minimisation.
 *
 * ## The one rule in the family that claims a figure
 *
 * `($0 - $1) * 12` — the monthly gap between what reaches the target on time
 * and what is planned, over a year. Both inputs are today's plans in today's
 * money; nothing is projected and no return is assumed. It is subject to the
 * impact ceiling, and an outlier is **withheld, never clamped**: WP 2.7's
 * ruling in `support.ts`' `clampImpact` — printing the ceiling for a computed
 * figure would put a number on screen that is in neither the snapshot nor any
 * declared arithmetic. The insight survives with a caveat saying so.
 *
 * Retirement goals do not reach this rule: WP 4.6 evaluates them through the
 * projection (R2), not a savings pace, and `goals.list` carries only rows with
 * a pace verdict. A goal whose date has arrived (`horizon_months: 0`) is
 * skipped — "a month" of pace is not a pace.
 */
import type { Insight } from '../../../contract/response.ts';
import { builtinManifest } from '../../manifest.ts';
import {
  clampImpact,
  formatMoneyJson,
  insightOf,
  metric,
  suggest,
  type BuiltinRule,
  type RuleContext,
  type RuleOutput,
} from '../../support.ts';
import { ADVISORY_DISCLAIMER, annualGap, goalRef, goalsOf, integerOf } from './shared.ts';

const NOTHING: RuleOutput = Object.freeze({ insights: [], warnings: [] });

function minorOf(value: unknown): bigint | null {
  if (typeof value !== 'object' || value === null) return null;
  const minor = (value as Record<string, unknown>)['minor'];
  if (typeof minor !== 'string' || !/^-?\d{1,20}$/u.test(minor)) return null;
  return BigInt(minor);
}

export const retirementGoalPace: BuiltinRule = {
  manifest: builtinManifest({
    advisorId: 'builtin.retirement.goal_pace',
    displayName: 'A goal below the pace that reaches it on time',
    purpose:
      'Reports each goal whose funded amount plus its planned contributions falls short of the ' +
      'target by the date, with the monthly amount that would reach it.',
    scopes: ['goals.list'],
    maxSeverity: 'warning',
    producesImpact: true,
    maxInsights: 16,
  }),

  evaluate(context: RuleContext): RuleOutput {
    const { snapshot } = context;
    const goals = goalsOf(snapshot);
    if (goals.length === 0) return NOTHING;

    const insights: Insight[] = [];
    const warnings: string[] = [];

    for (const [index, goal] of goals.entries()) {
      if (typeof goal !== 'object' || goal === null) continue;
      const pace = goal.pace;
      if (typeof pace !== 'object' || pace === null || pace.status !== 'off_track') continue;
      const months = integerOf(goal.horizon_months);
      if (months === null || months < 1) continue;
      if (typeof goal.name !== 'string' || typeof goal.goal_ref !== 'string') continue;
      const required = minorOf(pace.required_monthly);
      const planned = minorOf(pace.planned_monthly);
      if (required === null || planned === null || required <= planned) continue;

      const gap = annualGap(
        snapshot,
        'goal_pace_gap_over_a_year',
        goalRef(index, 'pace.required_monthly.minor'),
        goalRef(index, 'pace.planned_monthly.minor'),
        'What reaches the target on time per month, less what is planned per month, over a year.',
      );
      if (gap === null) continue;

      const verdict = clampImpact(gap.value, pace.required_monthly.currency, 'goal pace gap');
      const caveats: string[] = [];
      if (verdict.kind === 'withheld') {
        warnings.push(verdict.warning);
        caveats.push(verdict.caveat);
      }

      const requiredText = formatMoneyJson(pace.required_monthly);
      const plannedText = formatMoneyJson(pace.planned_monthly);
      const targetText = formatMoneyJson(goal.target);
      const gapText = verdict.kind === 'kept' ? formatMoneyJson(verdict.money) : null;
      if (requiredText === null || plannedText === null || targetText === null) continue;
      if (verdict.kind === 'kept' && gapText === null) continue;

      const shortfall =
        gapText === null ? 'short of that pace.' : `about ${gapText} a year short of that pace.`;

      insights.push(
        insightOf({
          key: `retirement.goal_pace.${goal.goal_ref}`,
          period: context.period,
          type: 'retirement.goal_pace',
          severity: 'warning',
          title: 'A goal is behind the pace that reaches it on time',
          summary:
            // The name is quoted and never opens the sentence: it is the
            // holder's own text, and "Pay off the car needs…" would read as an
            // instruction and fail the copy linter's imperative rule.
            `The goal “${goal.name}” needs about ${requiredText} a month to reach ${targetText} in ` +
            `${String(months)} months. The contributions planned for it come to ` +
            `${plannedText} a month, ${shortfall}`,
          confidence: 1,
          horizon: months <= 12 ? 'this_year' : 'long_term',
          annualized: verdict.kind === 'kept' ? verdict.money : null,
          basis:
            'A year of the monthly gap between what reaches the target on the date and what is ' +
            'planned. Nothing is projected: both amounts are today’s plans.',
          derivationId: verdict.kind === 'kept' ? gap.derivation.id : null,
          derivations: [gap.derivation],
          evidence: [
            metric('The goal', goalRef(index, 'name'), goal.name),
            metric('Its target', goalRef(index, 'target'), targetText),
            metric('Months to the target date', goalRef(index, 'horizon_months'), null),
            metric('Needed per month', goalRef(index, 'pace.required_monthly'), requiredText),
            metric('Planned per month', goalRef(index, 'pace.planned_monthly'), plannedText),
            metric('Funded so far, as a share', goalRef(index, 'progress'), null),
          ],
          actions: [
            suggest(
              'Review the goal’s contribution plan',
              'A larger planned amount or a later target date both close the gap; the goal ' +
                'screen shows the effect of each.',
            ),
          ],
          caveats: [
            ...caveats,
            'Funded means the cash earmarked for this goal or, with none, the balances of ' +
              'accounts that only this goal draws on.',
            ADVISORY_DISCLAIMER,
          ],
        }),
      );
    }

    return { insights, warnings };
  },
};
