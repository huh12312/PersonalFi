// SPDX-License-Identifier: MIT
import { createFileRoute } from '@tanstack/react-router';

import { ReportsScreen } from '../features/reports/ReportsScreen.tsx';

/**
 * `/reports` (WP 2.9's own "Owns" list: `apps/web/src/routes/_app.reports.tsx`).
 * Not in `src/app/shell/nav-items.ts`'s `NAV_GROUPS`/`NavPath` union — that
 * file is shared, out of this work package's ownership, and every route it
 * already lists (Budget, Recurring, Insights, ...) was there before this
 * work package started. Reports is reachable via a link on the budget
 * screen's header (`BudgetScreen.tsx`) and by URL; adding it to the global
 * nav is a one-line follow-up left to the orchestrator (see
 * `docs/evidence/phase-2/wp2.9-budget-ui.md`'s open items).
 */
export const Route = createFileRoute('/_app/reports')({
  component: ReportsScreen,
});
