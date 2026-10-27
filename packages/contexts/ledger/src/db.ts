// SPDX-License-Identifier: MIT
import type { Database } from '@core/db';
import {
  DateOnly,
  money,
  type Clock,
  type DateOnly as DateOnlyType,
  type Money,
} from '@core/kernel';
import type { Executor } from '@core/platform';
import type { SQL } from 'drizzle-orm';
import { resolveCategory } from './effective.ts';
import type {
  AutoCategoryView,
  AutoResolution,
  EffectiveTransaction,
  LedgerTransaction,
  ProviderCounterparty,
  RuleResolution,
  TransactionFact,
  TransactionOverlay,
} from './types.ts';
import type { TransactionProviderRow, TransactionRow } from '../schema/index.ts';

/**
 * The database surface this context needs.
 *
 * A `Pick` rather than the full `Database`, so a Drizzle transaction handle and
 * the pool-backed database both satisfy it structurally and every write function
 * can be called inside a caller-supplied transaction. That is not a convenience:
 * `appendEvent` requires a transaction handle by construction (there is no
 * overload that publishes outside one), so a writer that could not accept one
 * could not emit its own events atomically.
 */
export type LedgerExecutor = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute' | 'with'
>;

/** The pool-backed database, which can also open transactions. */
export type LedgerDatabase = Database;

/**
 * Adapt a Drizzle handle to the platform's narrow `Executor`, for `appendEvent`.
 *
 * One cast, in one place, for one reason: Drizzle's `execute()` returns `PgRaw`,
 * a lazily-executed thenable, where the platform's `Executor` declares a
 * `Promise`. The two are interchangeable at runtime (`PgRaw` awaits to exactly
 * the `{ rows }` shape) but not assignable at compile time, which is why
 * `@core/platform` makes the identical cast in `platformExecutor()`. Doing it
 * here rather than at each call site keeps `appendEvent(tx, …)` honest: the
 * handle that writes the rows is the handle that appends the event, so the event
 * cannot outlive a rolled-back write.
 */
export function outboxOf(executor: LedgerExecutor): Executor {
  return {
    execute: <TRow extends Record<string, unknown>>(query: SQL) =>
      executor.execute(query) as unknown as Promise<{ rows: TRow[] }>,
  };
}

