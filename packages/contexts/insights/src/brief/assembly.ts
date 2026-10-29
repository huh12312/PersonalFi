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
 *
 * ## A plan the holder is working on is shown once (WP 11.5e)
 *
 * A follow-up item carries the plan's progress, and that progress names the
 * finding the advisor session was opened from. When that finding is itself
 * still a candidate this week, the Brief **dedupes** (`supersededFindings`):
 *
 *   1. the finding is withdrawn from both lists — it is not shown twice;
 *   2. the progress item **stands in for it**: it is ranked on the higher of
 *      its own score and the finding's (with that entry's factors, so the
 *      stored score still equals its factors), and, should neither carry a
 *      dollar figure while the finding was an attention item, it takes the
 *      finding's place on the attention strip;
 *   3. the progress item records the finding as **being worked on**
 *      (`workedOn`), which the Brief shows on that item.
 *
 * Deterministic: progress items are considered in `key` order, and a finding
 * claimed by two plans is claimed by the first.
 */
import type { BriefCandidate } from './candidate.ts';
import { findingIdentityOf } from './candidate.ts';
import {
  isBelowFloor,
  scoreOf,
  selectAttentionStrip,
  selectRanked,
  type ScoreFactors,
  type ScoredCandidate,
} from './ranking.ts';

export const COLD_START_THRESHOLD_DAYS = 30;

/**
 * What a young advisor history actually costs (G5-8). `historyDays` is the days
 * since this holder's earliest advisor *run*, so it says nothing about how many
 * months of transactions the install holds: a rule that compares months (spending
 * creep) reads the months already in the accounts and may rank on day one. The
 * note used to claim trend findings were "not yet assessable" and printed that
 * above two spending-creep items. It now says only what is true of the Brief
 * itself: few earlier weeks to compare it with.
 */
export const COLD_START_NOTE =
  'Under 30 days of advisor history, so there are few earlier weeks to compare this Brief with. ' +
  'Findings that compare months of spending read the transactions already in your accounts, ' +
  'not this history.';

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
  /** WP 11.5e: the finding this progress item stands in for this week (being worked on). */
  readonly workedOn?: { readonly insightId: string; readonly title: string } | null;
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

/**
 * WP 11.5e: origin insight id → the progress candidate that stands in for it.
 * A progress item claims its origin only when the origin is itself among the
 * candidates; progress items in `key` order, first claim wins. Pure.
 */
export function supersededFindings(
  candidates: readonly BriefCandidate[],
): ReadonlyMap<string, BriefCandidate> {
  const present = new Set(candidates.map((candidate) => candidate.insightId));
  const claims = new Map<string, BriefCandidate>();
  const withProgress = candidates
    .filter((candidate) => (candidate.progress?.origin ?? null) !== null)
    .sort((left, right) => left.key.localeCompare(right.key));
  for (const progress of withProgress) {
    const origin = progress.progress?.origin?.insight_ref;
    if (origin === undefined || origin === progress.insightId) continue;
    if (!present.has(origin) || claims.has(origin)) continue;
    claims.set(origin, progress);
  }
  return claims;
}

export function assembleBrief(input: AssembleBriefInput): AssembledBrief {
  const eligible = input.candidates.filter((candidate) =>
    isEligible(candidate, input.advisorKindOf),
  );
  const materiality = eligible.filter((candidate) => !isBelowFloor(candidate, input.currencyCode));

  // WP 11.5e: a finding being worked on is withdrawn; its progress item stands in for it.
  const superseded = supersededFindings(materiality);
  const standsInFor = new Map<string, BriefCandidate>();
  for (const [originId, progress] of superseded) {
    const origin = materiality.find((candidate) => candidate.insightId === originId);
    if (origin !== undefined) standsInFor.set(progress.insightId, origin);
  }
  const pool = materiality.filter((candidate) => !superseded.has(candidate.insightId));

  const scoreWith = (candidate: BriefCandidate) =>
    scoreOf(candidate, input.dismissRateOf(candidate.advisorId));
  const scored = pool
    .map((candidate): ScoredCandidate | null => {
      const own = scoreWith(candidate);
      const origin = standsInFor.get(candidate.insightId);
      if (origin === undefined) return own;
      const theirs = scoreWith(origin);
      if (theirs === null) return own;
      // The higher of the two, with that entry's factors: the stored score still equals its factors.
      if (own === null || theirs.score > own.score) {
        return { candidate, score: theirs.score, factors: theirs.factors };
      }
      return own;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  const ranked = selectRanked(scored);
  const rankedIds = new Set(ranked.map((entry) => entry.candidate.insightId));
  const attentionOrigins = new Set(
    selectAttentionStrip(materiality).map((candidate) => candidate.insightId),
  );
  const ownAttention = selectAttentionStrip(pool);
  const ownAttentionIds = new Set(ownAttention.map((candidate) => candidate.insightId));
  const attention = [
    ...ownAttention,
    // A progress item whose finding was an attention item takes its place there when it is not ranked.
    ...pool.filter((candidate) => {
      const origin = standsInFor.get(candidate.insightId);
      return (
        origin !== undefined &&
        attentionOrigins.has(origin.insightId) &&
        !rankedIds.has(candidate.insightId) &&
        !ownAttentionIds.has(candidate.insightId)
      );
    }),
  ].sort((a, b) => a.key.localeCompare(b.key));

  const workedOnOf = (candidate: BriefCandidate) => {
    const origin = standsInFor.get(candidate.insightId);
    return origin === undefined ? null : { insightId: origin.insightId, title: origin.title };
  };
  const rankedItems: BriefItemAssembly[] = ranked.map((entry, position) => ({
    section: 'ranked',
    position,
    candidate: entry.candidate,
    carried: input.carriedIdentities.has(findingIdentityOf(entry.candidate)),
    score: entry.score,
    scoreFactors: entry.factors,
    workedOn: workedOnOf(entry.candidate),
  }));
  const attentionItems: BriefItemAssembly[] = attention.map((candidate, position) => ({
    section: 'attention',
    position,
    candidate,
    carried: input.carriedIdentities.has(findingIdentityOf(candidate)),
    score: null,
    scoreFactors: null,
    workedOn: workedOnOf(candidate),
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
