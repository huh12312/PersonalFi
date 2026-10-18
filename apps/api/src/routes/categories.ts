// SPDX-License-Identifier: MIT
/**
 * `GET /categories` — the chart of categories a user may assign to.
 *
 * ## Why this route did not exist until now
 *
 * The Phase 1 re-gate (gate-security-review.md N-3) walked the app in a real
 * browser and could not set a category from the UI. Not because the write path
 * was broken — `PATCH /transactions/{id}` with a `categoryId` was proven to
 * persist against the running deployment — but because there was nothing to
 * pick *from*: no route listed categories, `select count(*) from categories`
 * returned `0`, and `CategoryPicker` rendered a single "Uncategorized" option
 * and said so in its own doc comment. A write path with no reachable read model
 * is a feature nobody has.
 *
 * So this route is half of condition D-6. The other half is the boot pass in
 * `app.ts` that puts the shipped taxonomy into the table for every user, because
 * a route over an empty table is the same empty picker with more steps.
 *
 * ## Flat, with parents named, rather than nested
 *
 * The taxonomy is two levels (decision D18/WP 1.4: ~20 top-level × 2 levels) and
 * the obvious wire shape is a tree. This returns a flat array in display order
 * with `parentId` on each row instead, for three reasons that all point the same
 * way: a tree in OpenAPI 3.1 is a self-referencing `$ref` that `openapi-ts`
 * generates as a recursive type the picker then has to flatten anyway; the sort
 * order the user sees is a property of the *list* and survives flattening but
 * not nesting; and a user's own custom category — which `TAXONOMY` has never
 * heard of — is one more row here and a special case there.
 *
 * `assignable` is computed by the read model from the table (a row with children
 * is a heading, not a destination), so the client never has to know that rule.
 *
 * `hue` (WP 10.8, migration 0045) is the chart hue a category is drawn in — one of
 * the kernel's thirteen `CHART_HUES`. The read model assigns `hueForId(id)` on the
 * first read and persists it; every later read returns the stored value, which
 * `PATCH` may change.
 *
 * `emoji` (WP 10.14, migration 0050) is the one emoji the holder chose, or null. Unlike `hue` it is never seeded:
 * the shipped default for a system key (`CATEGORY_DEFAULT_EMOJI`) and a custom category's initials are display
 * fallbacks the web draws for a null, and nothing writes them. `isSingleEmoji` (@core/kernel) is the one rule for
 * what may be stored, applied here on the body and again in `@ctx/categorization` before the write.
 */
import { CHART_HUES, isSingleEmoji, todayIn } from '@core/kernel';
import {
  archiveCategory,
  CATEGORY_VARIABILITIES,
  createCategory,
  listCategories,
  renameCategory,
  type UserCategory,
} from '@ctx/categorization';
import { listAggregateRowsInWindow } from '@ctx/ledger';
import { listSeries } from '@ctx/recurring';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { problems } from '../problem.ts';
import {
  isSuggestingSeries,
  suggestFixedCategories,
  suggestionWindow,
} from '../reports/variability-suggestions.ts';
import { booleanQuery, instantOrNull } from '../wire.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

const chartHueSchema = z
  .enum(CHART_HUES)
  .describe(
    'The chart hue this category is drawn in: one of thirteen named hues (the web reads ' +
      '`--chart-fill-<hue>`). Assigned once, on first read, from a hash of the id; stable after ' +
      'that, and editable by `PATCH /categories/{id}`.',
  )
  .meta({ id: 'ChartHue' });

const variabilitySchema = z
  .enum(CATEGORY_VARIABILITIES)
  .describe(
    "How this category's spending behaves: `fixed` (the same most periods), `flexible` (varies with choices " +
      'made inside the period) or `non_monthly` (irregular or annual). Set only by the holder (WP 10.11, ' +
      'migration 0047); a recurring stream only suggests `fixed` (`GET /categories/variability-suggestions`).',
  )
  .meta({ id: 'CategoryVariability' });

