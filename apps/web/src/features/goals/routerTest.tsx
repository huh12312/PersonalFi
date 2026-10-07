// SPDX-License-Identifier: MIT
/**
 * Test-only: mounts a component that renders `<Link>`s inside a memory router, with the routes the
 * plan and goals screens link to. Mirrors the wrapper `features/accounts/notices.test.tsx` builds.
 */
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';

export function RouterForTest({
  children,
  initial = '/',
}: {
  children: ReactNode;
  initial?: string;
}) {
  const root = createRootRoute();
  const index = createRoute({ getParentRoute: () => root, path: '/', component: () => children });
  const goals = createRoute({
    getParentRoute: () => root,
    path: '/goals',
    component: () => children,
  });
  const plan = createRoute({ getParentRoute: () => root, path: '/plan', component: () => null });
  const account = createRoute({
    getParentRoute: () => root,
    path: '/accounts/$accountId',
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([index, goals, plan, account]),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  return <RouterProvider router={router} />;
}
