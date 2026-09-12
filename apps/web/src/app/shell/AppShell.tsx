// SPDX-License-Identifier: MIT
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { IdleLockOverlay } from '../../features/auth/IdleLockOverlay.tsx';
import { BottomTabs } from './BottomTabs.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { ALL_NAV_ITEMS } from './nav-items.ts';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';

function titleForPath(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  const match = ALL_NAV_ITEMS.find((item) => item.to === pathname);
  return match?.label ?? 'PersonalFi';
}

/**
 * The authenticated app frame: sidebar (desktop) or bottom tabs (mobile), a
 * top bar, the command palette, and the idle soft-lock overlay — everything
 * every screen under `/` shares. Route components render only their own
 * content into `children`.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [searchOpen, setSearchOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      const isCmdK = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (isCmdK) {
        event.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-bg-page">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={titleForPath(pathname)} onOpenSearch={() => setSearchOpen(true)} />
        <main className="flex-1 overflow-y-auto px-4 pb-20 pt-4 md:px-6 md:pb-6 lg:px-8">
          {children}
        </main>
      </div>
      <BottomTabs />
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <IdleLockOverlay />
    </div>
  );
}
