// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { bulkUpdateTransactionsMutation } from '../../api/generated/@tanstack/react-query.gen.ts';
import { invalidateTransactionQueries } from './useTransactionOverlay.ts';

/** `POST /transactions/bulk` — applies one overlay patch to many rows at once, then invalidates every cached list page (no optimistic patch: `bulkUpdateTransactionsMutation`'s cache shape has no per-row predicate to reuse cheaply for an arbitrary id set). */
export function useBulkUpdateMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...bulkUpdateTransactionsMutation(),
    onSuccess: (_data, variables) => {
      for (const transactionId of variables.body.transactionIds) {
        invalidateTransactionQueries(queryClient, transactionId);
      }
    },
  });
}
