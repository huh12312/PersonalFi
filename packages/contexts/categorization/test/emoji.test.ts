// SPDX-License-Identifier: MIT
/**
 * A category's emoji (WP 10.14, migration 0050), against a real Postgres.
 *
 * The claims:
 *
 * 1. **The CHECK exists and bounds the length**: `categories_emoji_check` refuses a nine-code-point value at the
 *    database (one grapheme may be up to `MAX_EMOJI_CODE_POINTS` = 8 code points; "exactly one emoji" is the
 *    application's rule, because SQL cannot segment graphemes).
 * 2. **The fallback is never written.** A seeded category's emoji is NULL, a read returns `null`, and the table is
 *    still NULL after it — unlike the hue, which a first read seeds.
 * 3. **Writes go through `isSingleEmoji`.** `createCategory` and `renameCategory` store one emoji, `null` clears,
 *    omission leaves it, and anything else is `categorization.rule_invalid` (400) with nothing written.
 */
import { MAX_EMOJI_CODE_POINTS } from '@core/kernel';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCategory, listCategories, renameCategory } from '../src/categories.ts';
import { seedSystemTaxonomy } from '../src/seed-taxonomy.ts';
import { NO_DATABASE, categorizationDatabase, testClock, type TestDatabase } from './harness.ts';

describe.skipIf(NO_DATABASE)('category emoji (WP 10.14)', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;

  beforeAll(async () => {
    database = await categorizationDatabase('wp1014emoji');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
    await seedSystemTaxonomy(database.db, { userId: database.userId, clock });
  });

  async function storedEmoji(): Promise<Map<string, string | null>> {
    const rows = await database.db.execute<{ id: string; emoji: string | null }>(sql`
      SELECT id, emoji FROM categories WHERE user_id = ${database.userId}
    `);
    return new Map(rows.rows.map((row) => [row.id, row.emoji]));
  }

  it('categories_emoji_check exists and refuses a nine-code-point value', async () => {
    const result = await database.db.execute<{ definition: string }>(sql`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'categories_emoji_check' AND conrelid = 'categories'::regclass
    `);
    const definition = result.rows[0]?.definition;
    expect(definition, 'the named CHECK exists').toBeDefined();
    expect(definition).toContain('char_length(emoji)');
    expect(definition).toContain(String(MAX_EMOJI_CODE_POINTS));

    const [id] = [...(await storedEmoji()).keys()];
    // Eight code points (a ZWJ family is seven) fit; nine do not.
    const eight = '👨‍👩‍👧‍👦\u{1F3FD}';
    expect([...eight]).toHaveLength(8);
    await database.db.execute(sql`UPDATE categories SET emoji = ${eight} WHERE id = ${id}`);
    const nine = `${eight}\u{1F3FD}`;
    expect([...nine]).toHaveLength(9);
    let caught: unknown;
    try {
      await database.db.execute(sql`UPDATE categories SET emoji = ${nine} WHERE id = ${id}`);
    } catch (error) {
      caught = error;
    }
    expect(caught, 'the CHECK refused the write').toBeDefined();
    const cause = (caught as { cause?: { code?: string; constraint?: string } }).cause ?? caught;
    expect(cause).toMatchObject({ code: '23514', constraint: 'categories_emoji_check' });
    // The empty string is refused too; NULL is accepted.
    await expect(
      database.db.execute(sql`UPDATE categories SET emoji = '' WHERE id = ${id}`),
    ).rejects.toSatisfy((error: unknown) => {
      const inner = (error as { cause?: { code?: string } }).cause;
      return inner?.code === '23514';
    });
    await database.db.execute(sql`UPDATE categories SET emoji = NULL WHERE id = ${id}`);
  });

  it('a read returns null and leaves emoji NULL in the table: the default is never written', async () => {
    const before = await storedEmoji();
    expect(before.size).toBeGreaterThan(100);
    expect(
      [...before.values()].every((emoji) => emoji === null),
      'seeding sets none',
    ).toBe(true);

    const listed = await listCategories(database.db, database.userId, { includeArchived: true });
    expect(listed).toHaveLength(before.size);
    for (const category of listed) expect(category.emoji, category.key).toBeNull();
    // Read twice: neither read wrote anything (a first read *does* seed the hue — not this).
    await listCategories(database.db, database.userId);
    expect(
      [...(await storedEmoji()).values()].every((emoji) => emoji === null),
      'still NULL after reads',
    ).toBe(true);
  });

  it('renameCategory sets, keeps across a label-only edit, clears with null, and refuses anything but one emoji', async () => {
    const [target] = await listCategories(database.db, database.userId);
    if (target === undefined) throw new Error('no categories');

    const set = await renameCategory(
      database.db,
      { userId: database.userId, categoryId: target.id, emoji: '👩🏽‍💻' },
      { clock },
    );
    expect(set.emoji).toBe('👩🏽‍💻');
    expect(set.label, 'an emoji-only edit leaves the label').toBe(target.label);
    expect((await storedEmoji()).get(target.id)).toBe('👩🏽‍💻');

    const relabelled = await renameCategory(
      database.db,
      { userId: database.userId, categoryId: target.id, label: 'Re-iconed' },
      { clock },
    );
    expect(relabelled.emoji, 'a PATCH that does not name emoji leaves it').toBe('👩🏽‍💻');

    for (const refused of ['ab', '🛒🛒', '1', '', ' 🛒']) {
      await expect(
        renameCategory(
          database.db,
          { userId: database.userId, categoryId: target.id, emoji: refused },
          { clock },
        ),
        JSON.stringify(refused),
      ).rejects.toMatchObject({ code: 'categorization.rule_invalid' });
    }
    expect((await storedEmoji()).get(target.id), 'a refused edit wrote nothing').toBe('👩🏽‍💻');

    const cleared = await renameCategory(
      database.db,
      { userId: database.userId, categoryId: target.id, emoji: null },
      { clock },
    );
    expect(cleared.emoji).toBeNull();
    expect((await storedEmoji()).get(target.id)).toBeNull();
  });

  it('createCategory stores one emoji, none when omitted, and refuses two', async () => {
    const chosen = await createCategory(
      database.db,
      { userId: database.userId, parentId: null, label: 'Emoji Chosen', emoji: '🍽️' },
      { clock },
    );
    expect(chosen.emoji).toBe('🍽️');
    expect((await storedEmoji()).get(chosen.id)).toBe('🍽️');

    const plain = await createCategory(
      database.db,
      { userId: database.userId, parentId: chosen.id, label: 'Emoji Omitted' },
      { clock },
    );
    expect(plain.emoji).toBeNull();
    expect((await storedEmoji()).get(plain.id)).toBeNull();

    await expect(
      createCategory(
        database.db,
        { userId: database.userId, parentId: null, label: 'Emoji Refused', emoji: '🛒🛒' },
        { clock },
      ),
    ).rejects.toMatchObject({ code: 'categorization.rule_invalid' });
  });
});
