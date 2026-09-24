// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { InvestmentsScreen } from '../features/investments/InvestmentsScreen.tsx';
import { investmentsSearchSchema } from '../features/investments/search.ts';

/**
 * `/investments` (WP 3.11), replacing the Phase 1 `PlaceholderRoute`.
 *
 * `validateSearch` is where the screen's whole view state lives — the tab,
 * the open account, the allocation dimension, the valuation basis and the
 * drift targets — the `_app.transactions.tsx` shape. `replace: true` keeps a
 * tab flick out of the Back stack while still making every view a URL
 * somebody can paste.
 */
export const Route = createFileRoute('/_app/investments')({
  validateSearch: investmentsSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <InvestmentsScreen
      search={search}
      onSearchChange={(next) => void navigate({ search: next, replace: true })}
    />
  );
}
