// SPDX-License-Identifier: MIT
/**
 * WP 10.9 — `GET /reports/spending-pace` and `GET|PUT|DELETE /dashboard/layout`, over a real database.
 *
 * Every fixture row goes in through a production writer: the manual connector's opening batch (`linkManual`, the
 * initial-backfill path a real institution takes — the only writer that can mark a row pending), `POST
 * /accounts/{id}/transactions`, `PATCH /transactions/{id}` (category, excluded), `POST /transfers/pair`, and the
 * refund heuristic exactly as a consumer runs it. No row is hand-written (the O-11 fixture rule, WP 9.11).
 *
 * The expected curves are arithmetic a reader can check by hand against the fixture table below, and the parity
 * tests compare the pace with `GET /reports/spending` itself — the definition the pace must not drift from.
 *
 *   2025-12-05  −30.00  grocery                                  (December has data)
 *   2026-01-10  −60.00  grocery
 *   2026-02-03  −90.00  grocery
 *   2026-02-28  −10.00  grocery                                  (February: 100.00, 28 days)
 *   2026-03-01 +5000.00 paycheck, an income category             → not spend
 *   2026-03-02  −25.00  grocery
 *   2026-03-05 −1000.00 / +1000.00 checking → brokerage, paired  → a transfer, not spend (the brokerage is
 *                                                                  off-budget, so the legs could never cancel:
 *                                                                  only the transfer rule keeps it out)
 *   2026-03-09  −15.00  hardware, grocery category
 *   2026-03-10   −7.00  coffee, PENDING                          → left out by default
 *   2026-03-11  −44.00  grocery, excluded by the holder          → not spend
 *   2026-03-12   +5.00  hardware refund                          → nets: −5.00
 *   2026-03-15   −8.00  uncategorised                            → spend (the bucket is net negative)
 *
 * "Today" is 2026-03-17 (a fixed clock, holder zone UTC).
 */
import { fixedClock, systemClock } from '@core/kernel';
import { DateOnly } from '@core/kernel';
import { manualTransaction } from '@connector/manual';
import { detectRefundHints } from '@ctx/ledger';
import { money } from '@core/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres for the fixture ledger (CI's api-db job has one)
const describeWithDb = describe.skipIf(NO_DATABASE);

interface PaceDayWire {
  readonly day: number;
  readonly cumulativeMinor: string;
}
interface PaceWire {
  readonly month: string;
  readonly currency: string | null;
  readonly daysInMonth: number;
  readonly today: number | null;
  readonly days: PaceDayWire[];
  readonly lastMonthKey: string;
  readonly lastMonth: PaceDayWire[];
  readonly trailingMonths: string[];
  readonly trailingAverage: PaceDayWire[];
  readonly includePending: boolean;
  readonly pendingExcludedCount: number;
  readonly asOf: string;
  readonly lastSyncedAt: string | null;
}
interface WireCategory {
  readonly id: string;
  readonly kind: string;
  readonly assignable: boolean;
}

function curve(days: readonly PaceDayWire[]): number[] {
  return days.map((point) => Number(point.cumulativeMinor));
}

