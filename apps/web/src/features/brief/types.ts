// SPDX-License-Identifier: MIT
import type { BriefItem } from '../../api/generated/types.gen.ts';

/**
 * A narration overlay for a Brief item — **not part of the generated
 * contract today**. WP 5.3 built the narrator and its storage
 * (`insights.narrates_insight_id`, migration 0031) and a server-side reader
 * for it (`narrationsFor(executor, userId, findingIds)`,
 * `packages/contexts/insights/src/advisors/local/link.ts` per
 * `docs/evidence/phase-5/wp5.3-narrator.md` §4), but no REST route anywhere
 * serves it: `listInsights` — the one function behind both the feed and
 * `GET /insights/{insightId}` — unconditionally excludes narration rows
 * (`isNull(insights.narratesInsightId)`,
 * `packages/contexts/insights/src/read.ts:172`), by design (a narration
 * "never takes a feed, dashboard or Brief slot of its own"). So a narration
 * cannot be fetched by any path that exists in this codebase today.
 *
 * This type names the exact shape `GET /insights/brief/current` and
 * `GET /insights/brief/{isoWeek}` would need to add to `BriefItem` — a
 * `narration` field carrying the narrator's alternative wording — for
 * `NarratedSummary` (`./NarrationBadge.tsx`) to ever render for real against
 * a live backend. Until a route populates it, `narrationOf` below always
 * returns `null`, because the field is never present on the wire; nothing
 * in this package guesses at a URL to fetch one separately. See
 * `docs/evidence/phase-5/wp5.11-brief-ui.md` "Needs the orchestrator".
 */
export interface BriefNarration {
  /** The narrator's alternative wording for this item's finding (07 §7.5 rule 1: shown only until/unless rejected). */
  readonly narratedSummaryMd: string;
}

export type BriefItemWithNarration = BriefItem & {
  readonly narration?: BriefNarration | null;
};

export function narrationOf(item: BriefItemWithNarration): BriefNarration | null {
  return item.narration ?? null;
}
