// SPDX-License-Identifier: MIT
/**
 * Transfer pairing and duplicate detection, end to end.
 *
 * The pure heuristics are property-tested in `src/*.test.ts`; what is asserted
 * here is everything the database is responsible for — that a paired leg cannot
 * be paired twice, that a rejection outlives the next sync, and that a
 * cross-provider duplicate is *marked* rather than merged away.
 */
import { DateOnly, money } from '@core/kernel';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { transactions } from '../schema/index.ts';
import { applyProviderTransactions } from '../src/apply.ts';
import { detectRefundHints } from '../src/refunds.ts';
import { listTransactions } from '../src/read.ts';
import {
  confirmTransferPair,
  listTransferLinks,
  pairTransfers,
  rejectTransferPair,
} from '../src/transfers.ts';
import {
  CORRELATION_ID,
  NO_DATABASE,
  countEvents,
  eventPayloads,
  ledgerDatabase,
  providerTransaction,
  seedAccount,
  testClock,
  writeContext,
  type TestDatabase,
} from './harness.ts';

describe.skipIf(NO_DATABASE)('transfers, refunds and duplicates', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;
  let checkingId: string;
  let savingsId: string;

  beforeAll(async () => {
    database = await ledgerDatabase('transfers');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    checkingId = await seedAccount(database, clock, { providerAccountId: 'pa-checking' });
    savingsId = await seedAccount(database, clock, {
      providerAccountId: 'pa-savings',
      name: 'High-Yield Savings',
    });
  });

  async function add(
    accountId: string,
    added: ReturnType<typeof providerTransaction>[],
    provider = 'plaid',
  ): Promise<string[]> {
    const result = await database.db.transaction(async (tx) =>
      applyProviderTransactions(tx, {
        userId: database.userId,
        accountId,
        provider,
        added,
        clock,
        correlationId: CORRELATION_ID,
      }),
    );
    return [...result.addedTransactionIds];
  }

  async function sweep(day = '2026-05-28', amount = 50_000n): Promise<[string, string]> {
    const [out] = await add(checkingId, [
      providerTransaction({
        providerTransactionId: `out-${day}`,
        postedDate: DateOnly.parse(day),
        amount: money(-amount, 'USD'),
        name: 'TRANSFER TO HIGH-YIELD SAVINGS',
      }),
    ]);
    const [inflow] = await add(savingsId, [
      providerTransaction({
        providerTransactionId: `in-${day}`,
        postedDate: DateOnly.parse(day),
        amount: money(amount, 'USD'),
        name: 'TRANSFER FROM EVERYDAY CHECKING',
      }),
    ]);
    return [out ?? '', inflow ?? ''];
  }

  it('pairs the two legs of a savings sweep and says why', async () => {
    const [out, inflow] = await sweep();
    const result = await database.db.transaction(async (tx) =>
      pairTransfers(tx, { userId: database.userId }, writeContext(clock)),
    );

    expect(result.paired).toHaveLength(1);
    expect(result.paired[0]).toMatchObject({
      outflowId: out,
      inflowId: inflow,
      dayGap: 0,
      howMatched: 'exact_amount_same_day',
    });

    const links = await listTransferLinks(database.db, { userId: database.userId });
    expect(links[0]?.amount.minor).toBe(50_000n);
    expect(links[0]?.confidence).toBeGreaterThan(0.9);

    const rows = await database.db.select().from(transactions).where(eq(transactions.id, out));
    expect(rows[0]?.isTransfer).toBe(true);
    expect(rows[0]?.transferLinkId).toBe(links[0]?.id);

    const events = await eventPayloads<{ confidence: number }>(database, 'ledger.TransferPaired');
    expect(events).toHaveLength(1);
    expect(events[0]?.confidence).toBeGreaterThan(0.9);
  });

  it('does not pair the same legs twice when the job runs again', async () => {
    await sweep();
    await database.db.transaction(async (tx) =>
      pairTransfers(tx, { userId: database.userId }, writeContext(clock)),
    );
    const second = await database.db.transaction(async (tx) =>
      pairTransfers(tx, { userId: database.userId }, writeContext(clock)),
    );
    expect(second.paired).toHaveLength(0);
    expect(second.consideredLegs).toBe(0);
    expect(await countEvents(database, 'ledger.TransferPaired')).toBe(1);
  });

  it('keeps transfers out of a spend total while leaving them in the list', async () => {
    await sweep();
    await add(checkingId, [
      providerTransaction({
        providerTransactionId: 'coffee',
        amount: money(-1_234n, 'USD'),
        name: 'SQ *BLUE BOTTLE 4471',
      }),
    ]);
    await database.db.transaction(async (tx) =>
      pairTransfers(tx, { userId: database.userId }, writeContext(clock)),
    );

    const spend = await listTransactions(database.db, {
      userId: database.userId,
      filters: { transfers: 'exclude' },
    });
    expect(spend.items).toHaveLength(1);
    expect(spend.items[0]?.effective.amount.minor).toBe(-1_234n);

    const everything = await listTransactions(database.db, { userId: database.userId });
    expect(everything.items).toHaveLength(3);
  });

  it('never re-proposes a rejected pair, and unlinks the one it had made', async () => {
    const [out, inflow] = await sweep();
    await database.db.transaction(async (tx) =>
      pairTransfers(tx, { userId: database.userId }, writeContext(clock)),
    );

    const rejection = await database.db.transaction(async (tx) =>
      rejectTransferPair(
        tx,
        {
          userId: database.userId,
          transactionIdA: out,
          transactionIdB: inflow,
          reason: 'these are two different movements',
        },
        writeContext(clock),
      ),
    );
    expect(rejection.unlinked).toBe(true);
    expect(await listTransferLinks(database.db, { userId: database.userId })).toHaveLength(0);

    // The next sync runs the heuristic again over exactly the same two rows.
    const rerun = await database.db.transaction(async (tx) =>
      pairTransfers(tx, { userId: database.userId }, writeContext(clock)),
    );
    expect(rerun.consideredLegs).toBe(2);
    expect(rerun.paired).toHaveLength(0);

    const rows = await database.db.select().from(transactions).where(eq(transactions.id, out));
    expect(rows[0]?.isTransfer).toBe(false);
    expect(rows[0]?.transferLinkId).toBeNull();
  });

  it('lets the user pair two rows the heuristic would not have', async () => {
    const [out] = await add(checkingId, [
      providerTransaction({
        providerTransactionId: 'out-odd',
        postedDate: DateOnly.parse('2026-05-01'),
        amount: money(-30_000n, 'USD'),
        name: 'WITHDRAWAL',
      }),
    ]);
    const [inflow] = await add(savingsId, [
      providerTransaction({
        providerTransactionId: 'in-odd',
        // A fortnight apart and $2 short: outside every gate, and the user knows
        // better than the heuristic does.
        postedDate: DateOnly.parse('2026-05-15'),
        amount: money(29_800n, 'USD'),
        name: 'DEPOSIT',
      }),
    ]);

    const auto = await database.db.transaction(async (tx) =>
      pairTransfers(tx, { userId: database.userId }, writeContext(clock)),
    );
    expect(auto.paired).toHaveLength(0);

    await database.db.transaction(async (tx) =>
      confirmTransferPair(
        tx,
        {
          userId: database.userId,
          outflowTransactionId: out ?? '',
          inflowTransactionId: inflow ?? '',
        },
        writeContext(clock),
      ),
    );
    const links = await listTransferLinks(database.db, { userId: database.userId });
    expect(links[0]?.howMatched).toBe('user_confirmed');
    expect(links[0]?.confidence).toBe(1);
    expect(links[0]?.dayGap).toBe(14);
  });

  it('refuses to pair a row with itself or across one account', async () => {
    const [a, b] = await add(checkingId, [
      providerTransaction({ providerTransactionId: 'a', amount: money(-100n, 'USD') }),
      providerTransaction({ providerTransactionId: 'b', amount: money(100n, 'USD') }),
    ]);
    await expect(
      database.db.transaction(async (tx) =>
        confirmTransferPair(
          tx,
          {
            userId: database.userId,
            outflowTransactionId: a ?? '',
            inflowTransactionId: b ?? '',
          },
          writeContext(clock),
        ),
      ),
    ).rejects.toMatchObject({ code: 'ledger.transfer_same_account' });
  });

  it('flags a refund without netting it away', async () => {
    const [purchase] = await add(checkingId, [
      providerTransaction({
        providerTransactionId: 'purchase',
        postedDate: DateOnly.parse('2026-05-01'),
        amount: money(-8_999n, 'USD'),
        name: 'POWELLS BOOKS PORTLAND OR',
        merchantName: 'Powells Books',
      }),
    ]);
    const [refund] = await add(checkingId, [
      providerTransaction({
        providerTransactionId: 'refund',
        postedDate: DateOnly.parse('2026-05-09'),
        amount: money(8_999n, 'USD'),
        name: 'REFUND POWELLS BOOKS',
        merchantName: 'Powells Books',
      }),
    ]);

    const hints = await database.db.transaction(async (tx) =>
      detectRefundHints(tx, { userId: database.userId }, writeContext(clock)),
    );
    expect(hints).toEqual([
      expect.objectContaining({
        refundTransactionId: refund,
        purchaseTransactionId: purchase,
        full: true,
      }),
    ]);

    // Flagged, not netted: both rows are still there and still say what the bank
    // said they said.
    const page = await listTransactions(database.db, { userId: database.userId });
    expect(page.items).toHaveLength(2);
    const rows = await database.db
      .select()
      .from(transactions)
      .where(eq(transactions.id, refund ?? ''));
    expect(rows[0]?.refundOfId).toBe(purchase);
    expect(rows[0]?.refundConfidence).toBeGreaterThan(0.9);

    // Re-running after every sync must be free.
    const rerun = await database.db.transaction(async (tx) =>
      detectRefundHints(tx, { userId: database.userId }, writeContext(clock)),
    );
    expect(rerun).toHaveLength(1);
  });

  describe('cross-provider duplicates', () => {
    const sameCharge = {
      postedDate: DateOnly.parse('2026-05-12'),
      amount: money(-4_250n, 'USD'),
      name: 'WHOLEFDS MKT #10259',
    };

    it('marks the second sighting and keeps both rows', async () => {
      const csvAccountId = await seedAccount(database, clock, {
        provider: 'csv',
        providerAccountId: 'pa-checking',
        name: 'Everyday Checking (CSV)',
      });

      const [original] = await add(checkingId, [
        providerTransaction({ providerTransactionId: 'plaid-1', ...sameCharge }),
      ]);
      const [duplicate] = await add(
        csvAccountId,
        [providerTransaction({ providerTransactionId: 'csv-1', ...sameCharge })],
        'csv',
      );

      const rows = await database.db
        .select()
        .from(transactions)
        .where(eq(transactions.id, duplicate ?? ''));
      expect(rows[0]?.supersededById).toBe(original);
      expect(rows[0]?.supersededReason).toBe('duplicate');

      // Marked, never merged: 01 §5.2 prefers a visible duplicate to data loss,
      // so the default list still shows both and the user decides.
      const page = await listTransactions(database.db, { userId: database.userId });
      expect(page.items).toHaveLength(2);
      const deduped = await listTransactions(database.db, {
        userId: database.userId,
        filters: { includeDuplicates: false },
      });
      expect(deduped.items).toHaveLength(1);
      expect(deduped.items[0]?.id).toBe(original);
    });

    it('leaves two identical charges from one provider alone', async () => {
      // Two coffees, same shop, same price, same day. A provider does not report
      // one purchase twice under two ids, so these are two real purchases.
      await add(checkingId, [
        providerTransaction({ providerTransactionId: 'plaid-1', ...sameCharge }),
        providerTransaction({ providerTransactionId: 'plaid-2', ...sameCharge }),
      ]);
      const deduped = await listTransactions(database.db, {
        userId: database.userId,
        filters: { includeDuplicates: false },
      });
      expect(deduped.items).toHaveLength(2);
    });
  });
});
