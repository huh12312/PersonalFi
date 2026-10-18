// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { CategoryDetailScreen } from '../features/categories/CategoryDetailScreen.tsx';

const searchSchema = z.object({
  /** The selected month, `YYYY-MM`; absent = the current month. */
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/u)
    .optional(),
});

/** `/categories/{id}` (WP 10.14, V7): one category's months against its average, and its transactions. */
export const Route = createFileRoute('/_app/categories/$categoryId')({
  validateSearch: searchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { categoryId } = Route.useParams();
  const { month } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <CategoryDetailScreen
      categoryId={categoryId}
      month={month}
      onMonthChange={(next) => void navigate({ search: { month: next }, replace: true })}
    />
  );
}
