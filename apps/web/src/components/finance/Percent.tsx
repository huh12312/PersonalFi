// SPDX-License-Identifier: MIT
import type { HTMLAttributes } from 'react';

import { cn } from '../../lib/cn.ts';
import { formatPercent } from '../../lib/money.ts';

export interface PercentProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** A ratio, e.g. `0.021` for 2.1% — never a pre-multiplied "2.1". */
  value: number;
  signDisplay?: 'exceptZero' | 'auto' | 'never';
  colorBySign?: boolean;
}

/** 1 decimal below 10%, 0 above; `signDisplay: 'exceptZero'` when used as a delta (§2.7). */
export function Percent({
  value,
  signDisplay = 'auto',
  colorBySign = false,
  className,
  ...props
}: PercentProps) {
  return (
    <span
      className={cn(
        'tabular-nums',
        colorBySign && value > 0 && 'text-money-pos-text',
        colorBySign && value < 0 && 'text-money-neg-text',
        colorBySign && value === 0 && 'text-money-neutral',
        className,
      )}
      {...props}
    >
      {formatPercent(value, { signDisplay })}
    </span>
  );
}
