// SPDX-License-Identifier: MIT
import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { IdleLockOverlay } from '../../features/auth/IdleLockOverlay.tsx';
import { BottomTabs } from './BottomTabs.tsx';
import { CommandPalette } from './CommandPalette.tsx';
import { titleForPath } from './document-title.ts';
import { Sidebar } from './Sidebar.tsx';
import { TopBar } from './TopBar.tsx';

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
      {/* 2.4.1 Bypass Blocks: the first stop for a keyboard user, hidden until it has focus. The target is
          focused by script rather than followed as a `#hash`, which would put a fragment in the router's URL. */}
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[110] focus:rounded-md focus:bg-bg-surface-raised focus:px-4 focus:py-2 focus:text-small focus:font-medium focus:text-text-primary focus:shadow-[var(--shadow-elev-3)]"
      >
        Skip to main content
      </a>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={titleForPath(pathname)} onOpenSearch={() => setSearchOpen(true)} />
        <main
          id="main-content"
          tabIndex={-1}
          style={{ outline: 'none' }}
          className="flex-1 scroll-pb-24 overflow-y-auto px-4 pb-20 pt-4 md:px-6 lg:scroll-pb-4 lg:px-8 lg:pb-6"
        >
          {children}
        </main>
      </div>
      <BottomTabs />
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <IdleLockOverlay />
    </div>
  );
}
