// SPDX-License-Identifier: MIT
import { Separator as BaseSeparator } from '@base-ui-components/react/separator';
import type { ComponentProps } from 'react';

import { cn } from '../../lib/cn.ts';

export function Separator({ className, orientation = 'horizontal', ...props }: ComponentProps<typeof BaseSeparator>) {
  return (
    <BaseSeparator
      orientation={orientation}
      className={cn(
        'bg-border-hairline',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
