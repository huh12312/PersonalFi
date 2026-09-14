// SPDX-License-Identifier: MIT
/**
 * Accounts, balance observations, and net worth.
 *
 * The theme: a balance has an "as of", and an upsert from a provider must not
 * quietly undo something the user decided.
 */
import { Money, money } from '@core/kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  listAccounts,
  netWorthNow,
  recordBalance,
  setAccountClosed,
  setIncludeInNetWorth,
  upsertAccount,
} from '../src/accounts.ts';
import {
  NO_DATABASE,
  countEvents,
  eventPayloads,
  ledgerDatabase,
  seedAccount,
  testClock,
  writeContext,
  type TestDatabase,
} from './harness.ts';

describe.skipIf(NO_DATABASE)('accounts and balances', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;

  beforeAll(async () => {
    database = await ledgerDatabase('accounts');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
  });

  it('creates once, then reports only what actually changed', async () => {
    const first = await database.db.transaction(async (tx) =>
      upsertAccount(
        tx,
        {
          userId: database.userId,
          provider: 'plaid',
          providerAccountId: 'pa-1',
          name: 'Everyday Checking',
          type: 'depository',
          currency: 'USD',
        },
        writeContext(clock),
      ),
    );
    expect(first.created).toBe(true);

    const unchanged = await database.db.transaction(async (tx) =>
      upsertAccount(
        tx,
        {
          userId: database.userId,
          provider: 'plaid',
          providerAccountId: 'pa-1',
          name: 'Everyday Checking',
          type: 'depository',
          currency: 'USD',
        },
        writeContext(clock),
      ),
    );
    expect(unchanged.accountId).toBe(first.accountId);
    expect(unchanged.changedFields).toEqual([]);
    // A re-sync that changed nothing says nothing.
    expect(await countEvents(database, 'ledger.AccountUpserted')).toBe(1);

    const renamed = await database.db.transaction(async (tx) =>
      upsertAccount(
        tx,
        {
          userId: database.userId,
          provider: 'plaid',
          providerAccountId: 'pa-1',
          name: 'Everyday Checking (Joint)',
          type: 'depository',
          currency: 'USD',
        },
        writeContext(clock),
      ),
    );
    expect(renamed.changedFields).toEqual(['name']);
    const events = await eventPayloads<{ changedFields: string[]; created: boolean }>(
      database,
      'ledger.AccountUpserted',
    );
    expect(events.at(-1)).toMatchObject({ created: false, changedFields: ['name'] });
  });

  it('classifies a card and a mortgage as liabilities', async () => {
    const card = await seedAccount(database, clock, {
      providerAccountId: 'pa-card',
      type: 'credit',
    });
    const loan = await seedAccount(database, clock, {
      providerAccountId: 'pa-loan',
      type: 'loan',
    });
    const accounts = await listAccounts(database.db, { userId: database.userId });
    const byId = new Map(accounts.map((account) => [account.id, account]));
    expect(byId.get(card)?.classification).toBe('liability');
    expect(byId.get(loan)?.classification).toBe('liability');
  });

  it('records a balance once per (account, as-of, source)', async () => {
    const accountId = await seedAccount(database, clock);
    const asOf = new Date('2026-06-01T00:00:00.000Z');

    const first = await database.db.transaction(async (tx) =>
      recordBalance(
        tx,
        {
          userId: database.userId,
          accountId,
          current: money(120_000n, 'USD'),
          asOf,
          source: 'provider',
        },
        writeContext(clock),
      ),
    );
    const replay = await database.db.transaction(async (tx) =>
      recordBalance(
        tx,
        {
          userId: database.userId,
          accountId,
          current: money(120_000n, 'USD'),
          asOf,
          source: 'provider',
        },
        writeContext(clock),
      ),
    );

    expect(first.recorded).toBe(true);
    expect(replay.recorded).toBe(false);
    expect(await countEvents(database, 'ledger.BalanceRecorded')).toBe(1);
  });

  it('lets a manual figure sit beside a provider one for the same instant', async () => {
    const accountId = await seedAccount(database, clock);
    const asOf = new Date('2026-06-01T00:00:00.000Z');
    await database.db.transaction(async (tx) =>
      recordBalance(
        tx,
        {
          userId: database.userId,
          accountId,
          current: money(100n, 'USD'),
          asOf,
          source: 'provider',
        },
        writeContext(clock),
      ),
    );
    const manual = await database.db.transaction(async (tx) =>
      recordBalance(
        tx,
        { userId: database.userId, accountId, current: money(200n, 'USD'), asOf, source: 'manual' },
        writeContext(clock),
      ),
    );
    // Different sources are different observations of the same moment; the
    // unique index is on the triple, not on the pair.
    expect(manual.recorded).toBe(true);
  });

  it('refuses a balance in a currency the account does not hold', async () => {
    const accountId = await seedAccount(database, clock, { currency: 'USD' });
    await expect(
      database.db.transaction(async (tx) =>
        recordBalance(
          tx,
          {
            userId: database.userId,
            accountId,
            current: money(100n, 'EUR'),
            asOf: new Date('2026-06-01T00:00:00.000Z'),
            source: 'provider',
          },
          writeContext(clock),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ledger.currency_mismatch' });
  });

  it('shows the latest balance per account, and says when it was taken', async () => {
    const accountId = await seedAccount(database, clock);
    for (const [day, amount] of [
      ['2026-05-30', 100_000n],
      ['2026-06-01', 123_400n],
      ['2026-05-31', 110_000n],
    ] as const) {
      await database.db.transaction(async (tx) =>
        recordBalance(
          tx,
          {
            userId: database.userId,
            accountId,
            current: money(amount, 'USD'),
            asOf: new Date(`${day}T00:00:00.000Z`),
            source: 'provider',
          },
          writeContext(clock),
        ),
      );
    }
    const [account] = await listAccounts(database.db, { userId: database.userId });
    expect(account?.balance?.current.minor).toBe(123_400n);
    expect(account?.balance?.asOf.toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  describe('net worth', () => {
    it('adds assets to liabilities and says what it left out', async () => {
      const checking = await seedAccount(database, clock, { providerAccountId: 'pa-1' });
      const card = await seedAccount(database, clock, {
        providerAccountId: 'pa-2',
        type: 'credit',
      });
      const hidden = await seedAccount(database, clock, { providerAccountId: 'pa-3' });
      const asOf = new Date('2026-06-01T00:00:00.000Z');

      await balance(checking, 500_000n, asOf);
      // A card you owe $420 on contributes -42000 (the sign convention is the
      // contribution to net worth, stated on the column).
      await balance(card, -42_000n, asOf);
      await balance(hidden, 999_999n, asOf);
      await database.db.transaction(async (tx) =>
        setIncludeInNetWorth(
          tx,
          { userId: database.userId, accountId: hidden, include: false },
          writeContext(clock),
        ),
      );

      const result = await netWorthNow(database.db, { userId: database.userId });
      expect(result.totals).toEqual([
        {
          currency: 'USD',
          assets: money(500_000n, 'USD'),
          liabilities: money(-42_000n, 'USD'),
          net: money(458_000n, 'USD'),
        },
      ]);
      expect(result.asOf?.toISOString()).toBe('2026-06-01T00:00:00.000Z');
      expect(result.inputs.find((input) => input.accountId === hidden)).toMatchObject({
        included: false,
        excludedReason: 'opted_out',
      });
    });

    it('reports two currencies separately rather than adding dollars to euros', async () => {
      const usd = await seedAccount(database, clock, { providerAccountId: 'pa-usd' });
      const eur = await seedAccount(database, clock, {
        providerAccountId: 'pa-eur',
        currency: 'EUR',
      });
      const asOf = new Date('2026-06-01T00:00:00.000Z');
      await balance(usd, 100_000n, asOf);
      await balance(eur, 50_000n, asOf, 'EUR');

      const result = await netWorthNow(database.db, { userId: database.userId });
      expect(result.totals.map((total) => total.currency)).toEqual(['EUR', 'USD']);
      expect(Money.equals(result.totals[0]?.net ?? Money.zero('EUR'), money(50_000n, 'EUR'))).toBe(
        true,
      );
    });

    it('drops a closed account, and brings it back when it reopens', async () => {
      const accountId = await seedAccount(database, clock);
      await balance(accountId, 250_000n, new Date('2026-06-01T00:00:00.000Z'));

      await database.db.transaction(async (tx) =>
        setAccountClosed(
          tx,
          { userId: database.userId, accountId, closed: true },
          writeContext(clock),
        ),
      );
      const closed = await netWorthNow(database.db, { userId: database.userId });
      expect(closed.totals).toHaveLength(0);
      expect(closed.inputs[0]).toMatchObject({ included: false, excludedReason: 'closed' });
      // The default list hides it; the history it carries is untouched.
      expect(await listAccounts(database.db, { userId: database.userId })).toHaveLength(0);
      expect(
        await listAccounts(database.db, { userId: database.userId, includeClosed: true }),
      ).toHaveLength(1);

      await database.db.transaction(async (tx) =>
        setAccountClosed(
          tx,
          { userId: database.userId, accountId, closed: false },
          writeContext(clock),
        ),
      );
      const reopened = await netWorthNow(database.db, { userId: database.userId });
      expect(reopened.totals[0]?.net.minor).toBe(250_000n);
    });

    it('does not let a provider re-sync reopen an account the user closed', async () => {
      const accountId = await seedAccount(database, clock, { providerAccountId: 'pa-1' });
      await database.db.transaction(async (tx) =>
        setAccountClosed(
          tx,
          { userId: database.userId, accountId, closed: true },
          writeContext(clock),
        ),
      );
      await database.db.transaction(async (tx) =>
        upsertAccount(
          tx,
          {
            userId: database.userId,
            provider: 'plaid',
            providerAccountId: 'pa-1',
            name: 'Everyday Checking',
            type: 'depository',
            currency: 'USD',
          },
          writeContext(clock),
        ),
      );
      const accounts = await listAccounts(database.db, {
        userId: database.userId,
        includeClosed: true,
      });
      expect(accounts[0]?.closedAt).not.toBeNull();
    });

    it('says "no balance" rather than counting an account as zero', async () => {
      await seedAccount(database, clock);
      const result = await netWorthNow(database.db, { userId: database.userId });
      expect(result.totals).toHaveLength(0);
      expect(result.inputs[0]).toMatchObject({ included: false, excludedReason: 'no_balance' });
    });
  });

  async function balance(
    accountId: string,
    minor: bigint,
    asOf: Date,
    currency = 'USD',
  ): Promise<void> {
    await database.db.transaction(async (tx) =>
      recordBalance(
        tx,
        {
          userId: database.userId,
          accountId,
          current: money(minor, currency),
          asOf,
          source: 'provider',
        },
        writeContext(clock),
      ),
    );
  }
});
