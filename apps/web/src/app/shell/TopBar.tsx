// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { Eye, EyeOff, LogOut, Moon, Search, Sun } from 'lucide-react';

import { useLogoutMutation } from '../../api/pending-contracts.ts';
import { useHideAmounts } from '../../lib/privacy.ts';
import { useResolvedTheme, useThemePreference } from '../../lib/theme.ts';
import { SyncStatusPill } from '../../components/patterns/SyncStatusPill.tsx';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip.tsx';

export interface TopBarProps {
  title: string;
  onOpenSearch: () => void;
}

const ICON_BUTTON =
  'flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-bg-subtle focus-visible:outline-none';

/**
 * Page title, sync status, privacy toggle, theme toggle, and the command
 * palette's visible entry point (§4.2). Mobile collapse-on-scroll is left to
 * a future pass — this is the shell scaffold WP 0.5 asked for.
 */
export function TopBar({ title, onOpenSearch }: TopBarProps) {
  const navigate = useNavigate();
  const [, setPreference] = useThemePreference();
  const resolved = useResolvedTheme();
  const [hideAmounts, setHideAmounts] = useHideAmounts();
  const logout = useLogoutMutation();

  function toggleTheme(): void {
    setPreference(resolved === 'dark' ? 'light' : 'dark');
  }

  /**
   * gate-remediation-web.md M-4: there was no way to end a session short of
   * clearing cookies by hand. `useLogoutMutation`'s own `onSuccess` clears
   * the query cache (packages/api/pending-contracts.ts) — this handler's job
   * is only to call it and then leave the authenticated shell, in that
   * order, so nothing under `/_app` can render a stale query result between
   * "the server forgot this session" and "the client left the page."
   */
  async function handleSignOut(): Promise<void> {
    await logout.mutateAsync();
    await navigate({ to: '/login' });
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border-hairline bg-bg-page px-4 md:px-6">
      <h1 className="flex-1 truncate text-h3 text-text-primary">{title}</h1>

      <SyncStatusPill
        status={{ kind: 'synced', label: 'Synced 4m ago' }}
        className="hidden sm:inline-flex"
      />

      <button
        type="button"
        onClick={onOpenSearch}
        className="flex h-9 items-center gap-2 rounded-md border border-border-strong px-2.5 text-small text-text-muted hover:bg-bg-subtle focus-visible:outline-none"
        aria-label="Search (Ctrl K)"
      >
        <Search size={16} aria-hidden="true" />
        <span className="hidden md:inline">Search</span>
        <kbd className="hidden rounded-sm bg-bg-subtle px-1 py-0.5 text-caption text-text-muted md:inline">
          ⌘K
        </kbd>
      </button>

      <Tooltip>
        <TooltipTrigger
          onClick={() => setHideAmounts(!hideAmounts)}
          aria-pressed={hideAmounts}
          aria-label={hideAmounts ? 'Show amounts' : 'Hide amounts'}
          className={ICON_BUTTON}
        >
          {hideAmounts ? (
            <EyeOff size={18} aria-hidden="true" />
          ) : (
            <Eye size={18} aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipContent>{hideAmounts ? 'Show amounts (⌘⇧H)' : 'Hide amounts (⌘⇧H)'}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          onClick={toggleTheme}
          aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          className={ICON_BUTTON}
        >
          {resolved === 'dark' ? (
            <Sun size={18} aria-hidden="true" />
          ) : (
            <Moon size={18} aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipContent>{resolved === 'dark' ? 'Light theme' : 'Dark theme'}</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger
          onClick={() => void handleSignOut()}
          disabled={logout.isPending}
          aria-label="Sign out"
          className={ICON_BUTTON}
        >
          <LogOut size={18} aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>Sign out</TooltipContent>
      </Tooltip>
    </header>
  );
}
