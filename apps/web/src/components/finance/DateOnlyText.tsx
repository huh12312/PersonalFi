// SPDX-License-Identifier: MIT
import type { HTMLAttributes } from 'react';

import { formatDateOnly, formatDateOnlyShort } from '../../lib/date.ts';

export interface DateOnlyTextProps extends Omit<HTMLAttributes<HTMLTimeElement>, 'children'> {
  /** `DateOnly` wire form: `"YYYY-MM-DD"`, no zone (docs/CONVENTIONS.md "Time"). */
  value: string;
  /** `'short'` → "Mar 1"; `'long'` (default) → "Mar 1, 2026". */
  format?: 'short' | 'long';
}

/** Renders a `DateOnly` as a `<time>` with a machine-readable `dateTime`. */
export function DateOnlyText({ value, format = 'long', className, ...props }: DateOnlyTextProps) {
  const text = format === 'short' ? formatDateOnlyShort(value) : formatDateOnly(value);
  return (
    <time
      dateTime={value}
      className={className === undefined ? 'tabular-nums' : `tabular-nums ${className}`}
      {...props}
    >
      {text}
    </time>
  );
}
