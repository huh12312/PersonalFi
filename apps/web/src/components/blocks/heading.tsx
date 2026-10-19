// SPDX-License-Identifier: MIT
import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

import { cn } from '../../lib/cn.ts';

export type HeadingLevel = 2 | 3 | 4 | 5 | 6;

/** The heading level a block's title takes: a group's title at the renderer's level, its children one below. */
export const BlockHeadingLevel = createContext<HeadingLevel>(3);

export function deeper(level: HeadingLevel): HeadingLevel {
  return level >= 6 ? 6 : ((level + 1) as HeadingLevel);
}

/** A block's title as a real heading, at the level the surrounding blocks give it. */
export function BlockHeading({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const level = useContext(BlockHeadingLevel);
  const Tag = `h${String(level)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  return (
    <Tag className={cn('text-small font-semibold text-text-primary', className)}>{children}</Tag>
  );
}
