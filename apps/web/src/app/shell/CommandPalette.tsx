// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { Eye, EyeOff, Moon, Sun } from 'lucide-react';

import { Dialog, DialogContent } from '../../components/ui/dialog.tsx';
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
 *
 * Composed on top of this file's own `Dialog`/`DialogContent` (Base UI)
 * rather than `cmdk`'s `Command.Dialog` — gate-remediation-web.md H-3.
 * `Command.Dialog` wraps `@radix-ui/react-dialog`, whose default `modal`
 * scroll lock renders `react-remove-scroll` → `react-remove-scroll-bar`,
 * which injects a `<style>` tag into `<head>` the instant the palette opens.
 * `style-src-elem 'self'` blocks that outright. Base UI's dialog does its
 * own scroll lock without touching the Cache^H^H^H^H^Hstyle API (verified:
 * `@base-ui-components/react` has no dependency on `react-remove-scroll` at
 * all), so swapping the dialog primitive removes the violation instead of
 * working around it. `<Command>` (the plain root, not `.Dialog`) still
 * supplies every bit of cmdk's actual behaviour — filtering, keyboard nav,
 * the input/list/group/item wiring below are unchanged.
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showClose={false}
        aria-label="Command palette"
        className="left-1/2 top-[20vh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-0 overflow-hidden rounded-2xl p-0 data-[starting-style]:translate-y-0 data-[ending-style]:translate-y-0"
      >
        <Command label="Command palette" shouldFilter className="contents">
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
        </Command>
      </DialogContent>
    </Dialog>
  );
}
