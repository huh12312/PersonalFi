// SPDX-License-Identifier: MIT
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export type SyncStatus =
  | { kind: 'synced'; label: string }
  | { kind: 'syncing'; current: number; total: number }
  | { kind: 'stale'; label: string }
  | { kind: 'error'; label: string; onClick?: () => void };

export interface SyncStatusPillProps {
  status: SyncStatus;
  className?: string;
}

function content(status: SyncStatus): ReactNode {
  switch (status.kind) {
    case 'synced':
      return (
        <>
          <RefreshCw size={13} aria-hidden="true" />
          <span>{status.label}</span>
        </>
      );
    case 'syncing':
      return (
        <>
          <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" />
          <span>
            Syncing… {status.current} of {status.total}
          </span>
        </>
      );
    case 'stale':
      return (
        <>
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{status.label}</span>
        </>
      );
    case 'error':
      return (
        <>
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{status.label}</span>
        </>
      );
  }
}

const pillClassName = (status: SyncStatus, className: string | undefined) =>
  cn(
    'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-medium',
    status.kind === 'synced' && 'bg-bg-subtle text-text-secondary',
    status.kind === 'syncing' && 'bg-accent-wash text-accent-text',
    status.kind === 'stale' && 'bg-bg-subtle text-status-warning-text',
    status.kind === 'error' &&
      'bg-bg-subtle text-status-warning-text hover:bg-bg-surface hover:underline',
    className,
  );

/**
 * The sidebar/app-bar sync pill (§4.4): four states, colour is never the only
 * signal — every state pairs a glyph with text. `role="status"` so a screen
 * reader hears "Syncing… 3 of 5 accounts" without stealing focus. The `error`
 * state is the one that's also clickable (drills into the account that needs
 * attention), so it renders as a real `<button>` instead — `role="status"` on
 * a `<button>` is itself invalid (an interactive element can't also be a
 * non-interactive live region), so the button uses `aria-live` directly
 * instead, which announces changes without overriding its button semantics.
 */
export function SyncStatusPill({ status, className }: SyncStatusPillProps) {
  if (status.kind === 'error' && status.onClick !== undefined) {
    return (
      <button
        type="button"
        onClick={status.onClick}
        aria-live="polite"
        className={pillClassName(status, className)}
      >
        {content(status)}
      </button>
    );
  }

  return (
    <div role="status" className={pillClassName(status, className)}>
      {content(status)}
    </div>
  );
}
