// SPDX-License-Identifier: MIT
import { useMemo } from 'react';

import type { Account } from '../../api/generated/types.gen.ts';
import { useAccountsQuery } from './useAccounts.ts';

export interface AccountsLookup {
  readonly byId: ReadonlyMap<string, Account>;
  readonly accounts: readonly Account[];
  readonly isLoading: boolean;
  nameOf(accountId: string): string;
}

/** `accountId -> Account` for screens (the transactions list, the filter bar) that need a name or currency by id without re-fetching. */
const NO_ACCOUNTS: readonly Account[] = [];

export function useAccountsLookup(): AccountsLookup {
  const query = useAccountsQuery();
  // `query.data?.accounts` is a stable reference between renders (react-query
  // only replaces it on an actual refetch); the `?? []` fallback is not,
  // which would otherwise defeat `useMemo` below on every render.
  const accounts = query.data?.accounts ?? NO_ACCOUNTS;

  const byId = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);

  return {
    byId,
    accounts,
    isLoading: query.isLoading,
    nameOf: (accountId: string) => byId.get(accountId)?.name ?? 'Account',
  };
}
