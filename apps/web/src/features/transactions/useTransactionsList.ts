// SPDX-License-Identifier: MIT
import { useInfiniteQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { listTransactionsInfiniteOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Transaction, TransactionSummary } from '../../api/generated/types.gen.ts';
import { toTransactionsQuery, type TransactionsSearch } from './filters.ts';

const PAGE_SIZE = 100;

/**
 * The generated `listTransactionsInfiniteOptions` accepts either a raw cursor
 * *string* or a whole request-options object as its page param (so a caller
 * can vary filters per page); it never declares `undefined` as a member even
 * though `initialPageParam` — page one, which has no cursor yet — is exactly
 * that. Extracted from the generator's own return type rather than hand-typed
 * so a future contract change can't silently drift this from what
 * `listTransactionsInfiniteOptions` actually declares.
 */
type TransactionsPageParam = ReturnType<typeof listTransactionsInfiniteOptions>['initialPageParam'];

/**
 * Flattens the keyset-paginated `GET /transactions` infinite query
 * (docs/evidence/phase-1/wp1.5-api.md §2) into one array for the virtualizer,
 * plus the first page's aggregate `summary` (`null` on every page after the
 * first — this hook keeps whichever one it last saw, which is always page
 * one's, since later pages report `null` and never overwrite it back to
 * `null`).
 */
export function useTransactionsList(search: TransactionsSearch) {
  const query = toTransactionsQuery(search);

  const infiniteQuery = useInfiniteQuery({
    ...listTransactionsInfiniteOptions({ query: { ...query, limit: PAGE_SIZE } }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Runtime value is `undefined` (no cursor on page one), same as before
    // this type was tightened — see `TransactionsPageParam`'s doc above.
    initialPageParam: undefined as unknown as TransactionsPageParam,
  });

  const items = useMemo<Transaction[]>(
    () => infiniteQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [infiniteQuery.data],
  );

  const summary = useMemo<TransactionSummary | null>(() => {
    for (const page of infiniteQuery.data?.pages ?? []) {
      if (page.summary !== null) return page.summary;
    }
    return null;
  }, [infiniteQuery.data]);

  return {
    items,
    summary,
    isLoading: infiniteQuery.isLoading,
    isError: infiniteQuery.isError,
    error: infiniteQuery.error,
    hasNextPage: infiniteQuery.hasNextPage,
    isFetchingNextPage: infiniteQuery.isFetchingNextPage,
    fetchNextPage: infiniteQuery.fetchNextPage,
    refetch: infiniteQuery.refetch,
  };
}
