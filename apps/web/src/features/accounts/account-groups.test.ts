// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { Account, AccountBalance } from '../../api/generated/types.gen.ts';
import { ACCOUNT_TYPE_LABEL, groupAccounts, groupNetWorth } from './account-groups.ts';

function balance(minor: string, currency = 'USD'): AccountBalance {
  return {
    current: { minor, currency },
    available: null,
    limit: null,
    asOf: '2026-01-01T00:00:00.000Z',
    source: 'provider',
  };
}

function account(overrides: Partial<Account> & Pick<Account, 'id' | 'type'>): Account {
  return {
    connectionId: null,
    provider: 'manual',
    name: 'Account',
    officialName: null,
    subtype: null,
    classification: 'asset',
    currency: 'USD',
    mask: null,
    closedAt: null,
    includeInNetWorth: true,
    balance: null,
    ...overrides,
  };
}

describe('groupAccounts', () => {
  it('groups open accounts by type in the fixed display order', () => {
    const accounts: Account[] = [
      account({ id: 'inv_1', type: 'investment' }),
      account({ id: 'chk_1', type: 'depository' }),
      account({ id: 'cc_1', type: 'credit' }),
    ];

    const { groups, closedAccounts } = groupAccounts(accounts);

    expect(groups.map((g) => g.type)).toEqual(['depository', 'credit', 'investment']);
    expect(groups[0]?.label).toBe(ACCOUNT_TYPE_LABEL.depository);
    expect(closedAccounts).toEqual([]);
  });

  it('omits a type with no open accounts and separates closed accounts', () => {
    const accounts: Account[] = [
      account({ id: 'chk_1', type: 'depository' }),
      account({ id: 'old_1', type: 'depository', closedAt: '2025-01-01T00:00:00.000Z' }),
    ];

    const { groups, closedAccounts } = groupAccounts(accounts);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.accounts).toHaveLength(1);
    expect(closedAccounts).toHaveLength(1);
    expect(closedAccounts[0]?.id).toBe('old_1');
  });

  it('returns no groups for an empty account list', () => {
    expect(groupAccounts([])).toEqual({ groups: [], closedAccounts: [] });
  });
});

describe('groupNetWorth', () => {
  it('sums balances of the same currency, sign already a net-worth contribution', () => {
    const accounts: Account[] = [
      account({ id: 'chk_1', type: 'depository', balance: balance('500000') }), // $5,000.00
      account({ id: 'sav_1', type: 'depository', balance: balance('250000') }), // $2,500.00
    ];

    expect(groupNetWorth(accounts)).toEqual([
      { currency: 'USD', net: { minor: 750000n, currency: 'USD' } },
    ]);
  });

  it('nets a negative (credit/loan) balance against a positive one in the same currency', () => {
    const accounts: Account[] = [
      account({ id: 'chk_1', type: 'depository', balance: balance('100000') }),
      account({
        id: 'cc_1',
        type: 'credit',
        classification: 'liability',
        balance: balance('-42000'),
      }),
    ];

    expect(groupNetWorth(accounts)).toEqual([
      { currency: 'USD', net: { minor: 58000n, currency: 'USD' } },
    ]);
  });

  it('keeps different currencies as separate entries rather than summing across them', () => {
    const accounts: Account[] = [
      account({ id: 'usd_1', type: 'investment', balance: balance('100000', 'USD') }),
      account({ id: 'eur_1', type: 'investment', balance: balance('50000', 'EUR') }),
    ];

    const result = groupNetWorth(accounts);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.currency === 'USD')?.net.minor).toBe(100000n);
    expect(result.find((r) => r.currency === 'EUR')?.net.minor).toBe(50000n);
  });

  it('skips an account with no balance yet rather than treating it as zero', () => {
    const accounts: Account[] = [
      account({ id: 'chk_1', type: 'depository', balance: balance('100000') }),
      account({ id: 'new_1', type: 'depository', balance: null }),
    ];

    expect(groupNetWorth(accounts)).toEqual([
      { currency: 'USD', net: { minor: 100000n, currency: 'USD' } },
    ]);
  });

  it('returns an empty array when no account in the group has a balance', () => {
    const accounts: Account[] = [account({ id: 'new_1', type: 'depository', balance: null })];
    expect(groupNetWorth(accounts)).toEqual([]);
  });
});
