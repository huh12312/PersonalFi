// SPDX-License-Identifier: MIT
import { curveMonotoneX } from '@visx/curve';
import { LinearGradient } from '@visx/gradient';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear, scaleTime } from '@visx/scale';
import { AreaClosed, LinePath } from '@visx/shape';
import { defaultStyles, Tooltip, useTooltip } from '@visx/tooltip';
import { format } from 'date-fns';
import { useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Small local replacements for `d3-array`'s `extent`/`min`/`max`/`bisector` —
 * `d3-array` and `d3-time-format` ship without bundled types and no
 * `@types/*` package is declared for either (05's chart-library pick is visx,
 * which wraps `d3-scale`/`d3-shape` behind its own typed API; this file is
 * the one place that would otherwise reach past that wrapper). `date-fns` is
 * already a direct, typed dependency and covers the one format call needed.
 */
function dateExtent(points: readonly NetWorthPoint[]): [Date, Date] {
  let lo = points[0]?.date ?? new Date();
  let hi = lo;
  for (const point of points) {
    if (point.date < lo) lo = point.date;
    if (point.date > hi) hi = point.date;
  }
  return [lo, hi];
}

function numberExtent(points: readonly NetWorthPoint[]): [number, number] {
  let lo = points[0]?.netWorthMinor ?? 0;
  let hi = lo;
  for (const point of points) {
    if (point.netWorthMinor < lo) lo = point.netWorthMinor;
    if (point.netWorthMinor > hi) hi = point.netWorthMinor;
  }
  return [lo, hi];
}

/** Index of the point nearest `target` — a linear scan is fine for ~90 points. */
function nearestIndex(points: readonly NetWorthPoint[], target: Date): number {
  let best = 0;
  let bestDelta = Infinity;
  for (const [index, point] of points.entries()) {
    const delta = Math.abs(point.date.getTime() - target.getTime());
    if (delta < bestDelta) {
      bestDelta = delta;
      best = index;
    }
  }
  return best;
}

export interface NetWorthPoint {
  readonly date: Date;
  readonly netWorthMinor: number;
}

/**
 * Deterministic mock series (90 days, fixed anchor date — never `new Date()`,
 * so the chart is stable across renders, tests, and Playwright screenshots).
 * A small linear-congruential generator stands in for real daily variance;
 * swap for the real `/net-worth/daily` series once that endpoint exists.
 */
function mockNetWorthSeries(): NetWorthPoint[] {
  const anchor = new Date('2026-06-11T00:00:00Z');
  const days = 90;
  const startMinor = 82_400_00;
  let seed = 42;
  const points: NetWorthPoint[] = [];
  for (let i = 0; i < days; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const noise = (seed % 2000) - 1000;
    const trend = i * 4800;
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() - (days - 1 - i));
    points.push({ date, netWorthMinor: startMinor + trend + noise });
  }
  return points;
}

const MOCK_SERIES = mockNetWorthSeries();
const formatTick = (date: Date) => format(date, 'MMM d');
const formatUsd = (minor: number) =>
  (minor / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const margin = { top: 12, right: 12, bottom: 24, left: 12 };

interface ChartInnerProps {
  width: number;
  height: number;
  data: readonly NetWorthPoint[];
}

function ChartInner({ width, height, data }: ChartInnerProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<NetWorthPoint>();

  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);

  const xScale = useMemo(() => {
    const [minDate, maxDate] = dateExtent(data);
    return scaleTime({ domain: [minDate, maxDate], range: [0, innerWidth] });
  }, [data, innerWidth]);

  const yScale = useMemo(() => {
    const [lo, hi] = numberExtent(data);
    const pad = (hi - lo) * 0.1 || 1;
    return scaleLinear({ domain: [lo - pad, hi + pad], range: [innerHeight, 0] });
  }, [data, innerHeight]);

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  function handlePointerMove(event: ReactPointerEvent<SVGRectElement>): void {
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const date = xScale.invert(localX);
    const chosen = data[nearestIndex(data, date)];
    if (chosen === undefined) return;
    showTooltip({
      tooltipData: chosen,
      tooltipLeft: xScale(chosen.date),
      tooltipTop: yScale(chosen.netWorthMinor),
    });
  }

  const tickCount = width < 480 ? 3 : 6;
  const xTicks = xScale.ticks(tickCount);

  return (
    <div className="relative">
      <svg width={width} height={height} role="img" aria-label="Net worth over the last 90 days">
        <LinearGradient
          id="net-worth-gradient"
          from="var(--accent)"
          to="var(--accent)"
          fromOpacity={0.28}
          toOpacity={0}
        />
        <Group left={margin.left} top={margin.top}>
          <AreaClosed<NetWorthPoint>
            data={data as NetWorthPoint[]}
            x={(d: NetWorthPoint) => xScale(d.date)}
            y={(d: NetWorthPoint) => yScale(d.netWorthMinor)}
            yScale={yScale}
            curve={curveMonotoneX}
            fill="url(#net-worth-gradient)"
            stroke="none"
          />
          <LinePath<NetWorthPoint>
            data={data as NetWorthPoint[]}
            x={(d: NetWorthPoint) => xScale(d.date)}
            y={(d: NetWorthPoint) => yScale(d.netWorthMinor)}
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
              {formatTick(tick)}
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
            onPointerLeave={hideTooltip}
          />
        </Group>
      </svg>
      {tooltipOpen &&
        tooltipData !== undefined &&
        tooltipLeft !== undefined &&
        tooltipTop !== undefined && (
          <Tooltip
            left={tooltipLeft + margin.left}
            top={tooltipTop + margin.top}
            style={{
              ...defaultStyles,
              background: 'var(--bg-surface-raised)',
              color: 'var(--text-primary)',
              boxShadow: 'var(--shadow-elev-2)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            {formatTick(tooltipData.date)} · {formatUsd(tooltipData.netWorthMinor)}
          </Tooltip>
        )}
    </div>
  );
}

export interface NetWorthAreaChartProps {
  data?: readonly NetWorthPoint[];
  height?: number;
  className?: string;
}

/**
 * The one visx chart in this work package (05-frontend-architecture.md §3.3 —
 * "visx v4, single library"), proving the pipeline end to end: a gradient
 * area fill, `curveMonotoneX`, a hand-drawn bottom time axis (a single tick
 * row doesn't need `@visx/axis`'s full API), and a pointer-tracked tooltip.
 * Every other chart in the app follows this shape. Mock data only — the real
 * series comes from `GET /net-worth/daily` once that route exists.
 */
export function NetWorthAreaChart({
  data = MOCK_SERIES,
  height = 220,
  className,
}: NetWorthAreaChartProps) {
  return (
    <div className={className} style={{ height }}>
      <ParentSize>
        {({ width, height: parentHeight }) => (
          <ChartInner width={width} height={parentHeight} data={data} />
        )}
      </ParentSize>
    </div>
  );
}
