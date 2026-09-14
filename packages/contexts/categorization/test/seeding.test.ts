// SPDX-License-Identifier: MIT
/**
 * Seeding the taxonomy, the PFC map and the MCC table, against a real Postgres.
 *
 * Every claim here is a claim about the database and could not be made against a
 * double. "Re-seeding inserts nothing" is `ON CONFLICT DO UPDATE` plus
 * `RETURNING (xmax = 0)`; "the primary-only fallback row is not duplicated" is
 * `NULLS NOT DISTINCT` on a unique index, and Postgres's *default* is the
 * opposite, so the failure mode this pins is eighteen extra rows per re-seed,
 * growing forever, silently.
 *
 * The property under test is idempotence **in the specific sense that matters**:
 * running twice must be indistinguishable from running once *and must not undo a
 * user's edits*. Those are two different things and the second is the one that is
 * easy to get wrong — a `DO UPDATE SET label = EXCLUDED.label` would pass a naive
 * row-count check and quietly rename "Eating Out" back to "Dining & Drinks" on
 * every deploy.
 */
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FLAT_TAXONOMY } from '../src/taxonomy.ts';
import { MCC_CODES } from '../src/mcc-codes.ts';
import { PFC_DETAILED_TO_KEY, PFC_PRIMARY_TO_KEY } from '../src/pfc-map.ts';
import {
  categoryIdsByKey,
  categoryKeysById,
  seedSystemTaxonomy,
  type SeedTaxonomyResult,
} from '../src/seed-taxonomy.ts';
import {
  NO_DATABASE,
  categorizationDatabase,
  countRows,
  testClock,
  type TestDatabase,
} from './harness.ts';

const PROVIDER_MAPPING_COUNT = PFC_PRIMARY_TO_KEY.size + PFC_DETAILED_TO_KEY.size;

