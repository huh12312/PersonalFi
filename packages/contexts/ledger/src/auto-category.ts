// SPDX-License-Identifier: MIT
/**
 * The automatic tiers' write path (WP 11.2b).
 *
 * `@ctx/categorization` decides a category for every transaction through six
 * ordered tiers and records the decision in its own `category_assignments`. The
 * ledger may not read that table and may not import that context, yet every
 * reader of the effective category lives on the ledger's side of the line. So
 * the ledger owns a **projection** of the automatic decision: six nullable
 * columns on `transactions` (migration 0058), written here and only here.
 *
 * ```text
 *  categorize pass ─▶ category_assignments (history, the stored chain)
 *                 └─▶ port.writeAutoCategories ─▶ setAutoCategories ─▶ transactions.auto_*
 *                         (the pass's own transaction; the event follows it)
 *
 *  resolveCategoryId(overlay, rule, auto) = user ?? rule ?? auto
 * ```
 *
 * ## Why a call in the pass's transaction and not a consumer of
 * `categorization.AssignmentsChanged`
 *
 * Budgeting and recurring consume the same event, and each recomputes "a
 * deterministic function of current state" when it arrives. A projection written
 * by a *third* consumer would race them: the pump delivers per consumer, in no
 * order across consumers, so budgeting could recompute actuals before the
 * placement it was woken for had reached the ledger, and keep the stale total
 * until something else dirtied the period. Written in the same transaction as the
 * assignment, before the event is appended, the projection is committed before
 * any consumer can see the event. The ledger still never imports the other
 * context: the composition root hands the pass a port, exactly as for the rule
 * tier (`setRuleCategory`).
 *
 * ## Which tiers project
 *
 * Only 3 (`merchant_default`), 4 (`provider`) and 5 (`classifier`, already held
 * to its calibrated floor by the engine). A rule has `rule_category_id`, a pick
 * has `user_category_id`, and tier 6 - "nothing was confident enough" - is the
 * absence of a placement: a change with `placement: null` clears the row, so a
 * transaction the pass now leaves unplaced stops counting.
 *
 * ## Idempotent per assignment id
 *
 * A placement already stored for the same `assignmentId` writes nothing - no
 * column, no `updated_at` - so a redelivered event, a re-run pass and the
 * reprojection job all converge on the same rows.
 */
import { sql } from 'drizzle-orm';
import { AUTO_TIERS, type AutoTier } from '../schema/index.ts';
import type { LedgerExecutor } from './db.ts';
import { LedgerError } from './errors.ts';
import type { LedgerWriteContext } from './accounts.ts';

/** The automatic tiers' decision for one transaction, as the ledger stores it. */
export interface AutoPlacement {
  /** `category_assignments.id` of the decision this mirrors. */
  readonly assignmentId: string;
  /** One of `@ctx/categorization`'s `categories.id`. Opaque here. */
  readonly categoryId: string;
  readonly tier: AutoTier;
  /** `0..1`: the calibrated figure the engine stored, written as given. */
  readonly confidence: number;
  readonly decidedAt: Date;
}

/** `placement: null` clears the projection: tier 6, or a rule has taken the row over. */
export interface AutoCategoryChange {
  readonly transactionId: string;
  readonly placement: AutoPlacement | null;
}

export interface SetAutoCategoriesResult {
  /** Rows whose placement was written or replaced. */
  readonly placed: number;
  /** Rows whose placement was cleared. */
  readonly cleared: number;
  /** Rows already holding exactly this (the idempotent path), or not this holder's. */
  readonly unchanged: number;
}

const CHUNK = 200;

function check(placement: AutoPlacement): void {
  if (!(AUTO_TIERS as readonly string[]).includes(placement.tier)) {
    throw new LedgerError(
      'ledger.invalid_auto_placement',
      `${placement.tier} is not an automatic tier`,
    );
  }
  if (
    !Number.isFinite(placement.confidence) ||
    placement.confidence < 0 ||
    placement.confidence > 1
  ) {
    throw new LedgerError('ledger.invalid_auto_placement', 'confidence must be between 0 and 1');
  }
}

/**
 * Write the automatic tiers' placements for a batch of transactions.
 *
 * Runs on the caller's executor (a transaction handle, in the categorisation
 * pass). Scoped to `userId`: an id that is not this holder's is `unchanged`,
 * never written. A row the holder has already picked keeps its placement as
 * history and has `auto_superseded_at` set (it was set at the pick; this keeps
 * it set), so a late pass cannot make a picked row look unreviewed.
 */
export async function setAutoCategories(
  executor: LedgerExecutor,
  input: { readonly userId: string; readonly changes: readonly AutoCategoryChange[] },
  context: Pick<LedgerWriteContext, 'clock'>,
): Promise<SetAutoCategoriesResult> {
  const now = context.clock.now().toISOString();
  // Last write per transaction wins within a batch.
  const latest = new Map<string, AutoPlacement | null>();
  for (const change of input.changes) {
    if (change.placement !== null) check(change.placement);
    latest.set(change.transactionId, change.placement);
  }
  const placements = [...latest].flatMap(([transactionId, placement]) =>
    placement === null ? [] : [{ transactionId, placement }],
  );
  const clears = [...latest].flatMap(([transactionId, placement]) =>
    placement === null ? [transactionId] : [],
  );

  let placed = 0;
  for (let from = 0; from < placements.length; from += CHUNK) {
    const chunk = placements.slice(from, from + CHUNK);
    const values = sql.join(
      chunk.map(
        ({ transactionId, placement }) =>
          sql`(${transactionId}::uuid, ${placement.categoryId}::uuid, ${placement.tier}::text,
                ${placement.confidence.toFixed(4)}::numeric, ${placement.decidedAt.toISOString()}::timestamptz,
                ${placement.assignmentId}::uuid)`,
      ),
      sql`, `,
    );
    const result = await executor.execute<{ id: string }>(sql`
      UPDATE transactions AS t SET
        auto_category_id   = v.category_id,
        auto_tier          = v.tier,
        auto_confidence    = v.confidence,
        auto_decided_at    = v.decided_at,
        auto_assignment_id = v.assignment_id,
        auto_superseded_at = CASE WHEN t.user_category_id IS NOT NULL
                                  THEN COALESCE(t.auto_superseded_at, ${now}::timestamptz) END,
        updated_at         = ${now}::timestamptz
      FROM (VALUES ${values}) AS v(transaction_id, category_id, tier, confidence, decided_at, assignment_id)
      WHERE t.id = v.transaction_id
        AND t.user_id = ${input.userId}
        AND t.auto_assignment_id IS DISTINCT FROM v.assignment_id
      RETURNING t.id
    `);
    placed += result.rows.length;
  }

  let cleared = 0;
  for (let from = 0; from < clears.length; from += CHUNK) {
    const chunk = clears.slice(from, from + CHUNK);
    const ids = sql.join(
      chunk.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await executor.execute<{ id: string }>(sql`
      UPDATE transactions SET
        auto_category_id = NULL, auto_tier = NULL, auto_confidence = NULL,
        auto_decided_at = NULL, auto_assignment_id = NULL, auto_superseded_at = NULL,
        updated_at = ${now}::timestamptz
      WHERE user_id = ${input.userId}
        AND id IN (${ids})
        AND auto_category_id IS NOT NULL
      RETURNING id
    `);
    cleared += result.rows.length;
  }

  return { placed, cleared, unchanged: latest.size - placed - cleared };
}
