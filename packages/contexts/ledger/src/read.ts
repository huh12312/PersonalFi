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
import { resolveCategoryId } from './effective.ts';
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

/**
 * The fields an aggregate over the ledger reads — the reports' `ReportRow` shape — and nothing else (WP 10.9).
 * Every field is what `listTransactions` returns for the same row (`effective.date`, `effective.amount`,
 * `effective.categoryId` by `resolveCategoryId`, `effective.excluded`, `effective.pending`, …), asserted field
 * for field by `test/read.test.ts`.
 */
export interface LedgerAggregateRow {
  readonly id: string;
  readonly accountId: string;
  readonly date: DateOnlyType;
  readonly amount: Money;
  readonly categoryId: string | null;
  readonly merchantId: string | null;
  readonly isTransfer: boolean;
  readonly transferLinkId: string | null;
  readonly refundOfId: string | null;
  readonly excluded: boolean;
  readonly pending: boolean;
}

/**
 * Every row matching `filters` inside a **bounded** date window, in one statement, as `LedgerAggregateRow`s
 * (WP 10.9).
 *
 * For an aggregate a server computes and never ships row by row — the spending pace reads four months to draw
 * four curves — a keyset page sequence is N sequential round trips for one answer, and a full row (forty-odd
 * columns, mapped into a `LedgerTransaction`) is most of the cost: on a busy ledger, 6,300 full rows took ~75 ms
 * to read and map (`apps/api/test/db/spending-pace-http-perf.test.ts`'s dense corpus). The conditions are
 * `listTransactions`' own (`filterConditions`), over the same feed index `(user_id, effective_date, id)`; the
 * projection is the eleven columns an aggregate needs, and the `LIMIT` is gone, which is why both ends of the
 * window are required.
 */
export async function listAggregateRowsInWindow(
  executor: LedgerExecutor,
  input: {
    readonly userId: string;
    readonly filters: TransactionFilters & {
      readonly dateFrom: DateOnlyType;
      readonly dateTo: DateOnlyType;
    };
  },
): Promise<LedgerAggregateRow[]> {
  return selectAggregateRows(executor, input);
}

async function selectAggregateRows(
  executor: LedgerExecutor,
  input: {
    readonly userId: string;
    readonly filters: TransactionFilters & {
      readonly dateFrom: DateOnlyType;
      readonly dateTo: DateOnlyType;
    };
  },
  extra?: SQL,
): Promise<LedgerAggregateRow[]> {
  // A plain statement through `execute` (WP 10.10), not the query builder: on 31,000 rows the builder's own result
  // mapping was ~70 of ~195 ms (`apps/api/test/db/cash-flow-http-perf.test.ts`'s dense year). Same columns, same
  // conditions (`filterConditions`), same order; the `@core/db` type parsers still make `int8` a `bigint` and `DATE`
  // the `YYYY-MM-DD` text, so the mapping below is the builder path's, field for field (`test/read.test.ts`).
  const result = await executor.execute<{
    id: string;
    account_id: string;
    effective_date: string;
    effective_amount_minor: bigint;
    effective_currency: string;
    user_category_id: string | null;
    rule_category_id: string | null;
    effective_merchant_id: string | null;
    is_transfer: boolean;
    transfer_link_id: string | null;
    refund_of_id: string | null;
    user_excluded: boolean;
    pending: boolean;
  }>(sql`
    SELECT ${transactions.id} AS id,
           ${transactions.accountId} AS account_id,
           ${transactions.effectiveDate} AS effective_date,
           ${transactions.effectiveAmountMinor} AS effective_amount_minor,
           ${transactions.effectiveCurrency} AS effective_currency,
           ${transactions.userCategoryId} AS user_category_id,
           ${transactions.ruleCategoryId} AS rule_category_id,
           ${transactions.effectiveMerchantId} AS effective_merchant_id,
           ${transactions.isTransfer} AS is_transfer,
           ${transactions.transferLinkId} AS transfer_link_id,
           ${transactions.refundOfId} AS refund_of_id,
           ${transactions.userExcluded} AS user_excluded,
           ${transactions.pending} AS pending
      FROM ${transactions}
     WHERE ${and(...filterConditions(input.userId, input.filters), extra)}
     ORDER BY ${transactions.effectiveDate} DESC, ${transactions.id} DESC
  `);
  // `CHAR(3)` arrives padded; a ledger holds a handful of currencies, so each is validated once, not per row.
  const currencies = new Map<string, Money['currency']>();
  return result.rows.map((row) => {
    let code = currencies.get(row.effective_currency);
    if (code === undefined) {
      code = moneyOf(0n, row.effective_currency).currency;
      currencies.set(row.effective_currency, code);
    }
    return {
      id: row.id,
      accountId: row.account_id,
      // The `DATE` parser hands over the column's own ISO text, which is a DateOnly by construction.
      date: row.effective_date as DateOnlyType,
      amount: moneyOf(row.effective_amount_minor, code),
      // `effectiveOf`'s own rule: the overlay's category, else the rule tier's (only `userCategoryId` is read).
      categoryId: resolveCategoryId(
        {
          userNote: null,
          userExcluded: row.user_excluded,
          userCategoryId: row.user_category_id,
          userMerchantName: null,
        },
        { ruleCategoryId: row.rule_category_id },
      ),
      merchantId: row.effective_merchant_id,
      isTransfer: row.is_transfer,
      transferLinkId: row.transfer_link_id,
      refundOfId: row.refund_of_id,
      excluded: row.user_excluded,
      pending: row.pending,
    };
  });
}

