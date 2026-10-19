// SPDX-License-Identifier: MIT
/**
 * WP 10.15 (V8): Reports as blocks, figure for figure against the report routes, over a real database.
 *
 * The 24-month demo seed (`generateDemoData(1)`) is loaded into the harness's database; then for a 12-month window
 * `GET /reports/spending` and `GET /reports/blocks/spending` (and income) are compared cell by cell: every non-zero
 * cell is exactly one segment of its month's bar with the cell's magnitude, transaction count and drill-through,
 * every segment is a cell, and every bar's total is the sum of its own segments. Budget vs. actual is compared
 * line by line with lines this test assigns. A block never carries a figure its route does not.
 *
 * Project `api-db`; scratch database `personalfi_api_wp1015_report_blocks_<random>` (the harness's naming).
 */
import { systemClock } from '@core/kernel';
import { generateDemoData } from '@core/seed';
import { loadSeedDataset } from '@ctx/ledger';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transactionsHref } from '../../src/blocks/hrefs.ts';
import {
  createApiHarness,
  expectStatus,
  NO_DATABASE,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireMoney {
  readonly minor: string;
  readonly currency: string;
}
interface WireCell {
  readonly month: string;
  readonly categoryId: string | null;
  readonly amount: WireMoney;
  readonly transactionCount: number;
  readonly drillThrough: { categoryIds?: string[]; from: string; to: string };
}
interface Group {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly hue: string;
  readonly href?: string;
  readonly labelHref?: string;
  readonly count?: number;
}
interface Bar {
  readonly x: string;
  readonly total: string;
  readonly groups: readonly Group[];
}
interface BlockWire {
  readonly kind: string;
  readonly [key: string]: unknown;
}
interface Doc {
  readonly contractVersion: number;
  readonly blocks: readonly BlockWire[];
}

const WINDOW = 'from=2024-01-01&to=2026-12-31';

// perf-skip: NO_DATABASE — DATABASE_URL is unset, so there is no Postgres to load the 50k-row demo seed into (CI's migration-test job has one)
describe.skipIf(NO_DATABASE)('[slow] WP 10.15 report blocks equal the report routes', () => {
  let h: ApiHarness;

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp1015_report_blocks' });
    await loadSeedDataset(h.database.db, h.userId, generateDemoData(1), { clock: systemClock });
    // The demo seed arrives uncategorised, which would leave one bucket per month. Spread it over eight expense
    // and two income categories by a stable hash of the row id, so the comparison has many cells.
    const response = await h.request({ method: 'GET', url: '/categories', session: h.stale });
    expectStatus(response, 200);
    const { categories } = response.json() as {
      categories: { id: string; assignable: boolean; kind: string }[];
    };
    const expense = categories.filter((c) => c.assignable && c.kind === 'expense').slice(0, 8);
    const income = categories.filter((c) => c.assignable && c.kind === 'income').slice(0, 2);
    // fixture: transactions.user_category_id written by a direct UPDATE because the user overlay's only writer is PATCH /transactions/{id}, one row per request, and the seed is ~50k rows; the PATCH could write exactly these values (an assignable category per row), and the report routes read them back through the same effective-category rule.
    await h.database.db.execute(sql`
      UPDATE transactions
         SET user_category_id = CASE
               WHEN effective_amount_minor < 0 THEN (${sql.raw(`ARRAY[${expense.map((c) => `'${c.id}'`).join(',')}]`)}::uuid[])[1 + abs(hashtext(id::text)) % ${expense.length}]
               ELSE (${sql.raw(`ARRAY[${income.map((c) => `'${c.id}'`).join(',')}]`)}::uuid[])[1 + abs(hashtext(id::text)) % ${income.length}]
             END
       WHERE user_id = ${h.userId}::uuid AND abs(hashtext(id::text)) % 10 <> 0
    `);
  }, 240_000);

  afterAll(async () => {
    await h.close();
  });

  async function get<T>(url: string): Promise<T> {
    const response = await h.request({ method: 'GET', url, session: h.stale });
    expectStatus(response, 200);
    return response.json() as T;
  }

  it.each(['spending', 'income'] as const)(
    '%s: every non-zero cell is one segment with its own figure, count and drill-through',
    async (side) => {
      const { cells } = await get<{ cells: WireCell[] }>(`/reports/${side}?${WINDOW}`);
      const doc = await get<Doc>(`/reports/blocks/${side}?${WINDOW}`);
      expect(doc.contractVersion).toBe(1);
      const shown = cells.filter((cell) => cell.amount.minor !== '0');
      expect(shown.length, JSON.stringify(cells.slice(0, 3))).toBeGreaterThan(10);

      const segments = doc.blocks.flatMap((block) => {
        expect(block.kind).toBe('stacked-bars');
        const currency = block['currency'] as string;
        return (block['data'] as Bar[]).flatMap((bar) => {
          // The bar's total is its own segments' sum — never a figure of its own.
          expect(BigInt(bar.total)).toBe(bar.groups.reduce((sum, g) => sum + BigInt(g.value), 0n));
          return bar.groups.map((group) => ({ month: bar.x, currency, ...group }));
        });
      });
      expect(segments).toHaveLength(shown.length);
      for (const cell of shown) {
        const key = cell.categoryId ?? 'uncategorised';
        const matches = segments.filter(
          (segment) =>
            segment.month === cell.month &&
            segment.key === key &&
            segment.currency === cell.amount.currency,
        );
        expect(matches, `${cell.month} ${key}`).toHaveLength(1);
        const segment = matches[0];
        expect(segment?.value).toBe(cell.amount.minor.replace(/^-/u, ''));
        expect(segment?.count).toBe(cell.transactionCount);
        expect(segment?.href).toBe(transactionsHref(cell.drillThrough));
        if (cell.categoryId !== null) {
          expect(segment?.labelHref).toBe(`/categories/${cell.categoryId}?month=${cell.month}`);
        }
      }
    },
    60_000,
  );

  it('budget vs. actual: every line is one row with the route’s Assigned / Activity / Available', async () => {
    const current = await get<{ period: { id: string } }>('/budgets/current');
    const { categories } = await get<{
      categories: { id: string; assignable: boolean; kind: string }[];
    }>('/categories');
    const leaves = categories.filter((c) => c.assignable && c.kind === 'expense').slice(0, 3);
    for (const [index, category] of leaves.entries()) {
      const created = await h.request({
        method: 'POST',
        url: '/budgets/lines',
        session: h.stale,
        body: { periodId: current.period.id, categoryId: category.id, priority: 5 },
      });
      expectStatus(created, 201);
      const lineId = (created.json() as { line: { id: string } }).line.id;
      const assigned = await h.request({
        method: 'PATCH',
        url: `/budgets/lines/${lineId}`,
        session: h.stale,
        body: { assigned: { minor: String((index + 1) * 2500), currency: 'USD' } },
      });
      expectStatus(assigned, 200);
    }

    const route = await get<{
      lines: {
        id: string;
        categoryId: string | null;
        name: string | null;
        assigned: WireMoney;
        activity: WireMoney;
        available: WireMoney;
        cashOverspend: WireMoney;
        creditOverspend: WireMoney;
        drillThrough: { categoryIds?: string[]; from: string; to: string };
      }[];
    }>(`/reports/budget-vs-actual?periodId=${current.period.id}`);
    const doc = await get<Doc>(`/reports/blocks/budget-vs-actual?periodId=${current.period.id}`);
    expect(route.lines.length).toBeGreaterThanOrEqual(3);
    const table = doc.blocks[0];
    expect(table?.kind).toBe('table');
    const rows = table?.['rows'] as {
      key: string;
      cells: { value: unknown; href?: string; badges?: unknown[] }[];
    }[];
    expect(rows).toHaveLength(route.lines.length);
    for (const line of route.lines) {
      const row = rows.find((candidate) => candidate.key === line.id);
      expect(row, line.id).toBeDefined();
      const money = (m: WireMoney) => ({ amountMinor: m.minor, currency: m.currency });
      expect(row?.cells[1]?.value).toEqual(money(line.assigned));
      expect(row?.cells[2]?.value).toEqual(money(line.activity));
      expect(row?.cells[3]?.value).toEqual(money(line.available));
      const badges = (row?.cells[4]?.badges ?? []) as { label: string }[];
      expect(badges.some((b) => b.label === 'Cash')).toBe(line.cashOverspend.minor !== '0');
      expect(badges.some((b) => b.label === 'Credit')).toBe(line.creditOverspend.minor !== '0');
      expect(row?.cells[5]?.href).toBe(transactionsHref(line.drillThrough));
    }
  });

  it('the block routes need a session', async () => {
    const response = await h.request({ method: 'GET', url: `/reports/blocks/spending?${WINDOW}` });
    expect(response.statusCode).toBe(401);
  });
});
