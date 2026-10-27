// SPDX-License-Identifier: MIT
/**
 * WP 11.2b, over a real database through the real routes: the ledger's effective category is `user ?? rule ?? auto`
 * (tiers 3-5 of the decision order made effective), and **every reader** gets it through the one resolver.
 *
 * Two halves:
 *
 *   * the readers, one `it` each: a row the automatic tiers placed is counted in the transaction list and its filters
 *     (category, uncategorised, the Inbox's review rows), the spending report, the income report, the cash-flow hub,
 *     the spending pace, the category history, the budget (activity) and the budget-vs-actual report, the budgeting
 *     port, the insights snapshot's category spend, and the CSV export's effective category. The placement is written
 *     the way the categorisation pass writes it (`setAutoCategories`); the assertions are what a client reads.
 *   * the pass, end to end: a synced transaction whose provider category is known is placed by tier 4 through the
 *     categorisation consumer exactly as `modules.ts` wires it, wears its provenance, is explained from the stored
 *     chain, and "Looks right" (the normal pick) supersedes the placement, teaches, and leaves the review rows.
 */
import { DateOnly, systemClock } from '@core/kernel';
import { createConsumerPump, platformExecutor } from '@core/platform';
import { categoryIdsByKey } from '@ctx/categorization';
import { setAutoCategories, setRuleCategory } from '@ctx/ledger';
import { createEgressPolicy, createNtfyChannel, createSmtpChannel } from '@ctx/notifications';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createConnectorRegistry,
  createDomainRuntime,
  createBudgetingLedgerPort,
  createInsightsLedgerPort,
  createInvestmentSyncPort,
} from '../../src/domain.ts';
import { appModules } from '../../src/modules.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireTransaction {
  readonly id: string;
  readonly name: string;
  readonly categoryId: string | null;
  readonly categorySource?: 'user' | 'rule' | 'auto' | null;
  readonly autoCategory?: { tier: string; confidence: number; decidedAt: string } | null;
}
interface Cell {
  readonly month: string;
  readonly categoryId: string | null;
  readonly amount: { minor: string };
}

const today = (): string => new Date().toISOString().slice(0, 10);
const month = (): string => today().slice(0, 7);

async function post(
  h: ApiHarness,
  accountId: string,
  rows: readonly { minor: string; name: string }[],
): Promise<string[]> {
  const response = await h.request({
    method: 'POST',
    url: `/accounts/${accountId}/transactions`,
    session: h.fresh,
    body: {
      transactions: rows.map((row) => ({
        amount: { minor: row.minor, currency: 'USD' },
        postedDate: today(),
        name: row.name,
      })),
    },
  });
  expectStatus(response, 201);
  return (response.json() as { addedTransactionIds: string[] }).addedTransactionIds;
}

async function get<T>(h: ApiHarness, url: string): Promise<T> {
  const response = await h.request({ method: 'GET', url, session: h.stale });
  expectStatus(response, 200);
  return response.json() as T;
}

const sumFor = (cells: readonly Cell[], categoryId: string | null): bigint =>
  cells
    .filter((cell) => cell.categoryId === categoryId)
    .reduce((total, cell) => total + BigInt(cell.amount.minor), 0n);

