// SPDX-License-Identifier: MIT
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleBand, scaleLinear } from '@visx/scale';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

import { ChartDataTable } from '../../components/patterns/ChartDataTable.tsx';
import { useChartTooltipRules } from '../../components/patterns/chart-tooltip.ts';
import { chartFillVar, type FillHue } from '../../components/finance/chart-hue.ts';
import { prefersReducedMotion } from '../health/ScoreGauge.tsx';
import {
  domainOf,
  money,
  monthLabel,
  monthSentence,
  moveSelection,
  shownAverage,
  tableAmount,
  tickLabel,
  versusAverage,
  type HistoryView,
} from './history.ts';

/**
 * A category's monthly amounts (WP 10.14, V7; Monarch's equivalent), by the dataviz method.
 *
 * The question is "is this month normal for this category?" — magnitude over a short, regular time axis against one
 * reference — so: one column per month on **one** money axis, in the category's own hue (one series: no legend box,
 * the title names it), the 12-complete-month average as a **dashed reference line** in `--chart-label`, labelled with
 * its amount. The current month is drawn **hatched** (a 45° texture over a lighter wash of the same hue) and says
 * "so far". A month with no spend is a **zero**: a 2 px stub on the baseline in `--chart-axis` (never a gap that reads
 * as missing data), and "No spend" in the table; a month before the ledger's first row has no column and the table
 * says why.
 *
 *  - Columns ≤ 24 px, 4 px rounded data-end, square at the baseline; gridlines hairline and solid.
 *  - **Selecting** a month — a press on its column, or ← → Home End on the focused chart (a slider whose value text is
 *    the month's sentence, announced) — highlights it (the others dim, its tick turns bold with a marker under it) and
 *    calls `onSelect`, which the screen uses to filter the transactions beneath. The selection is persistent state,
 *    not a hover: nothing disappears when the pointer leaves.
 *  - **Hovering** a month shows its sentence in a readout over the plot's corner (hoverable, persistent, Escape
 *    dismisses it: 1.4.13, `useChartTooltipRules`) without selecting it.
 *  - Columns grow from the baseline once on first draw (Web Animations API), **never under reduced motion**.
 *  - **View as table**: every month, its amount or "No spend", its count, and the comparison with the average.
 */

const MAX_COLUMN = 24;
const RADIUS = 4;
const X_LABEL_BAND = 26;
const TICK_CHAR_PX = 7;
const DIMMED = 0.45;

export const CATEGORY_CHART_ROLES = {
  axis: '--chart-axis',
  gridline: '--chart-gridline',
  label: '--chart-label',
  average: '--chart-label',
  strong: '--text-primary',
  surface: '--bg-primary',
} as const;

function roleVar(role: keyof typeof CATEGORY_CHART_ROLES): string {
  return `var(${CATEGORY_CHART_ROLES[role]})`;
}

function compactMoney(minor: number, currency: string): string {
  return money(BigInt(Math.round(minor)), currency).replace(/\.00$/u, '');
}

/** A column from the baseline `near` to `far`, rounded (4 px) at the far end. */
export function columnPath(x: number, width: number, near: number, far: number): string {
  const height = Math.abs(near - far);
  if (height < 0.5 || width <= 0) return '';
  const r = Math.min(RADIUS, width / 2, height);
  if (far < near) {
    return `M${x},${near}V${far + r}Q${x},${far} ${x + r},${far}H${x + width - r}Q${x + width},${far} ${x + width},${far + r}V${near}Z`;
  }
  return `M${x},${near}V${far - r}Q${x},${far} ${x + r},${far}H${x + width - r}Q${x + width},${far} ${x + width},${far - r}V${near}Z`;
}

