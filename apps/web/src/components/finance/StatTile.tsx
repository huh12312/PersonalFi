// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export interface StatTileProps {
  label: string;
  /** The big number — usually a `<Money>` or `<Percent>`. */
  value: ReactNode;
  /** A small delta chip beneath the hero figure (Wealthfront's pattern, §2.1). */
  delta?: ReactNode;
  /** One line under the figure saying what it means ("after every expected charge"). */
  hint?: ReactNode;
  icon?: ReactNode;
  /**
   * `'hero'` (48px, dashboard net worth), `'display'` (34px, screen-level hero) or `'standard'` (24px, a figure
   * that sits beside a hero and must read as subordinate to it).
   */
  size?: 'hero' | 'display' | 'standard';
  className?: string;
}

/**
 * The tile's own intrinsic width (WP 10.7). The tile is a size container (`@container`, so the figure steps
 * down by the tile's width, not the viewport's, §8.4), and inline-size containment gives an element **no
 * intrinsic inline size**: in a parent that sizes children by their content (a `flex` row, an inline-block, a
 * `justify-between` header) every tile collapsed to 0 px and the tiles were drawn on top of one another — the
 * Recurring screen's "SafeExpeWorst" (docs/evidence/phase-10/wp10.7-recurring-forecast-view.md). In a grid or a
 * block the parent sizes the tile and none of this applies.
 *
 * `contain-intrinsic-inline-size` is the size containment's own answer: the width the tile reports to a parent
 * that asks for its content size. With `flex: 1 1 auto` the tiles start from that width and share what is left,
 * and the `min-width` (never wider than the parent: `min(…, 100%)`) stops a crowded row squeezing a figure below
 * what it needs; the row wraps instead.
 */
const INTRINSIC: Record<NonNullable<StatTileProps['size']>, string> = {
  hero: 'min-w-[min(16rem,100%)] [contain-intrinsic-inline-size:16rem]',
  display: 'min-w-[min(12rem,100%)] [contain-intrinsic-inline-size:12rem]',
  standard: 'min-w-[min(10rem,100%)] [contain-intrinsic-inline-size:10rem]',
};

const FIGURE: Record<NonNullable<StatTileProps['size']>, string> = {
  hero: 'text-[38px]/[42px] @sm:text-hero',
  display: 'text-[28px]/[34px] @sm:text-display',
  standard: 'text-[22px]/[28px] font-semibold @sm:text-h1',
};

/**
 * The "big-number hero stat" pattern that anchors every screen (§2.1): a
 * single 40–56px figure with a small delta chip beneath it, everything else
 * subordinate. Mobile steps the type scale down via a container query, not a
 * media query (§8.4), so the same tile works in a 4-col dashboard slot or a
 * full-width mobile stack.
 */
export function StatTile({
  label,
  value,
  delta,
  hint,
  icon,
  size = 'display',
  className,
}: StatTileProps) {
  return (
    <div data-stat-tile="" className={cn('@container flex-[1_1_auto]', INTRINSIC[size], className)}>
      <div className="flex items-center gap-2 text-small text-text-secondary">
        {icon}
        <span>{label}</span>
      </div>
      <div data-stat-figure="" className={cn('mt-1 tabular-nums text-text-primary', FIGURE[size])}>
        {value}
      </div>
      {hint !== undefined && <div className="mt-1 text-caption text-text-muted">{hint}</div>}
      {delta !== undefined && <div className="mt-2 text-small">{delta}</div>}
    </div>
  );
}