describe.skipIf(NO_DATABASE)('seedSystemTaxonomy', () => {
  let database: TestDatabase;
  let clock: ReturnType<typeof testClock>;

  beforeAll(async () => {
    database = await categorizationDatabase('seeding');
  });

  afterAll(async () => {
    await database.drop();
  });

  beforeEach(async () => {
    await database.truncate();
    clock = testClock();
  });

  async function seed(userId = database.userId): Promise<SeedTaxonomyResult> {
    return seedSystemTaxonomy(database.db, { userId, clock });
  }

  it('inserts the whole taxonomy, the whole PFC map and the whole MCC table', async () => {
    const result = await seed();

    expect(result.categoriesInserted).toBe(FLAT_TAXONOMY.length);
    expect(result.categoriesTotal).toBe(FLAT_TAXONOMY.length);
    expect(result.providerMappingsInserted).toBe(PROVIDER_MAPPING_COUNT);
    expect(result.mccInserted).toBe(MCC_CODES.length);

    expect(await countRows(database, 'categories')).toBe(FLAT_TAXONOMY.length);
    expect(await countRows(database, 'provider_category_map')).toBe(PROVIDER_MAPPING_COUNT);
    expect(await countRows(database, 'mcc_codes')).toBe(MCC_CODES.length);
  });

  it('is idempotent: the second run inserts nothing and changes no count', async () => {
    await seed();
    const again = await seed();

    expect(again.categoriesInserted).toBe(0);
    expect(again.providerMappingsInserted).toBe(0);
    expect(again.mccInserted).toBe(0);

    expect(await countRows(database, 'categories')).toBe(FLAT_TAXONOMY.length);
    expect(await countRows(database, 'provider_category_map')).toBe(PROVIDER_MAPPING_COUNT);
    expect(await countRows(database, 'mcc_codes')).toBe(MCC_CODES.length);
  });

  it('does not duplicate the primary-only fallback rows', async () => {
    // `detailed_code IS NULL` on eighteen rows. Under Postgres's default NULL
    // handling in a unique index every one of those NULLs is distinct, so
    // `ON CONFLICT` would never fire and a re-seed would add eighteen more rows
    // each time. `NULLS NOT DISTINCT` in migration 0006 is what stops it, and
    // this is the assertion that the clause is actually there.
    await seed();
    await seed();
    await seed();

    const fallbacks = await database.db.execute<{ count: string }>(
      sql`SELECT count(*) AS count FROM provider_category_map WHERE detailed_code IS NULL`,
    );
    expect(Number(fallbacks.rows[0]?.count)).toBe(PFC_PRIMARY_TO_KEY.size);
  });

  it('keeps a category the user renamed', async () => {
    await seed();
    await database.db.execute(sql`
      UPDATE categories SET label = 'Eating Out', description = 'Mine.', icon = 'pizza', sort = 4
       WHERE user_id = ${database.userId} AND key = 'dining'
    `);

    await seed();

    const row = await database.db.execute<{
      label: string;
      description: string;
      icon: string;
      sort: number;
    }>(
      sql`SELECT label, description, icon, sort FROM categories WHERE user_id = ${database.userId} AND key = 'dining'`,
    );
    expect(row.rows[0]).toMatchObject({
      label: 'Eating Out',
      description: 'Mine.',
      icon: 'pizza',
      sort: 4,
    });
  });

  it('repairs a structural drift, because kind moves money between totals', async () => {
    // `label` is the user's; `kind` is not. A credit-card payment whose kind had
    // drifted to `expense` would double-count every card purchase in the spend
    // total — the exact thing the Phase 1 exit criterion forbids — so re-seeding
    // re-asserts it.
    await seed();
    await database.db.execute(sql`
      UPDATE categories SET kind = 'expense'
       WHERE user_id = ${database.userId} AND key = 'transfers.credit_card_payment'
    `);

    await seed();

    const row = await database.db.execute<{ kind: string; parent_id: string | null }>(sql`
      SELECT kind, parent_id FROM categories
       WHERE user_id = ${database.userId} AND key = 'transfers.credit_card_payment'
    `);
    expect(row.rows[0]?.kind).toBe('transfer');
    expect(row.rows[0]?.parent_id).not.toBeNull();
  });

  it('cannot be given a leaf with no parent in the first place', async () => {
    // The other half of the structural guarantee, and the stronger half: the
    // `categories_two_levels` CHECK makes an orphaned leaf unrepresentable, so
    // re-seeding is repairing a drift that the database will not allow anyway.
    // Asserted rather than assumed, because a CHECK nobody has watched refuse
    // something is a CHECK that might have been dropped in a later migration.
    await seed();
    // Asserted on the *constraint name*, not on the message: Drizzle wraps the
    // driver error in a "Failed query" of its own and the message it prints says
    // nothing about which rule refused, so a `toThrow(/two_levels/)` here would
    // pass for any failure at all, including a typo in the statement.
    const failure = await database.db
      .execute(
        sql`
          UPDATE categories SET parent_id = NULL
           WHERE user_id = ${database.userId} AND key = 'transfers.credit_card_payment'
        `,
      )
      .then(
        () => null,
        (error: unknown) => error as { cause?: { constraint?: string } },
      );
    expect(failure?.cause?.constraint).toBe('categories_two_levels');
  });

  it('leaves an archived category archived', async () => {
    await seed();
    await database.db.execute(sql`
      UPDATE categories SET archived_at = now()
       WHERE user_id = ${database.userId} AND key = 'entertainment.gambling'
    `);

    await seed();

    const row = await database.db.execute<{ archived_at: string | null }>(sql`
      SELECT archived_at FROM categories
       WHERE user_id = ${database.userId} AND key = 'entertainment.gambling'
    `);
    expect(row.rows[0]?.archived_at).not.toBeNull();
  });

  it('never overwrites a provider mapping the user re-pointed', async () => {
    await seed();
    const idByKey = await categoryIdsByKey(database.db, database.userId);
    const family = idByKey.get('family.other_family') as string;

    await database.db.execute(sql`
      UPDATE provider_category_map SET category_id = ${family}, source = 'user'
       WHERE user_id = ${database.userId} AND detailed_code = 'GENERAL_SERVICES_EDUCATION'
    `);

    await seed();

    const row = await database.db.execute<{ category_id: string; source: string }>(sql`
      SELECT category_id, source FROM provider_category_map
       WHERE user_id = ${database.userId} AND detailed_code = 'GENERAL_SERVICES_EDUCATION'
    `);
    expect(row.rows[0]?.category_id).toBe(family);
    expect(row.rows[0]?.source).toBe('user');
  });

  it('gives every leaf a parent and every top level none', async () => {
    // The two-level CHECK in migration 0006 would reject a violation outright, so
    // this is really asserting that the seeding order resolves `parent_id` for
    // every child — `FLAT_TAXONOMY` is parent-first for exactly this reason, and
    // a reordering would leave a hundred and thirty-one orphans.
    await seed();

    const orphans = await database.db.execute<{ key: string }>(sql`
      SELECT key FROM categories
       WHERE user_id = ${database.userId} AND key LIKE '%.%' AND parent_id IS NULL
    `);
    expect(orphans.rows.map((row) => row.key)).toEqual([]);

    const roots = await database.db.execute<{ count: string }>(sql`
      SELECT count(*) AS count FROM categories
       WHERE user_id = ${database.userId} AND parent_id IS NULL
    `);
    expect(Number(roots.rows[0]?.count)).toBe(
      FLAT_TAXONOMY.filter((entry) => entry.parentKey === null).length,
    );
  });

  it('maps keys to ids and back for the user who owns them', async () => {
    await seed();
    const idByKey = await categoryIdsByKey(database.db, database.userId);
    const keyById = await categoryKeysById(database.db, database.userId);

    expect(idByKey.size).toBe(FLAT_TAXONOMY.length);
    expect(keyById.size).toBe(FLAT_TAXONOMY.length);
    const coffeeId = idByKey.get('dining.coffee') as string;
    expect(keyById.get(coffeeId)).toBe('dining.coffee');
  });

  it('seeds a second user without touching the first', async () => {
    // The cost of per-user categories, paid deliberately (decision D6). What must
    // not happen is the two users sharing a row: a rename by one would then be a
    // rename for both.
    await seed();
    const otherUserId = await database.createUser('Second Holder');
    const second = await seed(otherUserId);

    expect(second.categoriesInserted).toBe(FLAT_TAXONOMY.length);
    expect(await countRows(database, 'categories')).toBe(FLAT_TAXONOMY.length * 2);

    const first = await categoryIdsByKey(database.db, database.userId);
    const other = await categoryIdsByKey(database.db, otherUserId);
    expect(other.get('dining.coffee')).not.toBe(first.get('dining.coffee'));
  });
});