describe.skipIf(NO_DATABASE)('WP 11.2b — the effective category is user ?? rule ?? auto', () => {
  let h: ApiHarness;
  let accountId: string;
  let ids: ReadonlyMap<string, string>;
  let coffee: string;
  let refunds: string;
  let rulePets: string;
  // T_auto -50.00 (coffee, tier 5), T_rule -20.00 (rule), T_none -10.00, T_income -40.00 (an income-kind category, tier 4)
  let tAuto: string;
  let tRule: string;
  let tNone: string;
  let tIncome: string;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp112b' });
    ids = await categoryIdsByKey(h.database.db, h.userId);
    coffee = ids.get('dining.coffee') as string;
    refunds = ids.get('income.refunds_and_rebates') as string;
    rulePets = ids.get('family.pets') as string;
    const link = await linkManual(h, {
      providerConnectionId: 'wp112b-conn',
      displayName: 'Effective Checking',
      accounts: [
        { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
    });
    accountId = link.accountIds[0] as string;
    // The identity check refuses an on-budget account with no balance at all (`budgeting.balance_unreported`).
    expectStatus(
      await h.request({
        method: 'POST',
        url: `/accounts/${accountId}/balance`,
        session: h.fresh,
        body: { current: { minor: '500000', currency: 'USD' } },
      }),
      200,
    );
    [tAuto, tRule, tNone, tIncome] = (await post(h, accountId, [
      { minor: '-5000', name: 'Blue Bottle Coffee' },
      { minor: '-2000', name: 'Chewy' },
      { minor: '-1000', name: 'Mystery Vendor' },
      { minor: '-4000', name: 'Store Credit' },
    ])) as [string, string, string, string];

    const place = (
      transactionId: string,
      categoryId: string,
      tier: 'merchant_default' | 'provider' | 'classifier',
      confidence: number,
      assignmentId: string,
    ) => ({
      transactionId,
      placement: { assignmentId, categoryId, tier, confidence, decidedAt: new Date() },
    });
    await h.database.db.transaction(async (tx) => {
      await setAutoCategories(
        tx,
        {
          userId: h.userId,
          changes: [
            place(tAuto, coffee, 'classifier', 0.9234, '01920000-0000-7000-8000-0000000000f1'),
            place(tIncome, refunds, 'provider', 0.85, '01920000-0000-7000-8000-0000000000f2'),
          ],
        },
        { clock: systemClock },
      );
      await setRuleCategory(
        tx,
        { userId: h.userId, transactionId: tRule, ruleCategoryId: rulePets },
        { clock: systemClock, correlationId: '01920000-0000-7000-8000-0000000000f3' },
      );
    });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  // ---------------------------------------------------------------- the list and its filters

  it('the list and the detail carry the effective category and, for the machine’s, its provenance', async () => {
    const { items } = await get<{ items: WireTransaction[] }>(h, '/transactions?limit=50');
    const byId = new Map(items.map((item) => [item.id, item] as const));
    expect(byId.get(tAuto)).toMatchObject({
      categoryId: coffee,
      categorySource: 'auto',
      autoCategory: { tier: 'classifier', confidence: 0.9234 },
    });
    // A rule's category wears no chip; nor does an uncategorised row.
    expect(byId.get(tRule)).toMatchObject({
      categoryId: rulePets,
      categorySource: 'rule',
      autoCategory: null,
    });
    expect(byId.get(tNone)).toMatchObject({
      categoryId: null,
      categorySource: null,
      autoCategory: null,
    });

    const detail = await get<WireTransaction>(h, `/transactions/${tAuto}`);
    expect(detail).toMatchObject({
      categoryId: coffee,
      categorySource: 'auto',
      autoCategory: { tier: 'classifier' },
    });
  });

  it('the category filter, the uncategorised filter and the Inbox’s review filter follow the resolver', async () => {
    const idsOf = async (query: string) =>
      (await get<{ items: WireTransaction[] }>(h, `/transactions?limit=50&${query}`)).items.map(
        (i) => i.id,
      );
    expect(await idsOf(`categoryIds=${coffee}`)).toEqual([tAuto]);
    // The rule's category is found by the same filter too.
    expect(await idsOf(`categoryIds=${rulePets}`)).toEqual([tRule]);
    // "Uncategorised" is tier 6 only: neither the rule's nor the machine's rows.
    expect(await idsOf('uncategorized=true')).toEqual([tNone]);
    expect((await idsOf('uncategorized=false')).sort()).toEqual([tAuto, tRule, tIncome].sort());
    // The review rows: the machine placed them, nobody has looked.
    expect((await idsOf('autoReview=true')).sort()).toEqual([tAuto, tIncome].sort());
    const summary = await get<{ summary: { count: number } }>(h, '/transactions?autoReview=true');
    expect(summary.summary.count).toBe(2);
  });

  // ---------------------------------------------------------------- the reports

  it('spending and income reports count the placement in its category, not in uncategorised', async () => {
    const q = `from=${month()}-01&to=${today()}`;
    const spending = (await get<{ cells: Cell[] }>(h, `/reports/spending?${q}`)).cells;
    expect(sumFor(spending, coffee)).toBe(-5000n);
    expect(sumFor(spending, rulePets)).toBe(-2000n);
    // Only the genuinely unplaced row is the uncategorised envelope.
    expect(sumFor(spending, null)).toBe(-1000n);
    const income = (await get<{ cells: Cell[] }>(h, `/reports/income?${q}`)).cells;
    expect(sumFor(income, refunds)).toBe(-4000n);
  });

  it('the cash-flow hub, the category history and the spending pace read the same category', async () => {
    const flow = await get<{
      summary: { expensesMinor: string };
    }>(h, `/reports/cash-flow?timeframe=month&period=${month()}`);
    // The income-kind placement is not an expense: 50 + 20 + 10, not + 40.
    expect(BigInt(flow.summary.expensesMinor)).toBe(8000n);

    const history = await get<{ months: { month: string; amountMinor: string }[] }>(
      h,
      `/reports/category-history?categoryId=${coffee}`,
    );
    const current = history.months.at(-1);
    expect(current?.month).toBe(month());
    expect(BigInt(current?.amountMinor ?? '0')).toBe(5000n);

    const pace = await get<{ days: { day: number; cumulativeMinor: string }[] }>(
      h,
      `/reports/spending-pace?month=${month()}`,
    );
    expect(BigInt(pace.days.at(-1)?.cumulativeMinor ?? '0')).toBe(8000n);
  });

  it('the budget’s activity and the budget-vs-actual report count the placement', async () => {
    const current = await get<{ budgetId: string; period: { id: string } }>(h, '/budgets/current');
    const created = await h.request({
      method: 'POST',
      url: '/budgets/lines',
      session: h.stale,
      body: { periodId: current.period.id, categoryId: coffee, priority: 5 },
    });
    expectStatus(created, 201);
    const line = (created.json() as { line: { activity: { minor: string } } }).line;
    expect(line.activity.minor).toBe('-5000');

    const report = await get<{
      lines: { categoryId: string | null; activity: { minor: string } }[];
    }>(h, `/reports/budget-vs-actual?periodId=${current.period.id}`);
    const row = report.lines.find((entry) => entry.categoryId === coffee);
    expect(row?.activity.minor).toBe('-5000');
  });

  // ---------------------------------------------------------------- the ports

  it('the budgeting port, the insights snapshot’s category spend and the CSV export read it', async () => {
    const budgetPort = createBudgetingLedgerPort(h.database.db);
    const page = await budgetPort.listForBudget({
      userId: h.userId,
      dateFrom: DateOnly.parse(`${month()}-01`),
      dateTo: DateOnly.addDays(DateOnly.parse(today()), 1),
      limit: 100,
    });
    expect(page.items.find((item) => item.id === tAuto)?.categoryId).toBe(coffee);
    expect(page.items.find((item) => item.id === tNone)?.categoryId).toBeNull();

    const insights = createInsightsLedgerPort(h.database.db, systemClock);
    const spend = await insights.categorySpend({ userId: h.userId, months: 1 });
    const coffeeSpend = spend.find((entry) => entry.categoryId === coffee);
    expect(coffeeSpend?.total.minor).toBe(-5000n);

    const csv = await h.request({
      method: 'GET',
      url: '/transactions/export.csv',
      session: h.fresh,
    });
    expectStatus(csv, 200);
    const line = csv.body.split('\n').find((row) => row.includes('Blue Bottle Coffee'));
    expect(line).toContain(`"${coffee}"`);
  });

  // ---------------------------------------------------------------- the pass, end to end

  it('a synced row is placed by tier 4, explained from the stored chain, and “Looks right” supersedes and teaches', async () => {
    const [tProvider, tUnknown] = await post(h, accountId, [
      { minor: '-650', name: 'SQ *BLUE BOTTLE COFFEE' },
      { minor: '-300', name: 'ZZZ UNKNOWN LLC' },
    ]);
    if (tProvider === undefined || tUnknown === undefined) throw new Error('no ids');
    // The manual connector sends no provider category: put the one Plaid would send on the fact, as a fixture.
    await h.database.pool.query(
      `UPDATE transactions_provider SET provider_category = $1::jsonb
        WHERE id = (SELECT current_fact_id FROM transactions WHERE id = $2)`,
      [
        JSON.stringify({
          primary: 'FOOD_AND_DRINK',
          detailed: 'FOOD_AND_DRINK_COFFEE',
          confidence_level: 'HIGH',
        }),
        tProvider,
      ],
    );

    const logger = pino({ level: 'silent' });
    const runtime = createDomainRuntime({
      database: h.database.db,
      clock: systemClock,
      logger,
      registry: createConnectorRegistry(),
      secretBox: h.security.requireSecretBox(),
    });
    const egressPolicy = createEgressPolicy({ allowedHosts: [] });
    const modules = appModules({
      advisorsEnabled: true,
      localModelConfigured: false,
      database: h.database.db,
      userId: h.userId,
      orchestrator: runtime.orchestrator,
      timezone: 'UTC',
      clock: systemClock,
      notificationChannels: {
        ntfy: createNtfyChannel({ policy: egressPolicy }),
        smtp: createSmtpChannel({ policy: egressPolicy }),
      },
      secretBox: h.security.requireSecretBox(),
      investmentSyncPort: createInvestmentSyncPort(h.database.db),
    });
    const categorization = modules.find((module) => module.flagKey === 'module.categorization');
    const pump = createConsumerPump({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      clock: systemClock,
      logger,
      consumers: categorization?.consumers ?? [],
    });
    await pump.drain();

    const placed = await get<WireTransaction>(h, `/transactions/${tProvider}`);
    expect(placed).toMatchObject({ categorySource: 'auto', autoCategory: { tier: 'provider' } });
    const stored = await h.database.pool.query<{ confidence: string; id: string }>(
      `SELECT id, confidence::text FROM category_assignments WHERE transaction_id = $1 AND is_current`,
      [tProvider],
    );
    // The chip’s figure is the stored one, to the digit.
    expect(placed.autoCategory?.confidence).toBe(Number(stored.rows[0]?.confidence));

    // The explanation is read from storage: the stored chain, with the winning tier's figures.
    const explained = await get<{
      items: {
        transactionId: string;
        status: string;
        line: string;
        tiers: { source: string; won: boolean }[];
      }[];
    }>(h, `/transactions/explanations?ids=${tProvider},${tUnknown}`);
    const forProvider = explained.items.find((item) => item.transactionId === tProvider);
    expect(forProvider?.status).toBe('assigned');
    expect(forProvider?.tiers.find((tier) => tier.won)?.source).toBe('provider');
    expect(forProvider?.line).toMatch(/^Filed from your bank’s category/u);
    expect(explained.items.find((item) => item.transactionId === tUnknown)?.status).toBe(
      'abstained',
    );
    // …and the unplaced row stays uncategorised, with its "why".
    const unknown = await get<WireTransaction>(h, `/transactions/${tUnknown}`);
    expect(unknown).toMatchObject({ categoryId: null, categorySource: null });
    expect(
      (
        await get<{ items: WireTransaction[] }>(h, '/transactions?uncategorized=true&limit=50')
      ).items.map((i) => i.id),
    ).toContain(tUnknown);

    // "Looks right": the normal pick, with the category already there.
    const before = await get<{ items: WireTransaction[] }>(
      h,
      '/transactions?autoReview=true&limit=50',
    );
    expect(before.items.map((i) => i.id)).toContain(tProvider);
    const picked = await h.request({
      method: 'PATCH',
      url: `/transactions/${tProvider}`,
      session: h.stale,
      body: { categoryId: placed.categoryId },
    });
    expectStatus(picked, 200);
    expect(picked.json()).toMatchObject({ categorySource: 'user', autoCategory: null });
    const kept = await h.database.pool.query<{
      auto_category_id: string | null;
      superseded: boolean;
    }>(
      `SELECT auto_category_id, auto_superseded_at IS NOT NULL AS superseded FROM transactions WHERE id = $1`,
      [tProvider],
    );
    // The machine's answer stays as history.
    expect(kept.rows[0]).toEqual({ auto_category_id: placed.categoryId, superseded: true });
    const after = await get<{ items: WireTransaction[] }>(
      h,
      '/transactions?autoReview=true&limit=50',
    );
    expect(after.items.map((i) => i.id)).not.toContain(tProvider);

    // It teaches: the pick reaches the learning path through the same consumer.
    await pump.drain();
    const examples = await h.database.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM classifier_examples`,
    );
    expect(Number(examples.rows[0]?.n)).toBeGreaterThan(0);
    const confirmed = await h.database.pool.query<{ source: string; confirmed: boolean }>(
      `SELECT source, confirmed_at IS NOT NULL AS confirmed FROM category_assignments WHERE transaction_id = $1 AND is_current`,
      [tProvider],
    );
    expect(confirmed.rows[0]).toEqual({ source: 'user', confirmed: true });
  }, 120_000);

  // ---------------------------------------------------------------- the Inbox preference

  it('the Inbox preference defaults to shown, is saved per holder, and is read back', async () => {
    expect(await get(h, '/inbox/preferences')).toEqual({ showAutoReview: true });
    const off = await h.request({
      method: 'PUT',
      url: '/inbox/preferences',
      session: h.stale,
      body: { showAutoReview: false },
    });
    expectStatus(off, 200);
    expect(off.json()).toEqual({ showAutoReview: false });
    expect(await get(h, '/inbox/preferences')).toEqual({ showAutoReview: false });
    expectStatus(
      await h.request({
        method: 'PUT',
        url: '/inbox/preferences',
        session: h.stale,
        body: { showAutoReview: true },
      }),
      200,
    );
    const refused = await h.request({
      method: 'PUT',
      url: '/inbox/preferences',
      session: { accessToken: 'not-a-session', csrf: 'x'.repeat(40), fresh: false },
      body: { showAutoReview: false },
    });
    expect(refused.statusCode).toBe(401);
  });
});
