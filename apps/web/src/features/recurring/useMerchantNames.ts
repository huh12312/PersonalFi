// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { listTransactionsOptions } from '../../api/generated/@tanstack/react-query.gen.ts';

/**
 * `@ctx/recurring`'s routes (`GET /recurring/series`, `/candidates`) name a
 * stream by `merchantId` only — never a display name. That is decision D25
 * working as designed: a `merchants` row is `@ctx/ledger`'s to name, and
 * `@ctx/recurring` never reads payee text (docs/evidence/phase-2/
 * wp2.3-recurring.md §6, "no field carries payee text"). This screen still
 * owes a person a readable row, so it resolves names the same way any other
 * screen would — through the ledger's own reader, `GET /transactions`, which
 * already supports filtering by `merchantIds` (`apps/api/src/routes/
 * transactions.ts`).
 *
 * One batched query for every merchant id a screen needs, rather than one
 * per row: `merchantIds` is a repeatable filter, so a whole candidates +
 * series page resolves in a single round trip. The first transaction seen
 * for a merchant supplies its name — good enough for a label, and never
 * treated as anything but display text (no id is ever derived from it).
 */
export function useMerchantNames(merchantIds: readonly string[]): {
  nameOf: (merchantId: string) => string;
  isLoading: boolean;
} {
  const uniqueIds = useMemo(
    () => [...new Set(merchantIds.filter((id) => id.length > 0))].sort(),
    [merchantIds],
  );

  const query = useQuery({
    ...listTransactionsOptions({ query: { merchantIds: uniqueIds, limit: 200 } }),
    enabled: uniqueIds.length > 0,
  });

  const byMerchantId = useMemo(() => {
    const map = new Map<string, string>();
    for (const transaction of query.data?.items ?? []) {
      if (transaction.merchantId === null || map.has(transaction.merchantId)) continue;
      map.set(transaction.merchantId, transaction.merchantName ?? transaction.name);
    }
    return map;
  }, [query.data]);

  function nameOf(merchantId: string): string {
    return byMerchantId.get(merchantId) ?? `Merchant ${merchantId.slice(0, 8)}`;
  }

  return { nameOf, isLoading: uniqueIds.length > 0 && query.isLoading };
}
