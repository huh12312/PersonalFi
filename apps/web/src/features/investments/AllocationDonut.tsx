// SPDX-License-Identifier: MIT
import { Group } from '@visx/group';
import { Pie } from '@visx/shape';
import { useId } from 'react';

import { Money } from '../../components/finance/Money.tsx';
import { Percent } from '../../components/finance/Percent.tsx';
import type { AllocationReport } from '../../api/generated/types.gen.ts';
import { ratioToNumber, sliceLabel } from './labels.ts';
import type { AllocationDimension } from './search.ts';

const SIZE = 240;
const THICKNESS = 34;

/**
 * Eight CVD-validated hues (`--series-1..8`, `src/styles/theme.css`) **paired
 * one-to-one with eight distinct SVG textures**, so two adjacent slices
 * differ by fill pattern as well as by hue and the chart survives any colour
 * vision deficiency — D20's rule as WP 3.11's brief restates it: "the
 * CVD-safe colour pair PLUS pattern or label". Every slice additionally
 * carries its label and its own percentage in the legend, which is the
 * belt-and-braces third channel.
 */
const SLICE_STYLES = [
  { color: 'var(--series-1)', texture: 'diagonal' },
  { color: 'var(--series-2)', texture: 'dots' },
  { color: 'var(--series-3)', texture: 'horizontal' },
  { color: 'var(--series-4)', texture: 'grid' },
  { color: 'var(--series-5)', texture: 'back-diagonal' },
  { color: 'var(--series-6)', texture: 'vertical' },
  { color: 'var(--series-7)', texture: 'dense-dots' },
  { color: 'var(--series-8)', texture: 'chevron' },
] as const;

type Texture = (typeof SLICE_STYLES)[number]['texture'];

function texturePath(texture: Texture): string {
  switch (texture) {
    case 'diagonal':
      return 'M0,6 l6,-6 M-1.5,1.5 l3,-3 M4.5,7.5 l3,-3';
    case 'back-diagonal':
      return 'M0,0 l6,6 M-1.5,4.5 l3,3 M4.5,-1.5 l3,3';
    case 'horizontal':
      return 'M0,1.5 h6 M0,4.5 h6';
    case 'vertical':
      return 'M1.5,0 v6 M4.5,0 v6';
    case 'grid':
      return 'M0,3 h6 M3,0 v6';
    case 'dots':
      return 'M3,3 h0.01';
    case 'dense-dots':
      return 'M1.5,1.5 h0.01 M4.5,4.5 h0.01';
    case 'chevron':
      return 'M0,4.5 l3,-3 l3,3';
  }
}

export interface AllocationSlice {
  readonly key: string;
  readonly label: string;
  readonly value: AllocationReport['slices'][number]['value'];
  readonly weight: string;
}

export interface AllocationDonutProps {
  readonly dimension: AllocationDimension;
  readonly report: AllocationReport;
}

/**
 * The allocation donut (visx `Pie`, self-hosted — no CDN, no new CSP
 * directive).
 *
 * Nothing on this chart is computed here: each arc's angle is the server's
 * own `slices[].weight`, each legend amount is the server's `slices[].value`
 * rendered by `<Money>`, and the centre figure is `report.total`. The one
 * string→number conversion (`ratioToNumber`) turns a decimal-string ratio
 * into arc geometry and into `formatPercent`'s input; no money value passes
 * through it.
 *
 * The `<svg>` is `aria-hidden`: the legend beneath it is a real list carrying
 * every label, amount and percentage, so assistive technology reads the data
 * rather than a shape, and the donut cannot become an opaque `role="img"`
 * that hides the numbers.
 */
export function AllocationDonut({ dimension, report }: AllocationDonutProps) {
  // `useId()` returns a token containing punctuation React reserves (`«r1»`);
  // an SVG `fill="url(#…)"` reference is parsed as a CSS `<url>`, so the
  // prefix is stripped to `[A-Za-z0-9-]` before it becomes a fragment id.
  const patternPrefix = `alloc-${useId().replace(/[^a-zA-Z0-9-]/g, '')}`;
  const slices: AllocationSlice[] = report.slices.map((slice) => ({
    key: slice.key,
    label: sliceLabel(dimension, slice.key),
    value: slice.value,
    weight: slice.weight,
  }));

  const radius = SIZE / 2;

  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
        <svg width={SIZE} height={SIZE} aria-hidden="true" focusable="false">
          <defs>
            {SLICE_STYLES.map((style, index) => (
              <pattern
                key={style.texture}
                id={`${patternPrefix}-${String(index)}`}
                width={6}
                height={6}
                patternUnits="userSpaceOnUse"
              >
                <rect width={6} height={6} fill={style.color} />
                <path
                  d={texturePath(style.texture)}
                  stroke="var(--bg-surface)"
                  strokeWidth={1.1}
                  strokeLinecap="round"
                  fill="none"
                  opacity={0.75}
                />
              </pattern>
            ))}
          </defs>
          <Group top={radius} left={radius}>
            <Pie<AllocationSlice>
              data={slices}
              pieValue={(slice) => ratioToNumber(slice.weight)}
              outerRadius={radius - 2}
              innerRadius={radius - 2 - THICKNESS}
              padAngle={0.012}
              pieSortValues={null}
            >
              {(pie) =>
                pie.arcs.map((arc, index) => (
                  <path
                    key={arc.data.key}
                    d={pie.path(arc) ?? undefined}
                    fill={`url(#${patternPrefix}-${String(index % SLICE_STYLES.length)})`}
                    stroke="var(--bg-surface)"
                    strokeWidth={1}
                  />
                ))
              }
            </Pie>
          </Group>
        </svg>
        <div
          className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center"
          aria-hidden="true"
        >
          <span className="text-caption text-text-secondary">Total</span>
          <span className="text-h3 text-text-primary">
            <Money value={report.total} signDisplay="auto" colorBySign={false} compact />
          </span>
        </div>
      </div>

      <ul className="min-w-0 flex-1 space-y-1.5" data-testid="allocation-legend">
        {slices.map((slice, index) => {
          const style = SLICE_STYLES[index % SLICE_STYLES.length] ?? SLICE_STYLES[0];
          return (
            <li
              key={slice.key}
              className="flex items-center gap-2 text-small"
              data-testid={`allocation-slice-${slice.key}`}
            >
              <svg width={14} height={14} aria-hidden="true" focusable="false" className="shrink-0">
                <rect
                  width={14}
                  height={14}
                  rx={3}
                  fill={`url(#${patternPrefix}-${String(index % SLICE_STYLES.length)})`}
                  stroke={style.color}
                />
              </svg>
              <span className="min-w-0 flex-1 truncate text-text-primary">{slice.label}</span>
              <span className="tabular-nums text-text-secondary" data-testid="slice-weight">
                <Percent value={ratioToNumber(slice.weight)} />
              </span>
              <span className="w-28 text-right" data-testid="slice-value">
                <Money value={slice.value} signDisplay="auto" colorBySign={false} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
