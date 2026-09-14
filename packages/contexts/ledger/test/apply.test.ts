// SPDX-License-Identifier: MIT
/**
 * `applyProviderTransactions` against a real Postgres.
 *
 * There is no fake here, and could not be: every claim in this file is a claim
 * about the database. "Replaying a page is a no-op" is a unique index arbitrating
 * an upsert; "the overlay survives settlement" is an `UPDATE` that moves a
 * pointer and touches no `user_*` column; "removed and added in either order
 * converge" is two transactions reaching the same rows. A double would only
 * assert that the double works.
 */
import { DateOnly, money } from '@core/kernel';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { transactions, transactionsProvider } from '../schema/index.ts';
import { applyProviderTransactions } from '../src/apply.ts';
import { factOf, overlayOf } from '../src/db.ts';
import { resolveEffective } from '../src/effective.ts';
import { setTransactionOverlay } from '../src/overlay.ts';
import { getTransaction, listTransactions, scanForProjectionCheck } from '../src/read.ts';
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

describe.skipIf(NO_DATABASE)('applyProviderTransactions', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;
  let accountId: string;

  beforeAll(async () => {
    database = await ledgerDatabase('apply');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    accountId = await seedAccount(database, clock);
  });

  /** One sync page, applied inside its own transaction, as a connector would. */
  async function apply(page: {
    added?: readonly ReturnType<typeof providerTransaction>[];
    modified?: readonly ReturnType<typeof providerTransaction>[];
    removed?: readonly string[];
  }) {
    return database.db.transaction(async (tx) =>
      applyProviderTransactions(tx, {
        userId: database.userId,
        accountId,
        provider: 'plaid',
        clock,
        correlationId: CORRELATION_ID,
        added: page.added ?? [],
        modified: page.modified ?? [],
        removed: page.removed ?? [],
      }),
    );
  }

  it('creates a user-facing row whose effective columns came from resolveEffective', async () => {
    const result = await apply({
      added: [
        providerTransaction({
          providerTransactionId: 'tx-1',
          amount: money(-1_234n, 'USD'),
          postedDate: DateOnly.parse('2026-05-20'),
          authorizedDate: DateOnly.parse('2026-05-18'),
          name: 'SQ *BLUE BOTTLE 4471',
        }),
      ],
    });

    expect(result.addedTransactionIds).toHaveLength(1);
    const id = result.addedTransactionIds[0] ?? '';
    const detail = await getTransaction(database.db, {
      userId: database.userId,
      transactionId: id,
    });
    // The swipe date, not the settlement date (04 §2.4).
    expect(detail.effective.date).toBe('2026-05-18');
    expect(detail.effective.amount.minor).toBe(-1_234n);
    expect(detail.effective.name).toBe('Blue Bottle');
    expect(detail.merchantDisplayName).toBe('Blue Bottle');
    expect(detail.provenance.providerTransactionId).toBe('tx-1');
    expect(detail.provenance.revision).toBe(1);
  });

  it('is idempotent: applying the same page twice changes nothing and says nothing', async () => {
    const page = [
      providerTransaction({ providerTransactionId: 'tx-1' }),
      providerTransaction({
        providerTransactionId: 'tx-2',
        amount: money(-9_900n, 'USD'),
        name: 'WHOLEFDS MKT #10259',
      }),
    ];

    const first = await apply({ added: page });
    const afterFirst = await snapshot(database);
    const eventsAfterFirst = await countEvents(database);

    const second = await apply({ added: page });
    const afterSecond = await snapshot(database);

    expect(first.addedTransactionIds).toHaveLength(2);
    expect(second.addedTransactionIds).toHaveLength(0);
    expect(second.updatedTransactionIds).toHaveLength(0);
    expect(second.unchangedFactCount).toBe(2);
    expect(afterSecond).toEqual(afterFirst);
    // A replay that touched nothing must not wake four consumers up to
    // recompute an answer that cannot have changed.
    expect(await countEvents(database)).toBe(eventsAfterFirst);
  });

  it('bumps last_seen_at without a revision when a `modified` carries no change', async () => {
    const item = providerTransaction({ providerTransactionId: 'tx-1' });
    await apply({ added: [item] });
    clock.advanceMs(60_000);
    await apply({ modified: [item] });

    const facts = await database.db
      .select()
      .from(transactionsProvider)
      .where(eq(transactionsProvider.providerTransactionId, 'tx-1'));
    expect(facts[0]?.revision).toBe(1);
    expect(facts[0]?.lastSeenAt.getTime()).toBeGreaterThan(facts[0]?.firstSeenAt.getTime() ?? 0);
  });

  it('advances the revision and refreshes the projection when a `modified` really changed', async () => {
    const created = await apply({
      added: [providerTransaction({ providerTransactionId: 'tx-1' })],
    });
    const id = created.addedTransactionIds[0] ?? '';

    await apply({
      modified: [
        providerTransaction({
          providerTransactionId: 'tx-1',
          amount: money(-1_500n, 'USD'),
          merchantName: 'Blue Bottle Coffee',
        }),
      ],
    });

    const detail = await getTransaction(database.db, {
      userId: database.userId,
      transactionId: id,
    });
    expect(detail.id).toBe(id);
    expect(detail.effective.amount.minor).toBe(-1_500n);
    expect(detail.effective.name).toBe('Blue Bottle Coffee');
    expect(detail.provenance.revision).toBe(2);
  });

  describe('pending → posted', () => {
    it('keeps the id, the overlay and the splits when a charge settles (decision D10)', async () => {
      const created = await apply({
        added: [
          providerTransaction({
            providerTransactionId: 'pending-1',
            pending: true,
            amount: money(-5_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-18'),
            name: 'TST* THE FRENCH LAUNDRY',
          }),
        ],
      });
      const id = created.addedTransactionIds[0] ?? '';

      // The user does the work that must not evaporate.
      await database.db.transaction(async (tx) =>
        setTransactionOverlay(
          tx,
          {
            userId: database.userId,
            transactionId: id,
            patch: {
              userNote: 'anniversary dinner',
              userCategoryId: '01920000-0000-7000-8000-0000000000ca',
              userExcluded: true,
              userMerchantName: 'The French Laundry',
            },
          },
          writeContext(clock),
        ),
      );

      clock.advanceMs(86_400_000);
      const settled = await apply({
        added: [
          providerTransaction({
            providerTransactionId: 'posted-1',
            pendingTransactionId: 'pending-1',
            // Tips move the amount and settlement moves the date. Both are
            // normal, and neither may cost the user their annotations.
            amount: money(-6_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-20'),
            name: 'TST* THE FRENCH LAUNDRY',
            pending: false,
          }),
        ],
        removed: ['pending-1'],
      });

      expect(settled.addedTransactionIds).toHaveLength(0);
      expect(settled.removedTransactionIds).toHaveLength(0);
      expect(settled.superseded).toEqual([
        expect.objectContaining({
          transactionId: id,
          amountChanged: true,
          dateChanged: true,
          howMatched: 'provider_link',
        }),
      ]);

      const detail = await getTransaction(database.db, {
        userId: database.userId,
        transactionId: id,
      });
      expect(detail.id).toBe(id);
      expect(detail.effective.note).toBe('anniversary dinner');
      expect(detail.effective.categoryId).toBe('01920000-0000-7000-8000-0000000000ca');
      expect(detail.effective.excluded).toBe(true);
      expect(detail.effective.name).toBe('The French Laundry');
      expect(detail.effective.pending).toBe(false);
      expect(detail.effective.amount.minor).toBe(-6_000n);
      expect(detail.provenance.providerTransactionId).toBe('posted-1');

      // The pending fact is kept and stamped: the audit trail survives too.
      const pendingFact = await database.db
        .select()
        .from(transactionsProvider)
        .where(eq(transactionsProvider.providerTransactionId, 'pending-1'));
      expect(pendingFact[0]?.supersededById).toBe(detail.factId);
      expect(pendingFact[0]?.removedAt).not.toBeNull();

      const events = await eventPayloads<{ transactionId: string; amountChanged: boolean }>(
        database,
        'ledger.TransactionSupersededByPosted',
      );
      expect(events).toEqual([expect.objectContaining({ transactionId: id, amountChanged: true })]);
    });

    it('converges whether `removed` arrives before or after the `added`', async () => {
      const pendingItem = providerTransaction({
        providerTransactionId: 'pending-1',
        pending: true,
        amount: money(-5_000n, 'USD'),
      });
      const postedItem = providerTransaction({
        providerTransactionId: 'posted-1',
        pendingTransactionId: 'pending-1',
        amount: money(-5_100n, 'USD'),
        pending: false,
      });

      await apply({ added: [pendingItem] });
      // Plaid does not order `removed[]` against the `added[]` that supersedes
      // it, and the two need not even share a page.
      await apply({ removed: ['pending-1'] });
      const hiddenWhileWaiting = await listTransactions(database.db, { userId: database.userId });
      expect(hiddenWhileWaiting.items).toHaveLength(0);

      const settled = await apply({ added: [postedItem] });
      expect(settled.superseded).toHaveLength(1);

      const page = await listTransactions(database.db, { userId: database.userId });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.effective.amount.minor).toBe(-5_100n);
      expect(page.items[0]?.effective.pending).toBe(false);
    });

    it('falls back to a fuzzy match when the provider supplies no link', async () => {
      const created = await apply({
        added: [
          providerTransaction({
            providerTransactionId: 'pending-1',
            pending: true,
            amount: money(-100n, 'USD'),
            postedDate: DateOnly.parse('2026-05-18'),
            name: 'SHELL OIL 57443021 PORTLAND OR',
          }),
        ],
      });
      const id = created.addedTransactionIds[0] ?? '';

      // The classic gas hold: a $1 authorisation settling as a $52 fill, with no
      // `pending_transaction_id` because the institution supplies none.
      const settled = await apply({
        added: [
          providerTransaction({
            providerTransactionId: 'posted-1',
            pendingTransactionId: null,
            amount: money(-5_231n, 'USD'),
            postedDate: DateOnly.parse('2026-05-19'),
            name: 'SHELL OIL 57443021 PORTLAND OR',
            pending: false,
          }),
        ],
      });

      expect(settled.superseded).toEqual([
        expect.objectContaining({ transactionId: id, howMatched: 'fuzzy' }),
      ]);
      const page = await listTransactions(database.db, { userId: database.userId });
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.id).toBe(id);
    });

    it('refuses an ambiguous fuzzy match rather than merging two real charges', async () => {
      await apply({
        added: [
          providerTransaction({
            providerTransactionId: 'pending-1',
            pending: true,
            amount: money(-2_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-18'),
            name: 'COSTCO WHSE #1234 SEATTLE WA',
          }),
          providerTransaction({
            providerTransactionId: 'pending-2',
            pending: true,
            amount: money(-2_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-18'),
            name: 'COSTCO WHSE #1234 SEATTLE WA',
          }),
        ],
      });

      const settled = await apply({
        added: [
          providerTransaction({
            providerTransactionId: 'posted-1',
            amount: money(-2_000n, 'USD'),
            postedDate: DateOnly.parse('2026-05-19'),
            name: 'COSTCO WHSE #1234 SEATTLE WA',
            pending: false,
          }),
        ],
      });

      // Under-merging is a UI annoyance; over-merging is data loss (01 §5.2).
      expect(settled.superseded).toHaveLength(0);
      expect(settled.addedTransactionIds).toHaveLength(1);
      const page = await listTransactions(database.db, { userId: database.userId });
      expect(page.items).toHaveLength(3);
    });
  });

  describe('removed without a successor', () => {
    it('hides the row, keeps the overlay, and can reclaim it later', async () => {
      const created = await apply({
        added: [providerTransaction({ providerTransactionId: 'tx-1' })],
      });
      const id = created.addedTransactionIds[0] ?? '';
      await database.db.transaction(async (tx) =>
        setTransactionOverlay(
          tx,
          { userId: database.userId, transactionId: id, patch: { userNote: 'keep me' } },
          writeContext(clock),
        ),
      );

      const removal = await apply({ removed: ['tx-1'] });
      expect(removal.removedTransactionIds).toEqual([id]);

      const visible = await listTransactions(database.db, { userId: database.userId });
      expect(visible.items).toHaveLength(0);

      // Hidden, not destroyed: a `DELETE` here would take the note with it, and
      // the provider is entitled to change its mind.
      const withRemoved = await listTransactions(database.db, {
        userId: database.userId,
        filters: { includeRemoved: true },
      });
      expect(withRemoved.items).toHaveLength(1);
      expect(withRemoved.items[0]?.effective.note).toBe('keep me');

      const reclaimed = await apply({
        added: [providerTransaction({ providerTransactionId: 'tx-1' })],
      });
      expect(reclaimed.updatedTransactionIds).toEqual([id]);
      const back = await listTransactions(database.db, { userId: database.userId });
      expect(back.items[0]?.id).toBe(id);
      expect(back.items[0]?.effective.note).toBe('keep me');
    });

    it('ignores a `removed` id it has never seen', async () => {
      const result = await apply({ removed: ['never-heard-of-it'] });
      expect(result.removedTransactionIds).toHaveLength(0);
      expect(await countEvents(database, 'ledger.TransactionsUpserted')).toBe(0);
    });
  });

  it('keeps every stored projection equal to a fresh resolveEffective (the invariant)', async () => {
    await apply({
      added: [
        providerTransaction({ providerTransactionId: 'tx-1' }),
        providerTransaction({
          providerTransactionId: 'tx-2',
          pending: true,
          amount: money(4_200n, 'USD'),
          name: 'ACME CORP PAYROLL',
          authorizedDate: DateOnly.parse('2026-05-01'),
        }),
        providerTransaction({
          providerTransactionId: 'tx-3',
          amount: money(-77n, 'EUR'),
          name: 'AMZN Mktp US*2K4TT1FF2',
          merchantName: 'Amazon',
        }),
      ],
    });
    const first = await listTransactions(database.db, { userId: database.userId });
    await database.db.transaction(async (tx) =>
      setTransactionOverlay(
        tx,
        {
          userId: database.userId,
          transactionId: first.items[0]?.id ?? '',
          patch: { userMerchantName: 'Renamed Payee' },
        },
        writeContext(clock),
      ),
    );

    const rows = await scanForProjectionCheck(database.db, { userId: database.userId });
    expect(rows.length).toBe(3);
    for (const { transaction, fact } of rows) {
      const expected = resolveEffective(factOf(fact), overlayOf(transaction));
      // The denormalised columns are a projection, never a second opinion.
      expect({
        date: transaction.effectiveDate,
        amount: transaction.effectiveAmountMinor,
        currency: transaction.effectiveCurrency.trim(),
        name: transaction.effectiveName,
        pending: transaction.pending,
      }).toEqual({
        date: expected.date,
        amount: expected.amount.minor,
        currency: expected.amount.currency,
        name: expected.name,
        pending: expected.pending,
      });
    }
  });

  it("refuses to write against an account that is not this user's", async () => {
    const stranger = await database.createUser('Someone Else');
    await expect(
      database.db.transaction(async (tx) =>
        applyProviderTransactions(tx, {
          userId: stranger,
          accountId,
          provider: 'plaid',
          added: [providerTransaction({ providerTransactionId: 'tx-1' })],
          clock,
          correlationId: CORRELATION_ID,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ledger.account_not_found' });
  });
});

/** Everything that must not move between two applies of the same page. */
async function snapshot(database: TestDatabase): Promise<unknown> {
  const rows = await database.db.select().from(transactions).orderBy(transactions.id);
  return rows.map((row) => ({
    ...row,
    // `last_seen_at` on the fact is *expected* to move on a replay; `updated_at`
    // here is not, so it stays in the comparison.
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}
