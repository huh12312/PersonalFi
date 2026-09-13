// SPDX-License-Identifier: MIT
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';

import { Button } from '../components/ui/button.tsx';

/**
 * Router context, typed once here and threaded through every route's
 * `beforeLoad`/`loader`. Currently holds only the shared `QueryClient` — the
 * `/_app` auth guard uses it to call
 * `fetchQuery` instead of a bare `fetch`, so a guard check and a component's
 * `useSessionQuery` share one cache entry instead of racing two requests.
 */
export interface RouterContext {
  queryClient: QueryClient;
}

/**
 * Root route: no chrome of its own (the authenticated shell lives in
 * `_app.tsx`; `/login`, `/lock`, `/unlock` render full-screen without it) —
 * only the two states every route tree needs regardless of what matched:
 * "this route threw" and "nothing matched" (§4.4 tier 3, route-level errors).
 */
export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => <Outlet />,
  errorComponent: ({ error, reset }) => (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg-page px-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle text-status-critical">
        <AlertTriangle size={22} aria-hidden="true" />
      </div>
      <h1 className="text-h2 text-text-primary">Something went wrong</h1>
      <p className="max-w-sm text-small text-text-muted">
        {error instanceof Error ? error.message : 'An unexpected error occurred.'}
      </p>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" onClick={reset}>
          Retry
        </Button>
        <Link
          to="/"
          className="inline-flex h-10 items-center justify-center rounded-md bg-accent px-4 text-sm font-medium text-accent-contrast hover:opacity-90"
        >
          Go to dashboard
        </Link>
      </div>
    </div>
  ),
  notFoundComponent: () => (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg-page px-4 text-center">
      <h1 className="text-h2 text-text-primary">Page not found</h1>
      <Link to="/" className="text-small text-accent-text hover:underline">
        Go to dashboard
      </Link>
    </div>
  ),
});
