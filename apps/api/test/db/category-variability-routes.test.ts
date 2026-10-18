// SPDX-License-Identifier: MIT
/**
 * A category's variability over the wire (WP 10.11, migration 0047).
 *
 * 1. **`GET /categories` carries `variability`**, `null` for every category until the holder classifies one — no
 *    default, no backfill.
 * 2. **`PATCH /categories/{id}` sets it, clears it with `null`, and refuses a value outside the vocabulary**;
 *    `categories_variability_check` refuses one that got past the route, and its value list is
 *    `CATEGORY_VARIABILITIES` exactly.
 * 3. **`POST /categories` takes it.**
 * 4. **Export and import round-trip it**, and a pre-0047 archive (no `variability` key) still imports, NULL.
 * 5. **The recurring-stream suggestion**: an unclassified expense category into which an active outflow stream's
 *    merchant spends is suggested `fixed`, and the suggestion writes nothing; once classified it is never
 *    suggested again.
 */
import { manualTransaction } from '@connector/manual';
import { DateOnly, money, newId, systemClock } from '@core/kernel';
import { createConsumerPump, platformExecutor } from '@core/platform';
import { CATEGORY_VARIABILITIES } from '@ctx/categorization';
import { createRecurringConsumer } from '@ctx/recurring';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecurringLedgerPort } from '../../src/domain.ts';
import {
  buildExportBundle,
  parseAndVerifyBundle,
  serialiseBundle,
  type ParsedBundle,
} from '../../src/reports/export/bundle.ts';
import { importBundle } from '../../src/reports/export/import.ts';
import {
  NO_DATABASE,
  createApiHarness,
  expectStatus,
  linkManual,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireCategory {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly assignable: boolean;
  readonly variability: string | null;
}

interface WireSuggestion {
  readonly categoryId: string;
  readonly variability: string;
  readonly seriesIds: readonly string[];
}

describe.skipIf(NO_DATABASE)('category variability over the wire (WP 10.11)', () => {
  let h: ApiHarness;

  async function list(): Promise<WireCategory[]> {
    const response = await h.request({ method: 'GET', url: '/categories', session: h.stale });
    expectStatus(response, 200);
    return (response.json() as { categories: WireCategory[] }).categories;
  }

  async function storedVariability(
    pool: Pool = h.database.pool,
  ): Promise<Map<string, string | null>> {
    const rows = await pool.query<{ id: string; variability: string | null }>(
      'SELECT id, variability FROM categories',
    );
    return new Map(rows.rows.map((row) => [row.id, row.variability]));
  }

  async function patch(id: string, body: object) {
    return h.request({ method: 'PATCH', url: `/categories/${id}`, session: h.stale, body });
  }

  async function suggestions(): Promise<WireSuggestion[]> {
    const response = await h.request({
      method: 'GET',
      url: '/categories/variability-suggestions',
      session: h.stale,
    });
    expectStatus(response, 200);
    return (response.json() as { suggestions: WireSuggestion[] }).suggestions;
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp1011var' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('GET /categories carries variability, null until the holder classifies', async () => {
    const categories = await list();
    expect(categories.length).toBeGreaterThan(0);
    for (const category of categories) expect(category.variability, category.key).toBeNull();
    expect([...(await storedVariability()).values()].every((v) => v === null)).toBe(true);
  });

  it('the CHECK lists exactly CATEGORY_VARIABILITIES', async () => {
    const result = await h.database.pool.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'categories_variability_check'`,
    );
    const def = result.rows[0]?.def ?? '';
    const values = [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect(values.sort()).toEqual([...CATEGORY_VARIABILITIES].sort());
  });

  it('PATCH sets, clears with null, refuses outside the vocabulary; the CHECK refuses at the database', async () => {
    const [target] = (await list()).filter((c) => c.kind === 'expense');
    if (target === undefined) throw new Error('no expense categories');

    const set = await patch(target.id, { variability: 'non_monthly' });
    expectStatus(set, 200);
    const category = (set.json() as { category: WireCategory }).category;
    expect(category.variability).toBe('non_monthly');
    expect(category.label, 'a variability-only PATCH leaves the label').toBe(target.label);
    expect((await storedVariability()).get(target.id)).toBe('non_monthly');

    const relabel = await patch(target.id, { label: `${target.label} (renamed)` });
    expectStatus(relabel, 200);
    expect(
      (relabel.json() as { category: WireCategory }).category.variability,
      'a PATCH that does not name variability leaves it',
    ).toBe('non_monthly');

    const refused = await patch(target.id, { variability: 'monthly' });
    expect(refused.statusCode).toBe(400);
    expect((await storedVariability()).get(target.id), 'the refused PATCH wrote nothing').toBe(
      'non_monthly',
    );

    const cleared = await patch(target.id, { variability: null });
    expectStatus(cleared, 200);
    expect((cleared.json() as { category: WireCategory }).category.variability).toBeNull();
    expect((await storedVariability()).get(target.id)).toBeNull();

    await expect(
      h.database.db.execute(
        sql`UPDATE categories SET variability = 'weekly' WHERE id = ${target.id}`,
      ),
    ).rejects.toSatisfy((error: unknown) => {
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      return cause?.code === '23514' && cause.constraint === 'categories_variability_check';
    });
  });

  it('POST /categories takes an optional variability', async () => {
    const created = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Variability Chosen', kind: 'expense', variability: 'fixed' },
    });
    expectStatus(created, 201);
    expect((created.json() as { category: WireCategory }).category.variability).toBe('fixed');
    const plain = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Variability Omitted', kind: 'expense' },
    });
    expectStatus(plain, 201);
    expect((plain.json() as { category: WireCategory }).category.variability).toBeNull();
  });

  it('export and import round-trip variability; a pre-0047 archive imports with it NULL', async () => {
    const expense = (await list()).filter((c) => c.kind === 'expense');
    for (const [index, value] of ['fixed', 'flexible', 'non_monthly'].entries()) {
      const target = expense[index + 1];
      if (target === undefined) throw new Error('not enough categories');
      expectStatus(await patch(target.id, { variability: value }), 200);
    }
    const source = await storedVariability();
    expect(new Set([...source.values()].filter((v) => v !== null))).toEqual(
      new Set(['fixed', 'flexible', 'non_monthly']),
    );

    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2026-10-18T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));
    for (const row of parsed.rowsByTable.get('categories') ?? []) {
      expect(row, 'the export carries variability').toHaveProperty('variability');
    }

    const clean: TestDatabase = await createTestDatabase(
      `wp1011_export_${newId().replaceAll('-', '')}`,
    );
    try {
      await importBundle(clean.pool, parsed, clean.userId);
      expect(await storedVariability(clean.pool)).toEqual(source);
    } finally {
      await clean.drop();
    }

    const legacy: ParsedBundle = {
      manifest: parsed.manifest,
      rowsByTable: new Map(
        [...parsed.rowsByTable].map(([table, rows]) => [
          table,
          table === 'categories'
            ? rows.map((row) =>
                Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'variability')),
              )
            : rows,
        ]),
      ),
    };
    const old: TestDatabase = await createTestDatabase(
      `wp1011_export_old_${newId().replaceAll('-', '')}`,
    );
    try {
      await importBundle(old.pool, legacy, old.userId);
      const restored = await storedVariability(old.pool);
      expect(restored.size).toBe(source.size);
      expect(
        [...restored.values()].every((v) => v === null),
        'none in, none out',
      ).toBe(true);
    } finally {
      await old.drop();
    }
  });

  it('suggests fixed for the category an active outflow stream spends into, writes nothing, and stops once classified', async () => {
    expect(await suggestions(), 'no streams, no suggestions').toEqual([]);

    const today = DateOnly.parse(systemClock.now().toISOString().slice(0, 10));
    const dates = [3, 2, 1, 0].map((monthsAgo) => DateOnly.addMonths(today, -monthsAgo));
    await linkManual(h, {
      providerConnectionId: 'wp1011-conn',
      displayName: 'Variability Test Bank',
      accounts: [
        { providerAccountId: 'checking', name: 'Checking', type: 'depository', currency: 'USD' },
      ],
      batch: {
        added: dates.map((date, index) =>
          manualTransaction({
            providerAccountId: 'checking',
            providerTransactionId: `wp1011-stream-${String(index)}`,
            amount: money(-1_599n, 'USD'),
            postedDate: date,
            name: 'NETFLIX.COM',
            merchantName: 'Netflix',
          }),
        ),
      },
    });
    const pump = createConsumerPump({
      pool: h.database.pool,
      db: platformExecutor(h.database.db),
      clock: systemClock,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      consumers: [
        createRecurringConsumer({
          database: h.database.db,
          port: createRecurringLedgerPort(h.database.db),
          options: { timeZone: 'UTC' },
        }),
      ],
    });
    await pump.drain();

    // Four monthly charges at one amount: the detector establishes the stream ACTIVE on its own.
    const listed = await h.request({ method: 'GET', url: '/recurring/series', session: h.stale });
    expectStatus(listed, 200);
    const stream = (
      listed.json() as { series: { id: string; state: string; status: string; sign: string }[] }
    ).series.find((s) => s.state === 'ACTIVE' && s.sign === 'OUTFLOW');
    if (stream === undefined) throw new Error(`no active stream: ${listed.body}`);
    const seriesId = stream.id;

    // File every Netflix charge under one unclassified expense leaf, so the stream's category is that leaf.
    const leaf = (await list()).find(
      (c) => c.kind === 'expense' && c.assignable && c.variability === null,
    );
    if (leaf === undefined) throw new Error('no unclassified expense leaf');
    const txns = await h.request({ method: 'GET', url: '/transactions', session: h.stale });
    expectStatus(txns, 200);
    const netflix = (txns.json() as { items: { id: string; name: string }[] }).items.filter((t) =>
      t.name.toUpperCase().includes('NETFLIX'),
    );
    expect(netflix.length).toBe(4);
    for (const t of netflix) {
      expectStatus(
        await h.request({
          method: 'PATCH',
          url: `/transactions/${t.id}`,
          session: h.fresh,
          body: { categoryId: leaf.id },
        }),
        200,
      );
    }

    const before = await storedVariability();
    const suggested = await suggestions();
    expect(suggested).toEqual([
      { categoryId: leaf.id, variability: 'fixed', seriesIds: [seriesId] },
    ]);
    expect(await storedVariability(), 'a suggestion is never written').toEqual(before);
    expect((await list()).find((c) => c.id === leaf.id)?.variability).toBeNull();

    expectStatus(await patch(leaf.id, { variability: 'flexible' }), 200);
    expect(await suggestions(), 'a classified category is never suggested').toEqual([]);
  });
});
