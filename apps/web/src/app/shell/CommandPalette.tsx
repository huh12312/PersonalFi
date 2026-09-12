// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { Eye, EyeOff, Moon, Sun } from 'lucide-react';

import { useHideAmounts } from '../../lib/privacy.ts';
import { useResolvedTheme, useThemePreference } from '../../lib/theme.ts';
import { ALL_NAV_ITEMS } from './nav-items.ts';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The `⌘K` / `Ctrl K` command palette (§4.2): navigation and quick actions.
 * Search-over-transactions is a stub here — a real implementation needs a
 * server endpoint, which is out of scope for the app-frame scaffold. `cmdk`
 * is unstyled by design; the classes below are the minimal styling needed to
 * match the token system, not a wrapper library.
 */
export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const navigate = useNavigate();
  const [, setPreference] = useThemePreference();
  const resolved = useResolvedTheme();
  const [hideAmounts, setHideAmounts] = useHideAmounts();

  function runAndClose(action: () => void): void {
    action();
    onOpenChange(false);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      className="fixed left-1/2 top-[20vh] z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-2xl border border-border-hairline bg-bg-surface-raised shadow-[var(--shadow-elev-3)]"
      shouldFilter
    >
      <Command.Input
        placeholder="Search or jump to…"
        className="w-full border-b border-border-hairline bg-transparent px-4 py-3 text-body text-text-primary placeholder:text-text-muted focus:outline-none"
      />
      <Command.List className="max-h-80 overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-small text-text-muted">
          No results.
        </Command.Empty>

        <Command.Group
          heading="Go to"
          className="px-2 py-1.5 text-caption font-semibold uppercase tracking-wide text-text-muted"
        >
          {ALL_NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <Command.Item
                key={item.to}
                value={item.label}
                onSelect={() => runAndClose(() => void navigate({ to: item.to }))}
                className="flex h-10 cursor-pointer items-center gap-3 rounded-md px-2.5 text-small text-text-primary data-[selected=true]:bg-bg-subtle"
              >
                <Icon size={16} aria-hidden="true" />
                {item.label}
              </Command.Item>
            );
          })}
        </Command.Group>

        <Command.Group
          heading="Actions"
          className="px-2 py-1.5 text-caption font-semibold uppercase tracking-wide text-text-muted"
        >
          <Command.Item
            value="toggle-privacy"
            onSelect={() => runAndClose(() => setHideAmounts(!hideAmounts))}
            className="flex h-10 cursor-pointer items-center gap-3 rounded-md px-2.5 text-small text-text-primary data-[selected=true]:bg-bg-subtle"
          >
            {hideAmounts ? (
              <Eye size={16} aria-hidden="true" />
            ) : (
              <EyeOff size={16} aria-hidden="true" />
            )}
            {hideAmounts ? 'Show amounts' : 'Hide amounts'}
          </Command.Item>
          <Command.Item
            value="toggle-theme"
            onSelect={() =>
              runAndClose(() => setPreference(resolved === 'dark' ? 'light' : 'dark'))
            }
            className="flex h-10 cursor-pointer items-center gap-3 rounded-md px-2.5 text-small text-text-primary data-[selected=true]:bg-bg-subtle"
          >
            {resolved === 'dark' ? (
              <Sun size={16} aria-hidden="true" />
            ) : (
              <Moon size={16} aria-hidden="true" />
            )}
            {resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
