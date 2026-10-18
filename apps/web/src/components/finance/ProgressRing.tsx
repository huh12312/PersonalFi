// SPDX-License-Identifier: MIT
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export interface ProgressRingProps {
  /** 0..1 (and beyond — overflow renders as a second, darker arc lapping the first, §3.4). */
  value: number;
  size?: number;
  strokeWidth?: number;
  /** Screen-reader label, e.g. "$142 left of $600 budgeted". Colour is never the only signal. */
  label: string;
  /** Centre content — usually a `<Money>` remaining figure. */
  children?: ReactNode;
  className?: string;
}

const TONE_TRACK = 'stroke-bg-inset';

function toneForValue(value: number): string {
  if (value > 1) return 'stroke-money-neg';
  if (value >= 0.9) return 'stroke-status-warning-bold';
  return 'stroke-accent';
}

/**
 * Hand-rolled SVG ring — "the right answer anywhere" per the chart-library
 * memo (05-frontend-architecture.md §3.4): a single arc doesn't need visx.
 * Over 100% overflows as a second, darker arc lapping the first, never a
 * >360° sweep.
 */
export function ProgressRing({
  value,
  size = 96,
  strokeWidth = 10,
  label,
  children,
  className,
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const primaryFraction = Math.min(value, 1);
  const overflowFraction = Math.max(value - 1, 0);

  return (
    <div
      className={cn('relative inline-flex items-center justify-center', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={label}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className={TONE_TRACK}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          className={cn(
            toneForValue(value),
            'transition-[stroke-dashoffset] duration-base ease-standard',
          )}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - primaryFraction)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        {overflowFraction > 0 && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            className="stroke-money-neg-text"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - Math.min(overflowFraction, 1))}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            opacity={0.6}
          />
        )}
      </svg>
      {children !== undefined && (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center tabular-nums"
          aria-hidden="true"
        >
          {children}
        </div>
      )}
    </div>
  );
}
