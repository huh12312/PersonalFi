// SPDX-License-Identifier: MIT
/**
 * The user-visible chart of categories, and the boot pass that makes sure there
 * is one (gate conditions D-6 / N-3).
 *
 * ## Why this file exists at all
 *
 * `taxonomy.ts` has been the app's category list since WP 1.4 and `categories`
 * has been its table since migration 0006, but nothing in production ever put
 * the one into the other: `seedSystemTaxonomy` was called only from tests. The
 * Phase 1 re-gate found the consequence from the outside — `select count(*) from
 * categories` returned `0` on the running deployment and `CategoryPicker`
 * offered a single "Uncategorized" option — so a user could never categorise
 * anything from the app even though the write path was proven to work. A
 * taxonomy nobody can reach is a taxonomy that does not exist.
 *
 * ## Seeded at boot, not in a migration
 *
 * `categories` is `user_id`-scoped (decision D6: an ownership column on every
 * user-scoped table from the first migration), so there is nothing for a
 * migration to seed — migrations run before any user exists, and `just
 * bootstrap-user` creates the first one afterwards. A migration would also be
 * the wrong *shape*: an applied migration is immutable, and `TAXONOMY` gains
 * categories in later releases, so the pass that installs them has to be one
 * that runs again. Transcribing 130 categories into SQL would additionally give
 * the app two copies of its own taxonomy, drifting from the release that edits
 * only one of them.
 *
 * So: at boot, for every user, idempotently — which is exactly the contract
 * `seedSystemTaxonomy` was already written to (see its header) and never called
 * against. "First boot" and "every boot" are the same pass here; running it
 * every boot is what makes a category added in v0.3 appear for a user created in
 * v0.1, and it costs one pass over ~130 rows that almost always writes nothing.
 */
import type { Clock } from '@core/kernel';
import { sql } from 'drizzle-orm';
import type { CategorizationExecutor } from './db.ts';
import { seedSystemTaxonomy } from './seed-taxonomy.ts';
import type { CategoryKind } from './taxonomy.ts';

/** One row of the chart, as a user sees it. */
export interface UserCategory {
  readonly id: string;
  /** Stable across releases and renames. What rules and mappings key on. */
  readonly key: string;
  readonly parentId: string | null;
  readonly label: string;
  readonly description: string;
  readonly kind: CategoryKind;
  /** A Lucide icon name (decision D20). A key, never markup. */
  readonly icon: string;
  readonly sort: number;
  /**
   * `true` for a row this taxonomy installed, `false` for one the user created.
   * The picker uses it for nothing; a future "reset my categories" does.
   */
  readonly isSystem: boolean;
  /**
   * Archived categories are hidden, never deleted — historic assignments still
   * point at them and a budget from March must still say what it meant.
   */
  readonly archivedAt: Date | null;
  /** `false` for a top-level heading. Only leaves may be assigned. */
  readonly assignable: boolean;
}

export interface ListCategoriesOptions {
  /** Default `false`: a picker must not offer a category the user retired. */
  readonly includeArchived?: boolean;
}

/**
 * Every category this user has, system and custom alike, in display order.
 *
 * Reads the **table**, not `TAXONOMY`, and that is the whole point of the
 * function: the constant is what we ship, the table is what the user has, and
 * after a rename or a custom category they are different. Serving the constant
 * would produce a picker whose entries do not match the ids the write path
 * accepts, which is a worse bug than the empty picker it replaced.
 *
 * Ordered by `sort` with `key` as a tiebreak so two categories that share a sort
 * value — which a user's custom category will, since nothing assigns it one —
 * come back in a stable order rather than whatever the heap returns today.
 */
