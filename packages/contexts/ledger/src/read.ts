// SPDX-License-Identifier: MIT
/**
 * The read models.
 *
 * The transaction list is the app's most-run statement and the one a user waits
 * on, so three decisions are baked in here rather than left to a caller:
 *
 * **Keyset pagination, never `OFFSET`.** `OFFSET 40000` makes Postgres walk and
 * discard forty thousand rows, so the last page of a year's history is the
 * slowest one. Worse, it is *wrong* while data is arriving: a sync that inserts a
 * row above the current page shifts every subsequent offset by one, and the user
 * sees a transaction twice or never. A keyset cursor on
 * `(effective_date, id)` is stable under insertion — `keyset-stability.test.ts`
 * asserts exactly that — and reads one index range whatever page it is on.
 *
 * **The stored `effective_*` columns, never a join back to the fact.** They exist
 * to make this query one index scan. `resolveEffective()` wrote them; this reads
 * them; a test asserts the two agree for every row in the database.
 *
 * **`ILIKE` over a `gin_trgm_ops` index, not a tsvector.** A statement descriptor
 * is not prose: `WHOLEFDS MKT #10259` tokenises into noise, and a user searching
 * "wholefds" expects to find it. Trigrams handle the infix match a prefix index
 * cannot (decision D2, which is one of the reasons this is Postgres).
 */
import { DateOnly, type DateOnly as DateOnlyType, type Money } from '@core/kernel';
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import {
  accounts,
  merchants,
  transactionSplits,
  transactions,
  transactionsProvider,
  transferLinks,
  type AccountType,
  type TransferMatchKind,
} from '../schema/index.ts';
import { dateOnlyOf, moneyOf, transactionOf, type LedgerExecutor } from './db.ts';
import { LedgerError } from './errors.ts';
import type { LedgerTransaction, TransactionSplit } from './types.ts';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface TransactionFilters {
  readonly accountIds?: readonly string[];
  readonly merchantIds?: readonly string[];
  /** Opaque ids owned by `@ctx/categorization`; the ledger only matches on them. */
  readonly categoryIds?: readonly string[];
  readonly dateFrom?: DateOnlyType;
  readonly dateTo?: DateOnlyType;
  /** Signed minor units against the effective amount: -5000 is "$50 out or more". */
  readonly amountMinMinor?: bigint;
  readonly amountMaxMinor?: bigint;
  readonly pending?: boolean;
  /** `undefined` shows both; `false` hides the rows the user excluded. */
  readonly excluded?: boolean;
  readonly transfers?: 'include' | 'exclude' | 'only';
  /** Free text over the effective payee name. */
  readonly search?: string;
  /**
   * Rows the user has not assigned a category to.
   *
   * The *ledger's* meaning of uncategorized, which is `user_category_id IS NULL`
   * and nothing more. A row that `@ctx/categorization` has classified but the
   * user has never touched is still uncategorized by this definition, because
   * the ledger cannot see that context's assignments — `transactions` stores the
   * user's choice and only the user's. The transactions screen's
   * "Uncategorized ●12" chip needs the *effective* category and therefore needs
   * categorization's read model joined in; this filter is the Phase 1 stand-in
   * and is documented as such in the WP 1.5 evidence note.
   */
  readonly uncategorized?: boolean;
  /** Tombstoned rows are hidden by default. */
  readonly includeRemoved?: boolean;
  /** Cross-provider duplicates are shown by default — marked, never hidden. */
  readonly includeDuplicates?: boolean;
}

export interface ListTransactionsInput {
  readonly userId: string;
  readonly filters?: TransactionFilters;
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface TransactionPage {
  readonly items: readonly LedgerTransaction[];
  /** Opaque. Pass it back verbatim; `null` means this was the last page. */
  readonly nextCursor: string | null;
}

export async function listTransactions(
  executor: LedgerExecutor,
  input: ListTransactionsInput,
): Promise<TransactionPage> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const conditions = filterConditions(input.userId, input.filters ?? {});

  const cursor = decodeCursor(input.cursor);
  if (cursor !== null) {
    // Row-wise comparison, which matches `transactions_feed_idx`'s
    // (effective_date DESC, id DESC) ordering exactly, so Postgres starts the
    // scan at the cursor instead of filtering its way there.
    conditions.push(
      sql`(${transactions.effectiveDate}, ${transactions.id}) < (${cursor.date}::date, ${cursor.id}::uuid)`,
    );
  }

