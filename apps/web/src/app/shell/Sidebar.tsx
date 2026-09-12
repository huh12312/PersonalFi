// SPDX-License-Identifier: MIT
import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useState } from 'react';

import { cn } from '../../lib/cn.ts';
import { SyncStatusPill } from '../../components/patterns/SyncStatusPill.tsx';
import { NAV_GROUPS } from './nav-items.ts';

const COLLAPSE_KEY = 'personalfi:sidebar-collapsed';

/**
 * Desktop persistent sidebar, ≥1024px (§4.2): 248px, collapsible to a 64px
 * icon rail, collapse state persisted across sessions. Below `lg` the caller
 * (`AppShell`) doesn't render this at all — the bottom tab bar takes over.
 */
export function Sidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(COLLAPSE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const currentPath = useRouterState({ select: (s) => s.location.pathname });

  function toggleCollapsed(): void {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, String(next));
      } catch {
        // best-effort persistence only
      }
      return next;
    });
  }

  return (
    <aside
      className={cn(
        'hidden shrink-0 flex-col border-r border-border-hairline bg-bg-surface transition-[width] duration-base ease-standard lg:flex',
        collapsed ? 'w-16' : 'w-[248px]',
      )}
    >
      <div className="flex h-14 items-center px-4">
        <span className={cn('text-h3 font-semibold text-text-primary', collapsed && 'sr-only')}>
          PersonalFi
        </span>
      </div>

      {/* `aria-label` belongs on the element with the implicit `navigation`
          role (this `<nav>`), not the wrapping `<aside>` (`complementary`) —
          `getByRole('navigation', { name: 'Primary' })` needs the accessible
          name on the actual landmark. */}
      <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 py-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-4">
            {!collapsed && (
              <div className="px-2.5 pb-1.5 text-caption font-semibold uppercase tracking-wide text-text-muted">
                {group.label}
              </div>
            )}
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const active = currentPath === item.to;
                const Icon = item.icon;
                return (
                  <li key={item.to}>
                    <Link
                      to={item.to}
                      className={cn(
                        'flex h-10 items-center gap-3 rounded-md px-2.5 text-small font-medium text-text-secondary hover:bg-bg-subtle focus-visible:outline-none',
                        active && 'bg-accent-wash text-accent-text hover:bg-accent-wash',
                      )}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? item.label : undefined}
                    >
                      <Icon size={18} aria-hidden="true" className="shrink-0" />
                      <span className={cn(collapsed && 'sr-only')}>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="flex flex-col gap-2 border-t border-border-hairline p-3">
        {!collapsed && <SyncStatusPill status={{ kind: 'synced', label: 'Synced 4m ago' }} />}
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex h-9 items-center justify-center gap-2 rounded-md text-small text-text-muted hover:bg-bg-subtle focus-visible:outline-none"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? (
            <ChevronsRight size={16} aria-hidden="true" />
          ) : (
            <>
              <ChevronsLeft size={16} aria-hidden="true" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
