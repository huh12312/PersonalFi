// SPDX-License-Identifier: MIT
/**
 * WP 2.8 — reports aggregation, over a real database.
 *
 * Every number asserted here is computed independently of `apps/api/src/reports/**`:
 * the fixtures are built so the expected total is arithmetic anyone can check by
 * hand, not a re-run of the code under test.
 *
 * Project `api-db`; scratch database named `personalfi_api_wp_reports_<random>`
 * (the harness's own naming convention — see `test/helpers/api-harness.ts`).
 */
import { DateOnly, systemClock } from '@core/kernel';
import { detectRefundHints } from '@ctx/ledger';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { generateDemoData } from '@core/seed';
import { loadSeedDataset } from '@ctx/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeCategoryMonthActivity } from '../../src/reports/spending-income.ts';
import {
  createApiHarness,
  expectStatus,
  linkManual,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

const describeWithDb = describe.skipIf(NO_DATABASE);

interface WireMoney {
  readonly minor: string;
  readonly currency: string;
}
interface WireCell {
  readonly month: string;
  readonly categoryId: string | null;
  readonly amount: WireMoney;
  readonly transferExcludedCount: number;
  readonly refundNettedCount: number;
}
interface WireCategory {
  readonly id: string;
  readonly assignable: boolean;
}

async function firstAssignableCategoryId(h: ApiHarness): Promise<string> {
  const response = await h.request({ method: 'GET', url: '/categories', session: h.fresh });
  expectStatus(response, 200);
  const { categories } = response.json() as { categories: WireCategory[] };
  const leaf = categories.find((category) => category.assignable);
  if (leaf === undefined) throw new Error('no assignable category seeded');
  return leaf.id;
}

async function addManualTransaction(
  h: ApiHarness,
  accountId: string,
  input: {
    amountMinor: string;
    postedDate: string;
    name: string;
    merchantName?: string;
  },
): Promise<string> {
  const response = await h.request({
    method: 'POST',
    url: `/accounts/${accountId}/transactions`,
    session: h.fresh,
    body: {
      transactions: [
        {
          amount: { minor: input.amountMinor, currency: 'USD' },
          postedDate: input.postedDate,
          name: input.name,
          ...(input.merchantName === undefined ? {} : { merchantName: input.merchantName }),
        },
      ],
    },
  });
  expectStatus(response, 201);
  const body = response.json() as { addedTransactionIds: string[] };
  const id = body.addedTransactionIds[0];
  if (id === undefined) throw new Error('manual transaction was not added');
  return id;
}

describeWithDb('reports aggregation (WP 2.8)', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp_reports' });
  });

  afterAll(async () => {
    await h.close();
  });

  it('spending totals contain zero internal transfers', async () => {
    const checking = await linkManual(h, {
      providerConnectionId: 'txf-checking',
      displayName: 'Checking',
      accounts: [
        { providerAccountId: 'checking-1', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
    });
    const savings = await linkManual(h, {
      providerConnectionId: 'txf-savings',
      displayName: 'Savings',
      accounts: [
        { providerAccountId: 'savings-1', name: 'Savings', type: 'depository', currency: 'USD' },
      ],
    });
    const checkingId = checking.accountIds[0];
    const savingsId = savings.accountIds[0];
    if (checkingId === undefined || savingsId === undefined) throw new Error('accounts missing');

    const categoryId = await firstAssignableCategoryId(h);
    const groceryId = await addManualTransaction(h, checkingId, {
      amountMinor: '-4200',
      postedDate: '2025-03-05',
      name: 'Corner Grocery',
    });
    await h.request({
      method: 'PATCH',
      url: `/transactions/${groceryId}`,
      session: h.fresh,
      body: { categoryId },
    });

    const outflowId = await addManualTransaction(h, checkingId, {
      amountMinor: '-100000',
      postedDate: '2025-03-06',
      name: 'Transfer to Savings',
    });
    const inflowId = await addManualTransaction(h, savingsId, {
      amountMinor: '100000',
      postedDate: '2025-03-06',
      name: 'Transfer from Checking',
    });
    const pairResponse = await h.request({
      method: 'POST',
      url: '/transfers/pair',
      session: h.fresh,
      body: { outflowTransactionId: outflowId, inflowTransactionId: inflowId },
    });
    expectStatus(pairResponse, 200);

    const cells = await computeCategoryMonthActivity(h.database.db, {
      userId: h.userId,
      dateFrom: DateOnly.of(2025, 3, 1),
      dateTo: DateOnly.of(2025, 3, 31),
    });

    // The $1,000 transfer must not appear anywhere in the totals.
    const totalMinor = cells.reduce((sum, cell) => sum + BigInt(cell.amount.minor), 0n);
    expect(totalMinor).toBe(-4200n);

    const march = cells.filter((cell) => cell.month === '2025-03');
    const transferExcluded = march.reduce((sum, cell) => sum + cell.transferExcludedCount, 0);
    expect(transferExcluded).toBe(2); // both legs, counted
  });

  it('a refund nets against its original', async () => {
    const linked = await linkManual(h, {
      providerConnectionId: 'refund-checking',
      displayName: 'Refund Checking',
      accounts: [
        {
          providerAccountId: 'refund-1',
          name: 'Refund Checking',
          type: 'depository',
          currency: 'USD',
        },
      ],
    });
    const accountId = linked.accountIds[0];
    if (accountId === undefined) throw new Error('account missing');

    const categoryId = await firstAssignableCategoryId(h);
    const purchaseId = await addManualTransaction(h, accountId, {
      amountMinor: '-10000',
      postedDate: '2025-04-02',
      name: 'Blue Bottle Coffee',
      merchantName: 'Blue Bottle Coffee',
    });
    await h.request({
      method: 'PATCH',
      url: `/transactions/${purchaseId}`,
      session: h.fresh,
      body: { categoryId },
    });
    await addManualTransaction(h, accountId, {
      amountMinor: '4000',
      postedDate: '2025-04-10',
      name: 'Blue Bottle Coffee',
      merchantName: 'Blue Bottle Coffee',
    });

    // No HTTP route confirms a refund hint yet (Phase 2 gap); the heuristic
    // that would run after a sync is called directly, exactly as it would be
    // from a consumer.
    const hints = await detectRefundHints(
      h.database.db,
      { userId: h.userId },
      { clock: systemClock, correlationId: 'refund-test' },
    );
    expect(hints.length).toBeGreaterThan(0);

    // No `categoryIds` filter: the refund itself carries no `userCategoryId`
    // (only the purchase was categorised), and `computeCategoryMonthActivity`'s
    // filter is against that raw overlay column — filtering by `categoryId`
    // here would exclude the refund row before it ever had a chance to net.
    const cells = await computeCategoryMonthActivity(h.database.db, {
      userId: h.userId,
      dateFrom: DateOnly.of(2025, 4, 1),
      dateTo: DateOnly.of(2025, 4, 30),
    });
    const cell = cells.find((c) => c.categoryId === categoryId && c.month === '2025-04');
    if (cell === undefined) throw new Error('no cell for the refunded category');
    // -$100 purchase, +$40 refund: $60 of activity remains, not $100 and not $0.
    expect(cell.amount.minor).toBe(-6000n);
    expect(cell.refundNettedCount).toBe(1);
  });

  it('drill-through params reproduce the same filtered list', async () => {
    const response = await h.request({
      method: 'GET',
      url: '/reports/spending?from=2025-03-01&to=2025-03-31',
      session: h.fresh,
    });
    expectStatus(response, 200);
    const { cells } = response.json() as { cells: WireCell[] };
    for (const cell of cells) {
      const params = new URLSearchParams({ from: '2025-03-01', to: '2025-03-31' });
      if (cell.categoryId !== null) params.set('categoryIds', cell.categoryId);
      const listResponse = await h.request({
        method: 'GET',
        url: `/transactions?${params.toString()}`,
        session: h.fresh,
      });
      expectStatus(listResponse, 200);
      const { summary } = listResponse.json() as {
        summary: { totals: WireMoney[] } | null;
      };
      const total = summary?.totals.find((t) => t.currency === cell.amount.currency);
      // Transfers are excluded from both the report cell and the plain list
      // total (`sumTransactions` also excludes transfers), but the list total
      // is not refund-netted the way `computeActuals` is — so this only holds
      // exactly for a category with no refund in it. March's grocery cell has
      // none, which is what makes this comparison meaningful rather than
      // vacuous.
      if (cell.categoryId !== null && total !== undefined) {
        expect(BigInt(total.minor)).toBe(BigInt(cell.amount.minor));
      }
    }
  });
});

describe.skipIf(NO_DATABASE)('reports aggregation performance (50k seed)', () => {
  let database: TestDatabase;
  const userId = () => database.userId;

  beforeAll(async () => {
    database = await createTestDatabase(`personalfi_wp_reports_perf_${Date.now()}`);
    const dataset = generateDemoData(1); // 24 months, ~50k rows (Phase 1's budget)
    await loadSeedDataset(database.db, database.userId, dataset, { clock: systemClock });
  }, 180_000);

  afterAll(async () => {
    await database.drop();
  });

  it('report p95 < 200 ms on the 50k seed', async () => {
    const window = { dateFrom: DateOnly.of(2024, 10, 1), dateTo: DateOnly.of(2026, 9, 30) };
    // Two warm-up calls (connection setup, query planning) excluded from the sample.
    for (let i = 0; i < 2; i += 1) {
      await computeCategoryMonthActivity(database.db, { userId: userId(), ...window });
    }
    const samples: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      const start = performance.now();
      await computeCategoryMonthActivity(database.db, { userId: userId(), ...window });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? samples[samples.length - 1];
    expect(p95).toBeLessThan(200);
  });
});
