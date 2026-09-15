// SPDX-License-Identifier: MIT
/**
 * Transaction splits — the one write in WP 1.5 that has no home in a context yet.
 *
 * ## Why this is here and not in `@ctx/ledger`
 *
 * `transaction_splits` is the ledger's table and the ledger's `OWNERSHIP.md`
 * claims it, but WP 1.1 shipped the table, the read path (`getTransaction`
 * returns `splits`) and the error code (`ledger.splits_do_not_sum`) **without a
 * writer**. WP 1.5 owns the route, not the ledger's write surface, so the choice
 * was between shipping `POST /transactions/:id/splits` as a 501 and writing the
 * eighty lines here, in the composition root, where `apps/` is the one layer the
 * boundary rule and the schema-ownership check both allow to reach across.
 *
 * **This belongs in `@ctx/ledger` as `setTransactionSplits` and should move there
 * unchanged.** It is written to make that move a file rename: it takes a
 * `LedgerExecutor`-shaped handle, throws `LedgerError` with the ledger's own
 * codes, and touches exactly one table. The evidence note lists it as the first
 * deferred item.
 *
 * ## The invariant
 *
 * Splits must sum to the parent's **effective** amount, in the parent's
 * currency, and they replace the previous set wholesale rather than merging into
 * it. Enforced in the application rather than by a trigger for the reason
 * WP 1.1's schema comment gives: a per-row trigger makes an intermediate state
 * of a legitimate multi-row edit illegal.
 *
 * `Money.allocate` is not used here — the user supplied the numbers and the UI
 * (05 §5.5) will not let them save until the remainder is exactly zero. Largest
 * remainder belongs to "split evenly", which is a client-side affordance over the
 * same endpoint.
 */
import { money, newId, type Clock, type Money as MoneyType } from '@core/kernel';
import { transactionSplits, transactions } from '@ctx/ledger/schema';
import { LedgerError, type TransactionSplit } from '@ctx/ledger';
import { and, eq } from 'drizzle-orm';
import type { LedgerExecutor } from '@ctx/ledger';

export interface SplitInput {
  readonly amount: MoneyType;
  readonly userCategoryId: string | null;
  readonly note: string | null;
}

export interface SetSplitsInput {
  readonly userId: string;
  readonly transactionId: string;
  readonly splits: readonly SplitInput[];
}

async function requireTransaction(
  executor: LedgerExecutor,
  userId: string,
  transactionId: string,
): Promise<{ amountMinor: bigint; currency: string }> {
  const rows = await executor
    .select({
      amountMinor: transactions.effectiveAmountMinor,
      currency: transactions.effectiveCurrency,
    })
    .from(transactions)
    .where(and(eq(transactions.id, transactionId), eq(transactions.userId, userId)));
  const row = rows[0];
  if (row === undefined) {
    throw new LedgerError('ledger.transaction_not_found', `no transaction ${transactionId}`);
  }
  return { amountMinor: row.amountMinor, currency: row.currency.trim() };
}

/**
 * Replace a transaction's splits.
 *
 * Delete-then-insert rather than a diff: positions are dense and contiguous by
 * construction (`transaction_splits_position_idx` is unique on
 * `(transaction_id, position)`), and a diff that reorders lines would have to
 * dance around that index for no user-visible gain.
 */
export async function setTransactionSplits(
  executor: LedgerExecutor,
  input: SetSplitsInput,
  context: { clock: Clock },
): Promise<TransactionSplit[]> {
  const parent = await requireTransaction(executor, input.userId, input.transactionId);
  const now = context.clock.now();

  for (const split of input.splits) {
    if (split.amount.currency !== parent.currency) {
      throw new LedgerError(
        'ledger.currency_mismatch',
        `a split in ${split.amount.currency} cannot divide a transaction in ${parent.currency}`,
      );
    }
  }

  const total = input.splits.reduce((sum, split) => sum + split.amount.minor, 0n);
  if (total !== parent.amountMinor) {
    throw new LedgerError(
      'ledger.splits_do_not_sum',
      `splits total ${total.toString()} but the transaction is ${parent.amountMinor.toString()}`,
    );
  }

  await executor
    .delete(transactionSplits)
    .where(eq(transactionSplits.transactionId, input.transactionId));

  if (input.splits.length === 0) return [];

  const rows = input.splits.map((split, position) => ({
    id: newId(),
    userId: input.userId,
    transactionId: input.transactionId,
    position,
    amountMinor: split.amount.minor,
    currency: split.amount.currency,
    userCategoryId: split.userCategoryId,
    note: split.note,
    createdAt: now,
    updatedAt: now,
  }));
  await executor.insert(transactionSplits).values(rows);

  return rows.map((row) => ({
    id: row.id,
    transactionId: row.transactionId,
    position: row.position,
    amount: money(row.amountMinor, row.currency),
    userCategoryId: row.userCategoryId,
    note: row.note,
  }));
}

/** Drop every split. The transaction goes back to being one line. */
export async function clearTransactionSplits(
  executor: LedgerExecutor,
  input: { userId: string; transactionId: string },
): Promise<{ removed: number }> {
  await requireTransaction(executor, input.userId, input.transactionId);
  const removed = await executor
    .delete(transactionSplits)
    .where(eq(transactionSplits.transactionId, input.transactionId))
    .returning({ id: transactionSplits.id });
  return { removed: removed.length };
}
