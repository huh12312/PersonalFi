// SPDX-License-Identifier: MIT
/**
 * The user-edit write path.
 *
 * A user edit never touches `transactions_provider` — that is the whole point of
 * decision D11. It writes the sparse `user_*` overlay on `transactions` and then
 * refreshes the same `effective_*` projection the sync path refreshes, through
 * the same `resolveEffective()`. Two write paths, one resolver: if the sync path
 * and the edit path each had their own idea of what "effective" means, a renamed
 * payee would revert the next time the provider sent a revision, and nobody would
 * be able to say which layer had won.
 *
 * `null` in a patch means "clear it" (the user withdrew their intent and the
 * provider's value takes over again); a field absent from the patch is left
 * alone. That distinction is why the patch type uses optional properties rather
 * than a partial row.
 */
import { and, eq } from 'drizzle-orm';
import { transactions, transactionsProvider } from '../schema/index.ts';
import { transactionOf, type LedgerExecutor } from './db.ts';
import { LedgerError } from './errors.ts';
import { projectEffective } from './apply.ts';
import { ensureMerchants } from './merchant-store.ts';
import { resolveEffective } from './effective.ts';
import { factOf, overlayOf } from './db.ts';
import type { LedgerWriteContext } from './accounts.ts';
import type { LedgerTransaction } from './types.ts';

export interface OverlayPatch {
  readonly userNote?: string | null;
  readonly userExcluded?: boolean;
  /** Opaque id owned by `@ctx/categorization`. The ledger stores it, nothing more. */
  readonly userCategoryId?: string | null;
  readonly userMerchantName?: string | null;
}

/**
 * Apply a user's intent to one transaction.
 *
 * Returns the row as every reader will now see it, so a caller does not have to
 * re-read to find out what the resolver decided.
 */
export async function setTransactionOverlay(
  executor: LedgerExecutor,
  input: { userId: string; transactionId: string; patch: OverlayPatch },
  context: LedgerWriteContext,
): Promise<LedgerTransaction> {
  const now = context.clock.now();
  const rows = await executor
    .select({ transaction: transactions, fact: transactionsProvider })
    .from(transactions)
    .innerJoin(transactionsProvider, eq(transactions.currentFactId, transactionsProvider.id))
    .where(and(eq(transactions.id, input.transactionId), eq(transactions.userId, input.userId)));

  const row = rows[0];
  if (row === undefined) {
    throw new LedgerError('ledger.transaction_not_found', `no transaction ${input.transactionId}`);
  }

  const patched = {
    ...row.transaction,
    ...(input.patch.userNote === undefined ? {} : { userNote: input.patch.userNote }),
    ...(input.patch.userExcluded === undefined ? {} : { userExcluded: input.patch.userExcluded }),
    ...(input.patch.userCategoryId === undefined
      ? {}
      : { userCategoryId: input.patch.userCategoryId }),
    ...(input.patch.userMerchantName === undefined
      ? {}
      : { userMerchantName: input.patch.userMerchantName }),
  };

  // Resolve first, then map the resulting key to a merchant row: a user renaming
  // a payee to one that already exists must land on the existing row, not create
  // a second one with the same normalised key.
  const effective = resolveEffective(factOf(row.fact), overlayOf(patched));
  const merchantIds =
    effective.merchantKey === null
      ? new Map<string, string>()
      : await ensureMerchants(
          executor,
          input.userId,
          new Map([[effective.merchantKey, effective.merchantDisplayName ?? effective.name]]),
          now,
        );

  const projected = { ...projectEffective(patched, row.fact, merchantIds), updatedAt: now };
  const { id, createdAt: _createdAt, ...rest } = projected;
  await executor.update(transactions).set(rest).where(eq(transactions.id, id));
  return transactionOf(projected);
}
