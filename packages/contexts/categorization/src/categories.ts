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
import {
  hueForId,
  isChartHue,
  isSingleEmoji,
  newId,
  type ChartHue,
  type Clock,
} from '@core/kernel';
import { sql } from 'drizzle-orm';
import type { CategorizationExecutor } from './db.ts';
import { CategorizationError } from './errors.ts';
import { categoryIdsByKey, seedSystemTaxonomy } from './seed-taxonomy.ts';
import { CATEGORY_VARIABILITIES, type CategoryVariability } from '../schema/index.ts';
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
  /**
   * The chart hue this category is drawn in (WP 10.8, migration 0045): one of the thirteen `CHART_HUES`.
   * Seeded once with `hueForId(id)` on the first read that finds the column NULL, and persisted then;
   * after that it is the stored value, which the holder may change, and nothing re-derives it.
   */
  readonly hue: ChartHue;
  /**
   * Fixed / flexible / non-monthly (WP 10.11, migration 0047), or `null` while the holder has not classified it.
   * Never derived here: a recurring stream only *suggests* `fixed` (`apps/api`'s
   * `GET /categories/variability-suggestions`), and only `PATCH /categories/{id}` writes it.
   */
  readonly variability: CategoryVariability | null;
  /**
   * One emoji the holder chose (WP 10.14, migration 0050), or `null` when none is set. The **stored** value only:
   * a read never seeds it the way it seeds `hue`, so `null` here means the holder has not chosen one, and the web
   * draws the shipped default for the key (`CATEGORY_DEFAULT_EMOJI`) or the initials. Written only by
   * `createCategory`, `renameCategory` and an import, each through `isSingleEmoji`.
   */
  readonly emoji: string | null;
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
    hue: string | null;
    variability: string | null;
    emoji: string | null;
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
           c.hue,
           c.variability,
           c.emoji,
           c.sort,
           c.is_system,
           c.archived_at,
           (SELECT count(*) FROM categories AS child WHERE child.parent_id = c.id) AS child_count
      FROM categories AS c
     WHERE c.user_id = ${userId}
       AND (${includeArchived} OR c.archived_at IS NULL)
     ORDER BY c.sort, c.key
  `);

  const hues = await assignMissingHues(
    executor,
    userId,
    result.rows.filter((row) => row.hue === null).map((row) => row.id),
  );

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    parentId: row.parent_id,
    label: row.label,
    description: row.description,
    kind: row.kind,
    icon: row.icon,
    hue: storedHue(row.id, row.hue ?? hues.get(row.id) ?? null),
    variability: storedVariability(row.id, row.variability),
    // As stored, NULL included: the default emoji is a display fallback and is never written (0050).
    emoji: row.emoji,
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

/**
 * A hue as the table holds it. `categories_hue_check` (0045) admits only `CHART_HUES` or NULL, and every NULL
 * the read saw has been assigned by `assignMissingHues` before this is called, so either failure here means
 * the CHECK and the vocabulary disagree — a bug to surface, never a value to paper over with a recomputed
 * hash (which would be a second, unstored answer).
 */
function storedHue(categoryId: string, hue: string | null): ChartHue {
  if (!isChartHue(hue)) {
    throw new Error(`category ${categoryId} has no valid stored hue (${String(hue)})`);
  }
  return hue;
}

/** A variability as the table holds it: `categories_variability_check` (0047) admits the three values or NULL. */
function storedVariability(categoryId: string, value: string | null): CategoryVariability | null {
  if (value === null) return null;
  if (!isCategoryVariability(value)) {
    throw new Error(`category ${categoryId} has an invalid stored variability (${value})`);
  }
  return value;
}

export function isCategoryVariability(value: unknown): value is CategoryVariability {
  return typeof value === 'string' && (CATEGORY_VARIABILITIES as readonly string[]).includes(value);
}

/**
 * An emoji as a write names it: `null` (none / clear) or exactly one emoji by `isSingleEmoji` — one extended
 * grapheme cluster of emoji code points, at most `MAX_EMOJI_CODE_POINTS` long (0050's CHECK bounds the length;
 * only this can count graphemes). Anything else is the holder's mistake, `categorization.rule_invalid` (400).
 */
function requireEmoji(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !isSingleEmoji(value)) {
    throw new CategorizationError(
      'categorization.rule_invalid',
      'a category emoji must be exactly one emoji',
      { emoji: value },
    );
  }
  return value;
}

function requireVariability(value: unknown): CategoryVariability | null {
  if (value === null) return null;
  if (!isCategoryVariability(value)) {
    throw new CategorizationError(
      'categorization.rule_invalid',
      'a category variability must be fixed, flexible or non_monthly',
      { variability: value },
    );
  }
  return value;
}

/**
 * Assign on first read (WP 10.8). For each category the read found with `hue IS NULL`, persist
 * `hueForId(id)` — the same hash the web computes for a category it has no stored hue for, so the colour a
 * holder saw before the first read is the colour that gets stored — and return what is stored now.
 *
 * `AND hue IS NULL` is the whole concurrency story: two first reads racing write the same value, and a
 * holder's own `PATCH` that lands between this read's SELECT and its UPDATE is never overwritten. A row the
 * UPDATE did not touch (someone else got there first) is read back, so the answer is always the stored value.
 * `updated_at` is left alone: assigning a default is not an edit.
 */
async function assignMissingHues(
  executor: CategorizationExecutor,
  userId: string,
  categoryIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const hues = new Map<string, string>();
  if (categoryIds.length === 0) return hues;

  const seeds = sql.join(
    categoryIds.map((id) => sql`(${id}::uuid, ${hueForId(id)}::text)`),
    sql`, `,
  );
  const written = await executor.execute<{ id: string; hue: string }>(sql`
    UPDATE categories AS c SET hue = seed.hue
      FROM (VALUES ${seeds}) AS seed (id, hue)
     WHERE c.id = seed.id AND c.user_id = ${userId} AND c.hue IS NULL
    RETURNING c.id, c.hue
  `);
  for (const row of written.rows) hues.set(row.id, row.hue);

  const raced = categoryIds.filter((id) => !hues.has(id));
  if (raced.length > 0) {
    const stored = await executor.execute<{ id: string; hue: string | null }>(sql`
      SELECT id, hue FROM categories
       WHERE user_id = ${userId}
         AND id IN (${sql.join(
           raced.map((id) => sql`${id}::uuid`),
           sql`, `,
         )})
    `);
    for (const row of stored.rows) {
      if (row.hue !== null) hues.set(row.id, row.hue);
    }
  }
  return hues;
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

// ---------------------------------------------------------------------------
// Writes (WP 2.5 carry-over: closeout-architecture.md §4, "No POST /categories.
// The picker is read-only, and 05 §5.2's searchable combobox with a 'create new
// category' escape hatch still needs a write route to be worth building.")
// ---------------------------------------------------------------------------

/**
 * `label` → a `categories.key` fragment: lowercase, `[a-z][a-z0-9_]*`, matching
 * the `CHECK` migration 0006 puts on the column. Accented characters are folded
 * rather than dropped ("Crème" → "creme") so a label in the user's own language
 * still produces a readable key instead of an empty string falling through to
 * the `c_category` fallback below.
 */
function slugifyLabel(label: string): string {
  const cleaned = label
    .normalize('NFKD')
    .replaceAll(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '')
    .slice(0, 40);
  return cleaned.length > 0 && /^[a-z]/u.test(cleaned) ? cleaned : `c_${cleaned || 'category'}`;
}

/** The row shape every write below needs before it can decide anything. */
interface CategoryRow {
  readonly id: string;
  readonly key: string;
  readonly parentId: string | null;
  readonly kind: CategoryKind;
  readonly archivedAt: Date | null;
}

async function requireOwnCategory(
  executor: CategorizationExecutor,
  userId: string,
  categoryId: string,
): Promise<CategoryRow> {
  const result = await executor.execute<{
    id: string;
    key: string;
    parent_id: string | null;
    kind: CategoryKind;
    archived_at: string | Date | null;
  }>(sql`
    SELECT id, key, parent_id, kind, archived_at FROM categories
     WHERE id = ${categoryId} AND user_id = ${userId}
  `);
  const row = result.rows[0];
  // Scoped to `user_id` in the query itself, so a category id that belongs to
  // another user is indistinguishable from one that does not exist at all —
  // the same 404 either way, and no confirmation that the other row exists.
  if (row === undefined) {
    throw new CategorizationError(
      'categorization.category_not_found',
      `no category ${categoryId}`,
      { categoryId },
    );
  }
  return {
    id: row.id,
    key: row.key,
    parentId: row.parent_id,
    kind: row.kind,
    archivedAt: row.archived_at === null ? null : new Date(row.archived_at),
  };
}

export interface CreateCategoryInput {
  readonly userId: string;
  /** `null` creates a new top-level heading; otherwise a leaf under it. */
  readonly parentId: string | null;
  readonly label: string;
  readonly description?: string;
  readonly icon?: string;
  /** Only used for a top-level heading. A leaf always inherits its parent's. */
  readonly kind?: CategoryKind;
  /** WP 10.8. Omitted: seeded with `hueForId(id)`, the value a first read would assign. */
  readonly hue?: ChartHue;
  /** WP 10.11. Omitted or `null`: unclassified. */
  readonly variability?: CategoryVariability | null;
  /** WP 10.14. Omitted or `null`: none set (the default is never written). Otherwise exactly one emoji. */
  readonly emoji?: string | null;
}

function requireChartHue(hue: unknown): ChartHue {
  if (!isChartHue(hue)) {
    throw new CategorizationError(
      'categorization.rule_invalid',
      'a category hue must be one of the chart hues',
      { hue },
    );
  }
  return hue;
}

/**
 * `POST /categories` — the "create a new category" escape hatch 05 §5.2 asks
 * for. A category made here is indistinguishable from a shipped one to every
 * other read path (`listCategories`, the rules engine, `category_assignments`)
 * except `isSystem: false`, which exists only so a future "reset my
 * categories" knows what it may remove.
 *
 * The two-level `CHECK` (`categories_two_levels`, migration 0006) is enforced
 * here *before* the INSERT, not left to the database: a third-level attempt —
 * a leaf created under a category that already has a parent — is refused with
 * `categorization.category_third_level_refused`, a problem detail a client can
 * render, rather than a raw constraint-violation 500.
 */
export async function createCategory(
  executor: CategorizationExecutor,
  input: CreateCategoryInput,
  context: { readonly clock: Clock },
): Promise<UserCategory> {
  const label = input.label.trim();
  if (label.length === 0 || label.length > 120) {
    throw new CategorizationError(
      'categorization.rule_invalid',
      'a category label must be between 1 and 120 characters',
      { label: input.label },
    );
  }
  const requestedHue = input.hue === undefined ? undefined : requireChartHue(input.hue);
  const variability =
    input.variability === undefined ? null : requireVariability(input.variability);
  const emoji = input.emoji === undefined ? null : requireEmoji(input.emoji);

  let parentKey: string | null = null;
  let kind: CategoryKind;
  if (input.parentId === null) {
    kind = input.kind ?? 'expense';
  } else {
    const parent = await requireOwnCategory(executor, input.userId, input.parentId);
    if (parent.parentId !== null) {
      throw new CategorizationError(
        'categorization.category_third_level_refused',
        'a category may have at most two levels; this parent is already a child',
        { parentId: input.parentId },
      );
    }
    if (parent.archivedAt !== null) {
      throw new CategorizationError(
        'categorization.category_not_assignable',
        'the parent category is archived',
        { parentId: input.parentId },
      );
    }
    parentKey = parent.key;
    kind = parent.kind;
  }

  const idByKey = await categoryIdsByKey(executor, input.userId);
  const baseSlug = slugifyLabel(label);
  let key = parentKey === null ? baseSlug : `${parentKey}.${baseSlug}`;
  for (let suffix = 2; idByKey.has(key); suffix += 1) {
    if (suffix > 50) {
      throw new CategorizationError(
        'categorization.rule_invalid',
        'could not find a free key for this category; try a more distinct label',
        { label },
      );
    }
    const suffixed = `${baseSlug}_${String(suffix)}`;
    key = parentKey === null ? suffixed : `${parentKey}.${suffixed}`;
  }

  const id = newId();
  const now = context.clock.now();
  const description = input.description ?? '';
  const icon = input.icon ?? 'circle';
  const hue = requestedHue ?? hueForId(id);
  await executor.execute(sql`
    INSERT INTO categories
      (id, user_id, parent_id, key, label, description, kind, icon, hue, variability, emoji, sort,
       is_system, created_at, updated_at)
    VALUES (
      ${id}, ${input.userId}, ${input.parentId}, ${key}, ${label}, ${description}, ${kind},
      ${icon}, ${hue}, ${variability}, ${emoji}, 0, FALSE, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz
    )
  `);

  return {
    id,
    key,
    parentId: input.parentId,
    label,
    description,
    kind,
    icon,
    hue,
    variability,
    emoji,
    sort: 0,
    isSystem: false,
    archivedAt: null,
    // A brand-new leaf has no children yet; a brand-new heading has none either
    // until its first child is created, which is the honest answer for both.
    assignable: true,
  };
}

export interface RenameCategoryInput {
  readonly userId: string;
  readonly categoryId: string;
  readonly label?: string;
  readonly description?: string;
  readonly icon?: string;
  /** WP 10.8. One of `CHART_HUES`; anything else is refused (`categorization.rule_invalid`). */
  readonly hue?: ChartHue;
  /**
   * WP 10.11. `undefined` leaves it; `null` clears it back to unclassified; one of the three sets it. Anything
   * else is refused (`categorization.rule_invalid`).
   */
  readonly variability?: CategoryVariability | null;
  /**
   * WP 10.14. `undefined` leaves it; `null` clears it (the web falls back to the default again); a string must be
   * exactly one emoji (`isSingleEmoji`), anything else is refused (`categorization.rule_invalid`).
   */
  readonly emoji?: string | null;
}

/**
 * `PATCH /categories/{id}` — rename or re-describe, or (WP 10.8) recolour, (WP 10.11) classify, (WP 10.14) re-icon. Deliberately narrow:
 * `kind` and `parent_id` are structural (`seed-taxonomy.ts`'s own rule for why
 * a re-seed never touches them) and changing either after transactions have
 * been filed under a category is how a spend report silently moves money
 * between totals. A user who wants a different `kind` archives this one and
 * creates another.
 */
export async function renameCategory(
  executor: CategorizationExecutor,
  input: RenameCategoryInput,
  context: { readonly clock: Clock },
): Promise<UserCategory> {
  await requireOwnCategory(executor, input.userId, input.categoryId);

  const label = input.label === undefined ? undefined : input.label.trim();
  if (label !== undefined && (label.length === 0 || label.length > 120)) {
    throw new CategorizationError(
      'categorization.rule_invalid',
      'a category label must be between 1 and 120 characters',
      { label: input.label },
    );
  }
  const hue = input.hue === undefined ? null : requireChartHue(input.hue);
  // `COALESCE` cannot say "set to NULL", and clearing a classification is a real edit, so variability carries an
  // explicit "was it named" flag beside its value.
  const setVariability = input.variability !== undefined;
  const variability = setVariability ? requireVariability(input.variability) : null;
  // The same for the emoji: `null` clears a holder's choice back to the display fallback.
  const setEmoji = input.emoji !== undefined;
  const emoji = setEmoji ? requireEmoji(input.emoji) : null;

  await executor.execute(sql`
    UPDATE categories SET
      label       = COALESCE(${label ?? null}, label),
      description = COALESCE(${input.description ?? null}, description),
      icon        = COALESCE(${input.icon ?? null}, icon),
      hue         = COALESCE(${hue}, hue),
      variability = CASE WHEN ${setVariability} THEN ${variability}::text ELSE variability END,
      emoji       = CASE WHEN ${setEmoji} THEN ${emoji}::text ELSE emoji END,
      updated_at  = ${context.clock.now().toISOString()}::timestamptz
     WHERE id = ${input.categoryId} AND user_id = ${input.userId}
  `);

  const categories = await listCategories(executor, input.userId, { includeArchived: true });
  const updated = categories.find((category) => category.id === input.categoryId);
  // Unreachable except under a concurrent delete of the user row itself:
  // `requireOwnCategory` above already proved this row existed a moment ago.
  if (updated === undefined) {
    throw new CategorizationError(
      'categorization.category_not_found',
      `no category ${input.categoryId}`,
      { categoryId: input.categoryId },
    );
  }
  return updated;
}

export interface ArchiveCategoryResult {
  readonly category: UserCategory;
  readonly changed: boolean;
  /** How many child categories were archived along with a heading. */
  readonly childrenArchived: number;
}

/**
 * `DELETE /categories/{id}` — archive, never delete. `categories.archived_at`
 * already exists for exactly this (migration 0006: "a category with three
 * years of history behind it cannot be removed without orphaning those rows or
 * rewriting them"), so archiving is the whole implementation: every
 * `category_assignments` row, every `rules.actions[].categoryKey` and every
 * `provider_category_map`/`mcc_codes` row that points at this id keeps
 * resolving exactly as before — the row is still there, `listCategories`
 * simply omits it unless `includeArchived` is asked for.
 *
 * Archiving a heading cascades to its non-archived children: a leaf left
 * visible under a heading the picker no longer shows would be reachable by id
 * (an existing assignment) but not by browsing, which is a worse state than
 * archiving both.
 */
export async function archiveCategory(
  executor: CategorizationExecutor,
  input: { readonly userId: string; readonly categoryId: string },
  context: { readonly clock: Clock },
): Promise<ArchiveCategoryResult> {
  const existing = await requireOwnCategory(executor, input.userId, input.categoryId);
  if (existing.archivedAt !== null) {
    const categories = await listCategories(executor, input.userId, { includeArchived: true });
    const category = categories.find((entry) => entry.id === input.categoryId);
    if (category === undefined) {
      throw new CategorizationError(
        'categorization.category_not_found',
        `no category ${input.categoryId}`,
        { categoryId: input.categoryId },
      );
    }
    return { category, changed: false, childrenArchived: 0 };
  }

  const now = context.clock.now().toISOString();
  await executor.execute(sql`
    UPDATE categories SET archived_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
     WHERE id = ${input.categoryId} AND user_id = ${input.userId}
  `);
  const cascaded = await executor.execute<{ id: string }>(sql`
    UPDATE categories SET archived_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
     WHERE parent_id = ${input.categoryId} AND user_id = ${input.userId} AND archived_at IS NULL
    RETURNING id
  `);

  const categories = await listCategories(executor, input.userId, { includeArchived: true });
  const category = categories.find((entry) => entry.id === input.categoryId);
  if (category === undefined) {
    throw new CategorizationError(
      'categorization.category_not_found',
      `no category ${input.categoryId}`,
      { categoryId: input.categoryId },
    );
  }
  return { category, changed: true, childrenArchived: cascaded.rows.length };
}
