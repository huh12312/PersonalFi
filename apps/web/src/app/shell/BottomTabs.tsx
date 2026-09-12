// SPDX-License-Identifier: MIT
import { Link, useRouterState } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/cn.ts';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../components/ui/dialog.tsx';
import { BOTTOM_TABS, MORE_NAV_ITEMS } from './nav-items.ts';

/**
 * Mobile bottom tab bar, <768px (§4.2): 5 items, labels always visible
 * (icon-only tab bars fail comprehension and WCAG 2.2 label-in-name), safe
 * area honoured on notched phones. "More" opens a bottom sheet listing the
 * remaining destinations rather than cramming a 6th tab in.
 */
export function BottomTabs() {
  const [moreOpen, setMoreOpen] = useState(false);
  const currentPath = useRouterState({ select: (s) => s.location.pathname });
  const moreActive = MORE_NAV_ITEMS.some((item) => item.to === currentPath);

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex h-14 items-stretch border-t border-border-hairline bg-bg-surface/92 backdrop-blur-md pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {BOTTOM_TABS.map((item) => {
          const active = currentPath === item.to;
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              className="flex flex-1 flex-col items-center justify-center gap-0.5"
              aria-current={active ? 'page' : undefined}
            >
              <Icon
                size={22}
                aria-hidden="true"
                className={active ? 'text-accent-text' : 'text-text-muted'}
              />
              <span
                className={cn(
                  'text-[11px] leading-none',
                  active ? 'font-medium text-accent-text' : 'text-text-muted',
                )}
              >
                {item.label}
              </span>
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className="flex flex-1 flex-col items-center justify-center gap-0.5"
          aria-haspopup="dialog"
        >
          <Menu
            size={22}
            aria-hidden="true"
            className={moreActive ? 'text-accent-text' : 'text-text-muted'}
          />
          <span
            className={cn(
              'text-[11px] leading-none',
              moreActive ? 'font-medium text-accent-text' : 'text-text-muted',
            )}
          >
            More
          </span>
        </button>
      </nav>

      <Dialog open={moreOpen} onOpenChange={setMoreOpen}>
        <DialogContent variant="sheet">
          <DialogTitle>More</DialogTitle>
          <DialogDescription>
            Accounts, investments, plan, recurring, and settings.
          </DialogDescription>
          <ul className="mt-4 flex flex-col gap-1">
            {MORE_NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.to}>
                  <Link
                    to={item.to}
                    onClick={() => setMoreOpen(false)}
                    className="flex h-12 items-center gap-3 rounded-md px-3 text-body text-text-primary hover:bg-bg-subtle"
                  >
                    <Icon size={20} aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
