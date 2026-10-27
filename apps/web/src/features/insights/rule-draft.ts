// SPDX-License-Identifier: MIT
import type { Insight } from '../../api/generated/types.gen.ts';
import { displayValueOf, resolveEvidenceRef } from './evidence-resolver.ts';

/**
 * WP 11.1: the rule a `create_rule_draft` action proposes, read from the insight's **own evidence** — never
 * composed on this side of the wire (master plan D22, the same discipline `evidence-resolver.ts` keeps for numbers).
 *
 * `spending.rule_suggestion` ("a merchant you always file the same way") cites the category it would file into as a
 * row whose `sourceRef` ends `.category_ref` and the merchant through the transactions it was filed from, rows whose
 * `sourceRef` ends `.transaction_ref` — the first one is the transaction the rule is built from
 * (`POST /transactions/{id}/rule` takes its payee). The count it claims is the row ending `.confirmations`.
 *
 * A draft exists only when the insight offers a `create_rule_draft` action **and** its evidence resolves both a
 * category and a transaction. Anything less (S3 `spending.uncategorised` cites transactions but no category) is no
 * draft at all, and the action stays the inert suggestion it always was.
 */

export const RULE_SUGGESTION_TYPE = 'spending.rule_suggestion';
export const CREATE_RULE_DRAFT = 'create_rule_draft';

export interface RuleDraft {
  /** The transaction the rule is built from (its payee is the rule's match). */
  readonly transactionId: string;
  /** The category the rule would file into. */
  readonly categoryId: string;
  /** "Filed this way N times", as the evidence states it; `null` when the insight cites no count. */
  readonly confirmations: string | null;
}

type Evidence = Insight['evidence'][number];

/** The first row whose ref ends with `suffix`, looked up again through the resolver by that ref. */
function citedRow(insight: Pick<Insight, 'evidence'>, suffix: string): Evidence | null {
  const row = insight.evidence.find(
    (candidate) => candidate.sourceRef !== null && candidate.sourceRef.endsWith(suffix),
  );
  if (row === undefined || row.sourceRef === null) return null;
  return resolveEvidenceRef(insight.evidence, row.sourceRef);
}

/** The id a `…_ref` row resolves to, or `null` when it carries none. */
function refValue(row: Evidence | null): string | null {
  if (row === null) return null;
  const value = (row.resolvedDisplay ?? row.value ?? '').trim();
  return value === '' ? null : value;
}

export function ruleDraftOf(insight: Pick<Insight, 'evidence' | 'actions'>): RuleDraft | null {
  if (!insight.actions.some((action) => action.kind === CREATE_RULE_DRAFT)) return null;
  const categoryId = refValue(citedRow(insight, '.category_ref'));
  const transactionId = refValue(citedRow(insight, '.transaction_ref'));
  if (categoryId === null || transactionId === null) return null;
  const count = citedRow(insight, '.confirmations');
  const shown = count === null ? null : displayValueOf(count);
  return { transactionId, categoryId, confirmations: shown === '—' ? null : shown };
}
