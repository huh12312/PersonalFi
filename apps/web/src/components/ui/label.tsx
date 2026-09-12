// SPDX-License-Identifier: MIT
import type { LabelHTMLAttributes } from 'react';

import { cn } from '../../lib/cn.ts';

export function Label({
  className,
  htmlFor,
  children,
  ...props
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn('text-small font-medium text-text-secondary', className)}
      {...props}
    >
      {children}
    </label>
  );
}
