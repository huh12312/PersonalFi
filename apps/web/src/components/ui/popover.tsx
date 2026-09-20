// SPDX-License-Identifier: MIT
import { Popover as BasePopover } from '@base-ui-components/react/popover';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Vendored Base UI Popover (same already-a-dependency package as
 * `dialog.tsx`), for anchored non-modal panels — the category filter's
 * checklist, today's one caller.
 */
export const Popover = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverClose = BasePopover.Close;

/**
 * `Portal` + `Positioner` + `Popup` in one component, mirroring
 * `dialog.tsx`'s `DialogContent` — Base UI's `Positioner` throws ("<Popover.
 * Portal> is missing") if it is ever rendered without an ancestor `Portal`,
 * so bundling them here means a call site can't reproduce that mistake.
 */
export function PopoverContent({
  className,
  sideOffset = 6,
  align = 'start',
  children,
  ...props
}: ComponentProps<typeof BasePopover.Popup> &
  Pick<ComponentProps<typeof BasePopover.Positioner>, 'sideOffset' | 'align'>) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner className="z-50 outline-none" sideOffset={sideOffset} align={align}>
        <BasePopover.Popup
          className={cn(
            'w-72 rounded-md border border-border-strong bg-bg-surface-raised p-3 shadow-[var(--shadow-elev-2)] outline-none',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
            'transition-opacity duration-fast ease-standard',
            className,
          )}
          {...props}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
