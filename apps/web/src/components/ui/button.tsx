// SPDX-License-Identifier: MIT
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * Vendored shadcn/ui-style primitive (source, not a runtime dependency —
 * docs/research/05-frontend-architecture.md §2.5). Plain `<button>`, not a
 * Base UI wrapper: a button has no state machine to compose, so hand-rolling
 * it is the "right answer anywhere" call the memo makes for progress rings.
 *
 * Every target meets the 24×24 CSS px minimum (WCAG 2.5.8); `md`/`lg` meet
 * the 44×44 house standard for touch (§8.1, §8.3).
 */
const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium',
    'transition-colors duration-fast ease-standard',
    'disabled:pointer-events-none disabled:opacity-50',
    'focus-visible:outline-none', // :focus-visible ring comes from the global rule in base.css
  ].join(' '),
  {
    variants: {
      variant: {
        primary: 'bg-accent text-accent-contrast hover:opacity-90',
        secondary:
          'bg-bg-subtle text-text-primary border border-border-strong hover:bg-bg-inset',
        ghost: 'text-text-primary hover:bg-bg-subtle',
        destructive: 'bg-money-neg text-white hover:opacity-90',
        link: 'text-accent-text underline-offset-4 hover:underline',
      },
      size: {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4',
        lg: 'h-11 px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';