  const rows = await executor
    .select()
    .from(transactions)
    .where(and(...conditions))
    .orderBy(desc(transactions.effectiveDate), desc(transactions.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map(transactionOf),
    nextCursor:
      rows.length > limit && last !== undefined ? encodeCursor(last.effectiveDate, last.id) : null,
  };
}

/** Count matching rows. Separate from the page on purpose: it is the slow half. */
export async function countTransactions(
  executor: LedgerExecutor,
  input: { userId: string; filters?: TransactionFilters },
): Promise<number> {
  const rows = await executor
    .select({ count: sql<string>`count(*)` })
    .from(transactions)
    .where(and(...filterConditions(input.userId, input.filters ?? {})));
  return Number(rows[0]?.count ?? 0);
}

function filterConditions(userId: string, filters: TransactionFilters): (SQL | undefined)[] {
  const conditions: (SQL | undefined)[] = [eq(transactions.userId, userId)];

  if (filters.includeRemoved !== true) conditions.push(isNull(transactions.removedAt));
  if (filters.includeDuplicates === false) conditions.push(isNull(transactions.supersededById));
  if (filters.accountIds !== undefined && filters.accountIds.length > 0) {
    conditions.push(inArray(transactions.accountId, [...filters.accountIds]));
  }
  if (filters.merchantIds !== undefined && filters.merchantIds.length > 0) {
    conditions.push(inArray(transactions.effectiveMerchantId, [...filters.merchantIds]));
  }
  if (filters.categoryIds !== undefined && filters.categoryIds.length > 0) {
    conditions.push(inArray(transactions.userCategoryId, [...filters.categoryIds]));
  }
  if (filters.dateFrom !== undefined) {
    conditions.push(gte(transactions.effectiveDate, filters.dateFrom));
  }
  if (filters.dateTo !== undefined)
    conditions.push(lte(transactions.effectiveDate, filters.dateTo));
  if (filters.amountMinMinor !== undefined) {
    conditions.push(gte(transactions.effectiveAmountMinor, filters.amountMinMinor));
  }
  if (filters.amountMaxMinor !== undefined) {
    conditions.push(lte(transactions.effectiveAmountMinor, filters.amountMaxMinor));
  }
  if (filters.uncategorized === true) conditions.push(isNull(transactions.userCategoryId));
  if (filters.uncategorized === false) conditions.push(isNotNull(transactions.userCategoryId));
  if (filters.pending !== undefined) conditions.push(eq(transactions.pending, filters.pending));
  if (filters.excluded !== undefined) {
    conditions.push(eq(transactions.userExcluded, filters.excluded));
  }
  if (filters.transfers === 'exclude') conditions.push(eq(transactions.isTransfer, false));
  if (filters.transfers === 'only') conditions.push(eq(transactions.isTransfer, true));

  const search = filters.search?.trim();
  if (search !== undefined && search !== '') {
    const pattern = `%${escapeLike(search)}%`;
    // `effective_name` already *is* the resolved payee — the user's name if they
    // set one, else the provider's cleaned merchant name, else the raw
    // descriptor — so one column covers all three, and the trigram index on it
    // is the one that gets used. The note is searched too because a user who
    // wrote "reimburse Sam" expects to find it again.
    conditions.push(
      or(
        sql`${transactions.effectiveName} ILIKE ${pattern}`,
        sql`${transactions.userNote} ILIKE ${pattern}`,
      ),
    );
  }
  return conditions;
}

/**
 * `%` and `_` are wildcards in `LIKE`. A user searching for "20%" means twenty
 * percent, not "starts with 20"; a backslash means a backslash.
 */
function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * The cursor is `<effective_date>|<id>`, base64url.
 *
 * Opaque to the client on purpose — it is a position in an ordering, not a
 * filter, and a client that parses it will break the first time the ordering
 * gains a tiebreaker. Validated on the way back in, because it arrives from a
 * query string and lands in a SQL comparison.
 */
export function encodeCursor(date: string, id: string): string {
  return Buffer.from(`${date}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(
  cursor: string | null | undefined,
): { date: string; id: string } | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new LedgerError('ledger.cursor_invalid', 'cursor is not valid base64url');
  }
  const [date = '', id = ''] = decoded.split('|');
  if (!DateOnly.is(date) || !UUID_PATTERN.test(id)) {
    throw new LedgerError('ledger.cursor_invalid', 'cursor does not name a position in this feed');
  }
  return { date, id };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// ---------------------------------------------------------------------------
// One transaction, in full
// ---------------------------------------------------------------------------

/** Where the current numbers came from. Shown in the detail drawer, per 04 §2.2. */
export interface TransactionProvenance {
  readonly factId: string;
  readonly provider: string;
  readonly providerTransactionId: string;
  readonly pendingTransactionId: string | null;
  readonly postedDate: DateOnlyType;
  readonly authorizedDate: DateOnlyType | null;
  readonly providerName: string;
  readonly providerMerchantName: string | null;
  readonly providerAmount: Money;
  readonly providerCategory: unknown;
  readonly paymentChannel: string | null;
  readonly pending: boolean;
  readonly revision: number;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly removedAt: Date | null;
}

export interface TransferLinkView {
  readonly id: string;
  readonly otherTransactionId: string;
  readonly direction: 'outflow' | 'inflow';
  readonly amount: Money;
  readonly dayGap: number;
  readonly confidence: number;
  readonly howMatched: TransferMatchKind;
}

export interface TransactionDetail extends LedgerTransaction {
  readonly merchantDisplayName: string | null;
  readonly provenance: TransactionProvenance;
  readonly splits: readonly TransactionSplit[];
  readonly transfer: TransferLinkView | null;
  readonly removedAt: Date | null;
}

export async function getTransaction(
  executor: LedgerExecutor,
  input: { userId: string; transactionId: string },
): Promise<TransactionDetail> {
  const rows = await executor
    .select({
      transaction: transactions,
      fact: transactionsProvider,
      merchantName: merchants.displayName,
    })
    .from(transactions)
    .innerJoin(transactionsProvider, eq(transactions.currentFactId, transactionsProvider.id))
    .leftJoin(merchants, eq(transactions.effectiveMerchantId, merchants.id))
    .where(and(eq(transactions.id, input.transactionId), eq(transactions.userId, input.userId)));

  const row = rows[0];
  if (row === undefined) {
    throw new LedgerError('ledger.transaction_not_found', `no transaction ${input.transactionId}`);
  }

  const splitRows = await executor
    .select()
    .from(transactionSplits)
    .where(eq(transactionSplits.transactionId, input.transactionId))
    .orderBy(transactionSplits.position);

  let transfer: TransferLinkView | null = null;
  if (row.transaction.transferLinkId !== null) {
    const links = await executor
      .select()
      .from(transferLinks)
      .where(eq(transferLinks.id, row.transaction.transferLinkId));
    const link = links[0];
    if (link !== undefined) {
      const isOutflow = link.outflowTransactionId === row.transaction.id;
      transfer = {
        id: link.id,
        otherTransactionId: isOutflow ? link.inflowTransactionId : link.outflowTransactionId,
        direction: isOutflow ? 'outflow' : 'inflow',
        amount: moneyOf(link.amountMinor, link.currency),
        dayGap: link.dayGap,
        confidence: link.confidence,
        howMatched: link.howMatched,
      };
    }
  }

  return {
    ...transactionOf(row.transaction),
    merchantDisplayName: row.merchantName,
    removedAt: row.transaction.removedAt,
    transfer,
    provenance: {
      factId: row.fact.id,
      provider: row.fact.provider,
      providerTransactionId: row.fact.providerTransactionId,
      pendingTransactionId: row.fact.pendingTransactionId,
      postedDate: dateOnlyOf(row.fact.postedDate),
      authorizedDate: row.fact.authorizedDate === null ? null : dateOnlyOf(row.fact.authorizedDate),
      providerName: row.fact.name,
      providerMerchantName: row.fact.merchantName,
      providerAmount: moneyOf(row.fact.amountMinor, row.fact.currency),
      providerCategory: row.fact.providerCategory,
      paymentChannel: row.fact.paymentChannel,
      pending: row.fact.pending,
      revision: row.fact.revision,
      firstSeenAt: row.fact.firstSeenAt,
      lastSeenAt: row.fact.lastSeenAt,
      removedAt: row.fact.removedAt,
    },
    splits: splitRows.map((split): TransactionSplit => ({
      id: split.id,
      transactionId: split.transactionId,
      position: split.position,
      amount: moneyOf(split.amountMinor, split.currency),
      userCategoryId: split.userCategoryId,
      note: split.note,
    })),
  };
}

// ---------------------------------------------------------------------------
// The feed @ctx/categorization's decision engine reads
// ---------------------------------------------------------------------------

export interface CategorizationFeedFilters {
  /** Categorise exactly these. What the sync consumer's `LedgerPort` adapter passes. */
  readonly transactionIds?: readonly string[];
  readonly accountIds?: readonly string[];
  readonly dateFrom?: DateOnlyType;
  readonly dateTo?: DateOnlyType;
}

export interface CategorizationFeedRow {
  readonly id: string;
  readonly accountId: string;
  readonly accountType: AccountType;
  /** The ledger's resolved payee — `effective_name`. */
  readonly payee: string;
  /** The provider's raw descriptor, before anyone cleaned it. */
  readonly rawDescriptor: string;
  readonly providerMerchantName: string | null;
  readonly merchantId: string | null;
  readonly amount: Money;
  readonly date: DateOnlyType;
  readonly providerCategory: unknown;
  readonly isTransfer: boolean;
  /**
   * Tier 1, raw — **not** `resolveCategoryId`'s merged view. Non-null means the
   * user has spoken and the decision engine must not compete; see the warning on
   * `listForCategorization` below for why this must never be the *effective*
   * category.
   */
  readonly userCategoryId: string | null;
}

export interface CategorizationFeedPage {
  readonly items: readonly CategorizationFeedRow[];
  readonly nextCursor: string | null;
}

/**
 * Everything `@ctx/categorization`'s decision function is allowed to see about a
 * transaction, one page at a time.
 *
 * A dedicated read model rather than a reuse of `listTransactions` or
 * `getTransaction`, because the two callers want structurally different things.
 * The app's list page wants the *effective* view: money, date and category, all
 * resolved. The decision engine wants the raw ingredients that view was resolved
 * from, plus exactly one field off the overlay — `userCategoryId` — and only in
 * its **unmerged** form.
 *
 * Handing over `effective.categoryId` (`resolveCategoryId`'s output, which now
 * includes the rule tier) here instead would be a bug with teeth: once a rule's
 * own prior answer starts flowing into the slot `decide()` reads as "the user
 * said so", tier 1 wins by construction on every subsequent run, the rule tier
 * never gets a chance to re-decide, and a category becomes permanent the moment
 * a rule first sets it — indistinguishable from a real user edit forever after.
 * `userCategoryId` here is always the raw stored column, never the resolver's
 * output.
 *
 * `@ctx/categorization` never calls this directly — `personalfi/layer-imports`
 * forbids one context importing another (decision D8) — the composition root
 * (`apps/api/src/domain.ts`) adapts this to that context's `LedgerPort`.
 */
export async function listForCategorization(
  executor: LedgerExecutor,
  input: {
    readonly userId: string;
    readonly filters?: CategorizationFeedFilters;
    readonly cursor?: string | null;
    readonly limit?: number;
  },
): Promise<CategorizationFeedPage> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const filters = input.filters ?? {};
  const conditions: (SQL | undefined)[] = [
    eq(transactions.userId, input.userId),
    isNull(transactions.removedAt),
  ];
  if (filters.transactionIds !== undefined && filters.transactionIds.length > 0) {
    conditions.push(inArray(transactions.id, [...filters.transactionIds]));
  }
  if (filters.accountIds !== undefined && filters.accountIds.length > 0) {
    conditions.push(inArray(transactions.accountId, [...filters.accountIds]));
  }
  if (filters.dateFrom !== undefined) {
    conditions.push(gte(transactions.effectiveDate, filters.dateFrom));
  }
  if (filters.dateTo !== undefined)
    conditions.push(lte(transactions.effectiveDate, filters.dateTo));

  const cursor = decodeCursor(input.cursor);
  if (cursor !== null) {
    conditions.push(
      sql`(${transactions.effectiveDate}, ${transactions.id}) < (${cursor.date}::date, ${cursor.id}::uuid)`,
    );
  }

  const rows = await executor
    .select({ transaction: transactions, fact: transactionsProvider, accountType: accounts.type })
    .from(transactions)
    .innerJoin(transactionsProvider, eq(transactions.currentFactId, transactionsProvider.id))
    .innerJoin(accounts, eq(transactions.accountId, accounts.id))
    .where(and(...conditions))
    .orderBy(desc(transactions.effectiveDate), desc(transactions.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((row): CategorizationFeedRow => ({
      id: row.transaction.id,
      accountId: row.transaction.accountId,
      accountType: row.accountType,
      payee: row.transaction.effectiveName,
      rawDescriptor: row.fact.name,
      providerMerchantName: row.fact.merchantName,
      merchantId: row.transaction.effectiveMerchantId,
      amount: moneyOf(row.transaction.effectiveAmountMinor, row.transaction.effectiveCurrency),
      date: dateOnlyOf(row.transaction.effectiveDate),
      providerCategory: row.fact.providerCategory,
      isTransfer: row.transaction.isTransfer,
      userCategoryId: row.transaction.userCategoryId,
    })),
    nextCursor:
      rows.length > limit && last !== undefined
        ? encodeCursor(last.transaction.effectiveDate, last.transaction.id)
        : null,
  };
}

/**
 * Payees, most-used first. The list page's filter chips are built from this, and
 * it is a `@ctx/ledger` read model rather than a table scan in the API because
 * `merchants` belongs to this context and nothing outside it may read the table.
 */
export async function listMerchants(
  executor: LedgerExecutor,
  input: { userId: string; limit?: number },
): Promise<{ id: string; displayName: string; transactionCount: number }[]> {
  const rows = await executor
    .select({
      id: merchants.id,
      displayName: merchants.displayName,
      transactionCount: sql<string>`count(${transactions.id})`,
    })
    .from(merchants)
    .leftJoin(
      transactions,
      and(eq(transactions.effectiveMerchantId, merchants.id), isNull(transactions.removedAt)),
    )
    .where(eq(merchants.userId, input.userId))
    .groupBy(merchants.id, merchants.displayName)
    .orderBy(desc(sql`count(${transactions.id})`), merchants.displayName)
    .limit(Math.min(input.limit ?? 100, 500));

  return rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    transactionCount: Number(row.transactionCount),
  }));
}

/**
 * Every row whose stored projection might have drifted from `resolveEffective()`.
 *
 * Exists for the invariant test and for a future rebuild job: after an algorithm
 * fix, "recompute the projection for every row" must be a supported operation,
 * not an archaeology exercise. Streams by keyset rather than loading 50,000 rows.
 */
export async function scanForProjectionCheck(
  executor: LedgerExecutor,
  input: { userId: string; after?: { date: string; id: string }; limit?: number },
): Promise<
  {
    transaction: typeof transactions.$inferSelect;
    fact: typeof transactionsProvider.$inferSelect;
  }[]
> {
  const conditions: (SQL | undefined)[] = [eq(transactions.userId, input.userId)];
  if (input.after !== undefined) {
    conditions.push(
      sql`(${transactions.effectiveDate}, ${transactions.id}) < (${input.after.date}::date, ${input.after.id}::uuid)`,
    );
  }
  return executor
    .select({ transaction: transactions, fact: transactionsProvider })
    .from(transactions)
    .innerJoin(transactionsProvider, eq(transactions.currentFactId, transactionsProvider.id))
    .where(and(...conditions))
    .orderBy(desc(transactions.effectiveDate), desc(transactions.id))
    .limit(Math.min(input.limit ?? 1000, 5000));
}

/** Rows the provider retracted and nothing reclaimed. Hidden, never deleted here. */
export async function listRemovedTransactions(
  executor: LedgerExecutor,
  input: { userId: string },
): Promise<LedgerTransaction[]> {
  const rows = await executor
    .select()
    .from(transactions)
    .where(and(eq(transactions.userId, input.userId), isNotNull(transactions.removedAt)))
    .orderBy(desc(transactions.effectiveDate), desc(transactions.id));
  return rows.map(transactionOf);
}

/** Sum of the effective amounts a filter selects, by currency. Excludes transfers. */
export async function sumTransactions(
  executor: LedgerExecutor,
  input: { userId: string; filters?: TransactionFilters },
): Promise<{ currency: string; total: Money }[]> {
  const conditions = filterConditions(input.userId, {
    transfers: 'exclude',
    includeDuplicates: false,
    ...input.filters,
  });
  conditions.push(ne(transactions.effectiveAmountMinor, 0n));
  const rows = await executor
    .select({
      currency: transactions.effectiveCurrency,
      total: sql<string>`sum(${transactions.effectiveAmountMinor})`,
    })
    .from(transactions)
    .where(and(...conditions))
    .groupBy(transactions.effectiveCurrency);
  return rows.map((row) => ({
    currency: row.currency.trim(),
    total: moneyOf(BigInt(row.total), row.currency),
  }));
}
