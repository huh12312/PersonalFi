// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import {
  createCategoryMutation,
  listCategoriesOptions,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Category } from '../../api/generated/types.gen.ts';

/**
 * The chart of categories is the most cacheable thing this app fetches.
 *
 * It changes when the user renames a category or the app ships a new release —
 * never on a sync, never on an edit, never on a filter change. Every screen that
 * renders a `CategoryPicker` (the detail sheet, the bulk bar, and in Phase 2 the
 * rules and budget editors) shares one query key, so the list is fetched once
 * per session and the picker in a bulk bar costs nothing extra.
 *
 * Five minutes rather than `Infinity`: a reload should eventually pick up a
 * category added by a release the tab has outlived, and `Infinity` would mean
 * the only way to see it is a hard refresh.
 */
const CATEGORIES_STALE_TIME_MS = 5 * 60_000;

/** One option in a grouped picker: a heading, or an assignable child under it. */
export interface CategoryGroup {
  /** The heading. `null` for children that have no parent (e.g. `uncategorised`). */
  readonly parent: Category | null;
  readonly children: readonly Category[];
}

export interface UseCategoriesResult {
  readonly categories: readonly Category[];
  /** `id` → category, for rendering the *current* value of a picker by name. */
  readonly byId: ReadonlyMap<string, Category>;
  /**
   * Parent-then-children, in the server's display order. Built here rather than
   * in the picker so that the detail sheet, the bulk bar and anything Phase 2
   * adds all group the same way — and so the grouping is testable without
   * rendering a `<select>`.
   */
  readonly groups: readonly CategoryGroup[];
  readonly isLoading: boolean;
  readonly isError: boolean;
}

/**
 * `GET /categories` — this user's chart, in display order.
 *
 * Archived categories are deliberately not requested: a picker must not offer a
 * category the user retired. A transaction already assigned to an archived
 * category therefore renders its id rather than its label, which is the honest
 * failure — the alternative is offering the retired category to everyone.
 */
export function useCategories(): UseCategoriesResult {
  const query = useQuery({
    ...listCategoriesOptions(),
    staleTime: CATEGORIES_STALE_TIME_MS,
  });

  const categories = useMemo<readonly Category[]>(() => query.data?.categories ?? [], [query.data]);

  const byId = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  );

  const groups = useMemo<readonly CategoryGroup[]>(() => {
    // One pass, preserving the server's order. The response is already sorted
    // parent-before-child by `sort`, so a heading is seen before the children
    // that name it — but the grouping does not *rely* on that: a child whose
    // parent is missing (or who has none at all, which is how `uncategorised`
    // arrives) lands in a headless group rather than vanishing from the picker.
    interface MutableGroup {
      parent: Category | null;
      readonly children: Category[];
    }
    const order: MutableGroup[] = [];
    const byParentId = new Map<string, MutableGroup>();
    let headless: MutableGroup | null = null;

    const groupFor = (parentId: string | null): MutableGroup => {
      if (parentId === null) {
        if (headless === null) {
          headless = { parent: null, children: [] };
          order.push(headless);
        }
        return headless;
      }
      let group = byParentId.get(parentId);
      if (group === undefined) {
        group = { parent: byId.get(parentId) ?? null, children: [] };
        byParentId.set(parentId, group);
        order.push(group);
      }
      return group;
    };

    for (const category of categories) {
      // A heading opens its own group where *it* appears, not where its first
      // child does, so the picker's order matches the server's.
      if (!category.assignable && category.parentId === null) {
        groupFor(category.id).parent ??= category;
        continue;
      }
      groupFor(category.parentId).children.push(category);
    }

    // A heading whose children are all archived would render as an empty
    // `<optgroup>`, which reads as a bug rather than as an empty group.
    return order.filter((group) => group.children.length > 0);
  }, [categories, byId]);

  return {
    categories,
    byId,
    groups,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}

/**
 * `POST /categories` (05 §5.2's "create new category" escape hatch, WP 2.5's
 * carry-over route). Invalidates `GET /categories` so the new row — and any
 * combobox reading `useCategories` — sees it on the very next render; there is
 * no optimistic insert because the server assigns `id`/`key`/`sort`, all of
 * which a picker needs to select the row it just created.
 */
export function useCreateCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...createCategoryMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listCategoriesOptions().queryKey });
    },
  });
}
