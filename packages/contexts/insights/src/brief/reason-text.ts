// SPDX-License-Identifier: MIT
/**
 * Why a Brief item has no retirement figure, in words (Phase 5 gate G5-11).
 *
 * `RetirementImpactAnswer.not_computable.reason` carries the engine's own
 * refusal code by name (`brief/ports.ts`: "carried through by name rather than
 * swallowed"), so the stored row and the logs say exactly what refused. A
 * holder reads a sentence: the gate's walk printed "Not computable:
 * planning.projection_no_balances". The route maps at the wire; the stored code
 * is untouched.
 *
 * A code this table does not know falls back to a generic sentence, never to
 * the code itself — an engine code that reaches a screen is the defect this
 * file exists to remove.
 */
const REASON_WORDS: Readonly<Record<string, string>> = Object.freeze({
  no_dollar_figure: 'this finding does not claim a dollar amount to test against your plan',
  no_baseline: 'no baseline plan to project against',
  'planning.scenario_no_baseline': 'no baseline plan to project against',
  'planning.projection_no_balances':
    'no net-worth day has been recorded yet, so there are no starting balances to project from',
  'planning.projection_balances_unsealed':
    "today's net-worth day is still open; the projection starts from a finished day",
  'planning.projection_spending_unknown':
    'your plan states no retirement spending and none could be worked out from your transactions',
  'planning.projection_currency_mismatch':
    "your plan and your balances are in different currencies, so they can't be projected together",
  'planning.projection_assumptions_stale':
    "the planning assumptions have changed since this plan's last run",
});

export const REASON_FALLBACK_WORDS =
  'the planning engine could not project your plan with this action';

export function retirementReasonInWords(code: string): string {
  return REASON_WORDS[code] ?? REASON_FALLBACK_WORDS;
}
