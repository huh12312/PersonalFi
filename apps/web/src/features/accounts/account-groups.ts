// SPDX-License-Identifier: MIT
import type { Account } from '../../api/generated/types.gen.ts';

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
