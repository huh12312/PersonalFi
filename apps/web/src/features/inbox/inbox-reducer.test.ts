// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { Transaction } from '../../api/generated/types.gen.ts';
import { EMPTY_INBOX_STATE, inboxReducer, uncategorizedItem } from './inbox-reducer.ts';

function tx(id: string): Transaction {
  return {
    id,
    accountId: 'acct_1',
    factId: 'fact_1',
    date: '2026-06-01',
    amount: { minor: '-1000', currency: 'USD' },
    name: `Transaction ${id}`,
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
  };
}

const itemA = uncategorizedItem(tx('a'));
const itemB = uncategorizedItem(tx('b'));
const itemC = uncategorizedItem(tx('c'));

describe('inboxReducer', () => {
  it('set-items focuses the first item on first load', () => {
    const state = inboxReducer(EMPTY_INBOX_STATE, {
      type: 'set-items',
      items: [itemA, itemB, itemC],
    });
    expect(state.focusedId).toBe(itemA.id);
    expect(state.items).toHaveLength(3);
  });

  it('set-items keeps focus on the same item if it is still present', () => {
    const loaded = inboxReducer(EMPTY_INBOX_STATE, { type: 'set-items', items: [itemA, itemB] });
    const focused = inboxReducer(loaded, { type: 'focus', id: itemB.id });
    const refetched = inboxReducer(focused, { type: 'set-items', items: [itemA, itemB, itemC] });
    expect(refetched.focusedId).toBe(itemB.id);
  });

  it('set-items refocuses the first item if the previously-focused one is gone', () => {
    const loaded = inboxReducer(EMPTY_INBOX_STATE, { type: 'set-items', items: [itemA, itemB] });
    const focused = inboxReducer(loaded, { type: 'focus', id: itemB.id });
    const refetched = inboxReducer(focused, { type: 'set-items', items: [itemA, itemC] });
    expect(refetched.focusedId).toBe(itemA.id);
  });

  it('resolve removes the item and moves focus to what slid into its place', () => {
    const loaded = inboxReducer(EMPTY_INBOX_STATE, {
      type: 'set-items',
      items: [itemA, itemB, itemC],
    });
    const focusedB = inboxReducer(loaded, { type: 'focus', id: itemB.id });
    const resolved = inboxReducer(focusedB, { type: 'resolve', id: itemB.id });
    expect(resolved.items.map((i) => i.id)).toEqual([itemA.id, itemC.id]);
    expect(resolved.focusedId).toBe(itemC.id);
  });

  it('resolving the last item moves focus to the new last item', () => {
    const loaded = inboxReducer(EMPTY_INBOX_STATE, {
      type: 'set-items',
      items: [itemA, itemB, itemC],
    });
    const focusedC = inboxReducer(loaded, { type: 'focus', id: itemC.id });
    const resolved = inboxReducer(focusedC, { type: 'resolve', id: itemC.id });
    expect(resolved.items.map((i) => i.id)).toEqual([itemA.id, itemB.id]);
    expect(resolved.focusedId).toBe(itemB.id);
  });

  it('resolving the only item leaves focus null', () => {
    const loaded = inboxReducer(EMPTY_INBOX_STATE, { type: 'set-items', items: [itemA] });
    const resolved = inboxReducer(loaded, { type: 'resolve', id: itemA.id });
    expect(resolved.items).toHaveLength(0);
    expect(resolved.focusedId).toBeNull();
  });

  it('resolving a non-focused item does not move focus', () => {
    const loaded = inboxReducer(EMPTY_INBOX_STATE, {
      type: 'set-items',
      items: [itemA, itemB, itemC],
    });
    const focusedA = inboxReducer(loaded, { type: 'focus', id: itemA.id });
    const resolved = inboxReducer(focusedA, { type: 'resolve', id: itemC.id });
    expect(resolved.focusedId).toBe(itemA.id);
  });

  it('focus-delta moves within bounds and clamps at the edges', () => {
    const loaded = inboxReducer(EMPTY_INBOX_STATE, {
      type: 'set-items',
      items: [itemA, itemB, itemC],
    });
    const down = inboxReducer(loaded, { type: 'focus-delta', delta: 1 });
    expect(down.focusedId).toBe(itemB.id);
    const clampedTop = inboxReducer(loaded, { type: 'focus-delta', delta: -1 });
    expect(clampedTop.focusedId).toBe(itemA.id);
    const toEnd = inboxReducer(inboxReducer(loaded, { type: 'focus-delta', delta: 1 }), {
      type: 'focus-delta',
      delta: 1,
    });
    const clampedBottom = inboxReducer(toEnd, { type: 'focus-delta', delta: 1 });
    expect(clampedBottom.focusedId).toBe(itemC.id);
  });

  it('focus-delta on an empty inbox is a no-op', () => {
    const state = inboxReducer(EMPTY_INBOX_STATE, { type: 'focus-delta', delta: 1 });
    expect(state).toEqual(EMPTY_INBOX_STATE);
  });

  it('focusing an id not present in the inbox is ignored', () => {
    const loaded = inboxReducer(EMPTY_INBOX_STATE, { type: 'set-items', items: [itemA] });
    const state = inboxReducer(loaded, { type: 'focus', id: 'does-not-exist' });
    expect(state.focusedId).toBe(itemA.id);
  });
});
