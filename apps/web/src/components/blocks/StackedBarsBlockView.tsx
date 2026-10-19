// SPDX-License-Identifier: MIT
import { ParentSize } from '@visx/responsive';
import { scaleBand, scaleLinear } from '@visx/scale';
import { useRouter } from '@tanstack/react-router';
import { isInAppHref } from '@core/kernel';
import type { KeyboardEvent } from 'react';

import { chartFillVar } from '../finance/chart-hue.ts';
import { Money } from '../finance/Money.tsx';
import { ChartDataTable } from '../patterns/ChartDataTable.tsx';
import { ScrollRegion } from '../patterns/ScrollRegion.tsx';
import { moneyWords } from './BlockLabelText.tsx';
import { BlockLink } from './BlockLink.tsx';
import { BlockHeading } from './heading.tsx';
import type { Block } from './schema.ts';

type StackedBarsBlock = Extract<Block, { kind: 'stacked-bars' }>;
type Group = StackedBarsBlock['data'][number]['groups'][number];

const MARGIN = { top: 8, right: 8, bottom: 24, left: 8 };
/** The dataviz mark spec: a bar is at most 24 px thick, its data-end rounded 4 px, square at the baseline. */
const MAX_BAR = 24;
const END_RADIUS = 4;
/** The surface gap between stacked segments. */
const GAP = 2;
const PLOT_HEIGHT = 240;

function valueWords(value: string, currency: string | null): string {
  return currency === null ? value : moneyWords(value, currency);
}

/** A segment's path: square corners, except the top of the bar's last segment, rounded `END_RADIUS`. */
function segmentPath(
  x: number,
  y: number,
  width: number,
  height: number,
  roundTop: boolean,
): string {
  const r = roundTop ? Math.min(END_RADIUS, height, width / 2) : 0;
  return (
    `M${String(x)},${String(y + height)}` +
    `V${String(y + r)}` +
    (r > 0 ? `Q${String(x)},${String(y)} ${String(x + r)},${String(y)}` : '') +
    `H${String(x + width - r)}` +
    (r > 0 ? `Q${String(x + width)},${String(y)} ${String(x + width)},${String(y + r)}` : '') +
    `V${String(y + height)}Z`
  );
}

export interface StackedBarsInnerProps {
  readonly block: StackedBarsBlock;
  readonly width: number;
  readonly height?: number;
}

