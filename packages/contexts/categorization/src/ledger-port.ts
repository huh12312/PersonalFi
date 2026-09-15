// SPDX-License-Identifier: MIT
/**
 * How this context reads the ledger: a port, not an import.
 *
 * `personalfi/layer-imports` forbids one context importing another, and
 * docs/CONVENTIONS.md states the remedy in one line — "where a cycle seems
 * necessary, the answer is a domain event, not an import". Categorisation needs
 * both directions of that: it *reacts* to `ledger.TransactionsUpserted` (an
 * event, via the pump) and it *reads* the transactions that event named (which an
 * event payload deliberately does not carry — `@ctx/ledger`'s `events.ts`:
 * "payloads are ids and counts, never rows").
 *
 * So the read is a port. This file declares the shape; `apps/api`, the
 * composition root and the only layer allowed to wire things together, supplies
 * an adapter over `listTransactions` and `getTransaction`. Three things fall out
 * of that, and all three are worth the indirection:
 *
 *   * the boundary lint stays intact, and stays *meaningful* — no exception was
 *     carved for this context;
 *   * every test here runs against an in-memory implementation, so the engine's
 *     accuracy numbers are measured without a database in the loop;
 *   * the day a transaction can come from somewhere other than `@ctx/ledger` —
 *     a CSV preview screen that wants to show what *would* be categorised before
 *     importing anything — the engine already works on it.
 *
 * The port is otherwise read-only by design: this context writes its own tables
 * and its own events, and never the ledger's `user_category_id` — that column is
 * the *user's* overlay, and only the user's own edit through
 * `setTransactionOverlay` may write it.
 *
 * One write does cross the seam. Ledger's `resolveEffective` has a rule tier
 * (04 §2.2's middle tier; wp1.4 evidence §6) sitting between the user's overlay
 * and provider truth, and this context is that tier's only producer — a
 * resolution tier with no producer is a tier nobody can test. `decide()` in
 * `engine.ts` already returns `source: 'rule'` when a rule wins; `writeRuleCategory`
 * is how that answer reaches the column `resolveEffective`'s `rule` argument
 * reads, so a list page can show it without joining back into this context's
 * `category_assignments` on every row. It is still not a `user_category_id`
 * write, and the real adapter (`apps/api`, the composition root) is expected to
 * route it at `@ctx/ledger`'s `setRuleCategory` — the one function that touches
 * that column and nothing else.
 */
import type { DateOnly } from '@core/kernel';

/** Everything a decision is allowed to see about a transaction. */
export interface CategorizableTransaction {
  readonly id: string;
  readonly accountId: string;
  /** `depository` | `credit` | `loan` | `investment` | `crypto` | `manual`. */
  readonly accountType: string | null;
  /** The ledger's resolved `effective_name`. */
  readonly payee: string;
  /** The provider's raw descriptor, before anyone cleaned it. */
  readonly rawDescriptor: string;
  /** The provider's own cleaned merchant name, when it sent one. */
  readonly providerMerchantName: string | null;
  /** `@ctx/ledger`'s `merchants.id`, or null when nothing grouped. */
  readonly merchantId: string | null;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly date: DateOnly;
  /** `transactions_provider.provider_category`, verbatim jsonb. */
  readonly providerCategory: unknown;
  /** Only ever present from a CSV/OFX import; Plaid does not send it. */
  readonly mcc: string | null;
  readonly isTransfer: boolean;
  /** The user's overlay. Non-null means tier 1 wins and we must not compete. */
  readonly userCategoryId: string | null;
}

export interface ListForCategorizationInput {
  readonly userId: string;
  /** Categorise exactly these. What the sync consumer passes. */
  readonly transactionIds?: readonly string[];
  readonly dateFrom?: DateOnly;
  readonly dateTo?: DateOnly;
  readonly accountIds?: readonly string[];
  /** Opaque, straight from `@ctx/ledger`'s keyset pagination. */
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface CategorizableTransactionPage {
  readonly items: readonly CategorizableTransaction[];
  readonly nextCursor: string | null;
}

export interface WriteRuleCategoryInput {
  readonly userId: string;
  readonly transactionId: string;
  /**
   * One of this context's own `categories.id` values, or `null` to clear it (a
   * rule that stopped matching, or was deleted). Never a category *key* — the
   * ledger stores an opaque id and never resolves it.
   */
  readonly ruleCategoryId: string | null;
  /** Ties this write into the same trace as the sync or rule apply that caused it. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface LedgerPort {
  listForCategorization(input: ListForCategorizationInput): Promise<CategorizableTransactionPage>;
  /** Push the rule tier's answer into `@ctx/ledger`'s `resolveEffective` seam. */
  writeRuleCategory(input: WriteRuleCategoryInput): Promise<void>;
}

/**
 * Walk every page. The retroactive-apply and backfill paths both want this.
 *
 * A generator rather than an array: a retroactive rule apply over 50,000
 * transactions must not hold 50,000 rows in memory to count how many would
 * change, and `applyRule`'s preview mode is exactly that operation.
 */
export async function* streamTransactions(
  port: LedgerPort,
  input: ListForCategorizationInput,
  pageSize = 500,
): AsyncGenerator<CategorizableTransaction> {
  let cursor: string | null = input.cursor ?? null;
  do {
    // Spread-then-override would carry an explicit `undefined` into every
    // optional field, which `exactOptionalPropertyTypes` correctly rejects: a
    // property that is present and undefined is not the same as an absent one,
    // and an adapter is entitled to tell them apart.
    const page: CategorizableTransactionPage = await port.listForCategorization({
      userId: input.userId,
      ...(input.transactionIds === undefined ? {} : { transactionIds: input.transactionIds }),
      ...(input.dateFrom === undefined ? {} : { dateFrom: input.dateFrom }),
      ...(input.dateTo === undefined ? {} : { dateTo: input.dateTo }),
      ...(input.accountIds === undefined ? {} : { accountIds: input.accountIds }),
      cursor,
      limit: pageSize,
    });
    for (const item of page.items) yield item;
    cursor = page.nextCursor;
  } while (cursor !== null);
}
