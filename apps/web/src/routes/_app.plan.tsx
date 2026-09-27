// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { PlanScreen } from '../features/plan/PlanScreen.tsx';
import { planSearchSchema } from '../features/plan/search.ts';

/**
 * `/plan` (WP 4.10), replacing the Phase 1 `PlaceholderRoute`
 * (`docs/plan/04-phase-4-dispatch.md` §3 "WP 4.10").
 *
 * `validateSearch` is where the screen's whole view state lives — the
 * selected scenario, the two scenarios under compare, and the ad hoc goal
 * target the fan chart's dashed line and gap solver use — the
 * `_app.investments.tsx` shape.
 */
export const Route = createFileRoute('/_app/plan')({
  validateSearch: planSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <PlanScreen
      search={search}
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
    />
  );
}
