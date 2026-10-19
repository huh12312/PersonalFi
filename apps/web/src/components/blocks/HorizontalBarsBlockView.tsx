// SPDX-License-Identifier: MIT
import { chartFillVar } from '../finance/chart-hue.ts';
import { HorizontalBarRow } from '../finance/HorizontalBarRow.tsx';
import { ChartDataTable } from '../patterns/ChartDataTable.tsx';
import { BlockLabelText } from './BlockLabelText.tsx';
import { BlockLink } from './BlockLink.tsx';
import { BlockHeading } from './heading.tsx';
import type { Block } from './schema.ts';

type HorizontalBarsBlock = Extract<Block, { kind: 'horizontal-bars' }>;

/**
 * `horizontal-bars`: the Cash Flow hub's bar rows (`HorizontalBarRow`, WP 10.10). Each row's figure is printed beside
 * its bar (the bar is decorative, its length the block's `barPercent`), its hue is identity only, and a row with an
 * in-app href is a link. The list is a real list with an accessible name; the table repeats it for everyone else.
 */
export function HorizontalBarsBlockView({ block }: { readonly block: HorizontalBarsBlock }) {
  const name = block.title ?? 'Bars';
  return (
    <div role="group" aria-label={name} data-block-chart="horizontal-bars">
      {(block.title !== undefined || block.topRightLabel !== undefined) && (
        <div className="flex items-baseline justify-between gap-3">
          {block.title !== undefined && <BlockHeading>{block.title}</BlockHeading>}
          {block.topRightLabel !== undefined && (
            <BlockLabelText
              value={block.topRightLabel}
              className="ml-auto text-caption text-text-muted tabular-nums"
            />
          )}
        </div>
      )}
      <ul className="mt-1 flex flex-col">
        {block.bars.map((bar, index) => {
          const row = (
            <HorizontalBarRow
              label={bar.label}
              right={
                <BlockLabelText
                  value={bar.rightLabel}
                  className="shrink-0 text-small font-medium text-text-primary tabular-nums"
                />
              }
              fraction={bar.barPercent / 100}
              fill={chartFillVar(bar.hue)}
              small={block.smallBarStyle === true}
              {...(bar.leftLabel === undefined
                ? {}
                : { caption: <BlockLabelText value={bar.leftLabel} /> })}
            />
          );
          return (
            <li
              key={`${bar.label}-${String(index)}`}
              className="border-t border-border-hairline first:border-t-0"
            >
              {bar.href === undefined ? (
                <div className="px-1">{row}</div>
              ) : (
                <BlockLink
                  href={bar.href}
                  className="block rounded-md px-1 text-text-primary no-underline outline-none hover:bg-bg-subtle hover:no-underline focus-visible:ring-2 focus-visible:ring-focus-ring"
                >
                  {row}
                </BlockLink>
              )}
            </li>
          );
        })}
      </ul>
      <ChartDataTable
        className="mt-1"
        caption={name}
        columns={[
          'Item',
          ...(block.bars.some((bar) => bar.leftLabel !== undefined) ? ['Detail'] : []),
          'Value',
        ]}
        rows={block.bars.map((bar) => [
          bar.label,
          ...(block.bars.some((b) => b.leftLabel !== undefined)
            ? [bar.leftLabel === undefined ? '—' : <BlockLabelText key="l" value={bar.leftLabel} />]
            : []),
          <BlockLabelText key="r" value={bar.rightLabel} />,
        ])}
      />
    </div>
  );
}
