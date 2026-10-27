// SPDX-License-Identifier: MIT
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { listCategoryExplanationsOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type { CategoryExplanation } from '../../api/generated/types.gen.ts';

/** `GET /transactions/explanations` takes at most this many ids. */
export const MAX_EXPLANATION_IDS = 200;

/**
 * WP 11.1: the one-line "why" for the uncategorised rows on screen — **one** batched
 * `GET /transactions/explanations` for every row's id, keyed by transaction id.
 *
 * The line is the server's, composed from the decision working stored when the decision was made
 * (`@ctx/categorization`'s `explain-line.ts`). This hook hands it over as received; nothing on this side composes,
 * rewrites or recomputes an explanation (the tiers arrive too, and are not read here).
 *
 * The previous batch stays in place while a new set of ids loads (a row resolving changes the set), so the captions
 * that are still on screen do not blink out and back.
 */
export function useInboxExplanations(
  transactionIds: readonly string[],
): ReadonlyMap<string, CategoryExplanation> {
  const ids = useMemo(
    () => [...new Set(transactionIds)].sort().slice(0, MAX_EXPLANATION_IDS),
    [transactionIds],
  );
  const query = useQuery({
    ...listCategoryExplanationsOptions({ query: { ids: ids.join(',') } }),
    enabled: ids.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  return useMemo(
    () => new Map((query.data?.items ?? []).map((item) => [item.transactionId, item])),
    [query.data],
  );
}
