// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { BriefDashboardCard } from '../features/brief/BriefDashboardCard.tsx';
import { DashboardScreen } from '../features/dashboard/DashboardScreen.tsx';
import { netWorthSearchSchema } from '../features/networth/search.ts';
import { BackupStatusLine } from '../features/ops/BackupStatusLine.tsx';

/**
 * `/` — Dashboard. `validateSearch` adds `netWorthRange` (WP 3.12), the one
 * piece of URL state the net-worth full view needs to round-trip — the same
 * `validateSearch` + `Route.useSearch()`/`Route.useNavigate()` shape as
 * `_app.transactions.tsx`'s own search schema.
 */
export const Route = createFileRoute('/_app/')({
  validateSearch: netWorthSearchSchema,
  component: DashboardRoute,
});

/**
 * The hero net-worth figure (gate finding G3-2's fix). Lives with the net worth widget since WP 10.9; re-exported
 * here so `-app.index.test.tsx` keeps pinning it where the gate found it.
 */
export { NetWorthHero } from '../features/dashboard/widgets/NetWorthWidget.tsx';

/**
 * The widget grid (WP 10.9: net worth, spending pace, budgets, upcoming, to review, goals, investments, top
 * insights — each in its own card, ordered and shown per the holder's Customize choices), then this week's Brief
 * and the backup status line, which are not widgets and are always shown.
 */
function DashboardRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-4">
      <DashboardScreen
        {...(search.netWorthRange === undefined ? {} : { netWorthRange: search.netWorthRange })}
        onNetWorthRangeChange={(range) =>
          void navigate({ search: { ...search, netWorthRange: range }, replace: true })
        }
      />
      <BriefDashboardCard />
      <BackupStatusLine />
    </div>
  );
}
