// SPDX-License-Identifier: MIT
import { Link } from '@tanstack/react-router';

import { CategoryIcon } from '../../components/finance/CategoryIcon.tsx';
import { cn } from '../../lib/cn.ts';
import { useCategories } from './useCategories.ts';

/**
 * A category's icon and name, linking to its screen (WP 10.14: every category name in the app reaches
 * `/categories/:id`). Uncategorised, or a category the list does not have (archived), is the icon and the name
 * without a link — there is no screen to open.
 */
export function CategoryNameLink({
  categoryId,
  label,
  className,
}: {
  readonly categoryId: string | null;
  /** The name to show; defaults to the category's own. */
  readonly label?: string;
  readonly className?: string;
}) {
  const { byId } = useCategories();
  const category = categoryId === null ? undefined : byId.get(categoryId);
  const name = label ?? category?.label ?? (categoryId === null ? 'Uncategorised' : 'Category');
  const icon =
    category === undefined ? (
      <CategoryIcon
        category={{
          id: categoryId,
          label: name,
          key: categoryId === null ? 'uncategorised' : null,
          isSystem: categoryId === null,
        }}
        size="xs"
      />
    ) : (
      <CategoryIcon category={category} size="xs" />
    );
  if (category === undefined) {
    return (
      <span className={cn('inline-flex items-center gap-1.5', className)}>
        {icon}
        {name}
      </span>
    );
  }
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      {icon}
      <Link
        to="/categories/$categoryId"
        params={{ categoryId: category.id }}
        className="underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        data-category-link={category.id}
      >
        {name}
      </Link>
    </span>
  );
}
