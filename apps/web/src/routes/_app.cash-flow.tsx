// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { CashFlowScreen } from '../features/cash-flow/CashFlowScreen.tsx';
import { cashFlowSearchSchema, searchOf, viewOf } from '../features/cash-flow/view.ts';

/**
 * `/cash-flow` (WP 10.10). The whole view — tab, display, timeframe, period, breakdown, comparison — is URL search
 * state (`features/cash-flow/view.ts`), defaults left out, so a link to a view is shareable inside the app and Back
 * walks the holder's own steps (each change is a history entry, unlike `/transactions`' filter typing).
 */
export const Route = createFileRoute('/_app/cash-flow')({
  validateSearch: cashFlowSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <CashFlowScreen
      view={viewOf(search)}
      onViewChange={(next) => void navigate({ search: searchOf(next) })}
    />
  );
}
