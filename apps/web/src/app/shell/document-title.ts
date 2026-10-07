// SPDX-License-Identifier: MIT
import { useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';

import { ALL_NAV_ITEMS } from './nav-items.ts';

/** The screen's own name — the top bar's heading — for a path under the authenticated shell. */
export function titleForPath(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const match = ALL_NAV_ITEMS.find((item) => item.to === pathname);
  if (match !== undefined) return match.label;
  if (pathname === '/accounts/connections') return 'Connections';
  if (pathname === '/settings/advisors') return 'Advisor management';
  if (pathname === '/reports') return 'Reports';
  if (pathname.startsWith('/accounts/')) return 'Account';
  return 'PersonalFi';
}

/** Screens outside the shell, which have no top bar of their own. */
const PUBLIC_TITLES: Readonly<Record<string, string>> = {
  '/login': 'Sign in',
  '/register': 'Set up a passkey',
  '/lock': 'Locked',
  '/unlock': 'Unlock',
  '/dev/kitchen-sink': 'Component gallery',
};

/**
 * WCAG 2.4.2 Page Titled. The document had one title, "PersonalFi", on every screen: a single-page app never
 * reloads, so nothing else would ever change it, and a screen-reader user switching tabs or hearing a route
 * change heard the same words for the dashboard as for the budget. "<screen> · PersonalFi", set on every route.
 */
export function documentTitleFor(pathname: string): string {
  const screen = PUBLIC_TITLES[pathname] ?? titleForPath(pathname);
  return screen === 'PersonalFi' ? 'PersonalFi' : `${screen} · PersonalFi`;
}

export function useDocumentTitle(): void {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    document.title = documentTitleFor(pathname);
  }, [pathname]);
}