describeWithDb('[slow] spending pace and dashboard layout (WP 10.9)', () => {
  let h: ApiHarness;
  let checkingId: string;

  async function pace(query = ''): Promise<PaceWire> {
    const response = await h.request({
      method: 'GET',
      url: `/reports/spending-pace${query}`,
      session: h.fresh,
    });
    expectStatus(response, 200);
    return response.json() as PaceWire;
  }

  async function reportTotal(from: string, to: string, month: string): Promise<bigint> {
    const response = await h.request({
      method: 'GET',
      url: `/reports/spending?from=${from}&to=${to}`,
      session: h.fresh,
    });
    expectStatus(response, 200);
    const { cells } = response.json() as {
      cells: { month: string; amount: { minor: string } }[];
    };
    return cells
      .filter((cell) => cell.month === month)
      .reduce((sum, cell) => sum - BigInt(cell.amount.minor), 0n);
  }

  async function add(
    accountId: string,
    amountMinor: string,
    postedDate: string,
    name: string,
  ): Promise<string> {
    const response = await h.request({
      method: 'POST',
      url: `/accounts/${accountId}/transactions`,
      session: h.fresh,
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

  async function patch(id: string, body: Record<string, unknown>): Promise<void> {
    const response = await h.request({
      method: 'PATCH',
      url: `/transactions/${id}`,
      session: h.fresh,
      body,
    });
    expectStatus(response, 200);
  }

  beforeAll(async () => {
    h = await createApiHarness({
      suite: 'wp109_pace',
      clock: fixedClock('2026-03-17T15:00:00.000Z'),
    });

    const categoriesResponse = await h.request({
      method: 'GET',
      url: '/categories',
      session: h.fresh,
    });
    expectStatus(categoriesResponse, 200);
    const { categories } = categoriesResponse.json() as { categories: WireCategory[] };
    const grocery = categories.find((c) => c.assignable && c.kind === 'expense');
    const salary = categories.find((c) => c.assignable && c.kind === 'income');
    if (grocery === undefined || salary === undefined) throw new Error('taxonomy not seeded');

    // The pending row needs the provider path: only a provider can say "pending".
    const bank = await linkManual(h, {
      providerConnectionId: 'wp109-bank',
      displayName: 'Everyday Bank',
      accounts: [
        { providerAccountId: 'chk', name: 'Checking', type: 'depository', currency: 'USD' },
        { providerAccountId: 'brk', name: 'Brokerage', type: 'investment', currency: 'USD' },
      ],
      batch: {
        added: [
          manualTransaction({
            providerAccountId: 'chk',
            providerTransactionId: 'wp109-pending-coffee',
            amount: money(-700n, 'USD'),
            postedDate: DateOnly.parse('2026-03-10'),
            name: 'PENDING COFFEE',
            pending: true,
          }),
        ],
      },
    });
    const [checking, brokerage] = bank.accountIds;
    if (checking === undefined || brokerage === undefined) throw new Error('accounts missing');
    checkingId = checking;

    const categorised = async (minor: string, date: string, name: string, categoryId: string) => {
      const id = await add(checking, minor, date, name);
      await patch(id, { categoryId });
      return id;
    };
    await categorised('-3000', '2025-12-05', 'Corner Grocery', grocery.id);
    await categorised('-6000', '2026-01-10', 'Corner Grocery', grocery.id);
    await categorised('-9000', '2026-02-03', 'Corner Grocery', grocery.id);
    await categorised('-1000', '2026-02-28', 'Corner Grocery', grocery.id);
    await categorised('500000', '2026-03-01', 'ACME PAYROLL', salary.id);
    await categorised('-2500', '2026-03-02', 'Corner Grocery', grocery.id);
    await categorised('-1500', '2026-03-09', 'Hardware Store', grocery.id);
    const excludedId = await categorised('-4400', '2026-03-11', 'Corner Grocery', grocery.id);
    await patch(excludedId, { excluded: true });
    await add(checking, '500', '2026-03-12', 'Hardware Store');
    await add(checking, '-800', '2026-03-15', 'Mystery Charge');

    const outflowId = await add(checking, '-100000', '2026-03-05', 'Transfer to Brokerage');
    const inflowId = await add(brokerage, '100000', '2026-03-05', 'Transfer from Checking');
    const paired = await h.request({
      method: 'POST',
      url: '/transfers/pair',
      session: h.fresh,
      body: { outflowTransactionId: outflowId, inflowTransactionId: inflowId },
    });
    expectStatus(paired, 200);

    // The refund heuristic, as the post-sync consumer runs it (no route confirms a hint).
    const hints = await detectRefundHints(
      h.database.db,
      { userId: h.userId },
      { clock: systemClock, correlationId: 'wp109-refund' },
    );
    expect(hints.length).toBeGreaterThan(0);
  }, 120_000);

  afterAll(async () => {
    await h.close();
  });

  it('this month: every day to today present, transfers / income / excluded / pending left out, the refund netted', async () => {
    const body = await pace('?month=2026-03');
    expect(body.month).toBe('2026-03');
    expect(body.currency).toBe('USD');
    expect(body.daysInMonth).toBe(31);
    expect(body.today).toBe(17);
    expect(body.days.map((point) => point.day)).toEqual(
      Array.from({ length: 17 }, (_unused, index) => index + 1),
    );
    expect(curve(body.days)).toEqual([
      0, 2500, 2500, 2500, 2500, 2500, 2500, 2500, 4000, 4000, 4000, 3500, 3500, 3500, 4300, 4300,
      4300,
    ]);
    expect(body.includePending).toBe(false);
    expect(body.pendingExcludedCount).toBe(1);
  });

  it('defaults to the current month in the holder zone', async () => {
    const body = await pace();
    expect(body.month).toBe('2026-03');
    expect(body.today).toBe(17);
  });

  it('includePending=true counts the pending row, and then matches GET /reports/spending exactly', async () => {
    const body = await pace('?month=2026-03&includePending=true');
    expect(body.pendingExcludedCount).toBe(0);
    expect(curve(body.days)[9]).toBe(4700); // day 10: the pending coffee
    const report = await reportTotal('2026-03-01', '2026-03-31', '2026-03');
    expect(report).toBe(5000n);
    expect(BigInt(body.days.at(-1)!.cumulativeMinor)).toBe(report);
  });

  it('last month: every day of February (28), its last point the Reports total for February', async () => {
    const body = await pace('?month=2026-03');
    expect(body.lastMonthKey).toBe('2026-02');
    expect(body.lastMonth).toHaveLength(28);
    const values = curve(body.lastMonth);
    expect(values.slice(0, 2)).toEqual([0, 0]);
    expect(values.slice(2, 27).every((value) => value === 9000)).toBe(true);
    expect(values[27]).toBe(10000);
    const report = await reportTotal('2025-12-01', '2026-02-28', '2026-02');
    expect(BigInt(body.lastMonth.at(-1)!.cumulativeMinor)).toBe(report);
  });

  it('the trailing average: three months, each read at min(day, its length), rounded half-even once', async () => {
    const body = await pace('?month=2026-03');
    expect(body.trailingMonths).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(body.trailingAverage).toHaveLength(31);
    const values = curve(body.trailingAverage);
    expect(values[0]).toBe(0); // day 1: nothing in any month
    expect(values[2]).toBe(3000); // day 3: (0 + 0 + 9000) / 3
    expect(values[4]).toBe(4000); // day 5: (3000 + 0 + 9000) / 3
    expect(values[9]).toBe(6000); // day 10: (3000 + 6000 + 9000) / 3
    expect(values[27]).toBe(6333); // day 28: 19000 / 3 = 6333.33…
    expect(values[30]).toBe(6333); // day 31: February read at its 28th
  });

  it('a past month runs to its last day; a month with no ledger row at all is empty, never zeros', async () => {
    const february = await pace('?month=2026-02');
    expect(february.today).toBeNull();
    expect(february.days).toHaveLength(28);
    expect(curve(february.days)[27]).toBe(10000);
    expect(february.lastMonthKey).toBe('2026-01');
    expect(curve(february.lastMonth)[30]).toBe(6000);

    const empty = await pace('?month=2024-06');
    expect(empty.days).toEqual([]);
    expect(empty.lastMonth).toEqual([]);
    expect(empty.trailingAverage).toEqual([]);
    expect(empty.trailingMonths).toEqual([]);
  });

  it('a future month has no days yet', async () => {
    const body = await pace('?month=2026-05');
    expect(body.today).toBeNull();
    expect(body.days).toEqual([]);
  });

  it('refuses a malformed month', async () => {
    for (const month of ['2026-13', '2026-3', 'march']) {
      const response = await h.request({
        method: 'GET',
        url: `/reports/spending-pace?month=${month}`,
        session: h.fresh,
      });
      expectStatus(response, 400);
    }
  });

  it('needs a session', async () => {
    const response = await h.request({ method: 'GET', url: '/reports/spending-pace' });
    expectStatus(response, 401);
  });

  it('names the last sync time', async () => {
    const body = await pace();
    expect(body.asOf).toBe('2026-03-17T15:00:00.000Z');
    expect(body.lastSyncedAt).not.toBeNull();
    expect(checkingId).toBeTruthy();
  });

  // --- the layout -------------------------------------------------------------------------------------------------

  const DEFAULT_ORDER = [
    'net-worth',
    'spending-pace',
    'budgets',
    'upcoming',
    'to-review',
    'goals',
    'investments',
    'top-insights',
  ];

  it('the layout is the default until one is saved; a save persists order and visibility; a reset restores it', async () => {
    const first = await h.request({ method: 'GET', url: '/dashboard/layout', session: h.fresh });
    expectStatus(first, 200);
    const initial = first.json() as {
      widgets: { id: string; visible: boolean }[];
      customised: boolean;
    };
    expect(initial.customised).toBe(false);
    expect(initial.widgets.map((entry) => entry.id)).toEqual(DEFAULT_ORDER);
    expect(initial.widgets.every((entry) => entry.visible)).toBe(true);

    const saved = [
      { id: 'spending-pace', visible: true },
      { id: 'net-worth', visible: true },
      { id: 'goals', visible: false },
    ];
    const put = await h.request({
      method: 'PUT',
      url: '/dashboard/layout',
      session: h.fresh,
      body: { widgets: saved },
    });
    expectStatus(put, 200);

    const reread = await h.request({ method: 'GET', url: '/dashboard/layout', session: h.fresh });
    const after = reread.json() as {
      widgets: { id: string; visible: boolean }[];
      customised: boolean;
    };
    expect(after.customised).toBe(true);
    // The saved three first, in the saved order; every widget the save did not name appended, shown.
    expect(after.widgets).toEqual([
      ...saved,
      ...DEFAULT_ORDER.filter((id) => !saved.some((entry) => entry.id === id)).map((id) => ({
        id,
        visible: true,
      })),
    ]);

    const stored = await h.database.pool.query<{ dashboard_layout: unknown }>(
      'SELECT dashboard_layout FROM users WHERE id = $1',
      [h.userId],
    );
    expect(stored.rows[0]?.dashboard_layout).toEqual(saved);

    const reset = await h.request({ method: 'DELETE', url: '/dashboard/layout', session: h.fresh });
    expectStatus(reset, 200);
    const back = reset.json() as { widgets: { id: string }[]; customised: boolean };
    expect(back.customised).toBe(false);
    expect(back.widgets.map((entry) => entry.id)).toEqual(DEFAULT_ORDER);
  });

  it('refuses a repeated or unknown widget', async () => {
    for (const widgets of [
      [
        { id: 'goals', visible: true },
        { id: 'goals', visible: false },
      ],
      [{ id: 'crystal-ball', visible: true }],
    ]) {
      const response = await h.request({
        method: 'PUT',
        url: '/dashboard/layout',
        session: h.fresh,
        body: { widgets },
      });
      expectStatus(response, 400);
    }
  });

  it('a stored id the product no longer draws is dropped on read; the database refuses a non-array', async () => {
    await h.database.pool.query(
      `UPDATE users SET dashboard_layout = '[{"id":"retired-widget","visible":true},{"id":"budgets","visible":false}]'::jsonb WHERE id = $1`,
      [h.userId],
    );
    const response = await h.request({ method: 'GET', url: '/dashboard/layout', session: h.fresh });
    const body = response.json() as { widgets: { id: string; visible: boolean }[] };
    expect(body.widgets[0]).toEqual({ id: 'budgets', visible: false });
    expect(body.widgets.map((entry) => entry.id)).not.toContain('retired-widget');
    expect(body.widgets).toHaveLength(DEFAULT_ORDER.length);

    await expect(
      h.database.pool.query(
        `UPDATE users SET dashboard_layout = '{"id":"budgets"}'::jsonb WHERE id = $1`,
        [h.userId],
      ),
    ).rejects.toThrow(/users_dashboard_layout_is_array/u);
    await h.database.pool.query('UPDATE users SET dashboard_layout = NULL WHERE id = $1', [
      h.userId,
    ]);
  });
});
