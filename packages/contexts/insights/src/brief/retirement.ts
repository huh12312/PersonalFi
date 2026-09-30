// SPDX-License-Identifier: MIT
/**
 * Turning a Brief candidate's own dollar figure into a `RetirementImpactPort`
 * request, and calling it -- the seam between assembly (pure) and
 * persistence (`store.ts`).
 */
import { Money } from '@core/kernel';
import type { BriefCandidate } from './candidate.ts';
import {
  NO_DOLLAR_FIGURE_ANSWER,
  type RetirementActionInput,
  type RetirementImpactAnswer,
  type RetirementImpactPort,
} from './ports.ts';

/**
 * `null` when the candidate claims no dollar figure at all -- the caller never
 * invokes the port for it (`NO_DOLLAR_FIGURE_ANSWER` answers directly). An
 * annualised figure is preferred over a one-time one when both are present
 * (07 §3.2's own precedent: a recurring dollar outranks a one-time one of the
 * same size); the two are never combined into one action, because the engine
 * takes exactly one kind of action per run (`solveRetirementImpact`).
 */
export function retirementActionFor(candidate: BriefCandidate): RetirementActionInput | null {
  if (candidate.annualizedImpact !== null && !Money.isZero(candidate.annualizedImpact)) {
    return { kind: 'extra_annual', annual: Money.absolute(candidate.annualizedImpact) };
  }
  if (candidate.oneTimeImpact !== null && !Money.isZero(candidate.oneTimeImpact)) {
    return { kind: 'one_off', lump: Money.absolute(candidate.oneTimeImpact) };
  }
  return null;
}

/** `store.ts#publishWeeklyBrief`'s `retirementEffectOf` callback, bound to one port and holder. */
export function retirementEffectOf(
  port: RetirementImpactPort,
  userId: string,
): (candidate: BriefCandidate) => Promise<RetirementImpactAnswer> {
  return async (candidate) => {
    const action = retirementActionFor(candidate);
    if (action === null) return NO_DOLLAR_FIGURE_ANSWER;
    return port.effectOf({ userId, action });
  };
}
