// SPDX-License-Identifier: MIT
import { curveMonotoneX } from '@visx/curve';
import { LinearGradient } from '@visx/gradient';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear, scaleTime } from '@visx/scale';
import { AreaClosed, LinePath } from '@visx/shape';
import { defaultStyles, Tooltip, useTooltip } from '@visx/tooltip';
import { format } from 'date-fns';
import { useId, useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { ChartDataTable } from '../components/patterns/ChartDataTable.tsx';
import { formatMoney, parseWireMoney } from '../lib/money.ts';
import { useChartTooltipRules } from '../components/patterns/chart-tooltip.ts';

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

/** Skips `null` — a day with no data must not collapse the y-domain to zero. */
function numberExtent(points: readonly NetWorthPoint[]): [number, number] {
  const values = points
    .map((point) => point.netWorthMinor)
    .filter((value): value is number => value !== null);
  let lo = values[0] ?? 0;
  let hi = lo;
  for (const value of values) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
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
  /** `null` means "the window has no data for this day" (a gap), never zero. */
  readonly netWorthMinor: number | null;
  /**
   * 08 §3.5: a day is sealed once it closes and never changes after. Omitted
   * ⇒ treated as sealed, so every pre-existing caller (mock data, the
   * kitchen sink, `ForecastBandChart`'s sibling) keeps its original solid
   * line with no code change.
   */
  readonly sealed?: boolean;
  /** `'observed' | 'interpolated' | 'corrected'` from the API, or `null`. */
  readonly source?: string | null;
}

/** `point.sealed` defaults to `true` — see `NetWorthPoint.sealed`'s doc. */
export function isSealedPoint(point: NetWorthPoint): boolean {
  return point.sealed ?? true;
}

export function isInterpolatedPoint(point: NetWorthPoint): boolean {
  return point.source === 'interpolated';
}

export interface SealedSegment {
  readonly sealed: boolean;
  readonly points: readonly NetWorthPoint[];
}

/**
 * Splits a series into contiguous runs of equal sealed-ness so sealed
 * history can be drawn solid and the live/unsealed tail dashed — "sealed
 * history visually distinct from today's live row" (dispatch §3, WP 3.12).
 *
 * Each run repeats its predecessor's last point as its own first point, so
 * the drawn line is continuous across the seam rather than showing a gap
 * exactly where sealed history ends.
 */
export function segmentBySealed(points: readonly NetWorthPoint[]): SealedSegment[] {
  if (points.length === 0) return [];
  const segments: SealedSegment[] = [];
  let currentSealed = isSealedPoint(points[0]!);
  let current: NetWorthPoint[] = [points[0]!];
  for (let i = 1; i < points.length; i += 1) {
    const point = points[i]!;
    const sealed = isSealedPoint(point);
    if (sealed === currentSealed) {
      current.push(point);
    } else {
      segments.push({ sealed: currentSealed, points: current });
      currentSealed = sealed;
      current = [points[i - 1]!, point]; // repeat the seam point for continuity
    }
  }
  segments.push({ sealed: currentSealed, points: current });
  return segments;
}

/**
 * Deterministic mock series (90 days, fixed anchor date — never `new Date()`,
 * so the chart is stable across renders, tests, and Playwright screenshots).
 * A small linear-congruential generator stands in for real daily variance;
 * swap for the real `GET /net-worth/series` window once a caller wires it —
 * `features/networth/NetWorthChart.tsx` does, on `_app.index.tsx`.
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
  color: string;
  showSealedLegend: boolean;
}

function ChartInner({ width, height, data, color, showSealedLegend }: ChartInnerProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<NetWorthPoint>();
  const tooltipRules = useChartTooltipRules(hideTooltip, tooltipOpen);

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

  const segments = useMemo(() => segmentBySealed(data), [data]);
  const interpolated = useMemo(() => data.filter(isInterpolatedPoint), [data]);
  // `useId`, not `Math.random` — a render must stay pure, and `useId` is
  // React's own stable-per-instance identifier. Two currency series stacked
  // on one screen must not share one `<linearGradient id>` (SVG ids are
  // document-global).
  const gradientId = `net-worth-gradient-${useId()}`;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  function handlePointerMove(event: ReactPointerEvent<SVGRectElement>): void {
    tooltipRules.keep();
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const date = xScale.invert(localX);
    const chosen = data[nearestIndex(data, date)];
    if (chosen === undefined || chosen.netWorthMinor === null) return;
    showTooltip({
      tooltipData: chosen,
      tooltipLeft: xScale(chosen.date),
      tooltipTop: yScale(chosen.netWorthMinor),
    });
  }

  const tickCount = width < 480 ? 3 : 6;
  const xTicks = xScale.ticks(tickCount);
  const hasUnsealed = data.some((point) => !isSealedPoint(point));

  const ariaLabel = [
    'Net worth over time',
    hasUnsealed ? "today's figure is unsealed and may still change" : null,
    interpolated.length > 0
      ? `${String(interpolated.length)} interpolated day${interpolated.length === 1 ? '' : 's'}`
      : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' — ');

  return (
    <div className="relative">
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <LinearGradient id={gradientId} from={color} to={color} fromOpacity={0.28} toOpacity={0} />
        <Group left={margin.left} top={margin.top}>
          {segments.map((segment, index) => (
            <Group key={index}>
              <AreaClosed<NetWorthPoint>
                data={segment.points as NetWorthPoint[]}
                x={(d: NetWorthPoint) => xScale(d.date)}
                y={(d: NetWorthPoint) => (d.netWorthMinor === null ? 0 : yScale(d.netWorthMinor))}
                defined={(d: NetWorthPoint) => d.netWorthMinor !== null}
                yScale={yScale}
                curve={curveMonotoneX}
                fill={`url(#${gradientId})`}
                fillOpacity={segment.sealed ? 1 : 0.6}
                stroke="none"
              />
              <LinePath<NetWorthPoint>
                data={segment.points as NetWorthPoint[]}
                x={(d: NetWorthPoint) => xScale(d.date)}
                y={(d: NetWorthPoint) => (d.netWorthMinor === null ? 0 : yScale(d.netWorthMinor))}
                defined={(d: NetWorthPoint) => d.netWorthMinor !== null}
                curve={curveMonotoneX}
                stroke={color}
                strokeWidth={2}
                strokeDasharray={segment.sealed ? undefined : '5,4'}
              />
            </Group>
          ))}
          {interpolated.map((point) =>
            point.netWorthMinor === null ? null : (
              <circle
                key={point.date.getTime()}
                cx={xScale(point.date)}
                cy={yScale(point.netWorthMinor)}
                r={3}
                fill="var(--bg-surface)"
                stroke={color}
                strokeWidth={1.5}
              />
            ),
          )}
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
            onPointerLeave={tooltipRules.onChartLeave}
          />
        </Group>
      </svg>
      {tooltipOpen &&
        tooltipData !== undefined &&
        tooltipData.netWorthMinor !== null &&
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
            {formatTick(tooltipData.date)} · {formatUsd(tooltipData.netWorthMinor)}
            {!isSealedPoint(tooltipData) && ' · live (unsealed)'}
            {isInterpolatedPoint(tooltipData) && ' · interpolated'}
          </Tooltip>
        )}
      {showSealedLegend && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4" style={{ backgroundColor: color }} />
            Sealed history
          </span>
          {hasUnsealed && (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-4"
                style={{
                  backgroundImage: `repeating-linear-gradient(to right, ${color} 0 4px, transparent 4px 8px)`,
                }}
              />
              Live (unsealed) — today's figure and may still change
            </span>
          )}
          {interpolated.length > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-full border"
                style={{ borderColor: color, backgroundColor: 'var(--bg-surface)' }}
              />
              Interpolated day (no observation; filled from neighbours)
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export interface NetWorthAreaChartProps {
  data?: readonly NetWorthPoint[];
  height?: number;
  className?: string;
  /** Line/area colour — lets a caller draw one distinct colour per currency. */
  color?: string;
  /** A small label pill (e.g. a currency code) pinned to the chart's corner. */
  seriesLabel?: string;
  /** Renders the sealed/live/interpolated legend row beneath the chart. */
  showSealedLegend?: boolean;
}

