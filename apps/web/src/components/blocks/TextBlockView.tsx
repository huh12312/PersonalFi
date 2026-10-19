// SPDX-License-Identifier: MIT
import { NarratedSummary } from '../../features/brief/NarrationBadge.tsx';
import type { BriefItemNarration } from '../../features/brief/types.ts';
import { cn } from '../../lib/cn.ts';
import type { Block } from './schema.ts';
import { BlockHeading } from './heading.tsx';

type TextBlock = Extract<Block, { kind: 'text' }>;

const SIZE: Record<TextBlock['size'], string> = {
  body: 'text-small',
  heading: 'text-h3',
  eyebrow: 'text-caption uppercase tracking-wide',
  caption: 'text-caption',
};
const WEIGHT: Record<NonNullable<TextBlock['weight']>, string> = {
  regular: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
};
const ROLE: Record<Exclude<NonNullable<TextBlock['role']>, 'narration'>, string> = {
  primary: 'text-text-primary',
  secondary: 'text-text-secondary',
  muted: 'text-text-muted',
};

/**
 * `text`. A heading is a real heading (at the level the blocks around it give it). A **narration** is drawn by the
 * Brief's own `NarratedSummary`, so it keeps its badge naming the provider and model (WP 10.6) and the template
 * wording one click away — a narration block cannot be drawn as plain text.
 */
export function TextBlockView({ block }: { readonly block: TextBlock }) {
  if (block.role === 'narration' && block.narration !== undefined) {
    const { status, narratedBy, templateContent } = block.narration;
    const narration: BriefItemNarration =
      status === 'pending'
        ? {
            status: 'pending',
            aiAssisted: false,
            textShown: false,
            summaryMd: null,
            narratedBy: null,
          }
        : {
            status: 'narrated',
            aiAssisted: true,
            textShown: status === 'narrated',
            summaryMd: status === 'narrated' ? block.content : null,
            narratedBy,
          };
    return (
      <div data-block-narration={status}>
        <NarratedSummary templateSummaryMd={templateContent} narration={narration} />
      </div>
    );
  }
  const className = cn(
    SIZE[block.size],
    block.weight === undefined ? undefined : WEIGHT[block.weight],
    ROLE[block.role === undefined || block.role === 'narration' ? 'primary' : block.role],
    'tabular-nums',
  );
  if (block.size === 'heading') {
    return <BlockHeading className={className}>{block.content}</BlockHeading>;
  }
  return <p className={className}>{block.content}</p>;
}
