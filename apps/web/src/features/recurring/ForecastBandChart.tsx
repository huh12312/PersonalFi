// SPDX-License-Identifier: MIT
import { curveMonotoneX } from '@visx/curve';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear, scaleTime } from '@visx/scale';
import { AreaClosed, LinePath } from '@visx/shape';
import { defaultStyles, Tooltip, useTooltip } from '@visx/tooltip';
import { useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { ChartDataTable } from '../../components/patterns/ChartDataTable.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { formatMoney, parseWireMoney } from '../../lib/money.ts';
import type { ForecastPoint } from './forecast-series.ts';
import { useChartTooltipRules } from '../../components/patterns/chart-tooltip.ts';

function moneyText(minor: number): string {
  return formatMoney(parseWireMoney({ minor: String(minor), currency: 'USD' }), {
    signDisplay: 'exceptZero',
  });
}

/**
 * The 30-day forward cash-flow band (02-phase-2-dispatch.md §3 WP 2.10),
 * following `charts/NetWorthAreaChart.tsx`'s shape — the one visx pattern
 * this codebase uses everywhere (05-frontend-architecture.md §3.3): a
 * gradient/shaded band, a `curveMonotoneX` centre line, a hand-drawn bottom
 * axis, and a pointer-tracked tooltip. The band here is the detector's own
 * uncertainty (`forecast-series.ts#buildForecastBand`'s low/high), not a
 * visual flourish — every value plotted traces back to a real
 * `ProjectedCharge` from `GET /recurring/forecast`.
 */

function toLocalDate(dateOnly: string): Date {
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
}

function dateExtent(points: readonly ForecastPoint[]): [Date, Date] {
  const dates = points.map((point) => toLocalDate(point.date));
  return [dates[0] ?? new Date(), dates.at(-1) ?? new Date()];
}

function valueExtent(points: readonly ForecastPoint[]): [number, number] {
  let lo = 0;
  let hi = 0;
  for (const point of points) {
    lo = Math.min(lo, point.cumulativeLowMinor);
    hi = Math.max(hi, point.cumulativeHighMinor);
  }
  return [lo, hi];
}

function nearestIndex(points: readonly ForecastPoint[], target: Date): number {
  let best = 0;
  let bestDelta = Infinity;
  for (const [index, point] of points.entries()) {
    const delta = Math.abs(toLocalDate(point.date).getTime() - target.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = index;
    }
  }
  return best;
}

const margin = { top: 12, right: 12, bottom: 24, left: 12 };

interface ChartInnerProps {
  width: number;
  height: number;
  data: readonly ForecastPoint[];
}

function ChartInner({ width, height, data }: ChartInnerProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<ForecastPoint>();
  const tooltipRules = useChartTooltipRules(hideTooltip, tooltipOpen);

  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);

  const xScale = useMemo(() => {
    const [minDate, maxDate] = dateExtent(data);
    return scaleTime({ domain: [minDate, maxDate], range: [0, innerWidth] });
  }, [data, innerWidth]);

  const yScale = useMemo(() => {
    const [lo, hi] = valueExtent(data);
    const pad = (hi - lo) * 0.1 || 100;
    return scaleLinear({ domain: [lo - pad, hi + pad], range: [innerHeight, 0] });
  }, [data, innerHeight]);

  if (innerWidth <= 0 || innerHeight <= 0 || data.length === 0) return null;

  function handlePointerMove(event: ReactPointerEvent<SVGRectElement>): void {
    tooltipRules.keep();
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const date = xScale.invert(localX);
    const chosen = data[nearestIndex(data, date)];
    if (chosen === undefined) return;
    showTooltip({
      tooltipData: chosen,
      tooltipLeft: xScale(toLocalDate(chosen.date)),
      tooltipTop: yScale(chosen.cumulativeExpectedMinor),
    });
  }

  const tickCount = width < 480 ? 3 : 6;
  const xTicks = xScale.ticks(tickCount);
  const zeroY = yScale(0);

  return (
    <div className="relative">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Projected cash flow band from ${formatDateOnly(data[0]!.date, 'MMM d')} to ${formatDateOnly(data.at(-1)!.date, 'MMM d')}`}
      >
        <Group left={margin.left} top={margin.top}>
          <line
            x1={0}
            x2={innerWidth}
            y1={zeroY}
            y2={zeroY}
            stroke="var(--chart-gridline)"
            strokeDasharray="3,3"
          />
          <AreaClosed<ForecastPoint>
            data={data as ForecastPoint[]}
            x={(d: ForecastPoint) => xScale(toLocalDate(d.date))}
            y={(d: ForecastPoint) => yScale(d.cumulativeHighMinor)}
            y1={(d: ForecastPoint) => yScale(d.cumulativeHighMinor)}
            yScale={yScale}
            curve={curveMonotoneX}
            fill="var(--accent)"
            fillOpacity={0.12}
            stroke="none"
          />
          <AreaClosed<ForecastPoint>
            data={data as ForecastPoint[]}
            x={(d: ForecastPoint) => xScale(toLocalDate(d.date))}
            y={(d: ForecastPoint) => yScale(d.cumulativeLowMinor)}
            yScale={yScale}
            curve={curveMonotoneX}
            fill="var(--bg-surface)"
            fillOpacity={1}
            stroke="none"
          />
          <LinePath<ForecastPoint>
            data={data as ForecastPoint[]}
            x={(d: ForecastPoint) => xScale(toLocalDate(d.date))}
            y={(d: ForecastPoint) => yScale(d.cumulativeExpectedMinor)}
            curve={curveMonotoneX}
            stroke="var(--accent)"
            strokeWidth={2}
          />
          {xTicks.map((tick) => (
            <text
              key={tick.getTime()}
              x={xScale(tick)}
              y={innerHeight + 18}
              fontSize={11}
              fill="var(--chart-axis-ink)"
              textAnchor="middle"
            >
              {formatDateOnly(tick.toISOString().slice(0, 10), 'MMM d')}
            </text>
          ))}
          {tooltipOpen && tooltipLeft !== undefined && (
            <line
              x1={tooltipLeft}
              x2={tooltipLeft}
              y1={0}
              y2={innerHeight}
              stroke="var(--chart-gridline)"
              strokeDasharray="3,3"
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
      {tooltipOpen &&
        tooltipData !== undefined &&
        tooltipLeft !== undefined &&
        tooltipTop !== undefined && (
          <Tooltip
            {...tooltipRules.readoutProps}
            data-chart-readout=""
            left={tooltipLeft + margin.left}
            top={tooltipTop + margin.top}
            style={{
              ...defaultStyles,
              pointerEvents: 'auto',
              background: 'var(--bg-surface-raised)',
              color: 'var(--text-primary)',
              boxShadow: 'var(--shadow-elev-2)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            {formatDateOnly(tooltipData.date, 'MMM d')} ·{' '}
            {moneyText(tooltipData.cumulativeExpectedMinor)} (band{' '}
            {moneyText(tooltipData.cumulativeLowMinor)} –{' '}
            {moneyText(tooltipData.cumulativeHighMinor)})
          </Tooltip>
        )}
    </div>
  );
}

export interface ForecastBandChartProps {
  data: readonly ForecastPoint[];
  height?: number;
  className?: string;
}

export function ForecastBandChart({ data, height = 200, className }: ForecastBandChartProps) {
  return (
    <div className={className}>
      <div style={{ height }}>
        <ParentSize>
          {({ width, height: parentHeight }) => (
            <ChartInner width={width} height={parentHeight} data={data} />
          )}
        </ParentSize>
      </div>
      {/* 09 §5.6: the band's own figures, for the reader the tooltip (pointer-only) and the shading cannot reach. */}
      <ChartDataTable
        className="mt-1"
        caption="Projected cumulative cash flow, expected and the band around it"
        columns={['Date', 'Expected', 'Band low', 'Band high']}
        rows={data.map((point) => [
          formatDateOnly(point.date, 'MMM d'),
          moneyText(point.cumulativeExpectedMinor),
          moneyText(point.cumulativeLowMinor),
          moneyText(point.cumulativeHighMinor),
        ])}
      />
    </div>
  );
}
