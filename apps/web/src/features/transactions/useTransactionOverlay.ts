// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData, Query, QueryClient } from '@tanstack/react-query';

import { updateTransactionMutation } from '../../api/generated/@tanstack/react-query.gen.ts';
import type {
  ListTransactionsResponse,
  Transaction,
  TransactionDetail,
  TransactionOverlayPatchInput,
} from '../../api/generated/types.gen.ts';

/**
 * The generated query-key shape (`generated/@tanstack/react-query.gen.ts`'s
 * `createQueryKey`) is `[{ _id, _infinite?, baseUrl, body?, headers?, path?,
 * query? }]` — an object keyed by the operation's own name, not a plain
 * `['transactions', ...]` array this file could match structurally. A
 * `predicate` over that shape is the supported way to reach "every cached
 * `listTransactions` page, whatever filters it was fetched with" without
 * re-deriving every possible filter's exact key.
 */
interface GeneratedQueryKeyHead {
  readonly _id?: string;
  readonly _infinite?: boolean;
  readonly path?: { readonly transactionId?: string };
}

function isListTransactionsInfiniteQuery(query: Query): boolean {
  const head = query.queryKey[0] as GeneratedQueryKeyHead | undefined;
  return head?._id === 'listTransactions' && head._infinite === true;
}

function isGetTransactionQuery(query: Query, transactionId: string): boolean {
  const head = query.queryKey[0] as GeneratedQueryKeyHead | undefined;
  return head?._id === 'getTransaction' && head.path?.transactionId === transactionId;
}

/** What an overlay patch optimistically means for the *reader* shape (`Transaction`/`TransactionDetail`), which mirrors but is not identical to the patch's own field names. */
function toOptimisticFields(patch: TransactionOverlayPatchInput): Partial<Transaction> {
  return {
    ...(patch.note !== undefined ? { note: patch.note } : {}),
    ...(patch.excluded !== undefined ? { excluded: patch.excluded } : {}),
    // WP 11.2b: a category the holder just picked is theirs, so its provenance chip goes at once. (A cleared
    // category cannot be resolved here - a rule or the machine's placement may take its place - and is
    // reconciled by the invalidation.)
    ...(patch.categoryId !== undefined
      ? patch.categoryId === null
        ? { categoryId: null }
        : { categoryId: patch.categoryId, categorySource: 'user' as const, autoCategory: null }
      : {}),
    // `payeeName: null` restores the provider's name, which this cache patch
    // cannot know without the row's `provenance` (only present on the detail
    // shape, not the list row) — left alone in that case and reconciled by
    // the invalidation below rather than guessed at.
    ...(patch.payeeName !== undefined && patch.payeeName !== null ? { name: patch.payeeName } : {}),
  };
}

export interface TransactionQuerySnapshot {
  readonly entries: ReadonlyArray<readonly [readonly unknown[], unknown]>;
}

/** Captures every cached page/detail entry for one transaction before an optimistic write, so `restoreTransactionQueries` can put them back verbatim on failure. */
export function snapshotTransactionQueries(
  queryClient: QueryClient,
  transactionId: string,
): TransactionQuerySnapshot {
  const listEntries = queryClient.getQueriesData({ predicate: isListTransactionsInfiniteQuery });
  const detailEntries = queryClient.getQueriesData({
    predicate: (query) => isGetTransactionQuery(query, transactionId),
  });
  return { entries: [...listEntries, ...detailEntries] };
}

export function restoreTransactionQueries(
  queryClient: QueryClient,
  snapshot: TransactionQuerySnapshot,
): void {
  for (const [queryKey, data] of snapshot.entries) {
    queryClient.setQueryData(queryKey, data);
  }
}

/** Applies `patch` to every cached list page and detail view that contains `transactionId`, in place, before the network round trip resolves. */
export function applyOptimisticOverlayPatch(
  queryClient: QueryClient,
  transactionId: string,
  patch: TransactionOverlayPatchInput,
): void {
  const fields = toOptimisticFields(patch);

  queryClient.setQueriesData<InfiniteData<ListTransactionsResponse>>(
    { predicate: isListTransactionsInfiniteQuery },
    (data) => {
      if (data === undefined) return data;
      return {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items.map((item) =>
            item.id === transactionId ? { ...item, ...fields } : item,
          ),
        })),
      };
    },
  );

  queryClient.setQueriesData<TransactionDetail>(
    { predicate: (query) => isGetTransactionQuery(query, transactionId) },
    (data) => (data === undefined ? data : { ...data, ...fields }),
  );
}

export function invalidateTransactionQueries(
  queryClient: QueryClient,
  transactionId: string,
): void {
  void queryClient.invalidateQueries({ predicate: isListTransactionsInfiniteQuery });
  void queryClient.invalidateQueries({
    predicate: (query) => isGetTransactionQuery(query, transactionId),
  });
}

/**
 * `PATCH /transactions/:id` (the user overlay: note, category, exclusion,
 * payee name), applied optimistically with rollback on failure
 * (05-frontend-architecture.md §5.2: "every mutation is optimistic ... with
 * rollback"). Used by both the detail panel's edit form and the `e`/`n`
 * keyboard shortcuts on the list.
 */
export function useTransactionOverlayMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    ...updateTransactionMutation(),
    onMutate: async (variables) => {
      const transactionId = variables.path.transactionId;
      await queryClient.cancelQueries({ predicate: isListTransactionsInfiniteQuery });
      await queryClient.cancelQueries({
        predicate: (query) => isGetTransactionQuery(query, transactionId),
      });
      const snapshot = snapshotTransactionQueries(queryClient, transactionId);
      applyOptimisticOverlayPatch(queryClient, transactionId, variables.body);
      return { snapshot };
    },
    onError: (_error, _variables, context) => {
      if (context?.snapshot !== undefined) restoreTransactionQueries(queryClient, context.snapshot);
    },
    onSettled: (_data, _error, variables) => {
      invalidateTransactionQueries(queryClient, variables.path.transactionId);
    },
  });
}
