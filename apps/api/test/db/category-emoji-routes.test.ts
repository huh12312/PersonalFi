// SPDX-License-Identifier: MIT
/**
 * A category's emoji over the wire (WP 10.14, migration 0050).
 *
 * 1. **`GET /categories` carries `emoji`**, `null` for every category until the holder sets one, and reading never
 *    writes the shipped default (`CATEGORY_DEFAULT_EMOJI`) into the table — the web draws it for a null.
 * 2. **`PATCH /categories/{id}` takes exactly one emoji** — a plain pictograph, one with VS16, a ZWJ sequence with a
 *    skin tone, a skin-toned hand, a ZWJ family — and refuses two, letters, a digit and the empty string with 400;
 *    `null` clears it, and a label-only PATCH leaves it. `categories_emoji_check` refuses nine code points at the
 *    database.
 * 3. **`POST /categories` takes it**, and omitting it stores none.
 * 4. **Export and import round-trip it** (the registry reads columns from information_schema: no code change), and a
 *    pre-0050 archive (no `emoji` key) imports with it NULL.
 */
import { newId } from '@core/kernel';
import { createTestDatabase, type TestDatabase } from '@core/testkit';
import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
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
  type ApiHarness,
} from '../helpers/api-harness.ts';

interface WireCategory {
  readonly id: string;
  readonly key: string;
  readonly label: string;
  readonly kind: string;
  readonly icon: string;
  readonly emoji: string | null;
}

/** Each is one emoji: plain, with VS16, ZWJ + skin tone, a skin-toned hand, a ZWJ family of four. */
const ACCEPTED = ['🛒', '🍽️', '👩🏽‍💻', '👍🏽', '👨‍👩‍👧‍👦'] as const;
/** Letters, two emoji, a digit, empty. */
const REFUSED = ['ab', '🛒🛒', '1', ''] as const;

