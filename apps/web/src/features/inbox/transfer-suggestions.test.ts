// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { Transaction } from '../../api/generated/types.gen.ts';
import { findTransferSuggestions } from './transfer-suggestions.ts';

function tx(overrides: Partial<Transaction> & Pick<Transaction, 'id'>): Transaction {
  return {
    accountId: 'acct_checking',
    factId: 'fact_1',
    date: '2026-06-01',
    amount: { minor: '-5000', currency: 'USD' },
    name: 'Row',
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

describe('findTransferSuggestions', () => {
  it('pairs one outflow with its matching inflow in another account', () => {
    const outflow = tx({
      id: 'out_1',
      accountId: 'acct_checking',
      amount: { minor: '-5000', currency: 'USD' },
    });
    const inflow = tx({
      id: 'in_1',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
    });
    const result = findTransferSuggestions([outflow, inflow]);
    expect(result).toEqual([{ outflow, inflow }]);
  });

  it('never suggests a row more than once', () => {
    const outflow = tx({
      id: 'out_1',
      accountId: 'acct_checking',
      amount: { minor: '-5000', currency: 'USD' },
    });
    const inflowA = tx({
      id: 'in_a',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-01',
    });
    const inflowB = tx({
      id: 'in_b',
      accountId: 'acct_credit',
      amount: { minor: '5000', currency: 'USD' },
      date: '2026-06-02',
    });

    const result = findTransferSuggestions([outflow, inflowA, inflowB]);
    expect(result).toHaveLength(1);
    // The closer-dated candidate wins; the other stays unmatched and does not
    // reappear as a second suggestion for the same outflow.
    expect(result[0]).toEqual({ outflow, inflow: inflowA });
  });

  it('does not suggest a pair already marked or linked as a transfer', () => {
    const outflow = tx({
      id: 'out_1',
      isTransfer: true,
      amount: { minor: '-5000', currency: 'USD' },
    });
    const inflow = tx({
      id: 'in_1',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
    });
    expect(findTransferSuggestions([outflow, inflow])).toEqual([]);
  });

  it('finds no suggestions in an empty pool', () => {
    expect(findTransferSuggestions([])).toEqual([]);
  });

  it('matches multiple independent pairs without cross-claiming', () => {
    const out1 = tx({
      id: 'out_1',
      accountId: 'acct_checking',
      amount: { minor: '-5000', currency: 'USD' },
    });
    const in1 = tx({
      id: 'in_1',
      accountId: 'acct_savings',
      amount: { minor: '5000', currency: 'USD' },
    });
    const out2 = tx({
      id: 'out_2',
      accountId: 'acct_checking',
      amount: { minor: '-2000', currency: 'USD' },
    });
    const in2 = tx({
      id: 'in_2',
      accountId: 'acct_savings',
      amount: { minor: '2000', currency: 'USD' },
    });

    const result = findTransferSuggestions([out1, in1, out2, in2]);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ outflow: out1, inflow: in1 });
    expect(result).toContainEqual({ outflow: out2, inflow: in2 });
  });
});
