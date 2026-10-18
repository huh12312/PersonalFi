// SPDX-License-Identifier: MIT
/**
 * A category's chart hue over the wire (WP 10.8, migration 0045).
 *
 * The claims:
 *
 * 1. **`GET /categories` carries `hue`**, and the first read persists `hueForId(id)` — the value the web
 *    computes for a category it has not seen a stored hue for.
 * 2. **Stable.** A later read returns the stored value even when it is not the hash.
 * 3. **`PATCH` sets it and refuses a name outside the vocabulary** (400, zod), and the database's own
 *    `categories_hue_check` refuses one that got past the route.
 * 4. **Export and import round-trip it**, and a pre-0045 archive (no `hue` key) still imports: the hue stays
 *    NULL until the next read seeds it.
 */
import { CHART_HUES, hueForId, newId, type ChartHue } from '@core/kernel';
import { listCategories } from '@ctx/categorization';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
  problemOf,
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireCategory {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly hue: ChartHue;
}

function otherThan(hue: ChartHue): ChartHue {
  const other = CHART_HUES.find((candidate) => candidate !== hue);
  if (other === undefined) throw new Error('the vocabulary has one hue');
  return other;
}

describe.skipIf(NO_DATABASE)('category hue over the wire (WP 10.8)', () => {
  let h: ApiHarness;

  async function list(): Promise<WireCategory[]> {
    const response = await h.request({
      method: 'GET',
      url: '/categories?includeArchived=true',
      session: h.stale,
    });
    expectStatus(response, 200);
    return (response.json() as { categories: WireCategory[] }).categories;
  }

  async function storedHues(pool = h.database.pool): Promise<Map<string, string | null>> {
    const rows = await pool.query<{ id: string; hue: string | null }>(
      'SELECT id, hue FROM categories',
    );
    return new Map(rows.rows.map((row) => [row.id, row.hue]));
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp108hue' });
  }, 300_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('GET /categories carries hue, and the first read persists hueForId(id)', async () => {
    const before = await storedHues();
    expect(before.size).toBeGreaterThan(100);
    expect(
      [...before.values()].every((hue) => hue === null),
      'nothing assigned yet',
    ).toBe(true);

    const categories = await list();
    expect(categories).toHaveLength(before.size);
    for (const category of categories) {
      expect(CHART_HUES).toContain(category.hue);
      expect(category.hue, category.key).toBe(hueForId(category.id));
    }
    const after = await storedHues();
    for (const category of categories) {
      expect(after.get(category.id), `${category.key} persisted`).toBe(hueForId(category.id));
    }
  });

  it('a re-read returns the stored hue even when it is not the hash', async () => {
    const [target] = await list();
    if (target === undefined) throw new Error('no categories');
    const stored = otherThan(hueForId(target.id));
    await h.database.pool.query('UPDATE categories SET hue = $1 WHERE id = $2', [
      stored,
      target.id,
    ]);
    const reread = await list();
    expect(reread.find((category) => category.id === target.id)?.hue).toBe(stored);
    expect((await storedHues()).get(target.id)).toBe(stored);
  });

  it('PATCH sets hue, refuses a name outside the vocabulary, and the CHECK refuses one at the database', async () => {
    const [, target] = await list();
    if (target === undefined) throw new Error('no categories');
    const chosen = otherThan(target.hue);

    const patched = await h.request({
      method: 'PATCH',
      url: `/categories/${target.id}`,
      session: h.stale,
      body: { hue: chosen },
    });
    expectStatus(patched, 200);
    const category = (patched.json() as { category: WireCategory }).category;
    expect(category.hue).toBe(chosen);
    expect(category.label, 'a hue-only PATCH leaves the label').toBe(target.label);
    expect((await list()).find((entry) => entry.id === target.id)?.hue).toBe(chosen);

    const refused = await h.request({
      method: 'PATCH',
      url: `/categories/${target.id}`,
      session: h.stale,
      body: { hue: 'magenta' },
    });
    expect(refused.statusCode).toBe(400);
    expect((await storedHues()).get(target.id), 'the refused PATCH wrote nothing').toBe(chosen);

    const empty = await h.request({
      method: 'PATCH',
      url: `/categories/${target.id}`,
      session: h.stale,
      body: {},
    });
    expect(empty.statusCode).toBe(400);

    await expect(
      h.database.db.execute(sql`UPDATE categories SET hue = 'magenta' WHERE id = ${target.id}`),
    ).rejects.toSatisfy((error: unknown) => {
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      return cause?.code === '23514' && cause.constraint === 'categories_hue_check';
    });
  });

  it('POST /categories takes an optional hue, and seeds from the id without one', async () => {
    const seeded = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Hue From Id', kind: 'expense' },
    });
    expectStatus(seeded, 201);
    const seededCategory = (seeded.json() as { category: WireCategory }).category;
    expect(seededCategory.hue).toBe(hueForId(seededCategory.id));

    const chosen = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: seededCategory.id, label: 'Hue Chosen', hue: 'brown' },
    });
    expectStatus(chosen, 201);
    expect((chosen.json() as { category: WireCategory }).category.hue).toBe('brown');

    const refused = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Hue Refused', hue: 'magenta' },
    });
    expect(refused.statusCode).toBe(400);
    expect(problemOf(refused)['status']).toBe(400);
  });

  it('export and import round-trip categories.hue; a pre-0045 archive imports with hue NULL, seeded on next read', async () => {
    await list();
    const source = await storedHues();
    expect(
      [...source.values()].every((hue) => hue !== null),
      'every hue assigned',
    ).toBe(true);
    const nonHash = [...source].filter(([id, hue]) => hue !== hueForId(id));
    expect(nonHash.length, 'some hues are holder choices, not the hash').toBeGreaterThan(0);

    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2026-10-18T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));
    for (const row of parsed.rowsByTable.get('categories') ?? []) {
      expect(row, 'the export carries hue').toHaveProperty('hue');
    }

    const clean: TestDatabase = await createTestDatabase(
      `wp108_export_${newId().replaceAll('-', '')}`,
    );
    try {
      await importBundle(clean.pool, parsed, clean.userId);
      expect(await storedHues(clean.pool)).toEqual(source);
    } finally {
      await clean.drop();
    }

    // A pre-0045 archive: the same bundle with no `hue` key on any category row.
    const legacy: ParsedBundle = {
      manifest: parsed.manifest,
      rowsByTable: new Map(
        [...parsed.rowsByTable].map(([table, rows]) => [
          table,
          table === 'categories'
            ? rows.map((row) =>
                Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'hue')),
              )
            : rows,
        ]),
      ),
    };
    const old: TestDatabase = await createTestDatabase(
      `wp108_export_old_${newId().replaceAll('-', '')}`,
    );
    try {
      await importBundle(old.pool, legacy, old.userId);
      const restored = await storedHues(old.pool);
      expect(restored.size).toBe(source.size);
      expect(
        [...restored.values()].every((hue) => hue === null),
        'no hue in, none out',
      ).toBe(true);
      const read = await listCategories(old.db, old.userId, { includeArchived: true });
      for (const category of read) expect(category.hue).toBe(hueForId(category.id));
    } finally {
      await old.drop();
    }
  });
});
