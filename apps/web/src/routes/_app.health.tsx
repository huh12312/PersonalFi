// SPDX-License-Identifier: MIT
import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * Layout route for `/health` and `/health/{pillar}` (WP 10.12): no chrome of its own beyond the app shell; the
 * screen is `_app.health.index.tsx`, a pillar's detail `_app.health.$pillar.tsx`.
 */
export const Route = createFileRoute('/_app/health')({
  component: () => <Outlet />,
});