export interface CategoryHistoryInnerProps {
  readonly width: number;
  readonly height: number;
  readonly view: HistoryView;
  readonly hue: FillHue;
  readonly selected: number;
  readonly onSelect: (index: number) => void;
  /** The month under the pointer (the hover readout), or null. */
  readonly onHover?: (index: number | null) => void;
  /** The pointer is over the plot (cancels a pending release of the hover readout). */
  readonly onPointerKeep?: () => void;
  /** The pointer left the plot: release the hover readout after its grace period (1.4.13). */
  readonly onPointerLeave?: () => void;
}

/** The plot. Exported so a unit test can drive it with an explicit size: `ParentSize` never measures in happy-dom. */
export function CategoryHistoryInner({
  width,
  height,
  view,
  hue,
  selected,
  onSelect,
  onHover,
  onPointerKeep,
  onPointerLeave,
}: CategoryHistoryInnerProps) {
  const patternId = `category-hatch-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const plotRef = useRef<SVGGElement>(null);
  const currency = view.currency ?? 'USD';
  const average = shownAverage(view);
  const domain = scaleLinear<number>({
    domain: domainOf(view) as [number, number],
    nice: 4,
  }).domain() as [number, number];
  const yTicks = scaleLinear<number>({ domain }).ticks(4);
  const yLabelWidth =
    Math.max(...yTicks.map((tick) => compactMoney(tick, currency).length)) * TICK_CHAR_PX;
  const margin = { top: 18, right: 8, bottom: X_LABEL_BAND, left: yLabelWidth + 10 };
  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);
  const keys = view.months.map((month) => month.month);
  const xScale = scaleBand<string>({
    domain: keys,
    range: [0, innerWidth],
    paddingInner: 0.3,
    paddingOuter: 0.15,
  });
  const yScale = scaleLinear<number>({ domain, range: [innerHeight, 0] });

  // Grow once from the baseline on first draw; never under reduced motion, never on a later re-render.
  // (`ParentSize` may first render at zero size, with no plot: the growth waits for the first real draw.)
  const grown = useRef(false);
  const drawn = innerWidth > 0 && innerHeight > 0;
  useEffect(() => {
    if (grown.current || !drawn) return;
    const node = plotRef.current;
    if (node === null) return;
    grown.current = true;
    if (prefersReducedMotion()) return;
    for (const column of node.querySelectorAll<SVGPathElement>('[data-column-bar]')) {
      if (typeof column.animate !== 'function') continue;
      column.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], {
        duration: 420,
        easing: 'cubic-bezier(0.2, 0, 0, 1)',
      });
    }
  }, [drawn]);

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const band = xScale.bandwidth();
  const step = xScale.step();
  const column = Math.max(Math.min(MAX_COLUMN, band), 1);
  const baseline = yScale(0);
  const center = (index: number) => (xScale(keys[index]!) ?? 0) + band / 2;
  const fill = chartFillVar(hue);
  const labelEvery = Math.max(1, Math.ceil(40 / step));
  const averageY = average === null ? null : yScale(Number(average));

  function indexAt(event: ReactPointerEvent<SVGRectElement>): number {
    const local = event.clientX - event.currentTarget.getBoundingClientRect().left;
    let best = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < keys.length; index += 1) {
      const distance = Math.abs(center(index) - local);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    }
    return best;
  }

  return (
    <svg width={width} height={height} aria-hidden="true" data-testid="category-history-plot">
      <defs>
        <pattern
          id={patternId}
          patternUnits="userSpaceOnUse"
          width={6}
          height={6}
          patternTransform="rotate(45)"
        >
          <rect width={6} height={6} fill={fill} opacity={0.35} />
          <line x1={0} y1={0} x2={0} y2={6} stroke={fill} strokeWidth={3} />
        </pattern>
      </defs>
      <Group left={margin.left} top={margin.top} innerRef={plotRef}>
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={0}
              x2={innerWidth}
              y1={yScale(tick)}
              y2={yScale(tick)}
              stroke={roleVar(tick === 0 ? 'axis' : 'gridline')}
              strokeWidth={1}
            />
            <text
              data-axis="y"
              x={-8}
              y={yScale(tick)}
              dy="0.32em"
              fontSize={11}
              fill={roleVar('label')}
              textAnchor="end"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {compactMoney(tick, currency)}
            </text>
          </g>
        ))}

        {view.months.map((month, index) => {
          const left = (xScale(month.month) ?? 0) + (band - column) / 2;
          const dimmed = index !== selected;
          const isZero = month.inHistory && month.amountMinor === 0n;
          return (
            <g
              key={month.month}
              data-month={month.month}
              data-selected={index === selected ? 'true' : undefined}
              data-current={month.isCurrent ? 'true' : undefined}
              data-in-history={month.inHistory ? 'true' : 'false'}
              data-zero={isZero ? 'true' : undefined}
              opacity={dimmed ? DIMMED : 1}
            >
              {month.inHistory && !isZero && (
                <path
                  data-column-bar=""
                  d={columnPath(left, column, baseline, yScale(Number(month.amountMinor)))}
                  fill={month.isCurrent ? `url(#${patternId})` : fill}
                  style={{
                    transformBox: 'fill-box',
                    transformOrigin: month.amountMinor < 0n ? 'top' : 'bottom',
                  }}
                />
              )}
              {isZero && (
                // A zero is drawn as a zero: a stub on the baseline, never an absent column.
                <rect
                  x={left}
                  y={baseline - 2}
                  width={column}
                  height={2}
                  rx={1}
                  fill={roleVar('axis')}
                  data-zero-stub=""
                />
              )}
            </g>
          );
        })}

        {averageY !== null && average !== null && (
          <g data-testid="category-average-line" data-average-minor={average.toString()}>
            <line
              x1={0}
              x2={innerWidth}
              y1={averageY}
              y2={averageY}
              stroke={roleVar('average')}
              strokeWidth={1.5}
              strokeDasharray="5 4"
              strokeLinecap="round"
            />
            <text
              x={innerWidth}
              y={averageY - 5}
              fontSize={11}
              fill={roleVar('label')}
              textAnchor="end"
              stroke={roleVar('surface')}
              strokeWidth={3}
              paintOrder="stroke"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              Avg {money(average, currency)}
            </text>
          </g>
        )}

        {view.months.map((month, index) =>
          index === selected ||
          (index % labelEvery === (view.months.length - 1) % labelEvery &&
            Math.abs(index - selected) * step >= 34) ? (
            <text
              key={`tick-${month.month}`}
              data-axis="x"
              x={center(index)}
              y={innerHeight + 15}
              fontSize={11}
              fontWeight={index === selected ? 600 : 400}
              fill={roleVar(index === selected ? 'strong' : 'label')}
              textAnchor="middle"
            >
              {tickLabel(month)}
            </text>
          ) : null,
        )}
        {view.months[selected] !== undefined && (
          // The selection marker: a small bar under the selected tick, in ink (not colour alone: the tick is bold).
          <rect
            x={center(selected) - 8}
            y={innerHeight + 20}
            width={16}
            height={3}
            rx={1.5}
            fill={roleVar('strong')}
            data-testid="category-selected-marker"
          />
        )}

        <rect
          x={0}
          y={-margin.top}
          width={innerWidth}
          height={innerHeight + margin.top + X_LABEL_BAND}
          fill="transparent"
          style={{ touchAction: 'pan-y', cursor: 'pointer' }}
          data-testid="category-history-surface"
          onPointerMove={(event) => {
            onPointerKeep?.();
            onHover?.(indexAt(event));
          }}
          onPointerDown={(event) => {
            onPointerKeep?.();
            onSelect(indexAt(event));
          }}
          onPointerLeave={() => (onPointerLeave === undefined ? onHover?.(null) : onPointerLeave())}
        />
      </Group>
    </svg>
  );
}

