// SPDX-License-Identifier: MIT
import { Money } from '@core/kernel';

import type { Account } from '../../api/generated/types.gen.ts';
import { parseWireMoney } from '../../lib/money.ts';

export const ACCOUNT_TYPE_ORDER = [
  'depository',
  'credit',
  'loan',
  'investment',
  'crypto',
  'manual',
] as const;

export const ACCOUNT_TYPE_LABEL: Record<Account['type'], string> = {
  depository: 'Cash',
  credit: 'Credit cards',
  loan: 'Loans',
  investment: 'Investments',
  crypto: 'Crypto',
  manual: 'Manual',
};

export interface AccountGroup {
  readonly type: Account['type'];
  readonly label: string;
  readonly accounts: readonly Account[];
}

/**
 * Groups open accounts by `type` (deliverable: "/accounts: grouped by type"),
 * in a fixed, meaningful order (checking/savings first, most-glanced-at;
 * manual last) rather than alphabetically or by server response order.
 * Closed accounts are carried separately (`closedAccounts`) so they collapse
 * into one section at the bottom regardless of type, matching the
 * Rocket Money / Wealthfront convention this app follows (05 §2.1).
 */
export function groupAccounts(accounts: readonly Account[]): {
  groups: readonly AccountGroup[];
  closedAccounts: readonly Account[];
} {
  const open = accounts.filter((a) => a.closedAt === null);
  const closedAccounts = accounts.filter((a) => a.closedAt !== null);

  const groups = ACCOUNT_TYPE_ORDER.map((type) => ({
    type,
    label: ACCOUNT_TYPE_LABEL[type],
    accounts: open.filter((a) => a.type === type),
  })).filter((group) => group.accounts.length > 0);

  return { groups, closedAccounts };
}

/**
 * The net figure for one group of accounts (deliverable: "a net figure per
 * group"), one entry per currency actually present. `balance` is `null`
 * until a sync has recorded one (wp1.5-api.md §7.1's "known gap" — a linked
 * account with no balance yet), and a `null` balance contributes nothing
 * rather than being treated as zero, which would understate the group by
 * omission and *also* silently claim a stated fact ("this account has $0").
 * `AccountBalance.current` is already signed as a net-worth contribution
 * (docs/CONVENTIONS.md "Money" — a card you owe on is negative), so groups
 * are summed, never subtracted.
 */
export interface GroupNetWorthEntry {
  readonly currency: string;
  readonly net: Money;
}

export function groupNetWorth(accounts: readonly Account[]): readonly GroupNetWorthEntry[] {
  const byCurrency = new Map<string, Money>();
  for (const account of accounts) {
    if (account.balance === null) continue;
    const current = parseWireMoney(account.balance.current);
    const running = byCurrency.get(current.currency);
    byCurrency.set(current.currency, running === undefined ? current : Money.add(running, current));
  }
  return [...byCurrency.entries()].map(([currency, net]) => ({ currency, net }));
}
