// SPDX-License-Identifier: MIT
import type { BriefItem, Insight } from '../../api/generated/types.gen.ts';

/**
 * Adapts a Brief item's own snapshotted fields into the shape
 * `features/insights/EvidencePanel.tsx` (not owned by this work package)
 * requires, so the "Why am I seeing this?" panel can reuse it unmodified.
 *
 * Deliberately **not** a fetch of the live insight by `item.insightId`:
 * `docs/evidence/phase-5/wp5.6-brief.md` §2 is explicit that a Brief's
 * displayed fields are snapshotted at publish time and must never be
 * answered by a later join through `insight_id` — "a Brief that read
 * through would let this week's re-run answer last week's 'why did it say
 * $720?'" (07 §7.3). So every field below is either the Brief's own
 * snapshot or a documented, honest filler — never a value read from a live
 * re-fetch, and never a guess.
 *
 * `EvidencePanel` only ever reads `advisorId`, `confidence`,
 * `confidenceBasis`, `impactBasis` (guarded on `!== ''`), `evidence`,
 * `caveats` (guarded on `.length > 0`) and `actions` (guarded on
 * `.length > 0`) — every other field on `Insight` exists only because the
 * prop type is the full shape, and is never rendered.
 */
export function insightViewOf(item: BriefItem): Insight {
  return {
    id: item.insightId ?? item.id,
    advisorId: item.advisorId,
    advisorVersion: '',
    key: item.insightKey,
    period: '',
    type: item.insightType,
    severity: item.severity,
    severityClamped: false,
    title: item.title,
    summaryMd: item.summaryMd,
    confidence: item.confidence,
    // The Brief's own assembly only ever includes pending, builtin
    // (rule-based) insights — narrations are excluded by construction
    // (`packages/contexts/insights/src/read.ts:172`, confirmed again in
    // `wp5.6-brief.md`'s own assembly header: "pending, unsuppressed,
    // unexpired *builtin* insights"). So `confidenceBasis` is always
    // `'rule'` for every item this screen can ever render — a structural
    // invariant, not a guess at a missing field.
    confidenceBasis: 'rule',
    horizon: item.horizon,
    status: 'pending_review',
    annualizedImpact: item.annualizedImpact,
    oneTimeImpact: item.oneTimeImpact,
    // Not carried by the Brief's snapshot today (this package's own
    // finding — see `docs/evidence/phase-5/wp5.11-brief-ui.md`, "Needs the
    // orchestrator"). Left honestly empty — EvidencePanel's own guard hides
    // the row — rather than fabricated.
    impactBasis: '',
    caveats: [],
    inputDigest: '',
    firstProposedAt: '',
    lastProposedAt: '',
    expiresAt: null,
    evidence: item.evidence,
    actions: [],
    // WP 10.15: the insight card's bookmark, helpfulness and mentions are not part of the Brief's snapshot and
    // `EvidencePanel` reads none of them — empty, never borrowed from the live insight.
    bookmarkedAt: null,
    feedback: null,
    feedbackReason: null,
    mentions: [],
    titleSegments: [{ text: item.title }],
    bodySegments: [{ text: item.summaryMd }],
    contextLine: null,
    // WP 11.5e: the evidence panel reads none of it; the Brief's own card offers the link.
    talkThrough: false,
  };
}