/**
 * The one visx chart in this work package (05-frontend-architecture.md §3.3 —
 * "visx v4, single library"), proving the pipeline end to end: a gradient
 * area fill, `curveMonotoneX`, a hand-drawn bottom time axis (a single tick
 * row doesn't need `@visx/axis`'s full API), and a pointer-tracked tooltip.
 * Every other chart in the app follows this shape.
 *
 * Extended for WP 3.12 rather than duplicated: `sealed`/`source` on each
 * point drive the sealed-vs-live line styling and the interpolated-day
 * markers, and `color`/`seriesLabel` let `features/networth/NetWorthChart.tsx`
 * stack one instance per currency — "one series per currency until an FX
 * rate exists, never a silently-summed line" (dispatch §3). Mock data by
 * default, unchanged from before this work package.
 */
/** `seriesLabel` is a currency code when the caller draws one series per currency; otherwise the dollar the mock data was in. */
function currencyOf(seriesLabel: string | undefined): string {
  return seriesLabel !== undefined && /^[A-Z]{3}$/.test(seriesLabel) ? seriesLabel : 'USD';
}

function tableRows(data: readonly NetWorthPoint[], currency: string): string[][] {
  return data.map((point) => [
    format(point.date, 'MMM d, yyyy'),
    point.netWorthMinor === null
      ? 'No value recorded'
      : formatMoney(parseWireMoney({ minor: String(point.netWorthMinor), currency }), {
          signDisplay: 'auto',
        }),
    [
      isSealedPoint(point) ? 'Sealed' : 'Live (unsealed)',
      isInterpolatedPoint(point) ? 'interpolated' : null,
      point.source === 'corrected' ? 'corrected' : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
  ]);
}

export function NetWorthAreaChart({
  data = MOCK_SERIES,
  height = 220,
  className,
  color = 'var(--accent)',
  seriesLabel,
  showSealedLegend = false,
}: NetWorthAreaChartProps) {
  return (
    <div className={className}>
      {seriesLabel !== undefined && (
        <p
          className="mb-1 text-caption font-medium text-text-secondary"
          data-testid={`net-worth-series-label-${seriesLabel}`}
        >
          {seriesLabel}
        </p>
      )}
      <div style={{ height }}>
        <ParentSize>
          {({ width, height: parentHeight }) => (
            <ChartInner
              width={width}
              height={parentHeight}
              data={data}
              color={color}
              showSealedLegend={showSealedLegend}
            />
          )}
        </ParentSize>
      </div>
      {/* 09 §5.6: the tooltip above needs a pointer and the line needs sight; this is the same series for everyone. */}
      <ChartDataTable
        className="mt-1"
        caption={`Net worth over time${seriesLabel === undefined ? '' : `, ${seriesLabel}`}`}
        columns={['Date', 'Value', 'Status']}
        rows={tableRows(data, currencyOf(seriesLabel))}
      />
    </div>
  );
}
