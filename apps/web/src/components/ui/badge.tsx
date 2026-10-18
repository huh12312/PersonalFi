// SPDX-License-Identifier: MIT
import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Status colour is never the only signal (WCAG 1.4.1) — every status variant
 * pairs a glyph via `icon` (a Lucide component), not colour alone.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-caption font-medium',
  {
    variants: {
      variant: {
        neutral: 'border-transparent bg-bg-subtle text-text-secondary',
        accent: 'border-transparent bg-accent-wash text-accent-text',
        success: 'border-status-success-border bg-status-success-bg text-status-success-text',
        warning: 'border-status-warning-border bg-status-warning-bg text-status-warning-text',
        danger: 'border-status-danger-border bg-status-danger-bg text-status-danger-text',
        info: 'border-status-info-border bg-status-info-bg text-status-info-text',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  icon?: ReactNode;
}

export function Badge({ className, variant, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {icon}
      {children}
    </span>
  );
}
