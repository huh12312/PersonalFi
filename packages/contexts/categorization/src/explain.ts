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
      },
    ];
  });
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
  }>(sql`
    SELECT transaction_id, evidence, decided_at
      FROM category_abstentions
     WHERE user_id = ${input.userId}
       AND transaction_id = ANY(${idArray})
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
    };
  });
}
