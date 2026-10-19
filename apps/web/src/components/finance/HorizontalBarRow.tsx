// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export interface HorizontalBarRowProps {
  /** An icon or avatar before the label (a category icon, initials), or nothing. */
  readonly leading?: ReactNode;
  readonly label: ReactNode;
  /** The figure at the row's right, already rendered (`Money`, a count). */
  readonly right: ReactNode;
  /** The bar's length, 0–1, as a share of the list's longest or of the side's total. Decorative. */
  readonly fraction: number;
  /** The mark colour: `var(--chart-fill-<hue>)`. */
  readonly fill: string;
  /** A small secondary line right of the bar (a share, a count), or nothing. */
  readonly caption?: ReactNode;
  /** A thinner bar (`smallBarStyle`). */
  readonly small?: boolean;
}

/**
 * Monarch's horizontal bar row (WP 10.10's Cash Flow breakdown row, extracted by WP 10.15 so the `horizontal-bars`
 * block draws the same row): the label and its figure on one line, a bar beneath whose length is decorative (the
 * figure is printed beside it), an optional caption right of the bar. The hue is identity only; text wears text
 * roles.
 */
export function HorizontalBarRow({
  leading,
  label,
  right,
  fraction,
  fill,
  caption,
  small = false,
}: HorizontalBarRowProps) {
  const share = Math.max(0, Math.min(1, fraction));
  return (
    <div className="flex items-center gap-3 py-2.5">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-small font-medium text-text-primary">{label}</span>
          {right}
        </div>
        <div className="mt-1 flex items-center gap-3">
          <div
            className={cn(
              'flex-1 overflow-hidden rounded-full bg-bg-tertiary',
              small ? 'h-1' : 'h-1.5',
            )}
            aria-hidden="true"
          >
            <div
              className="h-full rounded-full"
              data-share-bar=""
              style={{ width: `${String(share * 100)}%`, background: fill }}
            />
          </div>
          {caption !== undefined && (
            <span className="w-24 shrink-0 text-right text-caption tabular-nums text-text-secondary">
              {caption}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
