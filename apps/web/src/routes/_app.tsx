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
 * `beforeLoad` is the auth guard gate-remediation-web.md M-3/M-8 asked for:
 * with none of this wired up, every screen under `/` rendered for anyone who
 * could reach the URL, `useSessionQuery` (pending-contracts.ts) had zero call
 * sites, and there was no way to prove a visitor was signed in before the
 * shell (and, eventually, real financial data) mounted.
 *
 * It calls `context.queryClient.fetchQuery` rather than `getSession()`
 * directly so this check and `useSessionQuery` share one cache entry under
 * `sessionQueryKey` — a guard pass primes the cache instead of racing a
 * second request the moment the shell mounts.
 *
 * Client for this guard: `pending-contracts.ts`, not
 * `src/api/generated/@tanstack/react-query.gen.ts`. `pnpm --filter @app/web
 * gen` against `packages/contracts/openapi/openapi.json` *does* now emit a
 * relative `servers: [{ url: '/' }]` (the API team's half of this gate
 * remediation landed after this guard was first written against the old,
 * absolute-origin document) — so the condition that would have pushed this
 * onto the generated client instead no longer rules it out on its own. It's
 * still pending-contracts.ts, because every other `/auth/*` call site in
 * this codebase (`LoginScreen`, `IdleLockOverlay`, `LockScreen`,
 * `KekUnlockScreen`, `TopBar`'s sign-out) already imports from it: splitting
 * just the guard onto the generated client would mean two auth clients with
 * two query-key namespaces guarding the same session, for no benefit this
 * WP needs. Re-point every one of those imports together, in one pass, once
 * the TODO in pending-contracts.ts's header is ready to close out — not
 * piecemeal per call site.
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
