// SPDX-License-Identifier: MIT
/**
 * A category's chart hue (WP 10.8, migration 0045), against a real Postgres.
 *
 * The claims:
 *
 * 1. **The CHECK and the vocabulary are the same list.** `categories_hue_check` admits exactly the kernel's
 *    `CHART_HUES` (or NULL), and refuses a name outside it at the database, whatever the TypeScript does.
 * 2. **Assigned on first read.** A seeded category's hue is NULL in the table; the first `listCategories`
 *    returns `hueForId(id)` and persists exactly that.
 * 3. **Stable.** A re-read returns the *stored* value, never a recomputation: a hue changed in the table
 *    (here directly, as a holder's earlier choice would be) is what every later read says.
 * 4. **Editable.** `renameCategory` sets a hue and refuses a name outside the vocabulary; `createCategory`
 *    seeds from the new id or takes the one asked for.
 */
import { CHART_HUES, hueForId, type ChartHue } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCategory, listCategories, renameCategory } from '../src/categories.ts';
import { seedSystemTaxonomy } from '../src/seed-taxonomy.ts';
import { NO_DATABASE, categorizationDatabase, testClock, type TestDatabase } from './harness.ts';

/** Any hue that is not `hue`, so a stored value can be told apart from the hash. */
function otherThan(hue: ChartHue): ChartHue {
  const other = CHART_HUES.find((candidate) => candidate !== hue);
  if (other === undefined) throw new Error('the vocabulary has one hue');
  return other;
}

describe.skipIf(NO_DATABASE)('category hue (WP 10.8)', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;

  beforeAll(async () => {
    database = await categorizationDatabase('wp108hue');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    await seedSystemTaxonomy(database.db, { userId: database.userId, clock });
  });

  async function storedHues(): Promise<Map<string, string | null>> {
    const rows = await database.db.execute<{ id: string; hue: string | null }>(sql`
      SELECT id, hue FROM categories WHERE user_id = ${database.userId}
    `);
    return new Map(rows.rows.map((row) => [row.id, row.hue]));
  }

  it('categories_hue_check names exactly the kernel CHART_HUES', async () => {
    const result = await database.db.execute<{ definition: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'categories_hue_check' AND conrelid = 'categories'::regclass
    `);
    const definition = result.rows[0]?.definition;
    expect(definition, 'the named CHECK exists').toBeDefined();
    const names = [...(definition ?? '').matchAll(/'([a-z]+)'::text/gu)].map((match) => match[1]);
    expect(names).toEqual([...CHART_HUES]);
  });

  it('the database refuses a hue outside the vocabulary', async () => {
    const [id] = [...(await storedHues()).keys()];
    let caught: unknown;
    try {
      await database.db.execute(sql`UPDATE categories SET hue = 'magenta' WHERE id = ${id}`);
    } catch (error) {
      caught = error;
    }
    expect(caught, 'the CHECK refused the write').toBeDefined();
    const cause = (caught as { cause?: { code?: string; constraint?: string } }).cause ?? caught;
    expect(cause).toMatchObject({ code: '23514', constraint: 'categories_hue_check' });
    // A vocabulary name is accepted, and NULL still is.
    await database.db.execute(sql`UPDATE categories SET hue = 'sky' WHERE id = ${id}`);
    await database.db.execute(sql`UPDATE categories SET hue = NULL WHERE id = ${id}`);
  });

  it('the first read assigns hueForId(id) and persists exactly that', async () => {
    const before = await storedHues();
    expect(before.size).toBeGreaterThan(100);
    expect(
      [...before.values()].every((hue) => hue === null),
      'seeding sets no hue',
    ).toBe(true);

    const listed = await listCategories(database.db, database.userId, { includeArchived: true });
    expect(listed).toHaveLength(before.size);
    for (const category of listed) {
      expect(category.hue, category.key).toBe(hueForId(category.id));
    }

    const after = await storedHues();
    for (const category of listed) {
      expect(after.get(category.id), `${category.key} persisted`).toBe(hueForId(category.id));
    }
  });

  it('a re-read returns the stored hue, never a recomputation', async () => {
    const first = await listCategories(database.db, database.userId);
    const target = first[0];
    if (target === undefined) throw new Error('no categories');
    const stored = otherThan(hueForId(target.id));
    await database.db.execute(sql`UPDATE categories SET hue = ${stored} WHERE id = ${target.id}`);

    const second = await listCategories(database.db, database.userId);
    expect(second.find((category) => category.id === target.id)?.hue).toBe(stored);
    // And reading did not write the hash back over it.
    expect((await storedHues()).get(target.id)).toBe(stored);
  });

  it('a stored hue is never overwritten by a first read of the others', async () => {
    const [chosen] = [...(await storedHues()).keys()];
    if (chosen === undefined) throw new Error('no categories');
    const stored = otherThan(hueForId(chosen));
    // Set before any read: only this row is non-NULL when the first read runs.
    await database.db.execute(sql`UPDATE categories SET hue = ${stored} WHERE id = ${chosen}`);

    const [a, b] = await Promise.all([
      listCategories(database.db, database.userId),
      listCategories(database.db, database.userId),
    ]);
    expect(a.find((category) => category.id === chosen)?.hue).toBe(stored);
    expect(a.map((category) => category.hue)).toEqual(b?.map((category) => category.hue));
    expect((await storedHues()).get(chosen)).toBe(stored);
  });

  it('renameCategory sets a hue, keeps it across reads, and refuses a name outside the vocabulary', async () => {
    const [target] = await listCategories(database.db, database.userId);
    if (target === undefined) throw new Error('no categories');
    const chosen = otherThan(target.hue);

    const updated = await renameCategory(
      database.db,
      { userId: database.userId, categoryId: target.id, hue: chosen },
      { clock },
    );
    expect(updated.hue).toBe(chosen);
    expect(updated.label, 'a hue-only edit leaves the label').toBe(target.label);
    const reread = await listCategories(database.db, database.userId);
    expect(reread.find((category) => category.id === target.id)?.hue).toBe(chosen);

    await expect(
      renameCategory(
        database.db,
        { userId: database.userId, categoryId: target.id, hue: 'magenta' as ChartHue },
        { clock },
      ),
    ).rejects.toMatchObject({ code: 'categorization.rule_invalid' });
    expect((await storedHues()).get(target.id)).toBe(chosen);

    // A label-only edit leaves the hue.
    const relabelled = await renameCategory(
      database.db,
      { userId: database.userId, categoryId: target.id, label: 'Recoloured' },
      { clock },
    );
    expect(relabelled.hue).toBe(chosen);
  });

  it('createCategory seeds the hue from the new id, or stores the one asked for', async () => {
    const seeded = await createCategory(
      database.db,
      { userId: database.userId, parentId: null, label: 'Hue Seeded', kind: 'expense' },
      { clock },
    );
    expect(seeded.hue).toBe(hueForId(seeded.id));
    expect((await storedHues()).get(seeded.id)).toBe(hueForId(seeded.id));

    const asked = otherThan(hueForId(seeded.id));
    const chosen = await createCategory(
      database.db,
      { userId: database.userId, parentId: seeded.id, label: 'Hue Chosen', hue: asked },
      { clock },
    );
    expect(chosen.hue).toBe(asked);
    expect((await storedHues()).get(chosen.id)).toBe(asked);

    await expect(
      createCategory(
        database.db,
        {
          userId: database.userId,
          parentId: null,
          label: 'Hue Refused',
          hue: 'magenta' as ChartHue,
        },
        { clock },
      ),
    ).rejects.toMatchObject({ code: 'categorization.rule_invalid' });
  });
});
