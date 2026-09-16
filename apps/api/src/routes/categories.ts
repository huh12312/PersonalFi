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
import { listCategories, type UserCategory } from '@ctx/categorization';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { problems } from '../problem.ts';
import { booleanQuery, instantOrNull } from '../wire.ts';
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
  const { guards, database } = deps;

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
            'at one. Categories are per user (decision D6), so this is never a shared list.',
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
        // Delegated, never raw SQL: `assignable` is derived from the table's own
        // parent/child shape and the ordering tiebreak exists so two categories
        // sharing a `sort` come back stably. A second query here would be a
        // second answer to "what categories are there?".
        const categories = await listCategories(database, session.userId, {
          ...(request.query.includeArchived === undefined
            ? {}
            : { includeArchived: request.query.includeArchived }),
        });
        return { categories: categories.map(serialiseCategory) };
      },
    );
  };
};