/** The plot at an explicit width (exported so a unit test can draw it; `ParentSize` never measures in happy-dom). */
export function StackedBarsInner({ block, width, height = 240 }: StackedBarsInnerProps) {
  const router = useRouter();
  const name = block.title ?? 'Stacked bars';
  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = height - MARGIN.top - MARGIN.bottom;
  const xScale = scaleBand<string>({
    domain: block.data.map((bar) => bar.x),
    range: [0, innerWidth],
    padding: 0.3,
  });
  const yScale = scaleLinear<number>({
    domain: [0, Math.max(1, ...block.data.map((bar) => Math.abs(Number(bar.total))))],
    range: [innerHeight, 0],
  });
  const barWidth = Math.min(MAX_BAR, xScale.bandwidth());

  function follow(group: Group): void {
    if (group.href !== undefined && isInAppHref(group.href))
      void router.navigate({ href: group.href });
  }

  return (
    <svg width={width} height={height} aria-label={name} data-testid="stacked-bars-plot">
      <g transform={`translate(${String(MARGIN.left)} ${String(MARGIN.top)})`}>
        <line
          x1={0}
          x2={innerWidth}
          y1={innerHeight}
          y2={innerHeight}
          stroke="var(--chart-axis)"
          strokeWidth={1}
        />
        {block.data.map((bar) => {
          const x = (xScale(bar.x) ?? 0) + (xScale.bandwidth() - barWidth) / 2;
          let cumulative = 0;
          const drawn = bar.groups.filter((group) => Number(group.value) !== 0);
          return (
            <g key={bar.x} data-bar={bar.x}>
              {drawn.map((group, index) => {
                const value = Math.abs(Number(group.value));
                const top = yScale(cumulative + value);
                const bottom = yScale(cumulative);
                cumulative += value;
                const isLast = index === drawn.length - 1;
                const h = Math.max(0, bottom - top - (index === 0 ? 0 : GAP));
                const words = `${group.label}, ${bar.x}, ${valueWords(group.value, block.currency)}`;
                const linked = group.href !== undefined && isInAppHref(group.href);
                return (
                  <path
                    key={group.key}
                    d={segmentPath(x, top, barWidth, h, isLast)}
                    fill={chartFillVar(group.hue)}
                    data-segment={group.key}
                    {...(linked
                      ? {
                          role: 'link',
                          tabIndex: 0,
                          'aria-label': `${words}, view transactions`,
                          className:
                            'cursor-pointer outline-none hover:opacity-80 focus-visible:opacity-80',
                          onClick: () => follow(group),
                          onKeyDown: (event: KeyboardEvent<SVGPathElement>) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              follow(group);
                            }
                          },
                        }
                      : { 'aria-hidden': true })}
                  >
                    <title>{words}</title>
                  </path>
                );
              })}
              <text
                x={(xScale(bar.x) ?? 0) + xScale.bandwidth() / 2}
                y={innerHeight + 16}
                textAnchor="middle"
                fontSize={11}
                fill="var(--chart-label)"
                className="tabular-nums"
              >
                {bar.x}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

/**
 * `stacked-bars`: one column per `x`, a segment per group in its hue (`--chart-fill-<hue>`; a category's persisted
 * hue, so it matches every other chart), a 2 px surface gap between segments and only the top rounded (the dataviz
 * mark spec), a legend naming every group (identity is never colour alone), each linked segment a keyboard-reachable
 * link to its drill-through, and the table: every segment's x, group (linked to its own screen when the block says)
 * and value, plus its transaction count when the block carries one. The `total` is only the bar's height.
 */
export function StackedBarsBlockView({ block }: { readonly block: StackedBarsBlock }) {
  const name = block.title ?? 'Stacked bars';
  const legend = new Map<string, Group>();
  for (const bar of block.data) for (const group of bar.groups) legend.set(group.key, group);
  const withCounts = block.data.some((bar) =>
    bar.groups.some((group) => group.count !== undefined),
  );
  const rows = block.data.flatMap((bar) =>
    bar.groups
      .filter((group) => Number(group.value) !== 0)
      .map((group) => [
        bar.x,
        group.labelHref === undefined ? (
          group.label
        ) : (
          <BlockLink key={`l-${bar.x}-${group.key}`} href={group.labelHref}>
            {group.label}
          </BlockLink>
        ),
        block.currency === null ? (
          group.value
        ) : (
          <Money
            key={`v-${bar.x}-${group.key}`}
            value={{ minor: group.value, currency: block.currency }}
            signDisplay="never"
            colorBySign={false}
          />
        ),
        ...(withCounts ? [group.count === undefined ? '—' : String(group.count)] : []),
      ]),
  );
  return (
    <div role="group" aria-label={name} data-block-chart="stacked-bars">
      {block.title !== undefined && <BlockHeading>{block.title}</BlockHeading>}
      {block.data.length === 0 ? (
        <p className="mt-1 text-small text-text-muted">Nothing to draw.</p>
      ) : (
        <ScrollRegion label={name}>
          {/* An explicit height: `ParentSize` fills its parent, and a parent of `auto` height let the plot
              overflow onto the table toggle below it (a pointer target under another, caught by the e2e). */}
          <div className="mt-1 w-full min-w-[280px]" style={{ height: PLOT_HEIGHT }}>
            <ParentSize>
              {({ width }) => (
                <StackedBarsInner
                  block={block}
                  width={width > 0 ? width : 640}
                  height={PLOT_HEIGHT}
                />
              )}
            </ParentSize>
          </div>
        </ScrollRegion>
      )}
      {legend.size > 1 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1" aria-label={`${name}: legend`}>
          {[...legend.values()].map((group) => (
            <li
              key={group.key}
              className="flex items-center gap-1.5 text-caption text-text-secondary"
            >
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: chartFillVar(group.hue) }}
              />
              {group.label}
            </li>
          ))}
        </ul>
      )}
      <ChartDataTable
        className="mt-1"
        caption={name}
        columns={['Month', 'Category', 'Amount', ...(withCounts ? ['Transactions'] : [])]}
        rows={rows}
      />
    </div>
  );
}