export interface CategoryHistoryChartProps {
  readonly view: HistoryView;
  readonly hue: FillHue;
  /** "Groceries by month" — names the slider and the table. */
  readonly title: string;
  readonly selected: number;
  readonly onSelect: (index: number) => void;
  readonly height?: number;
}

export function CategoryHistoryChart({
  view,
  hue,
  title,
  selected,
  onSelect,
  height = 220,
}: CategoryHistoryChartProps) {
  const [announcement, setAnnouncement] = useState('');
  // The hover layer (dataviz: every chart has one): the month under the pointer, in a readout that is hoverable,
  // persistent and dismissed by Escape (1.4.13, `useChartTooltipRules`). Pressing selects; hovering only reads.
  const [hovered, setHovered] = useState<number | null>(null);
  const release = useCallback(() => setHovered(null), []);
  const rules = useChartTooltipRules(release, hovered !== null);
  const currency = view.currency ?? 'USD';
  const average = shownAverage(view);
  const sentence = monthSentence(view, selected);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const next = moveSelection(view.months.length, selected, event.key);
    if (next === null) return;
    event.preventDefault();
    if (next !== selected) onSelect(next);
    setAnnouncement(monthSentence(view, next));
  }

  return (
    <div data-testid="category-history" data-currency={currency} className="relative">
      {hovered !== null && view.months[hovered] !== undefined && (
        <div
          data-chart-readout=""
          data-testid="category-hover-readout"
          {...rules.readoutProps}
          className="absolute right-0 top-0 z-10 max-w-72 rounded-md border border-border-secondary bg-bg-overlay px-2.5 py-1.5 text-caption text-text-primary shadow-sm"
        >
          {monthSentence(view, hovered)}
          {hovered !== selected && (
            <span className="block text-text-secondary">Press to show its transactions.</span>
          )}
        </div>
      )}
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${title}: choose a month`}
        aria-valuemin={1}
        aria-valuemax={view.months.length}
        aria-valuenow={selected + 1}
        aria-valuetext={sentence}
        onKeyDown={onKeyDown}
        className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        style={{ height }}
        data-testid="category-history-slider"
      >
        <ParentSize>
          {({ width, height: parentHeight }) => (
            <CategoryHistoryInner
              width={width}
              height={parentHeight}
              view={view}
              hue={hue}
              selected={selected}
              onSelect={(index) => {
                onSelect(index);
                setAnnouncement('');
              }}
              onHover={setHovered}
              onPointerKeep={rules.keep}
              onPointerLeave={rules.onChartLeave}
            />
          )}
        </ParentSize>
      </div>
      <p className="sr-only" aria-live="polite" data-testid="category-history-announcement">
        {announcement}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-secondary">
        <span className="inline-flex items-center gap-1.5">
          <svg width={18} height={10} aria-hidden="true" className="shrink-0">
            <line
              x1={1}
              x2={17}
              y1={5}
              y2={5}
              stroke={roleVar('average')}
              strokeWidth={1.5}
              strokeDasharray="5 4"
            />
          </svg>
          {average === null
            ? 'Average withheld'
            : `Average month (last 12 complete months): ${money(average, currency)}`}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <svg width={10} height={10} aria-hidden="true" className="shrink-0">
            <rect width={10} height={10} rx={2} fill={chartFillVar(hue)} opacity={0.5} />
          </svg>
          Hatched: this month so far
        </span>
      </p>

      {/* 09 §5.6: every month, for the reader the plot cannot reach — including the zero months, said in words. */}
      <ChartDataTable
        className="mt-1"
        caption={`${title}. The average is over the complete months in your ledger's history, zero months included; this month is never in it.`}
        columns={[
          'Month',
          view.side === 'income' ? 'Received' : 'Spent',
          'Transactions',
          'vs average',
        ]}
        rows={view.months.map((month) => [
          `${monthLabel(month)}${month.isCurrent ? ' (so far)' : ''}`,
          tableAmount(view, month),
          month.inHistory ? String(month.transactionCount) : '—',
          average === null || !month.inHistory
            ? '—'
            : versusAverage(month.amountMinor, average, currency),
        ])}
      />
    </div>
  );
}
