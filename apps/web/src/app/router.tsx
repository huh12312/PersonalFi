// SPDX-License-Identifier: MIT
import { createRouter } from '@tanstack/react-router';

import { routeTree } from '../routeTree.gen.ts';

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultPreloadStaleTime: 0, // let TanStack Query's own staleTime govern caching (05 §1.5)
});

// Typed router registration (05-frontend-architecture.md §1.3 — "the single
// best type story in the list"): every <Link to> and loader result is typed
// from this module onward.
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
