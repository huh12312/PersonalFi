// SPDX-License-Identifier: MIT
import { ChevronRight } from 'lucide-react';

import { cn } from '../../lib/cn.ts';
import { BlockLink } from './BlockLink.tsx';
import type { Block } from './schema.ts';

type CtaBlock = Extract<Block, { kind: 'cta' }>;

const VARIANT: Record<CtaBlock['variant'], string> = {
  primary:
    'inline-flex h-10 items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-contrast no-underline hover:bg-accent-hover hover:no-underline',
  secondary:
    'inline-flex h-10 items-center rounded-md border border-border-strong bg-bg-subtle px-4 text-sm font-medium text-text-primary no-underline hover:bg-bg-inset hover:no-underline',
  link: 'inline-flex min-h-6 items-center gap-0.5 text-small font-medium',
};

/** `cta`: an in-app link styled as a button or a link (never a `<button>`: it navigates). */
export function CtaBlockView({ block }: { readonly block: CtaBlock }) {
  return (
    <div>
      <BlockLink href={block.href} className={cn(VARIANT[block.variant])}>
        {block.label}
        {block.variant === 'link' && <ChevronRight size={14} aria-hidden="true" />}
      </BlockLink>
    </div>
  );
}
