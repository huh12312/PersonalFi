// SPDX-License-Identifier: MIT
import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes, ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Status colour is never the only signal (WCAG 1.4.1) — every status variant
 * pairs a glyph via `icon` (a Lucide component), not colour alone.
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-caption font-medium',
  {
    variants: {
      variant: {
        neutral: 'bg-bg-subtle text-text-secondary',
        accent: 'bg-accent-wash text-accent-text',
        good: 'bg-bg-subtle text-status-good',
        warning: 'bg-bg-subtle text-status-warning',
        serious: 'bg-bg-subtle text-status-serious',
        critical: 'bg-bg-subtle text-status-critical',
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
