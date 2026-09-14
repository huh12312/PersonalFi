// SPDX-License-Identifier: MIT
/**
 * The append-only log, and the cursor properties that follow from it.
 *
 * These are the *reasons* the conformance suite passes for this adapter rather
 * than a restatement of it: the suite asserts behaviour through the port, and
 * this asserts the structure that makes the behaviour inevitable.
 */
import { DateOnly, money } from '@core/kernel';
import { describe, expect, it } from 'vitest';
import { MANUAL_PROVIDER, ManualConnector, manualTransaction } from './connector.ts';
import { ManualStore } from './store.ts';

function transaction(id: string, day = 20): ReturnType<typeof manualTransaction> {
  return manualTransaction({
    providerAccountId: 'acct-1',
    providerTransactionId: id,
    amount: money(-1_234n, 'USD'),
    postedDate: DateOnly.parse(`2026-05-${String(day).padStart(2, '0')}`),
    name: `MERCHANT ${id}`,
  });
}

describe('ManualStore', () => {
  it('numbers entries from one, strictly increasing', () => {
    const store = new ManualStore();
    store.open('conn');
    store.append('conn', { added: [transaction('a'), transaction('b')] });
    store.append('conn', {
      removed: [{ providerAccountId: 'acct-1', providerTransactionId: 'a' }],
    });

    expect(store.entriesAfter('conn', 0, 10).map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(store.highestSeq('conn')).toBe(3);
  });

  it('returns the same slice for the same cursor, however many times it is asked', () => {
    const store = new ManualStore();
    store.open('conn');
    store.append('conn', { added: [transaction('a'), transaction('b'), transaction('c')] });

    const first = store.entriesAfter('conn', 1, 2);
    expect(store.entriesAfter('conn', 1, 2)).toEqual(first);
    expect(first.map((entry) => entry.providerTransactionId)).toEqual(['b', 'c']);
  });

  it('keeps a removal as an entry rather than deleting anything', () => {
    // This is why a removed id cannot reappear: nothing is ever taken out of the
    // log, so there is no state for a later read to disagree with.
    const store = new ManualStore();
    store.open('conn');
    store.append('conn', { added: [transaction('a')] });
    store.append('conn', {
      removed: [{ providerAccountId: 'acct-1', providerTransactionId: 'a' }],
    });

    const entries = store.entriesAfter('conn', 0, 10);
    expect(entries.map((entry) => entry.kind)).toEqual(['added', 'removed']);
    expect(entries[1]?.fact).toBeNull();
  });

  it('treats accounts and balances as state, not log', () => {
    const store = new ManualStore();
    store.open('conn');
    const account = {
      providerAccountId: 'acct-1',
      name: 'Old name',
      officialName: null,
      type: 'depository' as const,
      subtype: null,
      currency: 'USD',
      mask: null,
      closed: false,
      capabilities: [] as const,
    };
    store.append('conn', { accounts: [account] });
    store.append('conn', { accounts: [{ ...account, name: 'New name' }] });

    expect(store.accounts('conn')).toHaveLength(1);
    expect(store.accounts('conn')[0]?.name).toBe('New name');
    expect(store.highestSeq('conn')).toBe(0);
  });

  it('forgets everything a disconnect closed', () => {
    const store = new ManualStore();
    store.open('conn');
    store.close('conn');
    expect(store.has('conn')).toBe(false);
    expect(() => store.accounts('conn')).toThrow(/no connection/);
  });
});

describe('ManualConnector', () => {
  const handle = {
    connectionId: '01920000-0000-7000-8000-0000000000b1',
    userId: '01920000-0000-7000-8000-0000000000b2',
    provider: MANUAL_PROVIDER,
    providerConnectionId: 'conn',
    secret: () => null,
  };

  const options = {
    reason: 'scheduled' as const,
    historyDays: 730,
    pageSize: 500,
    deadline: new Date('2026-06-01T12:01:00.000Z'),
    signal: new AbortController().signal,
    clock: { now: () => new Date('2026-06-01T12:00:00.000Z'), nowMs: () => 0 },
  };

  it('pages by sequence number and stops when the log is exhausted', async () => {
    const store = new ManualStore();
    const connector = new ManualConnector({ store, pageSize: 2 });
    store.open('conn');
    store.append('conn', { added: [transaction('a'), transaction('b'), transaction('c')] });

    const first = await connector.syncTransactions(handle, null, options);
    expect(first.added).toHaveLength(2);
    expect(first.nextCursor).toBe('2');
    expect(first.hasMore).toBe(true);

    const second = await connector.syncTransactions(handle, first.nextCursor, options);
    expect(second.added).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  it('leaves the cursor exactly where it was when there is nothing new', async () => {
    const store = new ManualStore();
    const connector = new ManualConnector({ store });
    store.open('conn');
    store.append('conn', { added: [transaction('a')] });

    const first = await connector.syncTransactions(handle, null, options);
    const again = await connector.syncTransactions(handle, first.nextCursor, options);
    expect(again.nextCursor).toBe(first.nextCursor);
    expect(again.added).toEqual([]);
    // Never null: null would tell the orchestrator "no incremental support" and
    // trigger a full re-pull on every run (cursor-contract rule 3).
    expect(again.nextCursor).not.toBeNull();
  });

  it('sends the account list only on the first page of a run', async () => {
    const store = new ManualStore();
    const connector = new ManualConnector({ store, pageSize: 1 });
    await connector.connect({
      displayName: 'Cash',
      providerConnectionId: 'conn',
      accounts: [{ providerAccountId: 'acct-1', name: 'Wallet', type: 'manual', currency: 'USD' }],
    });
    store.append('conn', { added: [transaction('a'), transaction('b')] });

    const first = await connector.syncTransactions(handle, null, options);
    expect(first.accounts).toHaveLength(1);
    const second = await connector.syncTransactions(handle, first.nextCursor, options);
    expect(second.accounts).toEqual([]);
  });

  it('rejects a cursor it never issued as CURSOR_EXPIRED, not as a crash', async () => {
    const store = new ManualStore();
    const connector = new ManualConnector({ store });
    store.open('conn');
    store.append('conn', { added: [transaction('a')] });

    await expect(
      connector.syncTransactions(handle, 'plaid-cursor-xyz' as never, options),
    ).rejects.toMatchObject({ name: 'ConnectorError', condition: 'CURSOR_EXPIRED' });
  });

  it('does not declare holdings, because it does not implement them', () => {
    // 08 §2.6's roster lists holdings for this adapter. Declaring a dataset the
    // adapter cannot produce is the silently-empty-dataset failure the whole
    // capability mechanism exists to prevent, so it goes in when the method does.
    const capabilities = new ManualConnector({ store: new ManualStore() }).capabilities();
    expect(capabilities.supports).not.toContain('holdings');
    expect(capabilities.reconnectFlow).toBe('none');
    expect(capabilities.historyWindowDays).toBe('unbounded');
  });
});

describe('manualTransaction', () => {
  it('derives a stable id from content when the caller supplies none', () => {
    const input = {
      providerAccountId: 'acct-1',
      amount: money(-450n, 'USD'),
      postedDate: DateOnly.parse('2026-05-20'),
      name: 'COFFEE',
    };
    expect(manualTransaction(input).providerTransactionId).toBe(
      manualTransaction(input).providerTransactionId,
    );
  });

  it('separates two deliberate duplicates by occurrence', () => {
    const input = {
      providerAccountId: 'acct-1',
      amount: money(-450n, 'USD'),
      postedDate: DateOnly.parse('2026-05-20'),
      name: 'COFFEE',
    };
    expect(manualTransaction({ ...input, occurrence: 2 }).providerTransactionId).not.toBe(
      manualTransaction(input).providerTransactionId,
    );
  });

  it('always carries a fingerprint', () => {
    expect(transaction('a').fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
