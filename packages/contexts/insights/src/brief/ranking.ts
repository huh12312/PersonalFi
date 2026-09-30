// SPDX-License-Identifier: MIT
/**
 * The Brief's own ranking (05-phase-5-dispatch.md §3 WP 5.6; 07 §3.2).
 *
 * `effective impact × confidence × actionability × urgency × (1 − 0.5 ·
 * dismiss_rate)` -- WP 2.7's factor functions (`advisors/ranking.ts`'s
 * `actionabilityOf`, `urgencyOf`, `DISMISS_PENALTY`) and WP 2.6's impact
 * function (`policy/alert-budget.ts`'s `effectiveImpactMinor`), reused
 * verbatim, and deliberately **not** composed through `rank()` or
 * `rankBuiltin()`: both add a severity-dominant term
 * (`alert-budget.ts:169-177`'s `severityRank(...) * 10 + magnitude *
 * confidence + safetyTerm`) that is right for a dashboard that must lead with
 * what will hurt, and wrong for a list whose one promise is "ranked by dollar
 * impact" -- a $30 urgent finding must not outrank a $700 notable one here,
 * which is exactly what the severity term would do (05 §5's Phase-5-specific
 * risk table, and the sabotage this package's evidence records putting it
 * back).
 *
 * Urgent findings with no dollar figure are not scored at all: they go to the
 * attention strip (`selectAttentionStrip`), a list of their own that never
 * competes with the ranked five and is therefore structurally immune to the
 * tie-break bug wp4.9 §12 item 1 found in `rank()` (S6 losing a dashboard slot
 * to key order) -- there is no tie-break here that could drop one, because
 * there is nothing here to drop it from.
 */
import { belowFloor, effectiveImpactMinor, type RankableInsight } from '../policy/alert-budget.ts';
import { DISMISS_PENALTY, actionabilityOf, urgencyOf } from '../advisors/ranking.ts';
import { severityRank } from '../contract/response.ts';
import { familyOf, type BriefCandidate } from './candidate.ts';

export const MAX_RANKED_ITEMS = 5;
export const MAX_PER_FAMILY = 2;

export interface ScoreFactors {
  /** Minor units, as a string -- the same treatment every money-adjacent JSON field gets. */
  readonly effectiveImpactMinor: string;
  readonly confidence: number;
  readonly actionability: number;
  readonly urgency: number;
  readonly dismissRate: number;
}

export interface ScoredCandidate {
  readonly candidate: BriefCandidate;
  readonly score: number;
  readonly factors: ScoreFactors;
}

function rankableOf(candidate: BriefCandidate): RankableInsight {
  return {
    key: candidate.key,
    severity: candidate.severity,
    confidence: candidate.confidence,
    annualizedImpact: candidate.annualizedImpact,
    oneTimeImpact: candidate.oneTimeImpact,
  };
}

/**
 * `null` when the candidate claims no dollar figure -- it is not a ranking
 * candidate at all (it may still be an attention-strip one).
 */
export function scoreOf(candidate: BriefCandidate, dismissRate: number): ScoredCandidate | null {
  const impact = effectiveImpactMinor(rankableOf(candidate));
  if (impact === null) return null;
  const confidence = Math.min(1, Math.max(0, candidate.confidence));
  const actionability = actionabilityOf(candidate.actionKinds);
  const urgency = urgencyOf(candidate.horizon);
  const clampedDismissRate = Math.min(1, Math.max(0, dismissRate));
  const score =
    Number(impact) *
    confidence *
    actionability *
    urgency *
    (1 - DISMISS_PENALTY * clampedDismissRate);
  return {
    candidate,
    score,
    factors: {
      effectiveImpactMinor: impact.toString(),
      confidence,
      actionability,
      urgency,
      dismissRate: clampedDismissRate,
    },
  };
}

/**
 * Score descending; ties break on severity (higher first), then `key`
 * ascending -- the dispatch's own tie-break order, applied only among
 * candidates that already have a score (an attention-strip item is never in
 * this comparison).
 */
function compareScored(a: ScoredCandidate, b: ScoredCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  const severityDiff = severityRank(b.candidate.severity) - severityRank(a.candidate.severity);
  if (severityDiff !== 0) return severityDiff;
  return a.candidate.key.localeCompare(b.candidate.key);
}

/**
 * The ≤5 ranked actions, no rule family holding more than
 * `MAX_PER_FAMILY` (E11: "Ranking must not be dominated by one noisy
 * category"). A greedy walk down the sorted order: a candidate whose family
 * already holds two is skipped -- not bumped to the attention strip, not
 * dropped from the underlying feed, simply not one of the five -- and the walk
 * continues to the next-highest-scored candidate.
 */
export function selectRanked(scored: readonly ScoredCandidate[]): readonly ScoredCandidate[] {
  const sorted = [...scored].sort(compareScored);
  const familyCounts = new Map<string, number>();
  const selected: ScoredCandidate[] = [];
  for (const entry of sorted) {
    if (selected.length >= MAX_RANKED_ITEMS) break;
    const family = familyOf(entry.candidate.type);
    const count = familyCounts.get(family) ?? 0;
    if (count >= MAX_PER_FAMILY) continue;
    familyCounts.set(family, count + 1);
    selected.push(entry);
  }
  return selected;
}

/**
 * The attention strip: urgent findings with no dollar figure at all,
 * `key`-ordered (every entry shares the same severity by construction, so
 * there is nothing else to order by). Never displaces a ranked action —
 * `selectRanked` never reads this list and this list never reads a score.
 */
export function selectAttentionStrip(
  candidates: readonly BriefCandidate[],
): readonly BriefCandidate[] {
  return candidates
    .filter(
      (candidate) =>
        candidate.severity === 'urgent' && effectiveImpactMinor(rankableOf(candidate)) === null,
    )
    .slice()
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** The $50 floor (07 §3.2, `policy/alert-budget.ts`'s own), reused rather than re-implemented. */
export function isBelowFloor(candidate: BriefCandidate, currencyCode: string): boolean {
  return belowFloor(rankableOf(candidate), currencyCode);
}
