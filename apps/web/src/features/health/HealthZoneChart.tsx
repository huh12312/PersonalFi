// SPDX-License-Identifier: MIT
import { DateOnly } from '@core/kernel';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { defaultStyles, TooltipWithBounds, useTooltip } from '@visx/tooltip';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { HealthThreshold } from '../../api/generated/types.gen.ts';
import { ChartDataTable } from '../../components/patterns/ChartDataTable.tsx';
import { useChartTooltipRules } from '../../components/patterns/chart-tooltip.ts';
import { formatDateOnly } from '../../lib/date.ts';
import { BAND_LABEL } from './format.ts';
import { healthVar, statusVar } from './health-chart-tokens.ts';
import type { SeriesPoint } from './history.ts';
import { bandFor, edgesOf, yDomainOf, zonesOf } from './zones.ts';

export interface HealthZoneChartProps {
  /** The metric's name: "Emergency fund". */
  readonly label: string;
  readonly threshold: HealthThreshold;
  /** The metric per day (scored days), oldest first. */
  readonly history: readonly SeriesPoint[];
  /** Today's value and date — the marked point. `null` when the pillar is withheld today. */
  readonly current: SeriesPoint | null;
  readonly formatValue: (value: number) => string;
  /** The first day of the window the chart spans (the history's 90 days). */
  readonly windowStart: string;
  readonly height?: number;
}

const BAND_COLUMN = 76;
const TICK_COLUMN = 56;
const MARGIN = { top: 10, right: BAND_COLUMN, bottom: 22, left: TICK_COLUMN };

/**
 * A pillar's metric against its health zones (WP 10.12; Monarch's equivalent). y is the
 * metric; the zones are horizontal bands whose edges are the scoring rules' boundaries (`thresholds` on the wire,
 * `zones.ts`), each in its band's status wash with the band's word in the same quartet's text ink; x is the 90-day
 * window. The metric's daily values are one 2 px `--chart-line` series and today's value is the marked point,
 * labelled "Now: …". A hover readout gives the day, the value and its band; "View as table" gives all of them.
 */
export function HealthZoneChart(props: HealthZoneChartProps) {
  const rows = [...props.history];
  if (props.current !== null && !rows.some((row) => row.date === props.current?.date)) {
    rows.push(props.current);
  }
  return (
    <figure className="flex flex-col gap-2">
      <div className="w-full" style={{ height: props.height ?? 240 }}>
        <ParentSize>{({ width }) => <HealthZoneChartInner {...props} width={width} />}</ParentSize>
      </div>
      <ChartDataTable
        caption={`${props.label} over the last 90 days`}
        columns={['Date', 'Value', 'Band']}
        rows={rows.map((row) => [
          formatDateOnly(row.date),
          props.formatValue(row.value),
          BAND_LABEL[bandFor(row.value, props.threshold)],
        ])}
      />
    </figure>
  );
}

