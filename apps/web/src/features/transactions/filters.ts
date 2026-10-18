// SPDX-License-Identifier: MIT
import { z } from 'zod';

import type { ListTransactionsData } from '../../api/generated/types.gen.ts';

/**
 * URL search state for `/transactions` (`src/routes/_app.transactions.tsx`'s
 * `validateSearch`). Kept close to `GET /transactions`'s own query shape
 * (docs/evidence/phase-1/wp1.5-api.md §2) rather than a UI-specific shape,
 * because the mapping in `toListTransactionsQuery` below is then a
 * near-identity function instead of a second vocabulary to keep in sync.
 *
 * `amountMin`/`amountMax` are minor-unit integer strings (the wire form of
 * `Money.minor`, docs/CONVENTIONS.md "Money") rather than dollars — the filter
 * bar converts a user-typed dollar amount at the edge, and the URL never
 * carries a float.
 */
export const transactionsSearchSchema = z.object({
  accounts: z.array(z.string()).optional(),
  categoryIds: z.array(z.string()).optional(),
  /** WP 10.10: a Cash Flow merchant row (or a Sankey merchant band) drills to exactly that merchant. */
  merchantIds: z.array(z.string()).optional(),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  amountMin: z
    .string()
    .regex(/^[+-]?\d+$/)
    .optional(),
  amountMax: z
    .string()
    .regex(/^[+-]?\d+$/)
    .optional(),
  q: z.string().max(200).optional(),
  pending: z.boolean().optional(),
  excluded: z.boolean().optional(),
  transfers: z.enum(['include', 'exclude', 'only']).optional(),
  uncategorized: z.boolean().optional(),
});

export type TransactionsSearch = z.infer<typeof transactionsSearchSchema>;

export const DEFAULT_TRANSACTIONS_SEARCH: TransactionsSearch = {};

/** Whether any filter (not counting `q`, which has its own "clear search" affordance) is set. */
export function hasActiveFilters(search: TransactionsSearch): boolean {
  return (
    (search.accounts?.length ?? 0) > 0 ||
    (search.categoryIds?.length ?? 0) > 0 ||
    (search.merchantIds?.length ?? 0) > 0 ||
    search.from !== undefined ||
    search.to !== undefined ||
    search.amountMin !== undefined ||
    search.amountMax !== undefined ||
    search.pending !== undefined ||
    search.excluded !== undefined ||
    search.transfers !== undefined ||
    search.uncategorized !== undefined
  );
}

const BOOLEAN_QUERY = { true: 'true', false: 'false' } as const;

/**
 * The one place `TransactionsSearch` becomes `ListTransactionsData['query']`
 * (also reused, filters-only, by `exportTransactions`). `cursor`/`limit` are
 * pagination internals, not URL state, and are added by the caller.
 */
export function toTransactionsQuery(
  search: TransactionsSearch,
): Omit<NonNullable<ListTransactionsData['query']>, 'cursor' | 'limit'> {
  return {
    ...(search.accounts !== undefined && search.accounts.length > 0
      ? { accountIds: search.accounts }
      : {}),
    ...(search.categoryIds !== undefined && search.categoryIds.length > 0
      ? { categoryIds: search.categoryIds }
      : {}),
    ...(search.merchantIds !== undefined && search.merchantIds.length > 0
      ? { merchantIds: search.merchantIds }
      : {}),
    ...(search.from !== undefined ? { from: search.from } : {}),
    ...(search.to !== undefined ? { to: search.to } : {}),
    ...(search.amountMin !== undefined ? { amountMin: search.amountMin } : {}),
    ...(search.amountMax !== undefined ? { amountMax: search.amountMax } : {}),
    ...(search.q !== undefined && search.q !== '' ? { q: search.q } : {}),
    ...(search.pending !== undefined ? { pending: BOOLEAN_QUERY[`${search.pending}`] } : {}),
    ...(search.excluded !== undefined ? { excluded: BOOLEAN_QUERY[`${search.excluded}`] } : {}),
    ...(search.transfers !== undefined ? { transfers: search.transfers } : {}),
    ...(search.uncategorized !== undefined
      ? { uncategorized: BOOLEAN_QUERY[`${search.uncategorized}`] }
      : {}),
  };
}
