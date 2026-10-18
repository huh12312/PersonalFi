// SPDX-License-Identifier: MIT
/**
 * WP 10.14 — `GET /reports/category-history`, over a real database.
 *
 * Every fixture row goes in through a production writer (the O-11 fixture rule): the manual connector's opening
 * batch (`linkManual`, the only writer that can say *pending*), `POST /accounts/{id}/transactions`, `PATCH
 * /transactions/{id}` (category, excluded), and the refund heuristic as the consumer runs it.
 *
 * "Today" is 2026-10-18 (a fixed clock, holder zone UTC): the window is 2025-10 … 2026-10. A heading H with two of its
 * leaves, A and B:
 *
 *   2024-06-10    −10.00  A                 before the window: every window month is in history
 *   2025-10-12   −120.00  A
 *   2026-01-05   −270.00  A, "Refund Shop"
 *   2026-01-20    +30.00  "Refund Shop"     uncategorised; the heuristic links it → nets into A: January 240.00
 *   2026-06-03   −300.00  A
 *   2026-06-09    −60.00  A, PENDING        counted, as Reports counts it
 *   2026-06-11    −99.00  A, excluded       dropped
 *   2026-06-15    −40.00  B
 *   2026-10-05   −130.00  A                 the current month, so far
 *   2026-10-07    −20.00  B
 *
 * A's complete months: 120 + 240 + 360 over twelve months (nine of them zero) = 60.00. Dropping the zero months would
 * give 240.00; counting the current month would give 65.38. H adds B: (720 + 40) / 12 = 63.33.
 */
import { manualTransaction } from '@connector/manual';
import { DateOnly, fixedClock, money, newId, systemClock } from '@core/kernel';
import { detectRefundHints } from '@ctx/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MANUAL_PROVIDER,
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface MonthWire {
  readonly month: string;
  readonly start: string;
  readonly end: string;
  readonly amountMinor: string;
  readonly transactionCount: number;
  readonly hasActivity: boolean;
  readonly complete: boolean;
  readonly isCurrent: boolean;
  readonly inHistory: boolean;
}
interface HistoryWire {
  readonly categoryId: string;
  readonly side: 'spending' | 'income';
  readonly includesChildren: boolean;
  readonly currency: string | null;
  readonly otherCurrencies: string[];
  readonly currentMonth: string;
  readonly through: string;
  readonly historyStart: string | null;
  readonly months: MonthWire[];
  readonly average: {
    readonly available: boolean;
    readonly withheld: 'insufficient_history' | 'no_data' | null;
    readonly amountMinor: string | null;
    readonly monthsAveraged: number;
    readonly months: string[];
  };
  readonly comparison: {
    readonly available: boolean;
    readonly withheld: 'insufficient_history' | 'no_data' | null;
    readonly thisMonthMinor: string;
    readonly averageMinor: string | null;
    readonly differenceMinor: string | null;
    readonly direction: 'more' | 'less' | 'same' | null;
  };
  readonly drillThrough: { categoryIds?: string[]; from: string; to: string };
}
interface WireCategory {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly assignable: boolean;
  readonly parentId: string | null;
}
interface BreakdownRowWire {
  readonly key: string | null;
  readonly sumMinor: string;
  readonly count: number;
}
interface CashFlowWire {
  readonly breakdowns: {
    readonly expenses: {
      readonly category: BreakdownRowWire[];
      readonly group: BreakdownRowWire[];
    };
  };
}
type Session = ApiHarness['fresh'];

