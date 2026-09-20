// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { Transaction } from '../../api/generated/types.gen.ts';
import { findTransferCandidates, orientPair } from './transfer-candidates.ts';

function tx(overrides: Partial<Transaction> & Pick<Transaction, 'id'>): Transaction {
  return {
    accountId: 'acct_checking',
    factId: 'fact_1',
    date: '2026-06-01',
    amount: { minor: '-5000', currency: 'USD' },
    name: 'Transfer',
    merchantId: null,
    merchantName: null,
    pending: false,
    excluded: false,
    categoryId: null,
    note: null,
    isTransfer: false,
    transferLinkId: null,
    refundOfId: null,
    refundConfidence: null,
    supersededById: null,
    supersededReason: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('findTransferCandidates', () => {
  const target = tx({
    id: 'txn_out',
    accountId: 'acct_checking',
    amount: { minor: '-5000', currency: 'USD' },
    date: '2026-06-10',
  });

  it('matches the same amount with the opposite sign, in a different account', () => {
    const match = tx({
      id: 'txn_in',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-11',
    });
    const result = findTransferCandidates(target, [match]);
    expect(result.map((t) => t.id)).toEqual(['txn_in']);
  });

  it('excludes a same-account row even if the amount matches', () => {
    const sameAccount = tx({
      id: 'txn_same_account',
      accountId: 'acct_checking',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-10',
    });
    expect(findTransferCandidates(target, [sameAccount])).toEqual([]);
  });

  it('excludes a row already marked or linked as a transfer', () => {
    const alreadyPaired = tx({
      id: 'txn_paired',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-10',
      isTransfer: true,
      transferLinkId: 'link_1',
    });
    expect(findTransferCandidates(target, [alreadyPaired])).toEqual([]);
  });

  it('excludes a row outside the date window', () => {
    const tooFar = tx({
      id: 'txn_far',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-20',
    });
    expect(findTransferCandidates(target, [tooFar], { windowDays: 5 })).toEqual([]);
    expect(findTransferCandidates(target, [tooFar], { windowDays: 10 }).map((t) => t.id)).toEqual([
      'txn_far',
    ]);
  });

  it('excludes a mismatched amount', () => {
    const wrongAmount = tx({
      id: 'txn_wrong',
      accountId: 'acct_savings',
      amount: { minor: '4999', currency: 'USD' },
      date: '2026-06-10',
    });
    expect(findTransferCandidates(target, [wrongAmount])).toEqual([]);
  });

  it('orders candidates by date proximity, closest first', () => {
    const near = tx({
      id: 'txn_near',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-09',
    });
    const far = tx({
      id: 'txn_farther',
      accountId: 'acct_credit',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-13',
    });
    const result = findTransferCandidates(target, [far, near]);
    expect(result.map((t) => t.id)).toEqual(['txn_near', 'txn_farther']);
  });
});

describe('orientPair', () => {
  it('names the negative leg the outflow, whichever order it is passed', () => {
    const out = { id: 'txn_out', amount: { minor: '-5000', currency: 'USD' } };
    const inflow = { id: 'txn_in', amount: { minor: '5000', currency: 'USD' } };
    expect(orientPair(out, inflow)).toEqual({
      outflowTransactionId: 'txn_out',
      inflowTransactionId: 'txn_in',
    });
    expect(orientPair(inflow, out)).toEqual({
      outflowTransactionId: 'txn_out',
      inflowTransactionId: 'txn_in',
    });
  });
});
