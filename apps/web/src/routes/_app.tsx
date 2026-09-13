// SPDX-License-Identifier: MIT
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

import { getSession, sessionQueryKey } from '../api/pending-contracts.ts';
import { AppShell } from '../app/shell/AppShell.tsx';

/**
 * Pathless layout route: every authenticated screen (Dashboard, Transactions,
 * Budget, Recurring, Accounts, Investments, Plan, Insights, Settings) nests
 * under this one so the sidebar/bottom-tabs/top-bar/command-palette/idle-lock
 * shell mounts exactly once, regardless of which child route is active.
 *
 * `beforeLoad` is the auth guard: it proves a visitor is signed in before the
 * shell, and eventually real financial data, mounts.
 *
 * It calls `context.queryClient.fetchQuery` rather than `getSession()`
 * directly so this check and `useSessionQuery` share one cache entry under
 * `sessionQueryKey` — a guard pass primes the cache instead of racing a
 * second request the moment the shell mounts.
 *
 * It uses `pending-contracts.ts` rather than the generated client because
 * every other `/auth/*` call site does. Splitting just the guard onto the
 * generated client would mean two auth clients with two query-key namespaces
 * guarding the same session; re-point them all together when the TODO in
 * `pending-contracts.ts`'s header is ready to close out.
 */
export const Route = createFileRoute('/_app')({
  beforeLoad: async ({ context, location }) => {
    try {
      await context.queryClient.fetchQuery({
        queryKey: sessionQueryKey,
        queryFn: getSession,
      });
    } catch {
      throw redirect({ to: '/login', search: { redirect: location.href } });
    }
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
