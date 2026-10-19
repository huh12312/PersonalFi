// SPDX-License-Identifier: MIT
import type { Insight, InsightTextSegment } from '../../api/generated/types.gen.ts';
import { resolveEvidenceRef, UnresolvedEvidenceRefError } from './evidence-resolver.ts';

/**
 * An insight card's entity mentions, on the client's side of the wire (WP 10.15, V8).
 *
 * The server names an entity only when the insight's own evidence cites its id (`@ctx/insights`' `mentions.ts`).
 * This module keeps the same discipline the evidence panel keeps for numbers (master plan D22, `evidence-
 * resolver.ts`): a segment is rendered as a link **only** when its entity is one of `insight.mentions`, that
 * mention's evidence row is found again in this exact insight's `evidence` through `resolveEvidenceRef` (by its
 * `sourceRef`), and that row's resolved value is the entity's id. Anything else — a segment naming an entity the
 * evidence does not cite, a mention whose row is gone, a row that resolves to a different id — is drawn as the
 * plain words it is. A mention can be dropped; it can never be invented.
 */

export type MentionEntityType = NonNullable<InsightTextSegment['entityType']>;

export interface VerifiedMention {
  readonly entityType: MentionEntityType;
  readonly entityId: string;
}

/** The mention behind a segment, if the insight's own evidence backs it; else `null` (render plain text). */
export function verifiedMentionOf(
  insight: Pick<Insight, 'mentions' | 'evidence'>,
  segment: InsightTextSegment,
): VerifiedMention | null {
  if (segment.entityType === undefined || segment.entityId === undefined) return null;
  const id = segment.entityId.toLowerCase();
  const mention = (insight.mentions ?? []).find(
    (candidate) =>
      candidate.entityType === segment.entityType && candidate.entityId.toLowerCase() === id,
  );
  if (mention === undefined) return null;
  const row = insight.evidence.find((candidate) => candidate.position === mention.evidencePosition);
  if (row === undefined || row.sourceRef === null) return null;
  try {
    const resolved = resolveEvidenceRef(insight.evidence, row.sourceRef);
    const value = (resolved.resolvedDisplay ?? resolved.value ?? '').trim().toLowerCase();
    if (value !== id) return null;
  } catch (error) {
    if (error instanceof UnresolvedEvidenceRefError) return null;
    throw error;
  }
  return { entityType: segment.entityType, entityId: segment.entityId };
}

/**
 * The segments to draw for a text: the server's segments when they spell exactly `text` (they always do — the
 * server splits, never rewrites), else `text` itself as one plain segment. The card never shows words the field
 * does not hold.
 */
export function segmentsFor(
  segments: readonly InsightTextSegment[] | null | undefined,
  text: string,
): readonly InsightTextSegment[] {
  if (segments === null || segments === undefined) return [{ text }];
  return segments.map((segment) => segment.text).join('') === text ? segments : [{ text }];
}

/**
 * Where a verified mention goes: a category's screen (V7), an account's screen, a merchant's transactions. A
 * transaction has no screen of its own — the card opens its detail sheet in place (`null` here).
 */
export function mentionHref(mention: VerifiedMention): string | null {
  switch (mention.entityType) {
    case 'category':
      return `/categories/${encodeURIComponent(mention.entityId)}`;
    case 'account':
      return `/accounts/${encodeURIComponent(mention.entityId)}`;
    case 'merchant':
      return `/transactions?merchantIds=${encodeURIComponent(JSON.stringify([mention.entityId]))}`;
    case 'transaction':
      return null;
  }
}

/** "Worth $X / year" or "Worth $X one-time" from the insight's own impact fields; `null` when it claims none. */
export function valueLineOf(insight: Pick<Insight, 'annualizedImpact' | 'oneTimeImpact'>): {
  readonly money: NonNullable<Insight['annualizedImpact']>;
  readonly suffix: '/ year' | 'one-time';
} | null {
  if (insight.annualizedImpact !== null)
    return { money: insight.annualizedImpact, suffix: '/ year' };
  if (insight.oneTimeImpact !== null) return { money: insight.oneTimeImpact, suffix: 'one-time' };
  return null;
}
