// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export interface StatTileProps {
  label: string;
  /** The big number — usually a `<Money>` or `<Percent>`. */
  value: ReactNode;
  /** A small delta chip beneath the hero figure (Wealthfront's pattern, §2.1). */
  delta?: ReactNode;
  icon?: ReactNode;
  /** `'hero'` (48px, dashboard net worth) or `'display'` (34px, screen-level hero). */
  size?: 'hero' | 'display';
  className?: string;
}

/**
 * The "big-number hero stat" pattern that anchors every screen (§2.1): a
 * single 40–56px figure with a small delta chip beneath it, everything else
 * subordinate. Mobile steps the type scale down via a container query, not a
 * media query (§8.4), so the same tile works in a 4-col dashboard slot or a
 * full-width mobile stack.
 */
export function StatTile({ label, value, delta, icon, size = 'display', className }: StatTileProps) {
  return (
    <div className={cn('@container', className)}>
      <div className="flex items-center gap-2 text-small text-text-secondary">
        {icon}
        <span>{label}</span>
      </div>
      <div
        className={cn(
          'mt-1 text-text-primary',
          size === 'hero' ? 'text-[38px]/[42px] @sm:text-hero' : 'text-[28px]/[34px] @sm:text-display',
        )}
      >
        {value}
      </div>
      {delta !== undefined && <div className="mt-2 text-small">{delta}</div>}
    </div>
  );
}
