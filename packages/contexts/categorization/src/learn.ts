// SPDX-License-Identifier: MIT
/**
 * WP 11.2 §1: the holder's pick teaches tiers 3 and 5.
 *
 * Until this WP every category the holder picked went to `@ctx/ledger`'s
 * overlay (`transactions.user_category_id`) and nowhere else: nothing in
 * `apps/api` called `confirmAssignment`, so on a real install
 * `classifier_examples` stayed empty, no merchant default was ever learned, and
 * the classifier and tier 3 were cold forever (WP 11.1's finding).
 *
 * The overlay write now appends `ledger.TransactionCategoryChosen` in its own
 * transaction, and the categorization consumer hands it here. The ledger does
 * not know this context exists; this context does not import the ledger. Every
 * pick path — the list, the detail sheet, a bulk edit, Confirm on a model
 * suggestion — goes through the overlay, so every one of them teaches.
 *
 * ## Idempotent, by reading the world rather than trusting the event
 *
 * The event says "the holder chose C for T". It is re-checked against current
 * state before anything is counted:
 *
 *   * the overlay must still say C (`stale` otherwise — the holder has since
 *     changed their mind, and the later event carries the lesson);
 *   * if the current assignment is already a confirmed `user` row for C, the
 *     lesson was already learned (`already_learned`) — a redelivered event, a
 *     replay from offset 0, or the backfill below run twice counts nothing.
 *
 * That second check is also what makes `backfillLearningFromPicks` safe to run
 * again: it replays every standing overlay pick through the same function.
 */
import { sql } from 'drizzle-orm';
import type {
  CategorizationContext,
  CategorizationDatabase,
  CategorizationExecutor,
} from './db.ts';
import {
  streamTransactions,
  type CategorizableTransaction,
  type LedgerPort,
} from './ledger-port.ts';
import { currentAssignment, recordConfirmation } from './service.ts';
import { UNCATEGORISED_KEY } from './taxonomy.ts';

export type LearnOutcome =
  'learned' | 'already_learned' | 'stale' | 'not_found' | 'unknown_category';

/** The event type, as a string: an event type is a wire contract (`consumer.ts`'s note). */
export const CATEGORY_CHOSEN_EVENT = 'ledger.TransactionCategoryChosen' as const;

async function holderCategoryKey(
  executor: CategorizationExecutor,
  userId: string,
  categoryId: string,
): Promise<string | null> {
  const result = await executor.execute<{ key: string }>(sql`
    SELECT key FROM categories WHERE user_id = ${userId} AND id = ${categoryId} LIMIT 1
  `);
  return result.rows[0]?.key ?? null;
}

async function learnWithin(
  executor: CategorizationExecutor,
  transaction: CategorizableTransaction,
  categoryId: string,
  context: CategorizationContext,
): Promise<LearnOutcome> {
  if (transaction.userCategoryId !== categoryId) return 'stale';
  const key = await holderCategoryKey(executor, context.userId, categoryId);
  // "Uncategorised" picked by hand is a withdrawal, not a lesson about the merchant.
  if (key === null || key === UNCATEGORISED_KEY) return 'unknown_category';
  const current = await currentAssignment(executor, transaction.id);
  if (current !== null && current.source === 'user' && current.categoryId === categoryId) {
    const confirmed = await executor.execute<{ confirmed: boolean }>(sql`
      SELECT confirmed_at IS NOT NULL AS confirmed FROM category_assignments WHERE id = ${current.id}
    `);
    if (confirmed.rows[0]?.confirmed === true) return 'already_learned';
  }
  await recordConfirmation(
    executor,
    { transactionId: transaction.id, categoryId, categoryKey: key, transaction },
    context,
  );
  return 'learned';
}

/**
 * Learn from one pick. Reads the transaction through the port (never trusting
 * the event's snapshot of it) and writes in one transaction.
 */
export async function learnFromPick(
  database: CategorizationDatabase,
  port: LedgerPort,
  input: { readonly transactionId: string; readonly categoryId: string },
  context: CategorizationContext,
): Promise<LearnOutcome> {
  let transaction: CategorizableTransaction | null = null;
  for await (const row of streamTransactions(port, {
    userId: context.userId,
    transactionIds: [input.transactionId],
  })) {
    transaction = row;
  }
  if (transaction === null) return 'not_found';
  const found = transaction;
  return database.transaction(async (tx) =>
    learnWithin(tx as unknown as CategorizationExecutor, found, input.categoryId, context),
  );
}

export interface BackfillLearningResult {
  /** Transactions with a hand-picked category in the overlay. */
  readonly picks: number;
  readonly learned: number;
  readonly alreadyLearned: number;
  /** Picks of "Uncategorised" or of a category this holder no longer has. */
  readonly skipped: number;
}

/**
 * `just categorization-learn-backfill holder=…`: replay every standing overlay
 * pick into the learning path, once. Idempotent — a second run learns nothing
 * (`already_learned` for every pick the first run taught). Nothing runs this
 * automatically: switching tier 3 and the classifier on for a whole history is
 * the holder's decision, taken by running the recipe.
 */
export async function backfillLearningFromPicks(
  database: CategorizationDatabase,
  port: LedgerPort,
  context: CategorizationContext,
): Promise<BackfillLearningResult> {
  let picks = 0;
  let learned = 0;
  let alreadyLearned = 0;
  let skipped = 0;
  // Oldest first is not available from the port; transaction-id order (UUIDv7,
  // so creation order) is what the gold set uses too, and it is deterministic.
  const picked: CategorizableTransaction[] = [];
  for await (const transaction of streamTransactions(port, { userId: context.userId })) {
    if (transaction.userCategoryId !== null) picked.push(transaction);
  }
  picked.sort((a, b) => a.id.localeCompare(b.id));
  for (const transaction of picked) {
    picks += 1;
    const categoryId = transaction.userCategoryId as string;
    const outcome = await database.transaction(async (tx) =>
      learnWithin(tx as unknown as CategorizationExecutor, transaction, categoryId, context),
    );
    if (outcome === 'learned') learned += 1;
    else if (outcome === 'already_learned') alreadyLearned += 1;
    else skipped += 1;
  }
  return { picks, learned, alreadyLearned, skipped };
}
