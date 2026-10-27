// SPDX-License-Identifier: MIT
/**
 * WP 11.2b: what tiers 3-5 decided, made effective.
 *
 * Until this WP the ledger's effective category was `user ?? rule`, and a
 * placement by a learned merchant default (tier 3), the provider's category
 * (tier 4) or the classifier above its floor (tier 5) lived only in
 * `category_assignments`: recorded, explainable, and invisible to the
 * transaction list, the Inbox filter, budgets and every report. Now the
 * categorisation pass hands each such placement to the ledger through its port
 * (`writeAutoCategories`), in the pass's own transaction, and the ledger stores
 * a projection it owns and resolves as the last tier of
 * `resolveCategoryId(user, rule, auto)`.
 *
 * "Never silently apply" (04 §5.2) is satisfied by what travels with the
 * placement, not by withholding it: the chip names the tier and the calibrated
 * confidence the engine stored, the stored explanation is one tap away, the
 * classifier is held to its floor by the engine before it can win, and a
 * holder's pick or a rule always outranks it.
 *
 * This file also holds the **reprojection**: the same writes, driven from the
 * *current* assignments instead of from a pass. It is the backfill for an
 * install that had assignments before the projection existed, the self-heal if
 * a projection ever drifted, and what the import runs after loading a bundle
 * (the projection is derived and never exported).
 */
import { sql } from 'drizzle-orm';
import type {
  CategorizationContext,
  CategorizationDatabase,
  CategorizationExecutor,
} from './db.ts';
import type { AssignmentSource } from './engine.ts';
import type { AutoCategoryChangeInput, LedgerPort } from './ledger-port.ts';

/** The tiers that project: 3 `merchant_default`, 4 `provider`, 5 `classifier`. */
export const AUTO_SOURCES = ['merchant_default', 'provider', 'classifier'] as const;
export type AutoSource = (typeof AUTO_SOURCES)[number];

export function isAutoTier(source: AssignmentSource): source is AutoSource {
  return (AUTO_SOURCES as readonly string[]).includes(source);
}

/**
 * The sources a current assignment may have for the projection to care: the three automatic tiers, which
 * project, and `rule`, which clears. (`user` is left alone: the pick already superseded the placement, which
 * stays as history; `none` is never written to `category_assignments`.) The one list, for the reprojection
 * below and for the import's SQL.
 */
export const PROJECTING_SOURCES = [...AUTO_SOURCES, 'rule'] as const;

/** A row of `category_assignments`, the columns the projection reads. */
export interface AssignmentRowForProjection {
  readonly id: string;
  readonly transaction_id: string;
  readonly category_id: string;
  readonly source: string;
  readonly confidence: string | number;
  readonly decided_at: string | Date;
}

/**
 * One current assignment's change to the ledger's projection, or `null` when it has none to make (a holder's
 * own `user` assignment). The single mapping from an assignment to a placement, for the categorisation pass's
 * twin (reprojection) and for the bundle import.
 */
export function autoChangeOf(row: AssignmentRowForProjection): AutoCategoryChangeInput | null {
  const source = row.source as AssignmentSource;
  if (isAutoTier(source)) {
    return {
      transactionId: row.transaction_id,
      placement: {
        assignmentId: row.id,
        categoryId: row.category_id,
        tier: source,
        confidence: Number(row.confidence),
        decidedAt: new Date(row.decided_at),
      },
    };
  }
  return source === 'rule' ? { transactionId: row.transaction_id, placement: null } : null;
}

export interface ReprojectResult {
  /** Current assignments read: tiers 3-5 and rules. */
  readonly considered: number;
  /** Placements written or replaced on the ledger. */
  readonly changedPlacements: number;
}

const PAGE = 500;

/**
 * Re-derive the ledger's projection from the current assignments.
 *
 * Tiers 3-5 project; a current `rule` assignment clears whatever the machine
 * said before it; a current `user` assignment is left alone (the holder's pick
 * already superseded the placement, and the projection stays as history).
 * Idempotent: the ledger writes nothing for a placement it already holds
 * (per assignment id). One transaction per page of 500, so a long ledger never
 * holds a long lock.
 */
export async function reprojectAutoCategories(
  database: CategorizationDatabase,
  port: LedgerPort,
  context: CategorizationContext,
): Promise<ReprojectResult> {
  let considered = 0;
  let changedPlacements = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const page = await database.transaction(async (tx) => {
      const executor = tx as unknown as CategorizationExecutor;
      const result = await executor.execute<{
        id: string;
        transaction_id: string;
        category_id: string;
        source: AssignmentSource;
        confidence: string;
        decided_at: string | Date;
      }>(sql`
        SELECT id, transaction_id, category_id, source, confidence, decided_at
          FROM category_assignments
         WHERE user_id = ${context.userId}
           AND is_current
           AND source IN ('merchant_default', 'provider', 'classifier', 'rule')
           AND id > ${after}::uuid
         ORDER BY id
         LIMIT ${PAGE}
      `);
      const changes = result.rows.flatMap((row) => {
        const change = autoChangeOf(row);
        return change === null ? [] : [change];
      });
      if (changes.length > 0) {
        await port.writeAutoCategories({
          userId: context.userId,
          changes,
          executor,
          correlationId: context.correlationId,
          causationId: context.causationId ?? null,
        });
      }
      return { rows: result.rows, changes };
    });
    considered += page.rows.length;
    changedPlacements += page.changes.filter((change) => change.placement !== null).length;
    const last = page.rows.at(-1);
    if (last === undefined || page.rows.length < PAGE) break;
    after = last.id;
  }
  return { considered, changedPlacements };
}
