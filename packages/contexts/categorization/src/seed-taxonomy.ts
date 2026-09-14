// SPDX-License-Identifier: MIT
/**
 * Seeding one user's taxonomy, the PFC map and the MCC table.
 *
 * **Idempotent, and idempotent in the specific sense that matters**: running it
 * twice must be indistinguishable from running it once *and must not undo a
 * user's edits*. Those are different properties and the second is the one that is
 * easy to get wrong. Concretely:
 *
 *   * A category that exists keeps its `label`, `description`, `icon` and `sort`.
 *     The user may have renamed "Dining & Drinks" to "Eating Out"; re-seeding
 *     after an upgrade must not put it back. Only `kind` and `parent_id` are
 *     re-asserted, because those are structural — a category whose `kind` drifted
 *     would silently move money between the spend and transfer totals.
 *   * A `provider_category_map` row marked `source = 'user'` is never touched.
 *   * An archived category stays archived.
 *
 * That means the upsert is `ON CONFLICT DO UPDATE` with a deliberately short
 * `SET` list, not `DO NOTHING` (which would never repair a structural drift) and
 * not a full overwrite (which would trample the user every release).
 *
 * New categories added to `TAXONOMY` in a later release are inserted by the same
 * pass, which is the whole reason this is re-run at boot rather than only at
 * first sign-in.
 */
import { newId } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type { CategorizationContext, CategorizationExecutor } from './db.ts';
import { MCC_CODES } from './mcc-codes.ts';
import { PFC_DETAILED_TO_KEY, PFC_PRIMARY_TO_KEY } from './pfc-map.ts';
import { FLAT_TAXONOMY } from './taxonomy.ts';

export interface SeedTaxonomyResult {
  readonly categoriesInserted: number;
  readonly categoriesTotal: number;
  readonly providerMappingsInserted: number;
  readonly providerMappingsTotal: number;
  readonly mccInserted: number;
  readonly mccTotal: number;
}

/**
 * Seed (or re-seed) everything static for one user.
 *
 * Takes an executor rather than opening its own transaction, so the caller can
 * run it inside user creation — a half-seeded taxonomy is worse than an
 * unseeded one, because the failure is invisible until a category is missing
 * from a picker three screens later.
 */
