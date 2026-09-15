// SPDX-License-Identifier: MIT
import { Money as MoneyKernel } from '@core/kernel';

import { Money } from '../../components/finance/Money.tsx';
import { groupNetWorth, type AccountGroup } from './account-groups.ts';
import { AccountCard } from './AccountCard.tsx';

export interface AccountGroupSectionProps {
  group: AccountGroup;
}

/** One account-type section: a header with the group's net figure, then its accounts. */
export function AccountGroupSection({ group }: AccountGroupSectionProps) {
  const netEntries = groupNetWorth(group.accounts);

  return (
    <section aria-labelledby={`account-group-${group.type}`}>
      <div className="flex items-baseline justify-between px-1 pb-1">
        <h2
          id={`account-group-${group.type}`}
          className="text-small font-semibold uppercase tracking-wide text-text-muted"
        >
          {group.label}
        </h2>
        <div className="flex items-center gap-3 text-small font-medium text-text-secondary">
          {netEntries.map((entry) => (
            <Money
              key={entry.currency}
              value={MoneyKernel.toJSON(entry.net)}
              signDisplay="auto"
              colorBySign={false}
            />
          ))}
        </div>
      </div>
      <div className="divide-y divide-border-hairline rounded-xl border border-border-hairline bg-bg-surface">
        {group.accounts.map((account) => (
          <AccountCard key={account.id} account={account} />
        ))}
      </div>
    </section>
  );
}