/**
 * Rows `computeActuals` treats identically, summed (WP 10.10): same account, currency, category tiers, merchant,
 * transfer flag, transfer-link presence and exclusion, in the same **segment** of the same month — a month is split at each date in
 * `cuts` that falls inside it, so a window ending on a cut or on a month end contains whole segments only. `date` is
 * the segment's last day; `count` is how many rows it sums.
 *
 * Refunds, and every row a refund names (`refund_of_id`), are **left out** — they are the rows whose treatment
 * depends on another row — and come back one by one from `listRefundLinkedRowsInWindow` over the same window: the two
 * reads partition `listAggregateRowsInWindow`'s rows exactly (`test/read.test.ts`). For an aggregate over a long
 * window whose rows need no identity of their own (the Cash Flow hub's history: 50,000 dense rows read and parsed in
 * ~200 ms, summed in Postgres to a few thousand).
 */
export interface LedgerAggregateSum {
  readonly accountId: string;
  readonly date: DateOnlyType;
  readonly amount: Money;
  readonly categoryId: string | null;
  readonly merchantId: string | null;
  readonly isTransfer: boolean;
  readonly linked: boolean;
  readonly excluded: boolean;
  readonly count: number;
}

/**
 * "A refund, or a row some refund names": the rows whose treatment depends on another row. The named rows are one
 * hashed sub-plan over the refund index, not a probe per row.
 */
function refundLinked(userId: string): SQL {
  return sql`(${transactions.refundOfId} IS NOT NULL OR ${transactions.id} IN (
    SELECT refund.refund_of_id FROM ${transactions} AS refund
     WHERE refund.user_id = ${userId} AND refund.refund_of_id IS NOT NULL))`;
}

/**
 * The segment a row's date falls in: the first cut on or after it in its month, else its month. Returned as the cut
 * itself, or as the month's **first** day (`date - (day - 1)`: integer date arithmetic — `date_trunc` would go through
 * `timestamptz` for every row) with `is_cut` false; the caller turns a month into its last day.
 */
function segmentOf(cuts: readonly DateOnlyType[]): {
  readonly key: SQL;
  readonly isCut: SQL;
  readonly join: SQL;
} {
  const sorted = [...new Set(cuts)].sort();
  const monthStart = sql`(${transactions.effectiveDate} - (EXTRACT(DAY FROM ${transactions.effectiveDate})::int - 1))`;
  if (sorted.length === 0) return { key: monthStart, isCut: sql`false`, join: sql`` };
  const months = sorted.map((cut) => DateOnly.startOfMonth(cut));
  if (new Set(months).size === months.length) {
    // One cut per month (the hub's counterparts never share a month): a hashed join on the month, not a CASE
    // branch per cut evaluated for every row.
    const values = sorted.map((cut) => sql`(${DateOnly.startOfMonth(cut)}::date, ${cut}::date)`);
    return {
      key: sql`COALESCE(segment_cut.day, ${monthStart})`,
      isCut: sql`(segment_cut.day IS NOT NULL)`,
      join: sql`LEFT JOIN (VALUES ${sql.join(values, sql`, `)}) AS segment_cut(month_start, day)
                  ON segment_cut.month_start = ${monthStart} AND ${transactions.effectiveDate} <= segment_cut.day`,
    };
  }
  const range = (cut: DateOnlyType) =>
    sql`${transactions.effectiveDate} BETWEEN ${DateOnly.startOfMonth(cut)}::date AND ${cut}::date`;
  const keys = sorted.map((cut) => sql`WHEN ${range(cut)} THEN ${cut}::date`);
  const flags = sorted.map((cut) => sql`WHEN ${range(cut)} THEN true`);
  return {
    key: sql`CASE ${sql.join(keys, sql` `)} ELSE ${monthStart} END`,
    isCut: sql`CASE ${sql.join(flags, sql` `)} ELSE false END`,
    join: sql``,
  };
}