/** Everything a write path needs that is not data. */
export interface LedgerContext {
  readonly userId: string;
  readonly clock: Clock;
  /** Ties a whole sync run together in the event log and the logs. */
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export function moneyOf(minor: bigint, currency: string): Money {
  return money(minor, currency.trim());
}

/** `DATE` arrives as `YYYY-MM-DD` because `@core/db` overrides the driver's parser. */
export function dateOnlyOf(value: string): DateOnlyType {
  return DateOnly.parse(value);
}

/** The narrow slice of a provider row that `resolveEffective` is allowed to see. */
export function factOf(row: TransactionProviderRow): TransactionFact {
  return {
    amount: moneyOf(row.amountMinor, row.currency),
    postedDate: dateOnlyOf(row.postedDate),
    authorizedDate: row.authorizedDate === null ? null : dateOnlyOf(row.authorizedDate),
    name: row.name,
    merchantName: row.merchantName,
    pending: row.pending,
    // Decision D25, tier 2. Without these the read path would resolve a
    // different merchant than the write path did for any descriptor whose only
    // evidence of a payee is a provider entity id.
    provider: row.provider,
    counterparties: row.counterparties as readonly ProviderCounterparty[] | null,
  };
}

/**
 * The user's overlay, as stored.
 *
 * The other half of `resolveEffective`'s input. Sparse by construction: `null`
 * means "the user has not spoken", which the resolver treats as "defer to the
 * provider" — so a provider revision that renames a payee is visible immediately
 * to everyone who never renamed it, and invisible to everyone who did.
 */
export function overlayOf(row: TransactionRow): TransactionOverlay {
  return {
    userNote: row.userNote,
    userExcluded: row.userExcluded,
    userCategoryId: row.userCategoryId,
    userMerchantName: row.userMerchantName,
  };
}

/**
 * The rule tier's stored answer, as `resolveEffective`'s `rule` argument
 * expects it. The other half of `overlayOf`: sparse, opaque, and written by
 * nothing under `src/` except `setRuleCategory` (`overlay.ts`).
 */
export function ruleOf(row: TransactionRow): RuleResolution {
  return { ruleCategoryId: row.ruleCategoryId };
}

/**
 * The automatic tiers' stored answer, as `resolveEffective`'s `auto` argument
 * expects it. Sparse like `ruleOf`: written by nothing under `src/` except
 * `setAutoCategories` (`auto-category.ts`).
 */
export function autoOf(row: TransactionRow): AutoResolution {
  return { autoCategoryId: row.autoCategoryId };
}

/**
 * The stored provenance of an automatic placement, or `null` when there is none.
 * Read back from the row, never recomputed: the confidence is the calibrated
 * figure the engine stored with the assignment.
 */
export function autoViewOf(row: TransactionRow): AutoCategoryView | null {
  if (
    row.autoCategoryId === null ||
    row.autoTier === null ||
    row.autoConfidence === null ||
    row.autoDecidedAt === null ||
    row.autoAssignmentId === null
  ) {
    return null;
  }
  return {
    tier: row.autoTier,
    confidence: row.autoConfidence,
    decidedAt: row.autoDecidedAt,
    assignmentId: row.autoAssignmentId,
    supersededAt: row.autoSupersededAt,
  };
}

/**
 * A row's columns minus the six `auto_*` ones. Every write path that sets a whole
 * row (a sync page, a user edit) goes through this, so none of them can write a
 * stale automatic placement back over a categorisation pass that committed after
 * the row was read.
 */
export function withoutAutoColumns<T extends Partial<TransactionRow>>(
  row: T,
): Omit<
  T,
  | 'autoCategoryId'
  | 'autoTier'
  | 'autoConfidence'
  | 'autoDecidedAt'
  | 'autoAssignmentId'
  | 'autoSupersededAt'
> {
  const {
    autoCategoryId: _a,
    autoTier: _b,
    autoConfidence: _c,
    autoDecidedAt: _d,
    autoAssignmentId: _e,
    autoSupersededAt: _f,
    ...rest
  } = row;
  return rest;
}

/**
 * Rehydrate the stored effective columns.
 *
 * Note what this does *not* do: recompute them. The stored columns are the
 * projection `resolveEffective()` produced at write time, and reading them back is
 * the whole point of denormalising them. `effective-invariant.test.ts` is what
 * keeps the two honest — it walks every row in the database and asserts the stored
 * values equal a fresh resolution of the fact and overlay.
 *
 * `categoryId` is the one field here that is not simply read back: there is no
 * stored `effective_category_id` column, unlike `effective_date` and its
 * siblings, because the category tier order needs only the overlay, the rule
 * column and (WP 11.2b) the automatic tiers' column — all already on this row —
 * and never the fact. Computing it here rather than denormalising a seventh
 * `effective_*` column is one fewer column a rule write, a pick or a
 * categorisation pass would have to keep in sync.
 */
export function effectiveOf(row: TransactionRow): EffectiveTransaction {
  const merchantName = row.userMerchantName ?? row.effectiveName;
  const category = resolveCategory(overlayOf(row), ruleOf(row), autoOf(row));
  return {
    date: dateOnlyOf(row.effectiveDate),
    amount: moneyOf(row.effectiveAmountMinor, row.effectiveCurrency),
    name: row.effectiveName,
    merchantKey: null,
    merchantDisplayName: row.effectiveMerchantId === null ? null : merchantName,
    pending: row.pending,
    excluded: row.userExcluded,
    categoryId: category.categoryId,
    categorySource: category.source,
    note: row.userNote,
  };
}

export function transactionOf(row: TransactionRow): LedgerTransaction {
  return {
    id: row.id,
    accountId: row.accountId,
    factId: row.currentFactId,
    effective: effectiveOf(row),
    auto: autoViewOf(row),
    merchantId: row.effectiveMerchantId,
    isTransfer: row.isTransfer,
    transferLinkId: row.transferLinkId,
    refundOfId: row.refundOfId,
    refundConfidence: row.refundConfidence,
    supersededById: row.supersededById,
    supersededReason: row.supersededReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
