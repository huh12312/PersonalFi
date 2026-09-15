// SPDX-License-Identifier: MIT
import { createFileRoute, Outlet } from '@tanstack/react-router';

/**
 * Layout route for `/accounts`, `/accounts/{id}`, and `/accounts/connections`
 * — a pathless-in-spirit parent (it does render `/accounts` itself, via the
 * sibling `_app.accounts.index.tsx`) so the three screens share no chrome
 * beyond what `_app.tsx`'s `AppShell` already provides; each child owns its
 * own heading and empty/loading states.
 */
export const Route = createFileRoute('/_app/accounts')({
  component: () => <Outlet />,
});
