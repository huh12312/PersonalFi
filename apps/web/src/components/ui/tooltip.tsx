// SPDX-License-Identifier: MIT
import { Tooltip as BaseTooltip } from '@base-ui-components/react/tooltip';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

/** One provider at the app root (src/app/App.tsx) sets shared open/close delays. */
export const TooltipProvider = BaseTooltip.Provider;

export function Tooltip({ children, ...props }: ComponentProps<typeof BaseTooltip.Root>) {
  return <BaseTooltip.Root {...props}>{children}</BaseTooltip.Root>;
}

export const TooltipTrigger = BaseTooltip.Trigger;

export function TooltipContent({
  className,
  sideOffset = 6,
  ...props
}: ComponentProps<typeof BaseTooltip.Popup> & { sideOffset?: number }) {
  return (
    <BaseTooltip.Portal>
      <BaseTooltip.Positioner sideOffset={sideOffset}>
        <BaseTooltip.Popup
          className={cn(
            'rounded-md bg-bg-surface-raised px-2.5 py-1.5 text-caption text-text-primary shadow-[var(--shadow-elev-2)]',
            'data-[state=closed]:animate-none',
            className,
          )}
          {...props}
        />
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  );
}
