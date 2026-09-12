// SPDX-License-Identifier: MIT
import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Soft, near-flat card: 1px hairline + a barely-there shadow, large radii
 * (05-frontend-architecture.md §2.1, §2.4). Dark mode expresses elevation via
 * surface + hairline, not shadow — `--shadow-elev-*` is already `none` there.
 */
const cardVariants = cva('rounded-lg border border-border-hairline bg-bg-surface md:rounded-xl', {
  variants: {
    elevation: {
      flat: '',
      raised: 'shadow-[var(--shadow-elev-1)]',
      popover: 'bg-bg-surface-raised shadow-[var(--shadow-elev-2)]',
    },
    padding: {
      none: '',
      default: 'p-5 md:p-6',
      compact: 'p-3',
    },
  },
  defaultVariants: { elevation: 'flat', padding: 'default' },
});

export interface CardProps
  extends HTMLAttributes<HTMLDivElement>, VariantProps<typeof cardVariants> {}

export function Card({ className, elevation, padding, ...props }: CardProps) {
  return <div className={cn(cardVariants({ elevation, padding }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mb-4 flex flex-col gap-1', className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-h2 text-text-primary', className)} {...props} />;
}

export function CardDescription({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-small text-text-muted', className)} {...props} />;
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn(className)} {...props} />;
}

export function CardFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('mt-4 flex items-center gap-2', className)} {...props} />;
}
