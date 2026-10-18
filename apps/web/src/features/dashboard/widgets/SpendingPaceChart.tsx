// SPDX-License-Identifier: MIT
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { defaultStyles, TooltipWithBounds, useTooltip } from '@visx/tooltip';
import { useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { SpendingPace } from '../../../api/generated/types.gen.ts';
import { ChartDataTable } from '../../../components/patterns/ChartDataTable.tsx';
import { useChartTooltipRules } from '../../../components/patterns/chart-tooltip.ts';
import { formatMoney, parseWireMoney } from '../../../lib/money.ts';
import { monthName, paceRows, type PaceRow } from './pace.ts';
import { PACE_LAST_MONTH_OPACITY, paceVar } from './pace-chart-tokens.ts';

/**
 * The spending pace (WP 10.9; Monarch's equivalent), drawn by the dataviz method.
 *
 * The question is "am I spending faster than last month?", which is a change-over-time comparison of running
 * totals, so: a line per series on one money axis (never two), x = day of the month.
 *
 *  - **This month**, solid 2 px in the expenses role, ending at today with an 8 px dot ringed in the surface.
 *  - **Last month**, dotted, the line role at reduced opacity — the reference, not a second headline.
 *  - **The trailing three-month average**, a 1 px hairline.
 *  - **Today** marked by a vertical hairline from the axis to the dot.
 *  - A light y-axis (compact money ticks, tabular figures, solid hairline gridlines) and x ticks at the 1st, the
 *    8th, 15th, 22nd and the month's last day, the end labels anchored inward.
 *  - **The readout** (pointer and the crosshair) lists every series at the day; **the table** carries every value
 *    for everyone else. A legend names the three strokes, so identity never rests on colour.
 *
 * Nothing animates (so nothing moves under reduced motion either).
 */

function moneyText(minor: bigint | number, currency: string, compact = false): string {
  return formatMoney(parseWireMoney({ minor: String(minor), currency }), {
    signDisplay: 'auto',
    compact,
  });
}

/** Width of one tick-label character at 11 px Geist with tabular figures (0.6 em), rounded up. */
const TICK_CHAR_PX = 7;
const X_LABEL_BAND = 22;

interface SeriesPoint {
  readonly day: number;
  readonly minor: number;
}

/** Presentation only: a pixel position from minor units (08 §6.5's carve-out, `toNumberApproximate`). */
function toPoints(series: SpendingPace['days'], maxDay: number): SeriesPoint[] {
  return series
    .filter((point) => point.day <= maxDay)
    .map((point) => ({ day: point.day, minor: Number(point.cumulativeMinor) }));
}

export function paceXTicks(daysInMonth: number, innerWidth: number): number[] {
  const candidates = innerWidth < 260 ? [1, 15, daysInMonth] : [1, 8, 15, 22, daysInMonth];
  return [...new Set(candidates.filter((day) => day <= daysInMonth))];
}

export interface PaceChartInnerProps {
  readonly width: number;
  readonly height: number;
  readonly pace: SpendingPace;
  readonly currency: string;
}

/** Exported so a unit test can drive it with an explicit size: `ParentSize` never measures in happy-dom. */
export function PaceChartInner({ width, height, pace, currency }: PaceChartInnerProps) {
  const { tooltipData, tooltipLeft, tooltipOpen, showTooltip, hideTooltip } = useTooltip<PaceRow>();
  const tooltipRules = useChartTooltipRules(hideTooltip, tooltipOpen);

  const maxDay = pace.daysInMonth;
  const thisMonth = useMemo(() => toPoints(pace.days, maxDay), [pace.days, maxDay]);
  const lastMonth = useMemo(() => toPoints(pace.lastMonth, maxDay), [pace.lastMonth, maxDay]);
  const average = useMemo(
    () => toPoints(pace.trailingAverage, maxDay),
    [pace.trailingAverage, maxDay],
  );
  const rows = useMemo(() => paceRows(pace), [pace]);

  const yDomain = useMemo((): [number, number] => {
    let lo = 0;
    let hi = 0;
    for (const point of [...thisMonth, ...lastMonth, ...average]) {
      lo = Math.min(lo, point.minor);
      hi = Math.max(hi, point.minor);
    }
    if (hi === lo) hi = lo + 10_000;
    return scaleLinear<number>({ domain: [lo, hi], nice: 4 }).domain() as [number, number];
  }, [thisMonth, lastMonth, average]);

  const yTicks = scaleLinear<number>({ domain: yDomain }).ticks(4);
  const yLabelWidth =
    Math.max(...yTicks.map((tick) => moneyText(tick, currency, true).length)) * TICK_CHAR_PX;
  const margin = { top: 12, right: 14, bottom: X_LABEL_BAND, left: yLabelWidth + 10 };
  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);

  const xScale = scaleLinear<number>({ domain: [1, Math.max(maxDay, 2)], range: [0, innerWidth] });
  const yScale = scaleLinear<number>({ domain: yDomain, range: [innerHeight, 0] });

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const end = thisMonth.at(-1);
  const comparePoint =
    end === undefined ? undefined : lastMonth[Math.min(end.day, lastMonth.length) - 1];
  const ariaLabel =
    `Spending pace for ${monthName(pace.month)}: ` +
    (end === undefined
      ? 'nothing spent yet. '
      : `${moneyText(end.minor, currency)} spent through day ${String(end.day)}. `) +
    (comparePoint === undefined
      ? 'No spending recorded last month to compare with.'
      : `By day ${String(comparePoint.day)} last month, ${moneyText(comparePoint.minor, currency)}.`) +
    (average.length > 0 ? ' A three-month average is drawn for reference.' : '');

  function handlePointerMove(event: ReactPointerEvent<SVGRectElement>): void {
    tooltipRules.keep();
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const day = Math.min(Math.max(Math.round(xScale.invert(localX)), 1), maxDay);
    const row = rows[day - 1];
    if (row === undefined) return;
    showTooltip({ tooltipData: row, tooltipLeft: xScale(day), tooltipTop: 0 });
  }

  return (
    <div className="relative">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} data-testid="pace-chart">
        <Group left={margin.left} top={margin.top}>
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={0}
                x2={innerWidth}
                y1={yScale(tick)}
                y2={yScale(tick)}
                stroke={paceVar(tick === 0 ? 'today' : 'gridline')}
                strokeWidth={1}
              />
              <text
                data-axis="y"
                x={-8}
                y={yScale(tick)}
                dy="0.32em"
                fontSize={11}
                fill={paceVar('axisInk')}
                textAnchor="end"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {moneyText(tick, currency, true)}
              </text>
            </g>
          ))}

          {average.length > 1 && (
            <LinePath<SeriesPoint>
              data={average}
              x={(d) => xScale(d.day)}
              y={(d) => yScale(d.minor)}
              stroke={paceVar('average')}
              strokeWidth={1}
              data-series="average"
            />
          )}

          {lastMonth.length > 1 && (
            <LinePath<SeriesPoint>
              data={lastMonth}
              x={(d) => xScale(d.day)}
              y={(d) => yScale(d.minor)}
              stroke={paceVar('lastMonth')}
              strokeOpacity={PACE_LAST_MONTH_OPACITY}
              strokeWidth={2}
              strokeDasharray="0.5 5"
              strokeLinecap="round"
              data-series="last-month"
            />
          )}

          {end !== undefined && pace.today !== null && (
            <line
              x1={xScale(end.day)}
              x2={xScale(end.day)}
              y1={innerHeight}
              y2={yScale(end.minor)}
              stroke={paceVar('today')}
              strokeWidth={1}
              data-testid="pace-today-rule"
            />
          )}

          {thisMonth.length > 0 && (
            <LinePath<SeriesPoint>
              data={thisMonth}
              x={(d) => xScale(d.day)}
              y={(d) => yScale(d.minor)}
              stroke={paceVar('thisMonth')}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              data-series="this-month"
            />
          )}

          {end !== undefined && (
            <circle
              cx={xScale(end.day)}
              cy={yScale(end.minor)}
              r={4}
              fill={paceVar('thisMonth')}
              stroke={paceVar('ring')}
              strokeWidth={2}
              paintOrder="stroke"
              data-testid="pace-today-dot"
            />
          )}

          {paceXTicks(maxDay, innerWidth).map((day, index, all) => (
            <text
              key={day}
              data-axis="x"
              x={xScale(day)}
              y={innerHeight + 16}
              fontSize={11}
              fill={paceVar('axisInk')}
              textAnchor={index === 0 ? 'start' : index === all.length - 1 ? 'end' : 'middle'}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {day}
            </text>
          ))}

          {tooltipOpen && tooltipLeft !== undefined && (
            <line
              x1={tooltipLeft}
              x2={tooltipLeft}
              y1={0}
              y2={innerHeight}
              stroke={paceVar('axisInk')}
              strokeOpacity={0.5}
              strokeWidth={1}
              pointerEvents="none"
            />
          )}

          <rect
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onPointerMove={handlePointerMove}
            onPointerLeave={tooltipRules.onChartLeave}
          />
        </Group>
      </svg>
      {tooltipOpen && tooltipData !== undefined && tooltipLeft !== undefined && (
        <TooltipWithBounds
          {...tooltipRules.readoutProps}
          data-chart-readout=""
          left={tooltipLeft + margin.left}
          top={margin.top}
          style={{
            ...defaultStyles,
            pointerEvents: 'auto',
            background: 'var(--bg-overlay)',
            color: 'var(--text-primary)',
            boxShadow: 'var(--shadow-elev-2)',
            border: '1px solid var(--border-divider)',
            borderRadius: 8,
            fontSize: 12,
            lineHeight: '18px',
            maxWidth: 240,
          }}
        >
          <PaceReadout row={tooltipData} currency={currency} month={pace.month} />
        </TooltipWithBounds>
      )}
    </div>
  );
}

