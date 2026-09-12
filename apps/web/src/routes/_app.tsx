// SPDX-License-Identifier: MIT
import { createFileRoute, Outlet } from '@tanstack/react-router';

import { AppShell } from '../app/shell/AppShell.tsx';

/**
 * Pathless layout route: every authenticated screen (Dashboard, Transactions,
 * Budget, Recurring, Accounts, Investments, Plan, Insights, Settings) nests
 * under this one so the sidebar/bottom-tabs/top-bar/command-palette/idle-lock
 * shell mounts exactly once, regardless of which child route is active.
 */
export const Route = createFileRoute('/_app')({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