/** Exported so a unit test can draw it at an explicit width. */
export function HealthZoneChartInner({
  label,
  threshold,
  history,
  current,
  formatValue,
  windowStart,
  height = 240,
  width,
}: HealthZoneChartProps & { readonly width: number }) {
  const { tooltipData, tooltipLeft, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<SeriesPoint>();
  const rules = useChartTooltipRules(hideTooltip, tooltipOpen);
  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);
  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const values = [...history.map((p) => p.value), ...(current === null ? [] : [current.value])];
  const domain = yDomainOf(threshold, values);
  const zones = zonesOf(threshold, domain);
  const startDay = DateOnly.toEpochDay(DateOnly.parse(windowStart));
  const endDate = current?.date ?? history.at(-1)?.date ?? windowStart;
  const endDay = Math.max(DateOnly.toEpochDay(DateOnly.parse(endDate)), startDay + 1);
  const xScale = scaleLinear<number>({ domain: [startDay, endDay], range: [0, innerWidth] });
  const yScale = scaleLinear<number>({ domain, range: [innerHeight, 0] });
  const xOf = (point: SeriesPoint) => xScale(DateOnly.toEpochDay(DateOnly.parse(point.date)));
  const all =
    current === null ? [...history] : [...history.filter((p) => p.date !== current.date), current];

  function handlePointerMove(event: ReactPointerEvent<SVGRectElement>): void {
    rules.keep();
    if (all.length === 0) return;
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    let nearest = all[0]!;
    for (const point of all) {
      if (Math.abs(xOf(point) - localX) < Math.abs(xOf(nearest) - localX)) nearest = point;
    }
    showTooltip({ tooltipData: nearest, tooltipLeft: xOf(nearest), tooltipTop: 0 });
  }

  const ariaLabel =
    `${label} against its health zones. ` +
    (current === null
      ? 'No value today. '
      : `Now ${formatValue(current.value)}, in the ${BAND_LABEL[bandFor(current.value, threshold)]} zone. `) +
    zones.map((zone) => `${BAND_LABEL[zone.band]} from ${formatValue(zone.from)}`).join('; ') +
    '.';

  const nowX = current === null ? 0 : xOf(current);
  const nowY = current === null ? 0 : yScale(current.value);
  const nowText = current === null ? '' : `Now: ${formatValue(current.value)}`;
  const nowWidth = nowText.length * 6.6 + 10;
  // Above the point (below it when the point is near the top), ending at it: never over the line it ends.
  const nowLabelX = Math.max(0, nowX - nowWidth + 6);
  const nowLabelY = nowY - 32 >= 0 ? nowY - 32 : Math.min(nowY + 12, innerHeight - 20);

  return (
    <div className="relative">
      <svg width={width} height={height} role="img" aria-label={ariaLabel} data-testid="zone-chart">
        <g transform={`translate(${String(MARGIN.left)} ${String(MARGIN.top)})`}>
          {zones.map((zone) => {
            const top = yScale(zone.to);
            const bandHeight = yScale(zone.from) - top;
            return (
              <g key={zone.band} data-zone={zone.band}>
                <rect
                  x={0}
                  y={top}
                  width={innerWidth + BAND_COLUMN - 4}
                  height={bandHeight}
                  fill={statusVar(zone.status, 'bg')}
                />
                {bandHeight >= 14 && (
                  <text
                    x={innerWidth + 8}
                    y={top + bandHeight / 2}
                    dy="0.32em"
                    fontSize={11}
                    fontWeight={600}
                    fill={statusVar(zone.status, 'text')}
                  >
                    {BAND_LABEL[zone.band]}
                  </text>
                )}
              </g>
            );
          })}
          {edgesOf(threshold)
            .filter((edge) => edge > domain[0] && edge < domain[1])
            .map((edge) => (
              <text
                key={edge}
                data-axis="y"
                x={-8}
                y={yScale(edge)}
                dy="0.32em"
                fontSize={11}
                fill={healthVar('axisInk')}
                textAnchor="end"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {formatValue(edge)}
              </text>
            ))}
          <text
            x={0}
            y={innerHeight + 16}
            fontSize={11}
            fill={healthVar('axisInk')}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatDateOnly(windowStart, 'MMM d')}
          </text>
          <text
            x={innerWidth}
            y={innerHeight + 16}
            fontSize={11}
            fill={healthVar('axisInk')}
            textAnchor="end"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {formatDateOnly(endDate, 'MMM d')}
          </text>
          {history.length > 1 && (
            <LinePath<SeriesPoint>
              data={[...history]}
              x={xOf}
              y={(point) => yScale(point.value)}
              stroke={healthVar('line')}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              fill="none"
              data-series="metric"
            />
          )}
          {current !== null && (
            <g data-testid="zone-now">
              <circle
                cx={nowX}
                cy={nowY}
                r={5}
                fill={healthVar('line')}
                stroke={healthVar('ring')}
                strokeWidth={2}
                paintOrder="stroke"
              />
              <rect
                x={nowLabelX}
                y={nowLabelY}
                width={nowWidth}
                height={20}
                rx={4}
                fill={healthVar('ring')}
              />
              <text
                x={nowLabelX + 5}
                y={nowLabelY + 10}
                dy="0.32em"
                fontSize={12}
                fontWeight={600}
                fill={healthVar('nowInk')}
              >
                {nowText}
              </text>
            </g>
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
          top={MARGIN.top}
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
          <strong className="font-semibold">{formatValue(tooltipData.value)}</strong>{' '}
          <span>· {BAND_LABEL[bandFor(tooltipData.value, threshold)]}</span>
        </TooltipWithBounds>
      )}
    </div>
  );
}
