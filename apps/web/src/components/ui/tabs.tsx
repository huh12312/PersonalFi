// SPDX-License-Identifier: MIT
import { Tabs as BaseTabs } from '@base-ui-components/react/tabs';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

export const Tabs = BaseTabs.Root;

export function TabsList({ className, ...props }: ComponentProps<typeof BaseTabs.List>) {
  return (
    <BaseTabs.List
      className={cn(
        'relative inline-flex items-center gap-1 rounded-md bg-bg-subtle p-1',
        className,
      )}
      {...props}
    />
  );
}

export function TabsTab({ className, ...props }: ComponentProps<typeof BaseTabs.Tab>) {
  return (
    <BaseTabs.Tab
      className={cn(
        'relative z-10 rounded-[calc(var(--radius-md)-2px)] px-3 py-1.5 text-small font-medium text-text-secondary',
        'data-[selected]:text-text-primary',
        'focus-visible:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function TabsIndicator({ className, ...props }: ComponentProps<typeof BaseTabs.Indicator>) {
  return (
    <BaseTabs.Indicator
      className={cn(
        'absolute rounded-[calc(var(--radius-md)-2px)] bg-bg-surface shadow-[var(--shadow-elev-1)]',
        'transition-all duration-fast ease-standard',
        className,
      )}
      {...props}
    />
  );
}

export function TabsPanel({ className, ...props }: ComponentProps<typeof BaseTabs.Panel>) {
  return <BaseTabs.Panel className={cn('mt-4 focus-visible:outline-none', className)} {...props} />;
}
