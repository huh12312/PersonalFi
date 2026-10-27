// SPDX-License-Identifier: MIT
/**
 * The holder's own answers: every transaction they filed by hand, and where.
 *
 * Two places record a hand-filed category today, and WP 11.1 reads both:
 *
 *   * **the ledger overlay** — `transactions.user_category_id`, which every
 *     category the holder picks in the app writes (`PATCH /transactions/:id`,
 *     the Inbox picker, a bulk edit), read here through the `LedgerPort` as
 *     `CategorizableTransaction.userCategoryId`; and
 *   * **confirmed assignments** — the `user`-sourced current
 *     `category_assignments` rows `confirmAssignment` writes.
 *
 * The second is the one this context's header and 11 §2 describe as "the
 * confirmation", but **nothing in `apps/api` calls `confirmAssignment` yet**
 * (WP 11.1 found it; see the evidence file's "Not done by design"), so on a
 * real install the overlay is where the holder's answers actually are. Where
 * both exist for one transaction the overlay wins: it is what the holder said
 * last. A transaction filed as Uncategorised is not an answer and is skipped.
 *
 * Reads only: one `SELECT` for the confirmations, one for the category keys,
 * and the holder's transactions through the port, page by page.
 */
import { sql } from 'drizzle-orm';
import type { CategorizationExecutor } from '../db.ts';
import {
  streamTransactions,
  type CategorizableTransaction,
  type LedgerPort,
} from '../ledger-port.ts';
import { categoryKeysById } from '../seed-taxonomy.ts';
import { UNCATEGORISED_KEY } from '../taxonomy.ts';

export interface HolderAnswer {
  readonly transaction: CategorizableTransaction;
  readonly categoryId: string;
  readonly categoryKey: string;
  /** Where the answer was read from. `overlay` wins when both say something. */
  readonly from: 'overlay' | 'confirmed';
}

export interface HolderAnswers {
  /** In transaction-id order, so everything downstream is deterministic. */
  readonly answers: readonly HolderAnswer[];
  /** Confirmations whose transaction the ledger no longer returns. */
  readonly missingTransactions: number;
}

export async function readHolderAnswers(
  executor: CategorizationExecutor,
  port: LedgerPort,
  userId: string,
): Promise<HolderAnswers> {
  const keyById = await categoryKeysById(executor, userId);
  const confirmed = await executor.execute<{ transaction_id: string; category_id: string }>(sql`
    SELECT a.transaction_id, a.category_id
      FROM category_assignments a
     WHERE a.user_id = ${userId}
       AND a.is_current
       AND a.source = 'user'
       AND a.confirmed_at IS NOT NULL
  `);
  const confirmedById = new Map(confirmed.rows.map((row) => [row.transaction_id, row.category_id]));

  const answers: HolderAnswer[] = [];
  const seen = new Set<string>();
  for await (const transaction of streamTransactions(port, { userId })) {
    seen.add(transaction.id);
    const overlay = transaction.userCategoryId;
    const categoryId = overlay ?? confirmedById.get(transaction.id) ?? null;
    if (categoryId === null) continue;
    const categoryKey = keyById.get(categoryId);
    if (categoryKey === undefined || categoryKey === UNCATEGORISED_KEY) continue;
    answers.push({
      transaction,
      categoryId,
      categoryKey,
      from: overlay !== null ? 'overlay' : 'confirmed',
    });
  }
  answers.sort((a, b) => a.transaction.id.localeCompare(b.transaction.id));

  let missingTransactions = 0;
  for (const id of confirmedById.keys()) if (!seen.has(id)) missingTransactions += 1;
  return { answers, missingTransactions };
}