/** A write's `emoji`: exactly one emoji, or null to clear. The 32 is UTF-16 units, well above 8 code points. */
const emojiInputSchema = z
  .string()
  .max(32)
  .refine(isSingleEmoji, 'emoji must be exactly one emoji')
  .nullable()
  .optional()
  .describe(
    'Exactly one emoji (one extended grapheme cluster, at most 8 code points). null clears it, and the web ' +
      'falls back to the shipped default for a system category or the initials. Omitted: unchanged on PATCH, ' +
      'none on POST.',
  );

const categorySchema = z
  .object({
    id: z.uuid().describe('What `PATCH /transactions/{id}` accepts as `categoryId`.'),
    key: z
      .string()
      .describe(
        'Stable across releases and renames — what rules and the provider mapping key on. ' +
          'A user-created category has one too, so this is never a `TAXONOMY` lookup.',
      ),
    parentId: z.uuid().nullable().describe('null for a top-level heading.'),
    label: z.string(),
    description: z.string(),
    kind: z.enum(['income', 'expense', 'transfer', 'investment', 'other']),
    icon: z.string().describe('A Lucide icon name (decision D20). A key, never markup.'),
    hue: chartHueSchema,
    variability: variabilitySchema.nullable().describe('null = not yet classified by the holder.'),
    emoji: z
      .string()
      .nullable()
      .describe(
        'One emoji (one extended grapheme cluster), set by the holder. null = none set; the web then shows ' +
          "the shipped default for a system category's key, or the initials — the default is never written.",
      ),
    sort: z.number().int(),
    isSystem: z.boolean().describe('true for a row the shipped taxonomy installed.'),
    archivedAt: z
      .string()
      .nullable()
      .describe(
        'Archived categories are hidden, never deleted: a budget from March must still ' +
          'say what it meant. Only present when `includeArchived` was asked for.',
      ),
    assignable: z
      .boolean()
      .describe(
        'false for a heading with children. Money lands on a leaf; a grouping is not a ' +
          'destination.',
      ),
  })
  .meta({ id: 'Category' });

function serialiseCategory(category: UserCategory): z.infer<typeof categorySchema> {
  return {
    id: category.id,
    key: category.key,
    parentId: category.parentId,
    label: category.label,
    description: category.description,
    kind: category.kind,
    icon: category.icon,
    hue: category.hue,
    variability: category.variability,
    emoji: category.emoji,
    sort: category.sort,
    isSystem: category.isSystem,
    archivedAt: instantOrNull(category.archivedAt),
    assignable: category.assignable,
  };
}