export async function listCategories(
  executor: CategorizationExecutor,
  userId: string,
  options: ListCategoriesOptions = {},
): Promise<readonly UserCategory[]> {
  const includeArchived = options.includeArchived ?? false;
  const result = await executor.execute<{
    id: string;
    key: string;
    parent_id: string | null;
    label: string;
    description: string;
    kind: CategoryKind;
    icon: string;
    sort: number;
    is_system: boolean;
    /**
     * `string | Date`, and the union is not defensive — it is what this driver
     * actually returns. A `TIMESTAMPTZ` read through the query *builder* arrives
     * as a `Date`, and the same column read through `execute()` with raw SQL
     * arrives as the wire string `2026-09-16 14:28:13.829141+00`. Declaring it
     * `Date` and passing it through cost an afternoon: every archived category
     * turned `GET /categories?includeArchived=true` into a 500 at the response
     * serialiser, because `toISOString` is not a function on a string.
     * `explainAssignment` in `service.ts` types `decided_at` the same way for the
     * same reason.
     */
    archived_at: string | Date | null;
    child_count: string;
  }>(sql`
    SELECT c.id,
           c.key,
           c.parent_id,
           c.label,
           c.description,
           c.kind,
           c.icon,
           c.sort,
           c.is_system,
           c.archived_at,
           (SELECT count(*) FROM categories AS child WHERE child.parent_id = c.id) AS child_count
      FROM categories AS c
     WHERE c.user_id = ${userId}
       AND (${includeArchived} OR c.archived_at IS NULL)
     ORDER BY c.sort, c.key
  `);

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    parentId: row.parent_id,
    label: row.label,
    description: row.description,
    kind: row.kind,
    icon: row.icon,
    sort: row.sort,
    isSystem: row.is_system,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
    // Assignable means "money can land here". A heading with children is a
    // grouping, not a destination; `uncategorised` is childless on purpose,
    // because "we do not know" does not decompose. Computed from the table
    // rather than from `isAssignableKey`, so a user's own custom category —
    // which `TAXONOMY` has never heard of — is answered correctly.
    assignable: Number(row.child_count) === 0,
  }));
}

export interface EnsureTaxonomyInput {
  /**
   * Whose charts to ensure. Supplied by the caller, **never** queried here.
   *
   * The first draft of this function selected the ids out of identity's own
   * `users` table, and the schema-ownership check caught it: that table belongs
   * to `@ctx/identity`, and one innocent read of another context's table is how
   * two packages stop being changeable independently. "Which users exist?" is a
   * question only the
   * composition root may ask — it is the one place allowed to know about both
   * contexts — so `apps/api/src/app.ts` asks identity's own `UserService` and
   * passes the answer in. That also makes this function trivially testable with
   * a list of ids and no `users` row at all.
   */
  readonly userIds: readonly string[];
  readonly clock: Clock;
}

export interface EnsureTaxonomyResult {
  readonly users: number;
  readonly categoriesInserted: number;
}

/**
 * Ensure each named user has the shipped taxonomy. The boot pass behind D-6.
 *
 * One user at a time, rather than one pass for all of them: a partially seeded
 * *user* is the failure that matters (a category missing from a picker three
 * screens later), and a second user's failure is no reason to undo the first
 * user's working chart. Today identity's `createPrimary` refuses a second user
 * outright, so this loop runs exactly once — and D6 says multi-user is additive
 * later, which is what taking a *list* rather than a single id is for.
 *
 * Idempotent by construction: `seedSystemTaxonomy` is an `ON CONFLICT (user_id,
 * key) DO UPDATE` over ~130 rows that reuses the existing id, so running it
 * every boot re-issues nothing that `category_assignments` already points at and
 * is how a category added in a later release reaches a user created by an
 * earlier one.
 *
 * The caller decides what a failure means. In `buildApp` it is logged and
 * survived, for the same reason the config snapshot is: a database that is up
 * but not yet migrated should get an API that can *say so* on `/ready`, not a
 * crash loop that tells the operator nothing.
 */
export async function ensureTaxonomy(
  executor: CategorizationExecutor,
  input: EnsureTaxonomyInput,
): Promise<EnsureTaxonomyResult> {
  let categoriesInserted = 0;
  for (const userId of input.userIds) {
    const result = await seedSystemTaxonomy(executor, { userId, clock: input.clock });
    categoriesInserted += result.categoriesInserted;
  }
  return { users: input.userIds.length, categoriesInserted };
}
