// SPDX-License-Identifier: MIT
import type { CSSProperties, HTMLAttributes } from 'react';

import { cn } from '../../lib/cn.ts';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** CSS width, e.g. `'100%'` or `120`. */
  width?: number | string;
  /** CSS height, e.g. `16` for a text line or `52`/`64` for a transaction row. */
  height?: number | string;
  /** `'text'` (small radius) or `'block'` (card/avatar radius) — match the real geometry, never a generic box (§4.4). */
  variant?: 'text' | 'block' | 'circle';
}

/**
 * `.skeleton` (base.css) is the 1.6s shimmer, already disabled under
 * `prefers-reduced-motion`. This component only supplies geometry so a
 * skeleton matches the real content's height/radius exactly and nothing
 * reflows when it resolves (§4.4).
 */
export function Skeleton({
  width,
  height = 16,
  variant = 'text',
  className,
  style,
  ...props
}: SkeletonProps) {
  const resolvedStyle: CSSProperties = {
    width,
    height,
    ...style,
  };
  return (
    <div
      role="presentation"
      aria-hidden="true"
      className={cn(
        'skeleton',
        variant === 'circle' && 'rounded-full',
        variant === 'text' && 'rounded-sm',
        className,
      )}
      style={resolvedStyle}
      {...props}
    />
  );
}

/** A stack of `Skeleton` text lines — the common case (a card's label + value). */
export function SkeletonText({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} height={14} width={index === lines - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}