export const categoryRoutes = (deps: RouteDeps): FastifyPluginAsyncZod => {
  const { guards, database, clock } = deps;

  return async (app) => {
    app.get(
      '/categories',
      {
        schema: {
          operationId: 'listCategories',
          summary: "This user's chart of categories, in display order",
          description:
            'Flat and ordered: a child follows its parent, and `parentId` carries the ' +
            'structure. Archived categories are omitted unless asked for — a picker must ' +
            'not offer a category the user retired, but a historic assignment still points ' +
            'at one. Categories are per user (decision D6), so this is never a shared list.\n\n' +
            "Taxonomy is seeded once, at user creation, by `bootstrap-seed.ts`'s " +
            '`seedUserState` (condition C-1, docs/evidence/phase-2/gate-security-review.md ' +
            '§5) — this route used to carry a D2-1 lazy repair for the gap that left; the ' +
            'repair is gone and this route is a plain read.',
          tags: ['categories'],
          querystring: z.object({
            includeArchived: booleanQuery.describe(
              'Default false. Set only by a management screen, never by a picker.',
            ),
          }),
          response: {
            200: z.object({ categories: z.array(categorySchema) }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const query = {
          ...(request.query.includeArchived === undefined
            ? {}
            : { includeArchived: request.query.includeArchived }),
        };
        // Delegated, never raw SQL: `assignable` is derived from the table's own
        // parent/child shape and the ordering tiebreak exists so two categories
        // sharing a `sort` come back stably. A second query here would be a
        // second answer to "what categories are there?".
        //
        // No lazy repair: `bootstrap-seed.ts`'s `seedUserState` seeds the
        // taxonomy at user creation (C-1), so an empty result here means the
        // user genuinely archived every category, not a cold-install gap.
        const categories = await listCategories(database, session.userId, query);
        return { categories: categories.map(serialiseCategory) };
      },
    );

    app.post(
      '/categories',
      {
        schema: {
          operationId: 'createCategory',
          summary: 'Create a custom category',
          description:
            '05 §5.2\'s "create new category" escape hatch. `parentId: null` creates a new ' +
            'top-level heading; a non-null `parentId` creates a leaf under it and inherits its ' +
            '`kind` (a leaf cannot have a different kind than its parent — that is what keeps a ' +
            "spend report's totals meaning what they say). The two-level `CHECK` " +
            '(migration 0006) is enforced before the write: a `parentId` that already has a ' +
            'parent of its own is refused, not silently flattened.',
          tags: ['categories'],
          body: z.object({
            parentId: z.uuid().nullable(),
            label: z.string().min(1).max(120),
            description: z.string().max(2_000).optional(),
            icon: z.string().min(1).max(64).optional(),
            kind: z
              .enum(['income', 'expense', 'transfer', 'investment', 'other'])
              .optional()
              .describe("Only used when `parentId` is null. A leaf inherits its parent's."),
            hue: chartHueSchema
              .optional()
              .describe('Omitted: seeded from the new id, as a first read would.'),
            variability: variabilitySchema
              .nullable()
              .optional()
              .describe('Omitted or null: unclassified.'),
            emoji: emojiInputSchema,
          }),
          response: {
            201: z.object({ category: categorySchema }),
            ...problems(400, 401, 404, 422, 503),
          },
        },
      },
      async (request, reply) => {
        const session = await guards.requireSession(request);
        const category = await mapDomainErrors(() =>
          createCategory(
            database,
            {
              userId: session.userId,
              parentId: request.body.parentId,
              label: request.body.label,
              ...(request.body.description === undefined
                ? {}
                : { description: request.body.description }),
              ...(request.body.icon === undefined ? {} : { icon: request.body.icon }),
              ...(request.body.kind === undefined ? {} : { kind: request.body.kind }),
              ...(request.body.hue === undefined ? {} : { hue: request.body.hue }),
              ...(request.body.variability === undefined
                ? {}
                : { variability: request.body.variability }),
              ...(request.body.emoji === undefined ? {} : { emoji: request.body.emoji }),
            },
            { clock },
          ),
        );
        return reply.code(201).send({ category: serialiseCategory(category) });
      },
    );

    app.get(
      '/categories/variability-suggestions',
      {
        schema: {
          operationId: 'listCategoryVariabilitySuggestions',
          summary: 'Unclassified expense categories a recurring stream suggests are fixed',
          description:
            'A suggestion, computed on read and never written (WP 10.11): an expense category with no ' +
            "`variability`, into which an active outflow recurring stream's merchant mostly spends, is " +
            'suggested `fixed`. The budget screen shows it as a "Suggested" chip until the holder confirms ' +
            'it with `PATCH /categories/{id}`. A classified category is never suggested. The rules are in ' +
            '`apps/api/src/reports/variability-suggestions.ts`.',
          tags: ['categories'],
          response: {
            200: z.object({
              suggestions: z.array(
                z.object({
                  categoryId: z.uuid(),
                  variability: z.literal('fixed'),
                  seriesIds: z
                    .array(z.uuid())
                    .describe('The active outflow streams behind the suggestion.'),
                }),
              ),
            }),
            ...problems(401, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const series = (
          await listSeries(database, { userId: session.userId, states: ['ACTIVE'] })
        ).filter(isSuggestingSeries);
        const timezone = await deps.pool.query<{ display_timezone: string }>(
          `SELECT display_timezone FROM users WHERE id = $1`,
          [session.userId],
        );
        const today = todayIn(clock, timezone.rows[0]?.display_timezone ?? 'UTC');
        const window = suggestionWindow(series, today);
        if (window === null) return { suggestions: [] };
        const [rows, categories] = await Promise.all([
          listAggregateRowsInWindow(database, {
            userId: session.userId,
            filters: {
              dateFrom: window.from,
              dateTo: window.to,
              merchantIds: [...new Set(series.map((s) => s.merchantId))],
            },
          }),
          listCategories(database, session.userId),
        ]);
        return { suggestions: suggestFixedCategories({ series, rows, categories }) };
      },
    );

    app.patch(
      '/categories/:categoryId',
      {
        schema: {
          operationId: 'renameCategory',
          summary: 'Rename, re-describe, recolour, re-icon or classify a category',
          description:
            'Deliberately narrow: `label`, `description`, `icon`, `hue`, `variability` and `emoji` only ' +
            "(`variability: null` returns a category to unclassified; `emoji: null` clears the holder's " +
            'emoji, and the web falls back to the default again). `kind` and the ' +
            'parent/child structure are not editable here — both are structural (the seeding ' +
            "pass's own rule for why a re-seed never touches them) and changing either after " +
            'transactions have been filed under a category is how a report silently moves ' +
            'money between totals. Works on a system category as well as a custom one: a user ' +
            'renaming "Dining & Drinks" to "Eating Out" is exactly what this is for.',
          tags: ['categories'],
          params: z.object({ categoryId: z.uuid() }),
          body: z
            .object({
              label: z.string().min(1).max(120).optional(),
              description: z.string().max(2_000).optional(),
              icon: z.string().min(1).max(64).optional(),
              hue: chartHueSchema.optional(),
              variability: variabilitySchema.nullable().optional(),
              emoji: emojiInputSchema,
            })
            .refine(
              (body) =>
                body.label !== undefined ||
                body.description !== undefined ||
                body.icon !== undefined ||
                body.hue !== undefined ||
                body.variability !== undefined ||
                body.emoji !== undefined,
              'a PATCH with no fields changes nothing; say what to change',
            ),
          response: {
            200: z.object({ category: categorySchema }),
            ...problems(400, 401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const category = await mapDomainErrors(() =>
          renameCategory(
            database,
            {
              userId: session.userId,
              categoryId: request.params.categoryId,
              ...(request.body.label === undefined ? {} : { label: request.body.label }),
              ...(request.body.description === undefined
                ? {}
                : { description: request.body.description }),
              ...(request.body.icon === undefined ? {} : { icon: request.body.icon }),
              ...(request.body.hue === undefined ? {} : { hue: request.body.hue }),
              ...(request.body.variability === undefined
                ? {}
                : { variability: request.body.variability }),
              ...(request.body.emoji === undefined ? {} : { emoji: request.body.emoji }),
            },
            { clock },
          ),
        );
        return { category: serialiseCategory(category) };
      },
    );

    app.delete(
      '/categories/:categoryId',
      {
        schema: {
          operationId: 'archiveCategory',
          summary: 'Archive a category',
          description:
            'Archives, never deletes (same reasoning as a closed account or a removed ' +
            'transaction): every `category_assignments`, `rules` and provider-mapping row ' +
            'that points at this id keeps resolving exactly as before, and `GET /categories` ' +
            'simply omits it unless `includeArchived` is asked for. Archiving a heading also ' +
            'archives its non-archived children — a leaf left visible under a heading the ' +
            'picker no longer shows would be reachable only by id, which is a worse state ' +
            'than archiving both. Idempotent: archiving an already-archived category is a ' +
            '200 with `changed: false`.',
          tags: ['categories'],
          params: z.object({ categoryId: z.uuid() }),
          response: {
            200: z.object({
              category: categorySchema,
              changed: z.boolean(),
              childrenArchived: z.int().nonnegative(),
            }),
            ...problems(401, 404, 503),
          },
        },
      },
      async (request) => {
        const session = await guards.requireSession(request);
        const result = await mapDomainErrors(() =>
          archiveCategory(
            database,
            { userId: session.userId, categoryId: request.params.categoryId },
            { clock },
          ),
        );
        return {
          category: serialiseCategory(result.category),
          changed: result.changed,
          childrenArchived: result.childrenArchived,
        };
      },
    );
  };
};