const WINDOW = [
  '2025-10',
  '2025-11',
  '2025-12',
  '2026-01',
  '2026-02',
  '2026-03',
  '2026-04',
  '2026-05',
  '2026-06',
  '2026-07',
  '2026-08',
  '2026-09',
  '2026-10',
];

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres for the fixture ledger (CI's api-db job has one)
describe.skipIf(NO_DATABASE)('[slow] the category detail history (WP 10.14)', () => {
  let h: ApiHarness;
  let heading: WireCategory;
  let leafA: WireCategory;
  let leafB: WireCategory;
  let children: string[];

  async function history(categoryId: string, session: Session = h.stale) {
    return h.request({
      method: 'GET',
      url: `/reports/category-history?categoryId=${categoryId}`,
      session,
    });
  }

  async function historyOk(categoryId: string, session: Session = h.stale): Promise<HistoryWire> {
    const response = await history(categoryId, session);
    expectStatus(response, 200);
    return response.json() as HistoryWire;
  }

  async function add(
    accountId: string,
    amountMinor: string,
    postedDate: string,
    name: string,
    session: Session = h.fresh,
  ): Promise<string> {
    const response = await h.request({
      method: 'POST',
      url: `/accounts/${accountId}/transactions`,
      session,
      body: {
        transactions: [
          { amount: { minor: amountMinor, currency: 'USD' }, postedDate, name, merchantName: name },
        ],
      },
    });
    expectStatus(response, 201);
    const id = (response.json() as { addedTransactionIds: string[] }).addedTransactionIds[0];
    if (id === undefined) throw new Error('not added');
    return id;
  }

  async function patch(id: string, body: Record<string, unknown>, session: Session = h.fresh) {
    expectStatus(
      await h.request({ method: 'PATCH', url: `/transactions/${id}`, session, body }),
      200,
    );
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp1014_history',
      clock: fixedClock('2026-10-18T15:00:00.000Z'),
    });

    const listed = await h.request({ method: 'GET', url: '/categories', session: h.fresh });
    expectStatus(listed, 200);
    const { categories } = listed.json() as { categories: WireCategory[] };
    const found = categories.find(
      (c) =>
        c.kind === 'expense' &&
        c.parentId === null &&
        categories.filter((child) => child.parentId === c.id).length >= 2,
    );
    if (found === undefined) throw new Error('no expense heading with two children');
    heading = found;
    const ownChildren = categories.filter((c) => c.parentId === heading.id);
    [leafA, leafB] = ownChildren as [WireCategory, WireCategory];
    // Archived children too: none are archived in a fresh taxonomy, so the listed ones are all of them.
    children = ownChildren.map((c) => c.id);

    const bank = await linkManual(h, {
      providerConnectionId: 'wp1014-bank',
      displayName: 'Everyday Bank',
      accounts: [
        { providerAccountId: 'chk', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: 'chk',
            providerTransactionId: 'wp1014-pending-deli',
            amount: money(-6_000n, 'USD'),
            postedDate: DateOnly.parse('2026-06-09'),
            name: 'PENDING DELI',
            pending: true,
          }),
        ],
      },
    });
    const [checking] = bank.accountIds;
    if (checking === undefined) throw new Error('account missing');

    const txns = await h.request({ method: 'GET', url: '/transactions', session: h.fresh });
    expectStatus(txns, 200);
    const pending = (txns.json() as { items: { id: string; name: string }[] }).items.find((t) =>
      t.name.toUpperCase().includes('PENDING DELI'),
    );
    if (pending === undefined) throw new Error('pending row missing');
    await patch(pending.id, { categoryId: leafA.id });

    const categorised = async (minor: string, date: string, name: string, categoryId: string) => {
      const id = await add(checking, minor, date, name);
      await patch(id, { categoryId });
      return id;
    };
    await categorised('-1000', '2024-06-10', 'Old Grocer', leafA.id);
    await categorised('-12000', '2025-10-12', 'Corner Grocer', leafA.id);
    await categorised('-27000', '2026-01-05', 'Refund Shop', leafA.id);
    await add(checking, '3000', '2026-01-20', 'Refund Shop');
    await categorised('-30000', '2026-06-03', 'Corner Grocer', leafA.id);
    const excluded = await categorised('-9900', '2026-06-11', 'Corner Grocer', leafA.id);
    await patch(excluded, { excluded: true });
    await categorised('-4000', '2026-06-15', 'Side Shop', leafB.id);
    await categorised('-13000', '2026-10-05', 'Corner Grocer', leafA.id);
    await categorised('-2000', '2026-10-07', 'Side Shop', leafB.id);

    const hints = await detectRefundHints(
      h.database.db,
      { userId: h.userId },
      { clock: systemClock, correlationId: 'wp1014-refund' },
    );
    expect(hints.length).toBe(1);
  }, 180_000);

  afterAll(async () => {
    await h.close();
  });

  it('thirteen months oldest first; a zero month is a real zero, in history and averaged', async () => {
    const body = await historyOk(leafA.id);
    expect(body.categoryId).toBe(leafA.id);
    expect(body.side).toBe('spending');
    expect(body.includesChildren).toBe(false);
    expect(body.currency).toBe('USD');
    expect(body.otherCurrencies).toEqual([]);
    expect(body.currentMonth).toBe('2026-10');
    expect(body.through).toBe('2026-10-18');
    expect(body.historyStart, 'the ledger reaches back before the window').toBe('2025-10');
    expect(body.months.map((m) => m.month)).toEqual(WINDOW);
    expect(body.months[0]).toMatchObject({ start: '2025-10-01', end: '2025-10-31' });
    expect(body.months.every((m) => m.inHistory)).toBe(true);

    const november = body.months.find((m) => m.month === '2025-11');
    expect(november).toMatchObject({
      amountMinor: '0',
      hasActivity: false,
      transactionCount: 0,
      complete: true,
      isCurrent: false,
      inHistory: true,
    });

    const amounts = Object.fromEntries(body.months.map((m) => [m.month, m.amountMinor]));
    expect(amounts).toMatchObject({
      '2025-10': '12000',
      // −270.00 purchase, +30.00 refund netted into the purchase's category.
      '2026-01': '24000',
      // 300.00 + 60.00 pending; the excluded 99.00 dropped; B's 40.00 is not A's.
      '2026-06': '36000',
      '2026-10': '13000',
    });
    const current = body.months.at(-1);
    expect(current).toMatchObject({ isCurrent: true, complete: false });
    expect(body.months.filter((m) => m.isCurrent)).toHaveLength(1);
  });

  it('the average is every complete month in history (zeros counted), never the current month', async () => {
    const body = await historyOk(leafA.id);
    // (120 + 240 + 360) / 12 = 60.00. Dropping zero months: 240.00; with the current month: 65.38.
    expect(body.average).toEqual({
      available: true,
      withheld: null,
      amountMinor: '6000',
      monthsAveraged: 12,
      months: WINDOW.slice(0, 12),
    });
    expect(body.comparison).toEqual({
      available: true,
      withheld: null,
      thisMonthMinor: '13000',
      averageMinor: '6000',
      differenceMinor: '7000',
      direction: 'more',
    });
    expect(body.drillThrough).toEqual({
      categoryIds: [leafA.id],
      from: '2025-10-01',
      to: '2026-10-31',
    });
  });

  it("each month's amount is exactly the Cash Flow hub's category breakdown for that month", async () => {
    const leaf = await historyOk(leafA.id);
    const group = await historyOk(heading.id);
    for (const month of WINDOW) {
      const response = await h.request({
        method: 'GET',
        url: `/reports/cash-flow?timeframe=month&period=${month}`,
        session: h.stale,
      });
      expectStatus(response, 200);
      const { breakdowns } = response.json() as CashFlowWire;
      const leafRow = breakdowns.expenses.category.find((row) => row.key === leafA.id);
      const groupRow = breakdowns.expenses.group.find((row) => row.key === heading.id);
      const leafMonth = leaf.months.find((m) => m.month === month);
      const groupMonth = group.months.find((m) => m.month === month);
      expect({ month, amount: leafMonth?.amountMinor, count: leafMonth?.transactionCount }).toEqual(
        { month, amount: leafRow?.sumMinor ?? '0', count: leafRow?.count ?? 0 },
      );
      expect({
        month,
        amount: groupMonth?.amountMinor,
        count: groupMonth?.transactionCount,
      }).toEqual({ month, amount: groupRow?.sumMinor ?? '0', count: groupRow?.count ?? 0 });
    }
  });

  it('a heading sums its children', async () => {
    const body = await historyOk(heading.id);
    expect(body.includesChildren).toBe(true);
    expect(new Set(body.drillThrough.categoryIds)).toEqual(new Set([heading.id, ...children]));
    const amounts = Object.fromEntries(body.months.map((m) => [m.month, m.amountMinor]));
    expect(amounts).toMatchObject({ '2026-06': '40000', '2026-10': '15000' });
    // (720 + 40) / 12 = 63.333… → 63.33.
    expect(body.average.amountMinor).toBe('6333');
    expect(body.comparison).toMatchObject({
      thisMonthMinor: '15000',
      differenceMinor: '8667',
      direction: 'more',
    });
    const b = await historyOk(leafB.id);
    // B: 40.00 over twelve months = 3.333… → 3.33; this month 20.00.
    expect(b.average.amountMinor).toBe('333');
    expect(b.comparison.thisMonthMinor).toBe('2000');
  });

  it("another holder's category and an unknown id are 404; a holder with no ledger is no_data, then one month of history is insufficient_history", async () => {
    const other = await h.database.createUser('Other Holder');
    const session = await h.issueSession({ fresh: true, userId: other });

    const created = await h.request({
      method: 'POST',
      url: '/categories',
      session,
      body: { parentId: null, label: 'Hobbies', kind: 'expense' },
    });
    expectStatus(created, 201);
    const theirs = (created.json() as { category: WireCategory }).category;

    const foreign = await history(theirs.id);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toMatchObject({ code: 'categorization.category_not_found' });
    expect((await history(leafA.id, session)).statusCode, 'and the other way round').toBe(404);
    expect((await history(newId())).statusCode).toBe(404);
    expect((await history('not-a-uuid')).statusCode).toBe(400);

    const empty = await historyOk(theirs.id, session);
    expect(empty.historyStart).toBeNull();
    expect(empty.months).toHaveLength(13);
    expect(empty.months.every((m) => !m.inHistory && m.amountMinor === '0')).toBe(true);
    expect(empty.average).toMatchObject({
      available: false,
      withheld: 'no_data',
      amountMinor: null,
    });
    expect(empty.comparison).toMatchObject({
      available: false,
      withheld: 'no_data',
      thisMonthMinor: '0',
      differenceMinor: null,
      direction: null,
    });

    // Their first ledger row is last month: one complete month of history.
    const providerConnectionId = 'wp1014-other-bank';
    h.manualStore.open(providerConnectionId);
    const linked = await h.request({
      method: 'POST',
      url: '/connections',
      session,
      body: {
        provider: MANUAL_PROVIDER,
        input: {
          displayName: 'Other Bank',
          providerConnectionId,
          accounts: [
            { providerAccountId: 'chk', name: 'Checking', type: 'depository', currency: 'USD' },
          ],
        },
      },
    });
    expectStatus(linked, 201);
    const [account] = (linked.json() as { accountIds: string[] }).accountIds;
    if (account === undefined) throw new Error('account missing');
    await patch(
      await add(account, '-5000', '2026-09-10', 'Hobby Shop', session),
      {
        categoryId: theirs.id,
      },
      session,
    );
    await patch(
      await add(account, '-1500', '2026-10-02', 'Hobby Shop', session),
      {
        categoryId: theirs.id,
      },
      session,
    );

    const young = await historyOk(theirs.id, session);
    expect(young.historyStart).toBe('2026-09');
    expect(young.months.filter((m) => m.inHistory).map((m) => m.month)).toEqual([
      '2026-09',
      '2026-10',
    ]);
    expect(young.months.find((m) => m.month === '2026-08')).toMatchObject({
      amountMinor: '0',
      inHistory: false,
    });
    expect(young.average).toEqual({
      available: false,
      withheld: 'insufficient_history',
      amountMinor: null,
      monthsAveraged: 0,
      months: [],
    });
    expect(young.comparison).toEqual({
      available: false,
      withheld: 'insufficient_history',
      thisMonthMinor: '1500',
      averageMinor: null,
      differenceMinor: null,
      direction: null,
    });
  });
});
