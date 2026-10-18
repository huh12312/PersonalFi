// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { BudgetScreen } from '../features/budget/BudgetScreen.tsx';

/**
 * `/budget`. WP 10.11: the view (`By group`, the default, left out of the URL; or `?view=variability`) is URL
 * state, so a link to the variability view is shareable and Back returns to the previous view. A bad value falls
 * back to the default.
 */
const budgetSearchSchema = z.object({
  view: z.enum(['variability']).optional().catch(undefined),
});

export const Route = createFileRoute('/_app/budget')({
  validateSearch: budgetSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BudgetScreen
      view={search.view === 'variability' ? 'variability' : 'group'}
      onViewChange={(view) =>
        void navigate({ search: view === 'variability' ? { view: 'variability' } : {} })
      }
    />
  );
}