export async function listAggregateSumsInWindow(
  executor: LedgerExecutor,
  input: {
    readonly userId: string;
    readonly filters: TransactionFilters & {
      readonly dateFrom: DateOnlyType;
      readonly dateTo: DateOnlyType;
    };
    readonly cuts: readonly DateOnlyType[];
  },
): Promise<LedgerAggregateSum[]> {
  const segment = segmentOf(input.cuts);
  const result = await executor.execute<{
    account_id: string;
    segment: string;
    is_cut: boolean;
    effective_currency: string;
    user_category_id: string | null;
    rule_category_id: string | null;
    effective_merchant_id: string | null;
    is_transfer: boolean;
    linked: boolean;
    user_excluded: boolean;
    sum_minor: bigint;
    n: bigint;
  }>(sql`
    SELECT ${transactions.accountId} AS account_id,
           ${segment.key} AS segment,
           ${segment.isCut} AS is_cut,
           ${transactions.effectiveCurrency} AS effective_currency,
           ${transactions.userCategoryId} AS user_category_id,
           ${transactions.ruleCategoryId} AS rule_category_id,
           ${transactions.effectiveMerchantId} AS effective_merchant_id,
           ${transactions.isTransfer} AS is_transfer,
           (${transactions.transferLinkId} IS NOT NULL) AS linked,
           ${transactions.userExcluded} AS user_excluded,
           sum(${transactions.effectiveAmountMinor})::bigint AS sum_minor,
           count(*)::bigint AS n
      FROM ${transactions}
      ${segment.join}
     WHERE ${and(...filterConditions(input.userId, input.filters))}
       AND NOT ${refundLinked(input.userId)}
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  `);
  // No ORDER BY: it turned a hash aggregate into a sort of every row (68 → 33 ms on 25,000 dense rows), and a sum's
  // order means nothing — the amounts are exact and a sum has no identity.
  const currencies = new Map<string, Money['currency']>();
  return result.rows.map((row) => {
    let code = currencies.get(row.effective_currency);
    if (code === undefined) {
      code = moneyOf(0n, row.effective_currency).currency;
      currencies.set(row.effective_currency, code);
    }
    return {
      accountId: row.account_id,
      date: row.is_cut
        ? (row.segment as DateOnlyType)
        : DateOnly.endOfMonth(row.segment as DateOnlyType),
      amount: moneyOf(BigInt(row.sum_minor), code),
      categoryId: resolveCategoryId(
        {
          userNote: null,
          userExcluded: row.user_excluded,
          userCategoryId: row.user_category_id,
          userMerchantName: null,
        },
        { ruleCategoryId: row.rule_category_id },
      ),
      merchantId: row.effective_merchant_id,
      isTransfer: row.is_transfer,
      linked: row.linked,
      excluded: row.user_excluded,
      count: Number(row.n),
    };
  });
}

/** The complement of `listAggregateSumsInWindow`: refunds and the rows refunds name, one by one. */
export async function listRefundLinkedRowsInWindow(
  executor: LedgerExecutor,
  input: {
    readonly userId: string;
    readonly filters: TransactionFilters & {
      readonly dateFrom: DateOnlyType;
      readonly dateTo: DateOnlyType;
    };
  },
): Promise<LedgerAggregateRow[]> {
  return selectAggregateRows(executor, input, refundLinked(input.userId));
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
 * The display name of each named merchant, this holder's only (WP 10.10: the Cash Flow hub's merchant breakdown
 * labels the merchant ids its rows carry). An id that is not this holder's, or no longer exists, is simply absent
 * from the map: the caller says "Unknown merchant", never another holder's name.
 */
export async function merchantDisplayNames(
  executor: LedgerExecutor,
  input: { readonly userId: string; readonly ids: readonly string[] },
): Promise<Map<string, string>> {
  if (input.ids.length === 0) return new Map();
  const rows = await executor
    .select({ id: merchants.id, displayName: merchants.displayName })
    .from(merchants)
    .where(and(eq(merchants.userId, input.userId), inArray(merchants.id, [...new Set(input.ids)])));
  return new Map(rows.map((row) => [row.id, row.displayName] as const));
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