describe.skipIf(NO_DATABASE)('category emoji over the wire (WP 10.14)', () => {
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

  async function storedEmoji(pool: Pool = h.database.pool): Promise<Map<string, string | null>> {
    const rows = await pool.query<{ id: string; emoji: string | null }>(
      'SELECT id, emoji FROM categories',
    );
    return new Map(rows.rows.map((row) => [row.id, row.emoji]));
  }

  async function patch(id: string, body: object) {
    return h.request({ method: 'PATCH', url: `/categories/${id}`, session: h.stale, body });
  }

  beforeAll(async () => {
    h = await createApiHarness({ suite: 'wp1014emoji' });
  }, 120_000);

  afterAll(async () => {
    await h.close();
  }, 60_000);

  it('GET /categories carries emoji, null until the holder sets one, and never writes the default', async () => {
    const categories = await list();
    expect(categories.length).toBeGreaterThan(100);
    for (const category of categories) {
      expect(category.emoji, category.key).toBeNull();
      expect(typeof category.icon, 'the Lucide icon is untouched').toBe('string');
    }
    await list();
    const stored = await storedEmoji();
    expect(stored.size).toBe(categories.length);
    expect(
      [...stored.values()].every((emoji) => emoji === null),
      'two reads later, the table still holds no emoji',
    ).toBe(true);
  });

  it('PATCH accepts exactly one emoji, including ZWJ sequences and skin tones', async () => {
    const [target] = await list();
    if (target === undefined) throw new Error('no categories');
    for (const emoji of ACCEPTED) {
      const response = await patch(target.id, { emoji });
      expectStatus(response, 200);
      const category = (response.json() as { category: WireCategory }).category;
      expect(category.emoji, emoji).toBe(emoji);
      expect(category.label, 'an emoji-only PATCH leaves the label').toBe(target.label);
      expect(category.icon, 'and the Lucide icon').toBe(target.icon);
      expect((await storedEmoji()).get(target.id)).toBe(emoji);
    }
  });

  it('PATCH refuses anything but one emoji with 400 and writes nothing', async () => {
    const [, target] = await list();
    if (target === undefined) throw new Error('no categories');
    expectStatus(await patch(target.id, { emoji: '🛒' }), 200);
    for (const emoji of REFUSED) {
      const response = await patch(target.id, { emoji });
      expect(response.statusCode, JSON.stringify(emoji)).toBe(400);
      expect(response.body, JSON.stringify(emoji)).toContain('emoji must be exactly one emoji');
    }
    expect((await storedEmoji()).get(target.id), 'every refused PATCH wrote nothing').toBe('🛒');
  });

  it('PATCH clears with null, and a label-only PATCH keeps the emoji', async () => {
    const [, , target] = await list();
    if (target === undefined) throw new Error('no categories');
    expectStatus(await patch(target.id, { emoji: '🍽️' }), 200);

    const relabel = await patch(target.id, { label: `${target.label} (renamed)` });
    expectStatus(relabel, 200);
    expect(
      (relabel.json() as { category: WireCategory }).category.emoji,
      'a PATCH that does not name emoji leaves it',
    ).toBe('🍽️');

    const cleared = await patch(target.id, { emoji: null });
    expectStatus(cleared, 200);
    expect((cleared.json() as { category: WireCategory }).category.emoji).toBeNull();
    expect((await storedEmoji()).get(target.id)).toBeNull();
  });

  it('the database refuses a nine-code-point emoji (categories_emoji_check)', async () => {
    const [, , , target] = await list();
    if (target === undefined) throw new Error('no categories');
    const nine = '👨‍👩‍👧‍👦\u{1F3FD}\u{1F3FD}';
    expect([...nine]).toHaveLength(9);
    await expect(
      h.database.db.execute(sql`UPDATE categories SET emoji = ${nine} WHERE id = ${target.id}`),
    ).rejects.toSatisfy((error: unknown) => {
      const cause = (error as { cause?: { code?: string; constraint?: string } }).cause;
      return cause?.code === '23514' && cause.constraint === 'categories_emoji_check';
    });
  });

  it('POST /categories takes an optional emoji and refuses two', async () => {
    const created = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Emoji Chosen', kind: 'expense', emoji: '🛒' },
    });
    expectStatus(created, 201);
    const chosen = (created.json() as { category: WireCategory }).category;
    expect(chosen.emoji).toBe('🛒');
    expect((await storedEmoji()).get(chosen.id)).toBe('🛒');

    const plain = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Emoji Omitted', kind: 'expense' },
    });
    expectStatus(plain, 201);
    const omitted = (plain.json() as { category: WireCategory }).category;
    expect(omitted.emoji).toBeNull();
    expect((await storedEmoji()).get(omitted.id)).toBeNull();

    const refused = await h.request({
      method: 'POST',
      url: '/categories',
      session: h.stale,
      body: { parentId: null, label: 'Emoji Refused', kind: 'expense', emoji: '🛒🛒' },
    });
    expect(refused.statusCode).toBe(400);
  });

  it('export and import round-trip emoji; a pre-0050 archive imports with it NULL', async () => {
    const categories = await list();
    for (const [index, emoji] of ACCEPTED.entries()) {
      const target = categories[index + 10];
      if (target === undefined) throw new Error('not enough categories');
      expectStatus(await patch(target.id, { emoji }), 200);
    }
    const source = await storedEmoji();
    expect([...source.values()].filter((emoji) => emoji !== null).length).toBeGreaterThanOrEqual(
      ACCEPTED.length,
    );

    const bundle = await buildExportBundle(h.database.pool, {
      userId: h.userId,
      appVersion: 'test',
      now: new Date('2026-10-18T00:00:00Z'),
    });
    const parsed = parseAndVerifyBundle(serialiseBundle(bundle));
    for (const row of parsed.rowsByTable.get('categories') ?? []) {
      expect(row, 'the export carries emoji').toHaveProperty('emoji');
    }

    const clean: TestDatabase = await createTestDatabase(
      `wp1014_export_${newId().replaceAll('-', '')}`,
    );
    try {
      await importBundle(clean.pool, parsed, clean.userId);
      expect(await storedEmoji(clean.pool), 'the id → emoji map round-trips').toEqual(source);
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
                Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'emoji')),
              )
            : rows,
        ]),
      ),
    };
    const old: TestDatabase = await createTestDatabase(
      `wp1014_export_old_${newId().replaceAll('-', '')}`,
    );
    try {
      await importBundle(old.pool, legacy, old.userId);
      const restored = await storedEmoji(old.pool);
      expect(restored.size).toBe(source.size);
      expect(
        [...restored.values()].every((emoji) => emoji === null),
        'none in, none out',
      ).toBe(true);
    } finally {
      await old.drop();
    }
  });
});
