// SPDX-License-Identifier: MIT
/**
 * WP 11.2b: the automatic tiers' projection (`transactions.auto_*`) against a real Postgres.
 *
 * What is proven here, and why it needs a database: the resolver is `user ?? rule ?? auto` in TypeScript
 * (`effective.test.ts`) *and* the same order spelled as one `COALESCE` in the list filters, and the two must agree
 * for every row; and the write path is idempotent per assignment id, clears on a tier-6 outcome or a rule's win,
 * and keeps a placement as history (`auto_superseded_at`) when the holder's own pick lands.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyProviderTransactions } from '../src/apply.ts';
import { setAutoCategories, type AutoCategoryChange } from '../src/auto-category.ts';
import { setRuleCategory, setTransactionOverlay } from '../src/overlay.ts';
import {
  countTransactions,
  getTransaction,
  listAggregateRowsInWindow,
  listAggregateSumsInWindow,
  listTransactions,
} from '../src/read.ts';
import { DateOnly } from '@core/kernel';
import {
  CORRELATION_ID,
  NO_DATABASE,
  ledgerDatabase,
  providerTransaction,
  seedAccount,
  testClock,
  writeContext,
  type TestDatabase,
} from './harness.ts';

const AUTO = '01920000-0000-7000-8000-0000000000a1';
const AUTO_2 = '01920000-0000-7000-8000-0000000000a2';
const RULE = '01920000-0000-7000-8000-0000000000b1';
const USER = '01920000-0000-7000-8000-0000000000c1';
const ASSIGNMENT_1 = '01920000-0000-7000-8000-0000000000e1';
const ASSIGNMENT_2 = '01920000-0000-7000-8000-0000000000e2';

describe.skipIf(NO_DATABASE)('setAutoCategories (WP 11.2b)', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;
  let accountId: string;
  let ids: string[];

  const place = (
    transactionId: string,
    over: Partial<NonNullable<AutoCategoryChange['placement']>> = {},
  ): AutoCategoryChange => ({
    transactionId,
    placement: {
      assignmentId: ASSIGNMENT_1,
      categoryId: AUTO,
      tier: 'classifier',
      confidence: 0.9234,
      decidedAt: new Date('2026-06-01T11:00:00.000Z'),
      ...over,
    },
  });

  const write = (changes: readonly AutoCategoryChange[]) =>
    database.db.transaction(async (tx) =>
      setAutoCategories(tx, { userId: database.userId, changes }, writeContext(clock)),
    );

  beforeAll(async () => {
    database = await ledgerDatabase('wp112b_auto');
  });
  afterAll(async () => {
    await database.drop();
  });
  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    accountId = await seedAccount(database, clock);
    const result = await database.db.transaction(async (tx) =>
      applyProviderTransactions(tx, {
        userId: database.userId,
        accountId,
        provider: 'plaid',
        clock,
        correlationId: CORRELATION_ID,
        added: [
          providerTransaction({ providerTransactionId: 'tx-1', name: 'BLUE BOTTLE' }),
          providerTransaction({ providerTransactionId: 'tx-2', name: 'CHEWY' }),
          providerTransaction({ providerTransactionId: 'tx-3', name: 'SHELL OIL' }),
        ],
      }),
    );
    ids = [...result.addedTransactionIds];
    expect(ids).toHaveLength(3);
  });

  const detail = (id: string) =>
    getTransaction(database.db, { userId: database.userId, transactionId: id });

  it('tiers 3, 4 and 5 each project, with their stored provenance, and become the effective category', async () => {
    const [a, b, c] = ids as [string, string, string];
    const result = await write([
      place(a, { tier: 'merchant_default', confidence: 0.75, assignmentId: ASSIGNMENT_1 }),
      place(b, { tier: 'provider', confidence: 0.85, assignmentId: ASSIGNMENT_2 }),
      place(c, {
        tier: 'classifier',
        confidence: 0.9234,
        assignmentId: '01920000-0000-7000-8000-0000000000e3',
      }),
    ]);
    expect(result).toEqual({ placed: 3, cleared: 0, unchanged: 0 });

    for (const [id, tier, confidence] of [
      [a, 'merchant_default', 0.75],
      [b, 'provider', 0.85],
      [c, 'classifier', 0.9234],
    ] as const) {
      const row = await detail(id);
      expect(row.effective.categoryId).toBe(AUTO);
      expect(row.effective.categorySource).toBe('auto');
      expect(row.auto).toMatchObject({ tier, confidence, supersededAt: null });
    }
  });

  it('is idempotent per assignment id: a replay writes nothing, not even updated_at', async () => {
    const [a] = ids as [string];
    await write([place(a)]);
    const before = await detail(a);
    clock.advanceMs(60_000);
    const again = await write([place(a)]);
    expect(again).toEqual({ placed: 0, cleared: 0, unchanged: 1 });
    const after = await detail(a);
    expect(after.updatedAt).toEqual(before.updatedAt);

    // A new assignment id (the pass decided again) replaces it.
    const replaced = await write([
      place(a, {
        assignmentId: ASSIGNMENT_2,
        categoryId: AUTO_2,
        tier: 'provider',
        confidence: 0.8,
      }),
    ]);
    expect(replaced.placed).toBe(1);
    expect((await detail(a)).effective.categoryId).toBe(AUTO_2);
  });

  it('a tier-6 outcome (placement null) clears the row; clearing nothing is a no-op', async () => {
    const [a, b] = ids as [string, string];
    await write([place(a)]);
    const cleared = await write([
      { transactionId: a, placement: null },
      { transactionId: b, placement: null },
    ]);
    expect(cleared).toEqual({ placed: 0, cleared: 1, unchanged: 1 });
    const row = await detail(a);
    expect(row.effective.categoryId).toBeNull();
    expect(row.effective.categorySource).toBeNull();
    expect(row.auto).toBeNull();
  });

  it('refuses a tier that is not automatic, and a confidence outside 0..1', async () => {
    const [a] = ids as [string];
    await expect(write([place(a, { tier: 'rule' as never })])).rejects.toMatchObject({
      code: 'ledger.invalid_auto_placement',
    });
    await expect(write([place(a, { confidence: 1.2 })])).rejects.toMatchObject({
      code: 'ledger.invalid_auto_placement',
    });
    // And the CHECK behind it: the database refuses what the function would not.
    await expect(
      database.db.execute(sql`UPDATE transactions SET auto_tier = 'rule' WHERE id = ${a}`),
    ).rejects.toThrow();
  });

  it('resolver precedence with all three present: the holder, then the rule, then the machine', async () => {
    const [a] = ids as [string];
    await write([place(a)]);
    expect((await detail(a)).effective).toMatchObject({ categoryId: AUTO, categorySource: 'auto' });

    await database.db.transaction(async (tx) =>
      setRuleCategory(
        tx,
        { userId: database.userId, transactionId: a, ruleCategoryId: RULE },
        writeContext(clock),
      ),
    );
    expect((await detail(a)).effective).toMatchObject({ categoryId: RULE, categorySource: 'rule' });

    await database.db.transaction(async (tx) =>
      setTransactionOverlay(
        tx,
        { userId: database.userId, transactionId: a, patch: { userCategoryId: USER } },
        writeContext(clock),
      ),
    );
    const final = await detail(a);
    expect(final.effective).toMatchObject({ categoryId: USER, categorySource: 'user' });
    // The machine's answer is still there, as history.
    expect(final.auto).toMatchObject({ tier: 'classifier' });
  });

  it('a holder pick supersedes the placement (history kept); withdrawing the pick brings it back, unreviewed', async () => {
    const [a] = ids as [string];
    await write([place(a)]);
    await database.db.transaction(async (tx) =>
      setTransactionOverlay(
        tx,
        { userId: database.userId, transactionId: a, patch: { userCategoryId: USER } },
        writeContext(clock),
      ),
    );
    const picked = await detail(a);
    expect(picked.auto?.supersededAt).toBeInstanceOf(Date);
    expect(picked.auto?.assignmentId).toBe(ASSIGNMENT_1);

    // A late pass writing a *new* placement onto a picked row keeps it superseded.
    await write([place(a, { assignmentId: ASSIGNMENT_2, categoryId: AUTO_2 })]);
    expect((await detail(a)).auto?.supersededAt).toBeInstanceOf(Date);
    expect((await detail(a)).effective.categoryId).toBe(USER);

    await database.db.transaction(async (tx) =>
      setTransactionOverlay(
        tx,
        { userId: database.userId, transactionId: a, patch: { userCategoryId: null } },
        writeContext(clock),
      ),
    );
    const back = await detail(a);
    expect(back.auto?.supersededAt).toBeNull();
    expect(back.effective).toMatchObject({ categoryId: AUTO_2, categorySource: 'auto' });
  });

  it('a whole-row write (a user edit of the note, a sync restatement) never writes a stale auto_* back', async () => {
    const [a] = ids as [string];
    // The overlay write reads the row first; a pass commits in between; the edit must not undo it.
    await database.db.transaction(async (tx) => {
      await setTransactionOverlay(
        tx,
        { userId: database.userId, transactionId: a, patch: { userNote: 'hi' } },
        writeContext(clock),
      );
    });
    await write([place(a)]);
    await database.db.transaction(async (tx) => {
      await setTransactionOverlay(
        tx,
        { userId: database.userId, transactionId: a, patch: { userNote: 'again' } },
        writeContext(clock),
      );
    });
    expect((await detail(a)).effective.categoryId).toBe(AUTO);
    await database.db.transaction(async (tx) =>
      applyProviderTransactions(tx, {
        userId: database.userId,
        accountId,
        provider: 'plaid',
        clock,
        correlationId: CORRELATION_ID,
        modified: [
          providerTransaction({
            providerTransactionId: 'tx-1',
            name: 'BLUE BOTTLE',
            merchantName: 'Blue Bottle',
          }),
        ],
      }),
    );
    expect((await detail(a)).effective.categoryId).toBe(AUTO);
  });

  it("writes only this holder's rows", async () => {
    const [a] = ids as [string];
    const result = await database.db.transaction(async (tx) =>
      setAutoCategories(
        tx,
        { userId: '01920000-0000-7000-8000-0000000000ff', changes: [place(a)] },
        writeContext(clock),
      ),
    );
    expect(result).toEqual({ placed: 0, cleared: 0, unchanged: 1 });
    expect((await detail(a)).effective.categoryId).toBeNull();
  });

  describe('the readers: an auto-categorised row now counts', () => {
    const window = {
      dateFrom: DateOnly.parse('2026-05-01'),
      dateTo: DateOnly.parse('2026-05-31'),
    };

    it('the list carries the category, and the categoryIds and uncategorized filters follow the resolver', async () => {
      const [a, b] = ids as [string, string];
      await write([place(a)]);
      await database.db.transaction(async (tx) =>
        setRuleCategory(
          tx,
          { userId: database.userId, transactionId: b, ruleCategoryId: RULE },
          writeContext(clock),
        ),
      );

      const byAuto = await listTransactions(database.db, {
        userId: database.userId,
        filters: { categoryIds: [AUTO] },
      });
      expect(byAuto.items.map((i) => i.id)).toEqual([a]);
      // A rule's category is found by the same filter (it used to match the holder's column only).
      const byRule = await listTransactions(database.db, {
        userId: database.userId,
        filters: { categoryIds: [RULE] },
      });
      expect(byRule.items.map((i) => i.id)).toEqual([b]);

      const uncategorised = await listTransactions(database.db, {
        userId: database.userId,
        filters: { uncategorized: true },
      });
      expect(uncategorised.items.map((i) => i.id)).toEqual([ids[2]]);
      expect(
        await countTransactions(database.db, {
          userId: database.userId,
          filters: { uncategorized: true },
        }),
      ).toBe(1);
      expect(
        await countTransactions(database.db, {
          userId: database.userId,
          filters: { uncategorized: false },
        }),
      ).toBe(2);
    });

    it('the aggregate rows and the grouped sums (reports, pace, cash flow, budgets) read the same category', async () => {
      const [a] = ids as [string];
      await write([place(a)]);
      const rows = await listAggregateRowsInWindow(database.db, {
        userId: database.userId,
        filters: window,
      });
      expect(rows.find((r) => r.id === a)?.categoryId).toBe(AUTO);
      expect(rows.filter((r) => r.categoryId === null)).toHaveLength(2);

      const sums = await listAggregateSumsInWindow(database.db, {
        userId: database.userId,
        filters: window,
        cuts: [],
      });
      const auto = sums.filter((s) => s.categoryId === AUTO);
      expect(auto).toHaveLength(1);
      expect(auto[0]?.amount.minor).toBe(-1_234n);
      expect(sums.filter((s) => s.categoryId === null).reduce((n, s) => n + s.count, 0)).toBe(2);
    });

    it('the SQL COALESCE and resolveCategoryId agree on all eight combinations of the three tiers', async () => {
      const combos: [boolean, boolean, boolean][] = [];
      for (const u of [false, true])
        for (const r of [false, true]) for (const m of [false, true]) combos.push([u, r, m]);
      const created = await database.db.transaction(async (tx) =>
        applyProviderTransactions(tx, {
          userId: database.userId,
          accountId,
          provider: 'plaid',
          clock,
          correlationId: CORRELATION_ID,
          added: combos.map((_c, i) =>
            providerTransaction({
              providerTransactionId: `combo-${String(i)}`,
              name: `COMBO ${String(i)}`,
            }),
          ),
        }),
      );
      for (const [i, [u, r, m]] of combos.entries()) {
        const id = created.addedTransactionIds[i] as string;
        if (m) await write([place(id)]);
        if (r)
          await database.db.transaction(async (tx) =>
            setRuleCategory(
              tx,
              { userId: database.userId, transactionId: id, ruleCategoryId: RULE },
              writeContext(clock),
            ),
          );
        if (u)
          await database.db.transaction(async (tx) =>
            setTransactionOverlay(
              tx,
              { userId: database.userId, transactionId: id, patch: { userCategoryId: USER } },
              writeContext(clock),
            ),
          );
      }
      const expected = (u: boolean, r: boolean, m: boolean) =>
        u ? USER : r ? RULE : m ? AUTO : null;
      const rows = await listAggregateRowsInWindow(database.db, {
        userId: database.userId,
        filters: window,
      });
      for (const [i, [u, r, m]] of combos.entries()) {
        const id = created.addedTransactionIds[i] as string;
        const want = expected(u, r, m);
        expect((await detail(id)).effective.categoryId).toBe(want);
        expect(rows.find((x) => x.id === id)?.categoryId).toBe(want);
        const filtered = await listTransactions(database.db, {
          userId: database.userId,
          filters: want === null ? { uncategorized: true } : { categoryIds: [want] },
        });
        expect(filtered.items.some((item) => item.id === id)).toBe(true);
      }
    });

    it('the review filter: placed in the window, nothing since from a rule or the holder', async () => {
      const [a, b, c] = ids as [string, string, string];
      await write([
        place(a, { decidedAt: new Date('2026-06-01T10:00:00.000Z') }),
        place(b, { assignmentId: ASSIGNMENT_2, decidedAt: new Date('2026-04-01T10:00:00.000Z') }),
        place(c, {
          assignmentId: '01920000-0000-7000-8000-0000000000e3',
          decidedAt: new Date('2026-06-01T10:00:00.000Z'),
        }),
      ]);
      const since = new Date('2026-05-15T00:00:00.000Z');
      const review = () =>
        listTransactions(database.db, {
          userId: database.userId,
          filters: { autoReviewSince: since },
        });
      expect((await review()).items.map((i) => i.id).sort()).toEqual([a, c].sort());

      await database.db.transaction(async (tx) =>
        setTransactionOverlay(
          tx,
          { userId: database.userId, transactionId: c, patch: { userCategoryId: AUTO } },
          writeContext(clock),
        ),
      );
      expect((await review()).items.map((i) => i.id)).toEqual([a]);
    });
  });
});
