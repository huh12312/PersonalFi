// SPDX-License-Identifier: MIT
import { DateOnly } from '@core/kernel';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { defaultStyles, TooltipWithBounds, useTooltip } from '@visx/tooltip';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { useChartTooltipRules } from '../../components/patterns/chart-tooltip.ts';
import { formatDateOnly } from '../../lib/date.ts';
import { healthVar } from './health-chart-tokens.ts';
import { canDrawSparkline, type SeriesPoint } from './history.ts';

export interface SparklineProps {
  readonly points: readonly SeriesPoint[];
  /** What the line is, for its accessible name: "Score over the last 90 days". */
  readonly label: string;
  readonly formatValue: (value: number) => string;
  /** Said instead of a line when there are fewer than two points. */
  readonly withheldText: string;
  /** The bounds the y-range may not leave (the score is 0–100); the range itself is the points' own, padded. */
  readonly domain?: readonly [number, number];
  /** The smallest y-span drawn, so a near-flat series is not blown up into a cliff. */
  readonly minSpan?: number;
  readonly height?: number;
  readonly testId?: string;
}

const MARGIN = { top: 6, right: 8, bottom: 6, left: 6 };

/**
 * A history sparkline (WP 10.12): one 2 px `--chart-line` series, x = date (a missing day is a gap in time, not a
 * point), the last day's dot ringed in the surface. A hover readout names the day and the value (dismissable,
 * hoverable, persistent — `useChartTooltipRules`); the screen's table carries every value for everyone else.
 * **Withheld under two points**: one point is not a line, and a sentence says so.
 */
export function Sparkline(props: SparklineProps) {
  if (!canDrawSparkline(props.points)) {
    return (
      <p
        className="text-caption text-text-muted"
        data-testid={props.testId ?? 'sparkline-withheld'}
      >
        {props.withheldText}
      </p>
    );
  }
  return (
    <div className="w-full" style={{ height: props.height ?? 56 }}>
      <ParentSize>
        {({ width }) => <SparklineInner {...props} width={Math.min(width, 640)} />}
      </ParentSize>
    </div>
  );
}

/** Exported so a unit test can draw it at an explicit width (`ParentSize` never measures in happy-dom). */
export function SparklineInner({
  points,
  label,
  formatValue,
  domain,
  minSpan = 0,
  height = 56,
  testId,
  width,
}: SparklineProps & { readonly width: number }) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<SeriesPoint>();
  const rules = useChartTooltipRules(hideTooltip, tooltipOpen);
  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);
  if (innerWidth <= 0 || innerHeight <= 0 || !canDrawSparkline(points)) return null;

  const days = points.map((point) => DateOnly.toEpochDay(DateOnly.parse(point.date)));
  const values = points.map((point) => point.value);
  // The points' own range, padded and at least `minSpan` tall: a sparkline shows the shape of the trend, and a
  // 0–100 axis flattens a few points' movement into a straight line.
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = Math.max((minSpan - (max - min)) / 2, (max - min) * 0.1);
  const lo = domain === undefined ? min - pad : Math.max(domain[0], min - pad);
  const hi = domain === undefined ? max + pad : Math.min(domain[1], max + pad);
  const xScale = scaleLinear<number>({
    domain: [Math.min(...days), Math.max(...days)],
    range: [0, innerWidth],
  });
  const yScale = scaleLinear<number>({
    domain: hi === lo ? [lo - 1, hi + 1] : [lo, hi],
    range: [innerHeight, 0],
  });
  const xOf = (point: SeriesPoint) => xScale(DateOnly.toEpochDay(DateOnly.parse(point.date)));
  const last = points[points.length - 1]!;
  const first = points[0]!;

  function handlePointerMove(event: ReactPointerEvent<SVGRectElement>): void {
    rules.keep();
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    let nearest = first;
    for (const point of points) {
      if (Math.abs(xOf(point) - localX) < Math.abs(xOf(nearest) - localX)) nearest = point;
    }
    showTooltip({
      tooltipData: nearest,
      tooltipLeft: xOf(nearest),
      tooltipTop: yScale(nearest.value),
    });
  }

  const ariaLabel =
    `${label}: ${String(points.length)} days from ${formatDateOnly(first.date)} ` +
    `(${formatValue(first.value)}) to ${formatDateOnly(last.date)} (${formatValue(last.value)}).`;

  return (
    <div className="relative">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={ariaLabel}
        data-testid={testId ?? 'sparkline'}
      >
        <g transform={`translate(${String(MARGIN.left)} ${String(MARGIN.top)})`}>
          <LinePath<SeriesPoint>
            data={[...points]}
            x={xOf}
            y={(point) => yScale(point.value)}
            stroke={healthVar('line')}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill="none"
          />
          <circle
            cx={xOf(last)}
            cy={yScale(last.value)}
            r={4}
            fill={healthVar('line')}
            stroke={healthVar('ring')}
            strokeWidth={2}
            paintOrder="stroke"
            data-sparkline-end=""
          />
          {tooltipOpen && tooltipLeft !== undefined && tooltipTop !== undefined && (
            <circle
              cx={tooltipLeft}
              cy={tooltipTop}
              r={4}
              fill={healthVar('ring')}
              stroke={healthVar('line')}
              strokeWidth={2}
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
            onPointerLeave={rules.onChartLeave}
          />
        </g>
      </svg>
      {tooltipOpen && tooltipData !== undefined && tooltipLeft !== undefined && (
        <TooltipWithBounds
          {...rules.readoutProps}
          data-chart-readout=""
          left={tooltipLeft + MARGIN.left}
          top={0}
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
            maxWidth: 220,
          }}
        >
          <div className="text-text-secondary">{formatDateOnly(tooltipData.date)}</div>
          <strong className="font-semibold">{formatValue(tooltipData.value)}</strong>
        </TooltipWithBounds>
      )}
    </div>
  );
}
