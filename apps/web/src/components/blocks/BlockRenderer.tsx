// SPDX-License-Identifier: MIT
import { BLOCK_CONTRACT_VERSION } from '@core/kernel';
import { useContext } from 'react';

import { cn } from '../../lib/cn.ts';
import { BadgeBlockView } from './BadgeBlockView.tsx';
import { CtaBlockView } from './CtaBlockView.tsx';
import { DividerBlockView } from './DividerBlockView.tsx';
import { BlockHeading, BlockHeadingLevel, deeper, type HeadingLevel } from './heading.tsx';
import { HorizontalBarsBlockView } from './HorizontalBarsBlockView.tsx';
import { InfoBlockView } from './InfoBlockView.tsx';
import { MeterBlockView } from './MeterBlockView.tsx';
import { MoneyBlockView } from './MoneyBlockView.tsx';
import { NetWorthBlockView } from './NetWorthBlockView.tsx';
import { PieBlockView } from './PieBlockView.tsx';
import { parseBlock, type Block } from './schema.ts';
import { SparklineRowBlockView } from './SparklineRowBlockView.tsx';
import { StackedBarsBlockView } from './StackedBarsBlockView.tsx';
import { TableBlockView } from './TableBlockView.tsx';
import { TextBlockView } from './TextBlockView.tsx';
import { TransactionsListBlockView } from './TransactionsListBlockView.tsx';

/**
 * A block that cannot be drawn, said so where it would have been (WP 10.15): a kind this build does not know
 * ("Unsupported block (merchants-list)") or a known kind that fails its rules ("Invalid block (money)"). Never
 * dropped: a screen that silently loses a block is a screen that silently loses a figure.
 */
export function UnsupportedBlock({
  kind,
  reason,
}: {
  readonly kind: string | null;
  readonly reason: 'unsupported' | 'invalid';
}) {
  const what = kind ?? 'no kind';
  return (
    <p
      role="note"
      data-testid="block-unsupported"
      data-block-problem={reason}
      className="rounded-md border border-dashed border-border-primary px-2 py-1 text-caption text-text-secondary"
    >
      {reason === 'unsupported' ? `Unsupported block (${what})` : `Invalid block (${what})`}
    </p>
  );
}

function GroupBlockView({ block }: { readonly block: Extract<Block, { kind: 'group' }> }) {
  const level = useContext(BlockHeadingLevel);
  return (
    <div
      role="group"
      {...(block.title === undefined ? {} : { 'aria-label': block.title })}
      className="flex flex-col gap-2"
      data-block-group={block.id ?? ''}
    >
      {block.title !== undefined && <BlockHeading>{block.title}</BlockHeading>}
      <BlockHeadingLevel.Provider value={block.title === undefined ? level : deeper(level)}>
        <BlockList blocks={block.blocks} />
      </BlockHeadingLevel.Provider>
    </div>
  );
}

/** One parsed block, by kind. */
export function BlockView({ block }: { readonly block: Block }) {
  switch (block.kind) {
    case 'text':
      return <TextBlockView block={block} />;
    case 'info':
      return <InfoBlockView block={block} />;
    case 'money':
      return <MoneyBlockView block={block} />;
    case 'horizontal-bars':
      return <HorizontalBarsBlockView block={block} />;
    case 'pie':
      return <PieBlockView block={block} />;
    case 'stacked-bars':
      return <StackedBarsBlockView block={block} />;
    case 'sparkline-row':
      return <SparklineRowBlockView block={block} />;
    case 'meter':
      return <MeterBlockView block={block} />;
    case 'net-worth':
      return <NetWorthBlockView block={block} />;
    case 'transactions-list':
      return <TransactionsListBlockView block={block} />;
    case 'table':
      return <TableBlockView block={block} />;
    case 'badge':
      return <BadgeBlockView block={block} />;
    case 'cta':
      return <CtaBlockView block={block} />;
    case 'divider':
      return <DividerBlockView />;
    case 'group':
      return <GroupBlockView block={block} />;
  }
}

function BlockList({ blocks }: { readonly blocks: readonly unknown[] }) {
  return (
    <>
      {blocks.map((raw, index) => {
        const parsed = parseBlock(raw);
        const key =
          parsed.ok && parsed.block.id !== undefined ? parsed.block.id : `#${String(index)}`;
        return (
          <div
            key={key}
            data-block-kind={parsed.ok ? parsed.block.kind : (parsed.kind ?? '')}
            data-block-id={parsed.ok ? (parsed.block.id ?? '') : ''}
          >
            {parsed.ok ? (
              <BlockView block={parsed.block} />
            ) : (
              <UnsupportedBlock kind={parsed.kind} reason={parsed.reason} />
            )}
          </div>
        );
      })}
    </>
  );
}

export interface BlockRendererProps {
  /**
   * The blocks to draw, as they came off the wire. Typed `unknown[]` on purpose: every one is parsed here, so a kind
   * this build does not know, or a block that fails its rules, is a visible row rather than a crash or a gap.
   */
  readonly blocks: readonly unknown[];
  /** The heading level of a top-level block's title (default 3: a screen's `h1`, its sections' `h2`). */
  readonly headingLevel?: HeadingLevel;
  readonly className?: string;
  readonly testId?: string;
}

/**
 * The block renderer (WP 10.15, V8; docs/design/blocks.md): one vocabulary drawn one way, for the Brief, Reports and
 * the kitchen sink. Each kind wraps the component that already draws it elsewhere (the budget meter, the Cash Flow
 * bar row, V6's net-worth chart); every chart block carries an accessible name and its table.
 */
export function BlockRenderer({ blocks, headingLevel = 3, className, testId }: BlockRendererProps) {
  return (
    <BlockHeadingLevel.Provider value={headingLevel}>
      <div
        className={cn('flex flex-col gap-3', className)}
        data-testid={testId ?? 'block-renderer'}
      >
        <BlockList blocks={blocks} />
      </div>
    </BlockHeadingLevel.Provider>
  );
}

/**
 * A whole document: its `contractVersion` checked first. A document of another version is said so, not guessed at
 * (a version-2 kind may mean something a version-1 renderer would draw wrongly).
 */
export function BlockDocumentView({
  document,
  ...props
}: Omit<BlockRendererProps, 'blocks'> & {
  readonly document: { readonly contractVersion: number; readonly blocks: readonly unknown[] };
}) {
  if (document.contractVersion !== BLOCK_CONTRACT_VERSION) {
    return (
      <p role="note" data-testid="block-unsupported" className="text-caption text-text-secondary">
        Unsupported block document (version {String(document.contractVersion)})
      </p>
    );
  }
  return <BlockRenderer blocks={document.blocks} {...props} />;
}
