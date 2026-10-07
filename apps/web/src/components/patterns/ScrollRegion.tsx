// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

/**
 * A wide table or chart that scrolls sideways *inside itself* instead of making the whole screen scroll
 * (WCAG 1.4.10 Reflow: data tables and diagrams are the two-dimensional content the criterion lets scroll,
 * but only the content — never the page). It is a labelled region and a tab stop, so a keyboard user can scroll
 * it with the arrow keys (axe's `scrollable-region-focusable`, 2.1.1) and a screen-reader user hears what it is.
 * `relative` is load-bearing: an absolutely positioned `sr-only` span inside a wide table otherwise has its containing
 * block outside the scroller, escapes the clip, and widens the whole page by its static position.
 */
export function ScrollRegion({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      role="region"
      aria-label={`${label}, scrollable`}
      tabIndex={0}
      className={cn('relative max-w-full overflow-x-auto', className)}
    >
      {children}
    </div>
  );
}
