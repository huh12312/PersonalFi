// SPDX-License-Identifier: MIT
/**
 * `BriefCandidate` -- what the Brief's assembly and ranking need from an
 * insight, independent of how it was read.
 *
 * A projection deliberately narrower than `read.ts`'s `InsightView`, and
 * declared here rather than imported: `read.ts` is WP 5.3's file this wave,
 * and a pure candidate shape that both `test/brief.test.ts` (plain objects,
 * no database) and `src/brief/store.ts` (mapped from a real `listInsights`
 * read) can produce is what keeps `brief/ranking.ts` and `brief/assembly.ts`
 * testable without either a database or a dependency on a file this package
 * does not own this wave.
 */
import type { Money } from '@core/kernel';
import type { Severity } from '../contract/response.ts';
import type { BriefPrimaryAction } from '../../schema/index.ts';

export interface BriefCandidateEvidence {
  readonly position: number;
  readonly kind: string;
  readonly label: string;
  readonly value: string | null;
  readonly sourceRef: string | null;
  readonly resolvedDisplay: string | null;
  readonly href: string | null;
}

/**
 * One insight eligible for the Brief to consider: pending, unsuppressed,
 * unexpired (the caller's job — `store.ts` reads through `listInsights` with a
 * `now`, which already applies both), a `builtin` advisor's finding, with at
 * least one proposed action and at least one evidence row.
 */
export interface BriefCandidate {
  readonly insightId: string;
  readonly advisorId: string;
  readonly key: string;
  readonly type: string;
  readonly severity: Severity;
  readonly title: string;
  readonly summaryMd: string;
  readonly confidence: number;
  readonly horizon: string;
  readonly annualizedImpact: Money | null;
  readonly oneTimeImpact: Money | null;
  readonly actionKinds: readonly string[];
  /**
   * CF-24: the first proposed action (lowest `position`), as the Brief will
   * say it — snapshotted onto the item at publish. Optional so a plain
   * candidate built without one (unit fixtures) publishes `null`.
   */
  readonly primaryAction?: BriefPrimaryAction | null;
  readonly evidence: readonly BriefCandidateEvidence[];
  readonly inputDigest: string;
}

/** The advisor-rule family a candidate belongs to: the dotted prefix of `type`. */
export function familyOf(type: string): string {
  const dot = type.indexOf('.');
  return dot === -1 ? type : type.slice(0, dot);
}

/** `${advisorId}|${key}` -- the identity `carried` and the attention strip compare on. */
export function findingIdentityOf(candidate: Pick<BriefCandidate, 'advisorId' | 'key'>): string {
  return `${candidate.advisorId}|${candidate.key}`;
}
