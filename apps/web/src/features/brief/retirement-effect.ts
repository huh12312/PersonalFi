// SPDX-License-Identifier: MIT
import type { BriefItem } from '../../api/generated/types.gen.ts';

export interface RetirementEffectDisplay {
  readonly text: string;
  /** Printed beside the figure when present (05-phase-5-dispatch.md §3 WP 5.6/5.11: "under a stated assumption printed on the item"). */
  readonly assumption: string | null;
}

const MONTHS_OF_SPENDING_REASON_TEXT: Record<
  'retirement_started' | 'no_retirement_spending',
  string
> = {
  retirement_started:
    'retirement has already started, so there is no remaining working period to extend',
  no_retirement_spending:
    'the plan has no retirement spending figure to measure months of funding against',
};

/**
 * The Brief's three — and only three — retirement-effect wordings
 * (05-phase-5-dispatch.md §3 WP 5.11), over the value `RetirementImpactPort`
 * already computed and the Brief stored (WP 5.6): never an interpolated
 * month, never a number this function derives. `yearsEarlier` and
 * `monthsOfSpending.months` are read and printed as-is — the only
 * arithmetic here is picking which already-computed branch to show.
 */
export function retirementEffectWording(
  effect: BriefItem['retirementEffect'],
): RetirementEffectDisplay {
  if (effect.kind === 'not_computable') {
    return { text: `Not computable: ${effect.reason}`, assumption: null };
  }

  if (effect.yearsEarlier !== null && effect.yearsEarlier !== 0) {
    const n = Math.abs(effect.yearsEarlier);
    const years = n === 1 ? '1 year' : `${String(n)} years`;
    const text = effect.yearsEarlier > 0 ? `Retire ${years} earlier` : `Retire ${years} later`;
    return { text, assumption: effect.assumption };
  }

  // yearsEarlier is null (unreachable at either end) or exactly 0 (the
  // common case per cut line 3: "most single actions will not move a whole
  // year") — the engine's own second figure, never an interpolated month.
  const months = effect.monthsOfSpending.months;
  if (months !== null) {
    return {
      text: `No change at yearly resolution · funds about ${months} months of retirement spending`,
      assumption: effect.assumption,
    };
  }
  return {
    text: `No change at yearly resolution · ${MONTHS_OF_SPENDING_REASON_TEXT[effect.monthsOfSpending.reason]}`,
    assumption: effect.assumption,
  };
}
