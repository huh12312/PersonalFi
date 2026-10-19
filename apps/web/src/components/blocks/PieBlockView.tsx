// SPDX-License-Identifier: MIT
import { Group } from '@visx/group';
import { Pie } from '@visx/shape';

import { chartFillVar } from '../finance/chart-hue.ts';
import { Money } from '../finance/Money.tsx';
import { ChartDataTable } from '../patterns/ChartDataTable.tsx';
import { moneyWords } from './BlockLabelText.tsx';
import { BlockHeading } from './heading.tsx';
import type { Block } from './schema.ts';

type PieBlock = Extract<Block, { kind: 'pie' }>;
type Slice = PieBlock['slices'][number];

const SIZE = 144;
const THICKNESS = 22;

/**
 * `pie`, drawn as a small donut (the dataviz skill: part-to-whole at a glance, a handful of slices; `AllocationDonut`
 * is bound to its allocation report and its textures, so this is the same visx `Pie` with the block's hues). Each
 * arc's angle is its value's share; a 2 px surface gap separates arcs. The legend beside it names every slice with
 * its value, so identity is never colour alone, and the table repeats it. No total and no percentage is printed:
 * the block does not carry one, and a renderer does not invent figures.
 */
export function PieBlockView({ block }: { readonly block: PieBlock }) {
  const name = block.title ?? 'Share';
  const drawn = block.slices.filter((slice) => Number(slice.value) > 0);
  const radius = SIZE / 2;
  const valueOf = (slice: Slice) =>
    block.currency === null ? (
      <span className="tabular-nums">{slice.value}</span>
    ) : (
      <Money
        value={{ minor: slice.value, currency: block.currency }}
        signDisplay="auto"
        colorBySign={false}
      />
    );
  const words = drawn
    .map(
      (slice) =>
        `${slice.label} ${block.currency === null ? slice.value : moneyWords(slice.value, block.currency)}`,
    )
    .join(', ');
  return (
    <div role="group" aria-label={name} data-block-chart="pie">
      {block.title !== undefined && <BlockHeading>{block.title}</BlockHeading>}
      <div className="mt-1 flex flex-col gap-3 sm:flex-row sm:items-center">
        <svg
          width={SIZE}
          height={SIZE}
          role="img"
          aria-label={`${name}: ${words}`}
          className="shrink-0"
        >
          <Group top={radius} left={radius}>
            <Pie<Slice>
              data={drawn}
              pieValue={(slice) => Number(slice.value)}
              outerRadius={radius - 2}
              innerRadius={radius - 2 - THICKNESS}
              padAngle={0.02}
              pieSortValues={null}
            >
              {(pie) =>
                pie.arcs.map((arc) => (
                  <path
                    key={`${arc.data.label}-${String(arc.index)}`}
                    d={pie.path(arc) ?? undefined}
                    fill={chartFillVar(arc.data.hue)}
                    stroke="var(--bg-primary)"
                    strokeWidth={2}
                  />
                ))
              }
            </Pie>
          </Group>
        </svg>
        <ul className="min-w-0 flex-1 space-y-1" aria-label={`${name}: legend`}>
          {block.slices.map((slice, index) => (
            <li
              key={`${slice.label}-${String(index)}`}
              className="flex items-center gap-2 text-small"
            >
              <span
                aria-hidden="true"
                className="inline-block h-3 w-3 shrink-0 rounded-sm"
                style={{ background: chartFillVar(slice.hue) }}
              />
              <span className="min-w-0 flex-1 truncate text-text-primary">{slice.label}</span>
              <span className="text-text-secondary">{valueOf(slice)}</span>
            </li>
          ))}
        </ul>
      </div>
      <ChartDataTable
        className="mt-1"
        caption={name}
        columns={['Slice', 'Value']}
        rows={block.slices.map((slice) => [slice.label, valueOf(slice)])}
      />
    </div>
  );
}
