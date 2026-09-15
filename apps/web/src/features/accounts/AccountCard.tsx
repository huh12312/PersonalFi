// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';
import { EyeOff } from 'lucide-react';

import { Money } from '../../components/finance/Money.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { ACCOUNT_TYPE_ICON } from './account-icons.tsx';
import type { Account } from '../../api/generated/types.gen.ts';

export interface AccountCardProps {
  account: Account;
}

/**
 * One row in a group's list: icon, name (+ mask), latest balance, and an
 * "Excluded" badge when the user opted the account out of net worth — never
 * hidden, per 05 §4.4's "colour is never the only signal" and the deliverable
 * "latest balances" (a `null` balance — no sync yet — reads as "No balance
 * yet" rather than a fabricated $0, wp1.5-api.md §7.1).
 */
export function AccountCard({ account }: AccountCardProps) {
  const Icon = ACCOUNT_TYPE_ICON[account.type];

  return (
    <Link
      to="/accounts/$accountId"
      params={{ accountId: account.id }}
      className="flex items-center gap-3 rounded-lg px-3 py-3 hover:bg-bg-subtle focus-visible:outline-none"
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-text-secondary">
        <Icon size={17} aria-hidden="true" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium text-text-primary">{account.name}</span>
          {account.mask !== null && (
            <span className="shrink-0 text-small text-text-muted">••{account.mask}</span>
          )}
          {!account.includeInNetWorth && (
            <Badge
              variant="neutral"
              icon={<EyeOff size={11} aria-hidden="true" />}
              className="shrink-0"
            >
              Excluded
            </Badge>
          )}
        </div>
        {account.officialName !== null && account.officialName !== account.name && (
          <div className="truncate text-small text-text-muted">{account.officialName}</div>
        )}
      </div>

      <div className="shrink-0 text-right">
        {account.balance !== null ? (
          <Money value={account.balance.current} className="text-body font-medium" />
        ) : (
          <span className="text-small text-text-muted">No balance yet</span>
        )}
      </div>
    </Link>
  );
}