export async function seedSystemTaxonomy(
  executor: CategorizationExecutor,
  context: Pick<CategorizationContext, 'userId' | 'clock'>,
): Promise<SeedTaxonomyResult> {
  const { userId } = context;

  // --- categories ----------------------------------------------------------
  // Parents before children: `parent_id` is resolved from the key map built as
  // we go, and `FLAT_TAXONOMY` is ordered parent-first for exactly this reason.
  const idByKey = new Map<string, string>();
  const existing = await executor.execute<{ id: string; key: string }>(
    sql`SELECT id, key FROM categories WHERE user_id = ${userId}`,
  );
  for (const row of existing.rows) idByKey.set(row.key, row.id);

  let categoriesInserted = 0;
  for (const entry of FLAT_TAXONOMY) {
    const id = idByKey.get(entry.key) ?? newId();
    const parentId = entry.parentKey === null ? null : (idByKey.get(entry.parentKey) ?? null);

    const result = await executor.execute<{ inserted: boolean }>(sql`
      INSERT INTO categories (id, user_id, parent_id, key, label, description, kind, icon, sort, is_system)
      VALUES (
        ${id}, ${userId}, ${parentId}, ${entry.key}, ${entry.label}, ${entry.description},
        ${entry.kind}, ${entry.icon}, ${entry.sort}, TRUE
      )
      ON CONFLICT (user_id, key) DO UPDATE SET
        -- Structural only. label/description/icon/sort are the user's to change.
        kind       = EXCLUDED.kind,
        parent_id  = EXCLUDED.parent_id,
        is_system  = TRUE,
        updated_at = now()
      RETURNING (xmax = 0) AS inserted
    `);
    if (result.rows[0]?.inserted === true) categoriesInserted += 1;
    idByKey.set(entry.key, id);
  }

  // The ids may have been assigned by a concurrent seeder, so re-read rather
  // than trusting the ids generated above. `ON CONFLICT DO UPDATE` returns the
  // *existing* row's id, but only via RETURNING id, and reading once here is
  // cheaper than adding a column to every one of the statements above.
  const seeded = await executor.execute<{ id: string; key: string }>(
    sql`SELECT id, key FROM categories WHERE user_id = ${userId}`,
  );
  idByKey.clear();
  for (const row of seeded.rows) idByKey.set(row.key, row.id);

  // --- provider_category_map ----------------------------------------------
  const mappings: { primary: string; detailed: string | null; key: string }[] = [
    ...[...PFC_PRIMARY_TO_KEY].map(([primary, key]) => ({ primary, detailed: null, key })),
    ...[...PFC_DETAILED_TO_KEY].map(([detailed, key]) => ({
      primary: primaryOf(detailed),
      detailed,
      key,
    })),
  ];

  let providerMappingsInserted = 0;
  for (const mapping of mappings) {
    const categoryId = idByKey.get(mapping.key);
    if (categoryId === undefined) continue;
    const result = await executor.execute<{ inserted: boolean }>(sql`
      INSERT INTO provider_category_map
        (id, user_id, provider, taxonomy_version, primary_code, detailed_code, category_id, source)
      VALUES
        (${newId()}, ${userId}, 'plaid', 'v2', ${mapping.primary}, ${mapping.detailed}, ${categoryId}, 'system')
      ON CONFLICT (user_id, provider, taxonomy_version, primary_code, detailed_code) DO UPDATE SET
        -- A row the user re-pointed is theirs. Re-seeding must not undo it.
        category_id = CASE WHEN provider_category_map.source = 'user'
                           THEN provider_category_map.category_id
                           ELSE EXCLUDED.category_id END,
        updated_at  = now()
      RETURNING (xmax = 0) AS inserted
    `);
    if (result.rows[0]?.inserted === true) providerMappingsInserted += 1;
  }

  // --- mcc_codes -----------------------------------------------------------
  //
  // 981 rows, so this is the one place a per-row round trip would actually hurt.
  // Built as a single multi-row INSERT via `unnest`, which keeps it to one
  // statement and one plan whatever the row count.
  const mccCodes: string[] = [];
  const mccDescriptions: string[] = [];
  const mccCategoryIds: string[] = [];
  const mccIds: string[] = [];
  for (const row of MCC_CODES) {
    const categoryId = idByKey.get(row.categoryKey);
    if (categoryId === undefined) continue;
    mccIds.push(newId());
    mccCodes.push(row.mcc);
    mccDescriptions.push(row.description);
    mccCategoryIds.push(categoryId);
  }

  const mccResult = await executor.execute<{ inserted: boolean }>(sql`
    INSERT INTO mcc_codes (id, user_id, mcc, description, category_id)
    SELECT * FROM unnest(
      ${mccIds}::uuid[],
      ${mccIds.map(() => userId)}::uuid[],
      ${mccCodes}::text[],
      ${mccDescriptions}::text[],
      ${mccCategoryIds}::uuid[]
    )
    ON CONFLICT (user_id, mcc) DO UPDATE SET category_id = EXCLUDED.category_id
    RETURNING (xmax = 0) AS inserted
  `);
  const mccInserted = mccResult.rows.filter((row) => row.inserted).length;

  return {
    categoriesInserted,
    categoriesTotal: FLAT_TAXONOMY.length,
    providerMappingsInserted,
    providerMappingsTotal: mappings.length,
    mccInserted,
    mccTotal: MCC_CODES.length,
  };
}

/**
 * The primary a detailed code belongs to.
 *
 * By longest-prefix match against the known primaries rather than by splitting
 * on the first underscore, because every primary contains underscores
 * (`FOOD_AND_DRINK_COFFEE`) and half of them are prefixes of nothing useful.
 * `TRANSFER_IN` and `TRANSFER_IN_WIRE` also mean the longest match has to win,
 * or `TRANSFER_IN_WIRE` lands under a primary that does not exist.
 */
function primaryOf(detailed: string): string {
  let best = '';
  for (const primary of PFC_PRIMARY_TO_KEY.keys()) {
    if (detailed.startsWith(`${primary}_`) && primary.length > best.length) best = primary;
  }
  return best === '' ? detailed : best;
}

/** `categories.key` → `categories.id`, for one user. */
export async function categoryIdsByKey(
  executor: CategorizationExecutor,
  userId: string,
): Promise<ReadonlyMap<string, string>> {
  const result = await executor.execute<{ id: string; key: string }>(
    sql`SELECT id, key FROM categories WHERE user_id = ${userId}`,
  );
  return new Map(result.rows.map((row) => [row.key, row.id]));
}

/** `categories.id` → `categories.key`. The inverse, for reading assignments back. */
export async function categoryKeysById(
  executor: CategorizationExecutor,
  userId: string,
): Promise<ReadonlyMap<string, string>> {
  const result = await executor.execute<{ id: string; key: string }>(
    sql`SELECT id, key FROM categories WHERE user_id = ${userId}`,
  );
  return new Map(result.rows.map((row) => [row.id, row.key]));
}