function LineKey({ series }: { readonly series: 'this' | 'last' | 'average' }) {
  return (
    <svg width={18} height={10} aria-hidden="true" className="shrink-0">
      <line
        x1={2}
        x2={16}
        y1={5}
        y2={5}
        stroke={paceVar(
          series === 'this' ? 'thisMonth' : series === 'last' ? 'lastMonth' : 'average',
        )}
        strokeOpacity={series === 'last' ? PACE_LAST_MONTH_OPACITY : 1}
        strokeWidth={series === 'average' ? 1 : 2}
        strokeDasharray={series === 'last' ? '0.5 4' : undefined}
        strokeLinecap="round"
      />
    </svg>
  );
}

function PaceReadout({
  row,
  currency,
  month,
}: {
  readonly row: PaceRow;
  readonly currency: string;
  readonly month: string;
}) {
  const line = (label: string, series: 'this' | 'last' | 'average', value: bigint | null) =>
    value === null ? null : (
      <div className="flex items-center gap-1.5">
        <LineKey series={series} />
        <strong className="font-semibold">{moneyText(value, currency)}</strong>
        <span className="text-text-secondary">{label}</span>
      </div>
    );
  return (
    <div className="tabular-nums">
      <div className="text-text-secondary">
        {monthName(month)} {row.day}
      </div>
      {line('this month', 'this', row.thisMonth)}
      {line('last month', 'last', row.lastMonth)}
      {line('3-month average', 'average', row.average)}
    </div>
  );
}

