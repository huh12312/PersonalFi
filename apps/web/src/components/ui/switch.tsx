// SPDX-License-Identifier: MIT
import { Switch as BaseSwitch } from '@base-ui-components/react/switch';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

export function Switch({ className, ...props }: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      className={cn(
        'relative h-6 w-10 shrink-0 rounded-full bg-bg-inset transition-colors duration-fast ease-standard',
        'data-[checked]:bg-accent',
        'focus-visible:outline-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb
        className={cn(
          'block h-5 w-5 translate-x-0.5 rounded-full bg-white transition-transform duration-fast ease-standard',
          'data-[checked]:translate-x-[18px]',
        )}
      />
    </BaseSwitch.Root>
  );
}
