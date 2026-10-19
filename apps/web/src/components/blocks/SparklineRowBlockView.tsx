// SPDX-License-Identifier: MIT
import { scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';

import { chartFillVar } from '../finance/chart-hue.ts';
import { ChartDataTable } from '../patterns/ChartDataTable.tsx';
import { BlockLabelText, moneyWords } from './BlockLabelText.tsx';
import type { Block } from './schema.ts';

type SparklineRowBlock = Extract<Block, { kind: 'sparkline-row' }>;

const WIDTH = 120;
const MARGIN = 6;

/**
 * `sparkline-row`: a label, a small line and a right label, Monarch's equivalent. The mark is the Health
 * sparkline's spec (`features/health/Sparkline.tsx`, WP 10.12): one 2 px line, the last value's dot ringed in the
 * surface. That component is keyed by calendar day (a missing day is a gap in time) and a block carries values only,
 * so the row draws the same mark over positions rather than wrapping it with invented dates. Withheld under two
 * values (one value is not a line). "From X to Y" is the only change it states — both are values the block carries
 * (`hideValueChange` drops it); it never computes a difference.
 */
export function SparklineRowBlockView({ block }: { readonly block: SparklineRowBlock }) {
  const words = (value: string): string =>
    block.currency === undefined ? value : moneyWords(value, block.currency);
  const values = block.values.map(Number);
  const height = block.largeStyle === true ? 48 : 28;
  const stroke = block.hue === undefined ? 'var(--chart-line)' : chartFillVar(block.hue);
  const first = block.values[0];
  const last = block.values[block.values.length - 1];
  const name = block.title ?? block.label;
  let line = null;
  if (values.length >= 2) {
    const x = scaleLinear<number>({
      domain: [0, values.length - 1],
      range: [MARGIN, WIDTH - MARGIN],
    });
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const y = scaleLinear<number>({
      domain: lo === hi ? [lo - 1, hi + 1] : [lo, hi],
      range: [height - MARGIN, MARGIN],
    });
    const lastIndex = values.length - 1;
    line = (
      <svg
        width={WIDTH}
        height={height}
        role="img"
        aria-label={`${name}: ${String(values.length)} values from ${words(first ?? '')} to ${words(last ?? '')}`}
        className="shrink-0"
      >
        <LinePath<number>
          data={values}
          x={(_, index) => x(index)}
          y={(value) => y(value)}
          stroke={stroke}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          fill="none"
        />
        <circle
          cx={x(lastIndex)}
          cy={y(values[lastIndex] ?? 0)}
          r={4}
          fill={stroke}
          stroke="var(--bg-primary)"
          strokeWidth={2}
          paintOrder="stroke"
        />
      </svg>
    );
  }
  return (
    <div data-block-chart="sparkline-row">
      {block.title !== undefined && <p className="text-caption text-text-muted">{block.title}</p>}
      <div className="flex items-center gap-3 py-1.5">
        <span className="min-w-0 flex-1 truncate text-small font-medium text-text-primary">
          {block.label}
        </span>
        {line ?? (
          <span className="text-caption text-text-muted" data-testid="block-withheld">
            Not enough values to draw a line.
          </span>
        )}
        {block.rightLabel !== undefined && (
          <BlockLabelText
            value={block.rightLabel}
            className="w-24 shrink-0 text-right text-small text-text-primary tabular-nums"
          />
        )}
      </div>
      {block.hideValueChange !== true &&
        first !== undefined &&
        last !== undefined &&
        values.length >= 2 && (
          <p className="text-caption text-text-secondary tabular-nums">
            From {words(first)} to {words(last)}
          </p>
        )}
      <ChartDataTable
        caption={name}
        columns={['Position', 'Value']}
        rows={block.values.map((value, index) => [String(index + 1), words(value)])}
      />
    </div>
  );
}
