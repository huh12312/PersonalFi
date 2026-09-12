// SPDX-License-Identifier: MIT
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';
import { Button, type ButtonProps } from '../ui/button.tsx';

export interface EmptyStateAction extends Pick<ButtonProps, 'variant'> {
  label: string;
  onClick?: () => void;
}

export interface EmptyStateProps {
  icon: LucideIcon;
  /** One line. "Connect your first account", "No transactions between Jan 1 and Jan 31". */
  headline: string;
  /** One explanatory sentence. */
  description?: string;
  /** Exactly one primary action is the spec (05-frontend-architecture.md §4.4); a second is offered as a secondary/ghost button only for the "clear filters" case. */
  action?: EmptyStateAction;
  secondaryAction?: EmptyStateAction;
  children?: ReactNode;
  className?: string;
}

/**
 * First-class empty screen, not a grey line of text (§4.4): a 24px glyph in a
 * `--bg-subtle` circle, a headline, one sentence, and one primary action.
 * Used for every "no accounts / no transactions / no budgets / no insights"
 * placeholder in the app frame.
 */
export function EmptyState({
  icon: Icon,
  headline,
  description,
  action,
  secondaryAction,
  children,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong px-6 py-16 text-center',
        className,
      )}
    >
      <div
        className="flex h-12 w-12 items-center justify-center rounded-full bg-bg-subtle text-text-secondary"
        aria-hidden="true"
      >
        <Icon size={24} strokeWidth={1.75} />
      </div>
      <h2 className="text-h3 text-text-primary">{headline}</h2>
      {description !== undefined && (
        <p className="max-w-sm text-small text-text-muted">{description}</p>
      )}
      {(action !== undefined || secondaryAction !== undefined) && (
        <div className="mt-2 flex items-center gap-2">
          {action !== undefined && (
            <Button variant={action.variant ?? 'primary'} onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          {secondaryAction !== undefined && (
            <Button variant={secondaryAction.variant ?? 'ghost'} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
