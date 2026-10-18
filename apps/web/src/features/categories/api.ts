// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  getCategoryHistoryOptions,
  listCategoriesOptions,
  listCategoryVariabilitySuggestionsOptions,
  renameCategoryMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';

/** `GET /reports/category-history` (WP 10.14): the 13 months, the average and the comparison for one category. */
export function useCategoryHistory(categoryId: string) {
  return useQuery({
    ...getCategoryHistoryOptions({ query: { categoryId } }),
    enabled: categoryId !== '',
  });
}

/**
 * `PATCH /categories/{id}` from the category editor (WP 10.14): name, emoji, hue and variability in one write.
 * Invalidates the chart of categories (every icon, picker and chart reads it) and the variability suggestions.
 */
export function useUpdateCategoryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    ...renameCategoryMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: listCategoriesOptions().queryKey });
      void queryClient.invalidateQueries({
        queryKey: listCategoryVariabilitySuggestionsOptions().queryKey,
      });
    },
  });
}