function PaceLegend({
  hasLast,
  hasAverage,
  averageMonths,
}: {
  readonly hasLast: boolean;
  readonly hasAverage: boolean;
  readonly averageMonths: number;
}) {
  return (
    <ul
      aria-label="Chart key"
      className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary"
      data-testid="pace-legend"
    >
      <li className="flex items-center gap-1.5">
        <LineKey series="this" />
        This month
      </li>
      {hasLast && (
        <li className="flex items-center gap-1.5">
          <LineKey series="last" />
          Last month
        </li>
      )}
      {hasAverage && (
        <li className="flex items-center gap-1.5">
          <LineKey series="average" />
          {averageMonths === 3 ? '3-month average' : `${String(averageMonths)}-month average`}
        </li>
      )}
    </ul>
  );
}

export interface SpendingPaceChartProps {
  readonly pace: SpendingPace;
  readonly currency: string;
  readonly height?: number;
  readonly className?: string;
}

export function SpendingPaceChart({
  pace,
  currency,
  height = 200,
  className,
}: SpendingPaceChartProps) {
  const rows = paceRows(pace);
  const cell = (value: bigint | null) => (value === null ? '—' : moneyText(value, currency));
  return (
    <div className={className}>
      <PaceLegend
        hasLast={pace.lastMonth.length > 0}
        hasAverage={pace.trailingAverage.length > 0}
        averageMonths={pace.trailingMonths.length}
      />
      <div className="mt-2" style={{ height }}>
        <ParentSize>
          {({ width, height: parentHeight }) => (
            <PaceChartInner width={width} height={parentHeight} pace={pace} currency={currency} />
          )}
        </ParentSize>
      </div>
      {/* 09 §5.6: every value, for the reader the readout (pointer-only) and the strokes cannot reach. */}
      <ChartDataTable
        className="mt-1"
        caption={`Spent so far, by day of the month: ${monthName(pace.month)}, ${monthName(pace.lastMonthKey)}, and the 3-month average`}
        columns={['Day', monthName(pace.month), monthName(pace.lastMonthKey), '3-month average']}
        rows={rows.map((row) => [
          String(row.day),
          cell(row.thisMonth),
          cell(row.lastMonth),
          cell(row.average),
        ])}
      />
    </div>
  );
}
