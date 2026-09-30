// SPDX-License-Identifier: MIT
/**
 * Pure Brief assembly (05-phase-5-dispatch.md §3 WP 5.6; 09 ADV-1, S1, E11).
 *
 * Takes the candidates a caller has already read (`store.ts` reads them
 * through `listInsights`, which already applies pending/unsuppressed/unexpired
 * — 05's Assembly rule's first three words) and everything else as plain
 * data, so this function needs no database and no clock of its own:
 * `test/brief.test.ts` drives it directly over plain objects.
 *
 * ## What "eligible" means here
 *
 * A candidate must be a `builtin` advisor's finding (narrations are `local_model`
 * and carry no `proposed_actions` of their own either way — WP 5.3's "linked,
 * never ranked" — so this filter and the action filter below both exclude
 * them; the kind check is the named, structural one), with at least one
 * proposed action and at least one evidence row (a "resolvable evidence
 * panel"). Below-floor candidates — those claiming a dollar figure under 07
 * §3.2's $50 — are excluded from both the ranked list and the attention strip:
 * the floor is about materiality, not about urgency, and an urgent finding is
 * never subject to it in the first place (`effectiveImpactMinor` is `null` for
 * one, so `isBelowFloor` never excludes it — `policy/alert-budget.ts`'s own
 * rule, reused unchanged).
 */
import type { BriefCandidate } from './candidate.ts';
import { findingIdentityOf } from './candidate.ts';
import {
  isBelowFloor,
  scoreOf,
  selectAttentionStrip,
  selectRanked,
  type ScoreFactors,
} from './ranking.ts';

export const COLD_START_THRESHOLD_DAYS = 30;

export const COLD_START_NOTE =
  'Under 30 days of advisor history, so trend-based findings — spending creep, category ' +
  'baselines, subscription drift — are not yet assessable; only what a single snapshot can show is included.';

export type BriefItemSection = 'ranked' | 'attention';

export interface BriefItemAssembly {
  readonly section: BriefItemSection;
  /** Position within its own section, 0-based. */
  readonly position: number;
  readonly candidate: BriefCandidate;
  /** True when this finding's identity was already in last week's Brief. */
  readonly carried: boolean;
  /** `null` for an attention-strip item: it was never ranked by score. */
  readonly score: number | null;
  readonly scoreFactors: ScoreFactors | null;
}

export interface AssembledBrief {
  readonly ranked: readonly BriefItemAssembly[];
  readonly attention: readonly BriefItemAssembly[];
  /** True exactly when `ranked` is empty (ADV-1, principle 3). */
  readonly nothingMaterial: boolean;
  readonly coldStart: boolean;
  readonly coldStartNote: string | null;
}

export interface AssembleBriefInput {
  readonly candidates: readonly BriefCandidate[];
  readonly advisorKindOf: (advisorId: string) => 'builtin' | 'local_model' | 'external' | undefined;
  /** `0` for an advisor with no dismissal history — ranks on its merits (07 §3.2). */
  readonly dismissRateOf: (advisorId: string) => number;
  /** `${advisorId}|${key}` identities the previous ISO week's Brief carried. */
  readonly carriedIdentities: ReadonlySet<string>;
  readonly currencyCode: string;
  /** Days since this holder's earliest advisor run. Drives the cold-start note. */
  readonly historyDays: number;
}

function isEligible(
  candidate: BriefCandidate,
  advisorKindOf: AssembleBriefInput['advisorKindOf'],
): boolean {
  return (
    advisorKindOf(candidate.advisorId) === 'builtin' &&
    candidate.actionKinds.length > 0 &&
    candidate.evidence.length > 0
  );
}

export function assembleBrief(input: AssembleBriefInput): AssembledBrief {
  const eligible = input.candidates.filter((candidate) =>
    isEligible(candidate, input.advisorKindOf),
  );
  const materiality = eligible.filter((candidate) => !isBelowFloor(candidate, input.currencyCode));

  const scored = materiality
    .map((candidate) => scoreOf(candidate, input.dismissRateOf(candidate.advisorId)))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const ranked = selectRanked(scored);
  const attention = selectAttentionStrip(materiality);

  const rankedItems: BriefItemAssembly[] = ranked.map((entry, position) => ({
    section: 'ranked',
    position,
    candidate: entry.candidate,
    carried: input.carriedIdentities.has(findingIdentityOf(entry.candidate)),
    score: entry.score,
    scoreFactors: entry.factors,
  }));
  const attentionItems: BriefItemAssembly[] = attention.map((candidate, position) => ({
    section: 'attention',
    position,
    candidate,
    carried: input.carriedIdentities.has(findingIdentityOf(candidate)),
    score: null,
    scoreFactors: null,
  }));

  const coldStart = input.historyDays < COLD_START_THRESHOLD_DAYS;
  return {
    ranked: rankedItems,
    attention: attentionItems,
    nothingMaterial: rankedItems.length === 0,
    coldStart,
    coldStartNote: coldStart ? COLD_START_NOTE : null,
  };
}
