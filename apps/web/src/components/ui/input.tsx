// SPDX-License-Identifier: MIT
import { forwardRef } from 'react';
import type { InputHTMLAttributes } from 'react';

import { cn } from '../../lib/cn.ts';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-10 w-full rounded-md border border-border-strong bg-bg-surface px-3 text-body text-text-primary',
        'placeholder:text-text-muted',
        'focus-visible:outline-none', // ring supplied by the global :focus-visible rule
        'disabled:cursor-not-allowed disabled:opacity-50',
        'aria-[invalid=true]:border-status-danger-border',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
