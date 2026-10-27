// SPDX-License-Identifier: MIT
/**
 * "Why is this one in the Inbox?" — for many transactions at once (WP 11.1).
 *
 * The batch read behind the Inbox's one-line explanation. For each transaction
 * it returns the **stored** working: the current assignment's chain when there
 * is one (`category_assignments.evidence`), else the abstention's chain
 * (`category_abstentions.evidence`), else an honest "nothing recorded". The line
 * is `explanationLineOf(chain)` over that stored chain — the same rule
 * `explainAssignment` states for a single transaction: recomputing would answer
 * "what would we decide today?", which is a different question, and would
 * present today's rules as the reason for a decision made under last month's.
 *
 * Reads only. Two `SELECT`s, whatever the batch size.
 */
import { sql } from 'drizzle-orm';
import type { CategorizationExecutor } from './db.ts';
import type { AssignmentSource } from './engine.ts';
import { explanationLineOf } from './explain-line.ts';

/** The most transaction ids one call may ask about. The Inbox's page is 50. */
export const MAX_EXPLAIN_BATCH = 200;

export interface StoredTierView {
  readonly source: string;
  readonly won: boolean;
  readonly detail: string;
  /**
   * WP 11.2b: the figures behind `detail`, as stored (`null` for a chain stored before WP 11.1).
   * What the chip's "Learned from N confirmations" reads.
   */
  readonly facts: Readonly<Record<string, string | number | boolean | null>> | null;
}

export interface TransactionExplanation {
  readonly transactionId: string;
  /** `assigned`: a tier decided; `abstained`: every tier declined; `not_recorded`: no pass has run. */
  readonly status: 'assigned' | 'abstained' | 'not_recorded';
  readonly source: AssignmentSource | null;
  readonly categoryKey: string | null;
  readonly confidence: number | null;
  readonly decidedAt: Date | null;
  /** The one-line "why", composed from the stored chain. */
  readonly line: string;
  /** Every stored tier, in order — what the line was composed from. */
  readonly tiers: readonly StoredTierView[];
  /**
   * WP 11.2: a language model's suggestion for an abstained row, or `null`.
   * Never an assignment: `status` stays `abstained` and `categoryKey` `null`.
   */
  readonly suggestion: StoredSuggestion | null;
}

/** A model's suggestion as stored on the abstention row (0055). The source is always the model. */
export interface StoredSuggestion {
  readonly source: 'model';
  readonly categoryId: string;
  readonly categoryKey: string;
  readonly categoryLabel: string;
  /** The model's own words, validated (≤ 140 characters, no figures, the copy linter). */
  readonly reason: string;
  readonly suggestedAt: Date;
  readonly runId: string | null;
}

function tierViews(chain: readonly unknown[]): StoredTierView[] {
  return chain.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record['source'] !== 'string') return [];
    return [
      {
        source: record['source'],
        won: record['won'] === true,
        detail: typeof record['detail'] === 'string' ? record['detail'] : '',
        facts: flatFacts(record['facts']),
      },
    ];
  });
}

function flatFacts(raw: unknown): StoredTierView['facts'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const facts: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      facts[key] = value;
    }
  }
  return facts;
}

function chainOf(evidence: unknown): readonly unknown[] {
  if (typeof evidence !== 'object' || evidence === null) return [];
  const chain = (evidence as Record<string, unknown>)['chain'];
  return Array.isArray(chain) ? chain : [];
}

export async function explainTransactions(
  executor: CategorizationExecutor,
  input: { readonly userId: string; readonly transactionIds: readonly string[] },
): Promise<readonly TransactionExplanation[]> {
  const ids = [...new Set(input.transactionIds)].slice(0, MAX_EXPLAIN_BATCH);
  if (ids.length === 0) return [];
  const idArray = sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

  const assigned = await executor.execute<{
    transaction_id: string;
    source: AssignmentSource;
    category_key: string;
    confidence: string;
    evidence: unknown;
    decided_at: string | Date;
  }>(sql`
    SELECT a.transaction_id, a.source, c.key AS category_key, a.confidence, a.evidence, a.decided_at
      FROM category_assignments a
      JOIN categories c ON c.id = a.category_id
     WHERE a.user_id = ${input.userId}
       AND a.is_current
       AND a.transaction_id = ANY(${idArray})
  `);
  const abstained = await executor.execute<{
    transaction_id: string;
    evidence: unknown;
    decided_at: string | Date;
    suggested_category_id: string | null;
    suggested_key: string | null;
    suggested_label: string | null;
    suggestion_reason: string | null;
    suggested_at: string | Date | null;
    suggestion_run_id: string | null;
  }>(sql`
    SELECT ab.transaction_id, ab.evidence, ab.decided_at,
           ab.suggested_category_id, c.key AS suggested_key, c.label AS suggested_label,
           ab.suggestion_reason, ab.suggested_at, ab.suggestion_run_id
      FROM category_abstentions ab
      LEFT JOIN categories c
        ON c.id = ab.suggested_category_id AND c.user_id = ab.user_id AND c.archived_at IS NULL
     WHERE ab.user_id = ${input.userId}
       AND ab.transaction_id = ANY(${idArray})
  `);

  const byAssignment = new Map(assigned.rows.map((row) => [row.transaction_id, row]));
  const byAbstention = new Map(abstained.rows.map((row) => [row.transaction_id, row]));

  return ids.map((transactionId): TransactionExplanation => {
    const assignment = byAssignment.get(transactionId);
    if (assignment !== undefined) {
      const chain = chainOf(assignment.evidence);
      return {
        transactionId,
        status: 'assigned',
        source: assignment.source,
        categoryKey: assignment.category_key,
        confidence: Number(assignment.confidence),
        decidedAt: new Date(assignment.decided_at),
        line: explanationLineOf(chain),
        tiers: tierViews(chain),
        suggestion: null,
      };
    }
    const abstention = byAbstention.get(transactionId);
    if (abstention !== undefined) {
      const chain = chainOf(abstention.evidence);
      return {
        transactionId,
        status: 'abstained',
        source: 'none',
        categoryKey: null,
        confidence: 0,
        decidedAt: new Date(abstention.decided_at),
        line: explanationLineOf(chain),
        tiers: tierViews(chain),
        suggestion:
          abstention.suggested_category_id === null ||
          abstention.suggested_key === null ||
          abstention.suggested_label === null ||
          abstention.suggestion_reason === null ||
          abstention.suggested_at === null
            ? null
            : {
                source: 'model',
                categoryId: abstention.suggested_category_id,
                categoryKey: abstention.suggested_key,
                categoryLabel: abstention.suggested_label,
                reason: abstention.suggestion_reason,
                suggestedAt: new Date(abstention.suggested_at),
                runId: abstention.suggestion_run_id,
              },
      };
    }
    return {
      transactionId,
      status: 'not_recorded',
      source: null,
      categoryKey: null,
      confidence: null,
      decidedAt: null,
      line: explanationLineOf([]),
      tiers: [],
      suggestion: null,
    };
  });
}
