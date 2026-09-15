// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import { useMemo, useState } from 'react';

import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { Label } from '../../components/ui/label.tsx';
import { TransactionDetailSheet } from '../transactions/TransactionDetailSheet.tsx';
import { TransactionsList } from '../transactions/TransactionsList.tsx';
import { DEFAULT_TRANSACTIONS_SEARCH, type TransactionsSearch } from '../transactions/filters.ts';
import { ACCOUNT_TYPE_ICON } from './account-icons.tsx';
import { useAccountsLookup } from './useAccountsLookup.ts';
import { useUpdateAccountMutation } from './useAccounts.ts';

export interface AccountDetailScreenProps {
  accountId: string;
}

/** `/accounts/{id}` (deliverable 2): the account's own header plus its transactions, filtered to just this account. */
export function AccountDetailScreen({ accountId }: AccountDetailScreenProps) {
  const { byId, isLoading, nameOf } = useAccountsLookup();
  const updateAccount = useUpdateAccountMutation();
  const [openTransactionId, setOpenTransactionId] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const search: TransactionsSearch = useMemo(
    () => ({ ...DEFAULT_TRANSACTIONS_SEARCH, accounts: [accountId] }),
    [accountId],
  );

  if (isLoading) return <SkeletonText lines={3} className="max-w-sm" />;

  const account = byId.get(accountId);

  if (account === undefined) {
    return (
      <EmptyState
        icon={AlertTriangle}
        headline="Account not found"
        description="It may have been removed, or you may not have access to it."
      >
        <Link to="/accounts" className="text-small text-accent-text underline">
          Back to accounts
        </Link>
      </EmptyState>
    );
  }

  const Icon = ACCOUNT_TYPE_ICON[account.type];

  function toggleSelect(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/accounts"
        className="flex w-fit items-center gap-1.5 text-small text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        Back to accounts
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border-hairline bg-bg-surface p-5">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle text-text-secondary">
            <Icon size={22} aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-h2 text-text-primary">{account.name}</h1>
            <p className="text-small text-text-muted">
              {account.mask !== null ? `••${account.mask} · ` : ''}
              {account.officialName ?? account.provider}
            </p>
          </div>
        </div>

        <div className="text-right">
          {account.balance !== null ? (
            <Money value={account.balance.current} className="text-h1" />
          ) : (
            <span className="text-small text-text-muted">No balance yet</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Base UI's `Switch.Root` renders `role="switch"` on a visible
              `<span>` but redirects a plain `id` to its own hidden
              `<input>` — `aria-labelledby` is what actually associates the
              label (dev.kitchen-sink.tsx's own fix for the same pairing). */}
          <Label id="account-include-net-worth-label">Include in net worth</Label>
          <Switch
            aria-labelledby="account-include-net-worth-label"
            checked={account.includeInNetWorth}
            onCheckedChange={(checked: boolean) =>
              updateAccount.mutate({ path: { accountId }, body: { includeInNetWorth: checked } })
            }
          />
        </div>
      </div>

      <TransactionsList
        search={search}
        accountName={nameOf}
        selected={selected}
        onToggleSelect={toggleSelect}
        onOpen={setOpenTransactionId}
        onClearFilters={() => {}}
      />

      <TransactionDetailSheet
        transactionId={openTransactionId}
        accountName={nameOf}
        onOpenChange={(open) => {
          if (!open) setOpenTransactionId(null);
        }}
      />
    </div>
  );
}
