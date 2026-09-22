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
 */
import {
  archiveCategory,
  createCategory,
  listCategories,
  renameCategory,
  type UserCategory,
} from '@ctx/categorization';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { problems } from '../problem.ts';
import { booleanQuery, instantOrNull } from '../wire.ts';
import { mapDomainErrors } from './domain-errors.ts';
import type { RouteDeps } from './deps.ts';

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
            },
            { clock },
          ),
        );
        return reply.code(201).send({ category: serialiseCategory(category) });
      },
    );

    app.patch(
      '/categories/:categoryId',
      {
        schema: {
          operationId: 'renameCategory',
          summary: 'Rename or re-describe a category',
          description:
            'Deliberately narrow: `label`, `description` and `icon` only. `kind` and the ' +
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
            })
            .refine(
              (body) =>
                body.label !== undefined ||
                body.description !== undefined ||
                body.icon !== undefined,
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
