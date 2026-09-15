// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, Landmark } from 'lucide-react';
import { useState } from 'react';

import { Money } from '../../components/finance/Money.tsx';
import { StatTile } from '../../components/finance/StatTile.tsx';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton, SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { groupAccounts } from './account-groups.ts';
import { AccountGroupSection } from './AccountGroupSection.tsx';
import { useAccountsQuery, useNetWorthQuery } from './useAccounts.ts';

function AccountsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <SkeletonText lines={2} className="max-w-xs" />
      <div className="flex flex-col gap-2">
        <Skeleton variant="text" width={120} height={14} />
        <Skeleton variant="block" height={180} />
      </div>
    </div>
  );
}

/**
 * `/accounts` (deliverable 2): accounts grouped by type with latest balances
 * and a net figure per group, plus the server's own per-currency net worth
 * (`GET /net-worth`) as the screen's hero — the two figures can legitimately
 * differ (a group's own sum ignores `includeInNetWorth`/closed-account
 * exclusion, which `/net-worth`'s audit trail applies).
 */
export function AccountsScreen() {
  const navigate = useNavigate();
  const accountsQuery = useAccountsQuery();
  const netWorthQuery = useNetWorthQuery();
  const [showClosed, setShowClosed] = useState(false);

  if (accountsQuery.isLoading) return <AccountsSkeleton />;

  if (accountsQuery.isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        headline="Couldn't load your accounts"
        description="Something went wrong talking to the server. Try again."
        action={{ label: 'Retry', onClick: () => void accountsQuery.refetch() }}
      />
    );
  }

  const accounts = accountsQuery.data?.accounts ?? [];
  const { groups, closedAccounts } = groupAccounts(accounts);

  if (groups.length === 0 && closedAccounts.length === 0) {
    return (
      <EmptyState
        icon={Landmark}
        headline="Connect your first account"
        description="Link a bank via Plaid, connect Coinbase, or add a manual account."
        action={{
          label: 'Add account',
          onClick: () => void navigate({ to: '/accounts/connections' }),
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {netWorthQuery.data !== undefined && netWorthQuery.data.totals.length > 0 ? (
          <div className="flex flex-wrap gap-8">
            {netWorthQuery.data.totals.map((total) => (
              <StatTile
                key={total.currency}
                label={
                  netWorthQuery.data.totals.length > 1
                    ? `Net worth (${total.currency})`
                    : 'Net worth'
                }
                value={<Money value={total.net} signDisplay="auto" />}
                size="hero"
              />
            ))}
          </div>
        ) : (
          <StatTile
            label="Net worth"
            value={<span className="text-text-muted">No balance yet</span>}
            size="hero"
          />
        )}
        <Button variant="secondary" onClick={() => void navigate({ to: '/accounts/connections' })}>
          Manage connections
        </Button>
      </div>

      {groups.map((group) => (
        <AccountGroupSection key={group.type} group={group} />
      ))}

      {closedAccounts.length > 0 && (
        <section>
          <Button variant="ghost" size="sm" onClick={() => setShowClosed((prev) => !prev)}>
            {showClosed ? 'Hide' : 'Show'} closed accounts ({closedAccounts.length})
          </Button>
          {showClosed && (
            <div className="mt-2 divide-y divide-border-hairline rounded-xl border border-border-hairline bg-bg-surface opacity-70">
              {closedAccounts.map((account) => (
                <div key={account.id} className="px-3 py-3 text-small text-text-muted">
                  {account.name}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
