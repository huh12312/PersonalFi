// SPDX-License-Identifier: MIT
import { Dialog as BaseDialog } from '@base-ui-components/react/dialog';
import { X } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

export const Dialog = BaseDialog.Root;
export const DialogTrigger = BaseDialog.Trigger;
export const DialogClose = BaseDialog.Close;

function DialogBackdrop({ className, ...props }: ComponentProps<typeof BaseDialog.Backdrop>) {
  return (
    <BaseDialog.Backdrop
      className={cn(
        'fixed inset-0 z-40 bg-[rgba(11,11,11,0.5)] backdrop-blur-sm',
        'transition-opacity duration-base ease-standard',
        'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
        className,
      )}
      {...props}
    />
  );
}

/**
 * One component, two shapes via `variant`: a centred dialog (desktop, `2xl`
 * radius all corners) and a bottom sheet (mobile, `2xl` on the top corners
 * only — 05-frontend-architecture.md §2.4). Screens choose per breakpoint;
 * this file only supplies the two variants, not the choice.
 */
export function DialogContent({
  className,
  variant = 'dialog',
  showClose = true,
  children,
  ...props
}: ComponentProps<typeof BaseDialog.Popup> & {
  variant?: 'dialog' | 'sheet';
  showClose?: boolean;
}) {
  return (
    <BaseDialog.Portal>
      <DialogBackdrop />
      <BaseDialog.Popup
        className={cn(
          'fixed z-50 bg-bg-surface-raised shadow-[var(--shadow-elev-3)] outline-none',
          'transition-all duration-base ease-standard',
          variant === 'dialog' &&
            [
              'left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl p-6',
              'data-[starting-style]:scale-95 data-[starting-style]:opacity-0',
              'data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            ].join(' '),
          variant === 'sheet' &&
            [
              'inset-x-0 bottom-0 w-full rounded-t-2xl p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]',
              'data-[starting-style]:translate-y-full data-[ending-style]:translate-y-full',
            ].join(' '),
          className,
        )}
        {...props}
      >
        {variant === 'sheet' && (
          <div className="mx-auto mb-4 h-1 w-10 shrink-0 rounded-full bg-border-strong" aria-hidden="true" />
        )}
        {children}
        {showClose && (
          <BaseDialog.Close
            aria-label="Close"
            className={cn(
              'absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md text-text-muted',
              'hover:bg-bg-subtle focus-visible:outline-none',
            )}
          >
            <X size={18} aria-hidden="true" />
          </BaseDialog.Close>
        )}
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
}

export function DialogTitle({ className, ...props }: ComponentProps<typeof BaseDialog.Title>) {
  return <BaseDialog.Title className={cn('text-h3 text-text-primary', className)} {...props} />;
}

export function DialogDescription({
  className,
  ...props
}: ComponentProps<typeof BaseDialog.Description>) {
  return (
    <BaseDialog.Description className={cn('mt-1 text-small text-text-muted', className)} {...props} />
  );
}
