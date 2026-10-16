// SPDX-License-Identifier: MIT
import { curveStepAfter } from '@visx/curve';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear, scaleTime } from '@visx/scale';
import { Area, LinePath } from '@visx/shape';
import { defaultStyles, TooltipWithBounds, useTooltip } from '@visx/tooltip';
import { useMemo } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { ChartDataTable } from '../../components/patterns/ChartDataTable.tsx';
import { useChartTooltipRules } from '../../components/patterns/chart-tooltip.ts';
import { formatDateOnly, toLocalDisplayDate } from '../../lib/date.ts';
import { formatMoney, parseWireMoney } from '../../lib/money.ts';
import { chartVar } from './forecast-chart-tokens.ts';
import type { ChargeMark, ForecastPoint } from './forecast-series.ts';

/**
 * The 30-day forward cash flow (WP 2.10; redrawn in WP 10.7 by the dataviz method).
 *
 * What the reader has to see is *when* money leaves and what the running total does because of it, so:
 *
 *  - **The running total is a step line** (`curveStepAfter`): a charge lands on a day, the total drops on that
 *    day and stays down. The old monotone curve drew a slope between days, money leaving gradually, which it
 *    never does.
 *  - **The detector's uncertainty band** around it (the worst and best ends summed day by day,
 *    `forecast-series.ts#buildForecastBand`), a wash of the line's own hue. Drawn only when it has width.
 *  - **A mark per expected charge on its due date**, in a lane under the plot: ▼ money out, ▲ money in, coloured
 *    by sign. Two charges on one day are two marks, stacked. A hairline stem rises from the day's first mark to
 *    the line, so each drop has its cause under it.
 *  - **A light y-axis**: 3–5 solid hairline gridlines, compact money labels with tabular figures, and the $0
 *    baseline drawn darker and always labelled.
 *  - **x ticks** at the first and last day of the window, anchored inward (`start` / `end`) so neither label can
 *    be cut off at the edge, with evenly spaced days between when there is room.
 *  - **The readout** (pointer) and **the table** (everyone) carry the same figures: the day, the running total,
 *    its band, and every charge due that day with its name and amount.
 *
 * Colour roles are `forecast-chart-tokens.ts`'s, measured by `src/styles/contrast.test.ts`. Nothing animates.
 */

function moneyText(minor: number, currency: string): string {
  return formatMoney(parseWireMoney({ minor: String(Math.round(minor)), currency }), {
    signDisplay: 'exceptZero',
  });
}

function tickText(minor: number, currency: string): string {
  return formatMoney(parseWireMoney({ minor: String(Math.round(minor)), currency }), {
    signDisplay: 'auto',
    compact: true,
  });
}

/** One x tick: a day and how its label anchors (`start` at the left edge, `end` at the right, so it stays inside). */
export interface XTick {
  readonly date: string;
  readonly anchor: 'start' | 'middle' | 'end';
}

/**
 * The first and last day, always, anchored inward; between them `between` evenly spaced days, by the plot's
 * width (none under 360 px, two under 640 px, four above).
 */
export function xTickPlan(days: readonly string[], innerWidth: number): XTick[] {
  if (days.length === 0) return [];
  const first = days[0]!;
  const last = days.at(-1)!;
  if (days.length === 1) return [{ date: first, anchor: 'middle' }];
  const between = innerWidth < 360 ? 0 : innerWidth < 640 ? 2 : 4;
  const ticks: XTick[] = [{ date: first, anchor: 'start' }];
  const span = days.length - 1;
  for (let k = 1; k <= between; k += 1) {
    const index = Math.round((k * span) / (between + 1));
    const date = days[index];
    if (date !== undefined && index > 0 && index < span) ticks.push({ date, anchor: 'middle' });
  }
  ticks.push({ date: last, anchor: 'end' });
  return ticks;
}

/** Rows in the charge lane: as many as the busiest day needs, at most four (a fifth charge is in the readout and the table, and counted as "+n"). */
const LANE_MAX_ROWS = 4;
const LANE_ROW = 12;
const LANE_GAP = 8;
const X_LABEL_BAND = 22;
/** Width of one tick-label character at 11 px Geist with tabular figures (0.6 em), rounded up. */
const TICK_CHAR_PX = 7;

function trianglePath(cx: number, cy: number, sign: 'OUTFLOW' | 'INFLOW'): string {
  const h = 9;
  const w = 10;
  return sign === 'OUTFLOW'
    ? `M${cx - w / 2},${cy - h / 2}L${cx + w / 2},${cy - h / 2}L${cx},${cy + h / 2}Z`
    : `M${cx - w / 2},${cy + h / 2}L${cx + w / 2},${cy + h / 2}L${cx},${cy - h / 2}Z`;
}

interface Readout {
  readonly point: ForecastPoint;
  readonly charges: readonly ChargeMark[];
}

export interface ChartInnerProps {
  readonly width: number;
  readonly height: number;
  readonly data: readonly ForecastPoint[];
  readonly marks: readonly ChargeMark[];
  readonly currency: string;
  /** Draw the band (it has width). `false` for a window whose every charge has a fixed amount. */
  readonly banded: boolean;
}

/** Exported so a unit test can drive it with an explicit size: `ParentSize` never measures in happy-dom. */
export function ChartInner({ width, height, data, marks, currency, banded }: ChartInnerProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<Readout>();
  const tooltipRules = useChartTooltipRules(hideTooltip, tooltipOpen);

  const marksByDate = useMemo(() => {
    const map = new Map<string, ChargeMark[]>();
    for (const mark of marks) {
      const list = map.get(mark.date);
      if (list === undefined) map.set(mark.date, [mark]);
      else list.push(mark);
    }
    return map;
  }, [marks]);

  const laneRows = Math.min(
    LANE_MAX_ROWS,
    Math.max(1, ...[...marksByDate.values()].map((list) => list.length)),
  );
  const laneHeight = LANE_GAP + laneRows * LANE_ROW;

  const yDomain = useMemo((): [number, number] => {
    let lo = 0;
    let hi = 0;
    for (const point of data) {
      lo = Math.min(lo, point.cumulativeLowMinor, point.cumulativeExpectedMinor);
      hi = Math.max(hi, point.cumulativeHighMinor, point.cumulativeExpectedMinor);
    }
    if (lo === hi) {
      lo -= 100;
      hi += 100;
    }
    const pad = (hi - lo) * 0.08;
    // Never pad past zero on the side the data does not reach: $0 is the baseline, not a margin.
    const padded: [number, number] = [lo < 0 ? lo - pad : 0, hi > 0 ? hi + pad : 0];
    return scaleLinear<number>({ domain: padded, nice: 4 }).domain() as [number, number];
  }, [data]);

  const yTicks = scaleLinear<number>({ domain: yDomain }).ticks(4);
  if (!yTicks.includes(0)) yTicks.push(0);
  const yLabelWidth =
    Math.max(...yTicks.map((tick) => tickText(tick, currency).length)) * TICK_CHAR_PX;
  const margin = { top: 10, right: 12, bottom: laneHeight + X_LABEL_BAND, left: yLabelWidth + 10 };

  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);
  const yScale = scaleLinear<number>({ domain: yDomain, range: [innerHeight, 0] });

  const days = useMemo(() => data.map((point) => point.date), [data]);
  const xScale = useMemo(
    () =>
      scaleTime<number>({
        domain: [
          toLocalDisplayDate(days[0] ?? '1970-01-01'),
          toLocalDisplayDate(days.at(-1) ?? '1970-01-01'),
        ],
        range: [0, innerWidth],
      }),
    [days, innerWidth],
  );

  // What is drawn starts from $0 *at* the first day, so a charge on day one is a visible drop at the left edge
  // rather than a line that begins already down (the readout and the table use `data` itself).
  const drawn = useMemo(
    (): ForecastPoint[] =>
      data.length === 0
        ? []
        : [
            {
              date: data[0]!.date,
              cumulativeExpectedMinor: 0,
              cumulativeLowMinor: 0,
              cumulativeHighMinor: 0,
            },
            ...data,
          ],
    [data],
  );

  if (innerWidth <= 0 || innerHeight <= 0 || data.length === 0) return null;

  const x = (date: string): number => xScale(toLocalDisplayDate(date));
  const pointByDate = new Map(data.map((point) => [point.date, point]));

  function handlePointerMove(event: ReactPointerEvent<SVGRectElement>): void {
    tooltipRules.keep();
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const target = xScale.invert(localX).getTime();
    let best = data[0]!;
    let bestDelta = Infinity;
    for (const point of data) {
      const delta = Math.abs(toLocalDisplayDate(point.date).getTime() - target);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = point;
      }
    }
    showTooltip({
      tooltipData: { point: best, charges: marksByDate.get(best.date) ?? [] },
      tooltipLeft: x(best.date),
      tooltipTop: yScale(best.cumulativeExpectedMinor),
    });
  }

  const last = data.at(-1)!;
  const zeroY = yScale(0);
  const laneTop = innerHeight + LANE_GAP;
  const ariaLabel =
    `Projected cash flow from ${formatDateOnly(data[0]!.date, 'MMM d')} to ${formatDateOnly(last.date, 'MMM d')}: ` +
    `${String(marks.length)} expected charge${marks.length === 1 ? '' : 's'}, ` +
    `expected net ${moneyText(last.cumulativeExpectedMinor, currency)}, ` +
    `worst case ${moneyText(last.cumulativeLowMinor, currency)}.`;

  return (
    <div className="relative">
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <Group left={margin.left} top={margin.top}>
          {/* Gridlines: solid hairlines, recessive; the $0 line is drawn after the data, darker. */}
          {yTicks
            .filter((tick) => tick !== 0)
            .map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={innerWidth}
                y1={yScale(tick)}
                y2={yScale(tick)}
                stroke={chartVar('gridline')}
                strokeWidth={1}
              />
            ))}
          {yTicks.map((tick) => (
            <text
              key={tick}
              data-axis="y"
              x={-8}
              y={yScale(tick)}
              dy="0.32em"
              fontSize={11}
              fontWeight={tick === 0 ? 600 : 400}
              fill={chartVar('axisInk')}
              textAnchor="end"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {tickText(tick, currency)}
            </text>
          ))}

          {banded && (
            <Area<ForecastPoint>
              data={drawn}
              x={(d) => x(d.date)}
              y0={(d) => yScale(d.cumulativeLowMinor)}
              y1={(d) => yScale(d.cumulativeHighMinor)}
              curve={curveStepAfter}
              fill={chartVar('band')}
              fillOpacity={0.12}
              stroke="none"
              data-testid="forecast-band"
            />
          )}

          <line
            x1={0}
            x2={innerWidth}
            y1={zeroY}
            y2={zeroY}
            stroke={chartVar('baseline')}
            strokeWidth={1}
            data-testid="forecast-zero-baseline"
          />

          {/* A stem from the day's first charge up to the line: the cause under each step. */}
          {[...marksByDate.entries()].map(([date]) => {
            const point = pointByDate.get(date);
            if (point === undefined) return null;
            return (
              <line
                key={`stem-${date}`}
                x1={x(date)}
                x2={x(date)}
                y1={yScale(point.cumulativeExpectedMinor)}
                y2={laneTop}
                stroke={chartVar('gridline')}
                strokeWidth={1}
                pointerEvents="none"
              />
            );
          })}

          <LinePath<ForecastPoint>
            data={drawn}
            x={(d) => x(d.date)}
            y={(d) => yScale(d.cumulativeExpectedMinor)}
            curve={curveStepAfter}
            stroke={chartVar('line')}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* The charge lane: one mark per charge, ▼ out / ▲ in, a 2 px surface ring so stacked marks stay apart. */}
          <g data-testid="forecast-charge-marks">
            {marks
              .filter((mark) => mark.rank < laneRows)
              .map((mark) => (
                <path
                  key={`${mark.seriesId}-${mark.date}-${String(mark.rank)}`}
                  data-charge-mark={mark.sign === 'OUTFLOW' ? 'out' : 'in'}
                  d={trianglePath(
                    x(mark.date),
                    laneTop + mark.rank * LANE_ROW + LANE_ROW / 2,
                    mark.sign,
                  )}
                  fill={chartVar(mark.sign === 'OUTFLOW' ? 'outflow' : 'inflow')}
                  stroke={chartVar('ring')}
                  strokeWidth={2}
                  paintOrder="stroke"
                  strokeLinejoin="round"
                  pointerEvents="none"
                />
              ))}
            {[...marksByDate.entries()]
              .filter(([, list]) => list.length > laneRows)
              .map(([date, list]) => (
                <text
                  key={`more-${date}`}
                  x={x(date) + 8}
                  y={laneTop + (laneRows - 1) * LANE_ROW + LANE_ROW / 2}
                  dy="0.32em"
                  fontSize={10}
                  fill={chartVar('axisInk')}
                >
                  +{list.length - laneRows}
                </text>
              ))}
          </g>

          {xTickPlan(days, innerWidth).map((tick) => (
            <text
              key={tick.date}
              data-axis="x"
              x={x(tick.date)}
              y={laneTop + laneRows * LANE_ROW + 15}
              fontSize={11}
              fill={chartVar('axisInk')}
              textAnchor={tick.anchor}
              style={{ fontVariantNumeric: 'tabular-nums' }}
            >
              {formatDateOnly(tick.date, 'MMM d')}
            </text>
          ))}

          {tooltipOpen && tooltipLeft !== undefined && (
            <line
              x1={tooltipLeft}
              x2={tooltipLeft}
              y1={0}
              y2={laneTop + laneRows * LANE_ROW}
              stroke={chartVar('axisInk')}
              strokeOpacity={0.5}
              strokeWidth={1}
              pointerEvents="none"
            />
          )}

          {/* The pointer surface covers the plot and the lane, so a mark is reached by its day. */}
          <rect
            x={0}
            y={0}
            width={innerWidth}
            height={laneTop + laneRows * LANE_ROW}
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
          // Pinned to the top of the plot (the crosshair carries the x), and flipped to the left of the crosshair
          // past the middle (`TooltipWithBounds`), so it never runs off the chart or covers the charge lane.
          <TooltipWithBounds
            {...tooltipRules.readoutProps}
            data-chart-readout=""
            left={tooltipLeft + margin.left}
            top={margin.top}
            style={{
              ...defaultStyles,
              pointerEvents: 'auto',
              background: 'var(--bg-surface-raised)',
              color: 'var(--text-primary)',
              boxShadow: 'var(--shadow-elev-2)',
              border: '1px solid var(--border-hairline)',
              borderRadius: 8,
              fontSize: 12,
              lineHeight: '18px',
              maxWidth: 280,
            }}
          >
            <ForecastReadout readout={tooltipData} currency={currency} banded={banded} />
          </TooltipWithBounds>
        )}
    </div>
  );
}

function ForecastReadout({
  readout,
  currency,
  banded,
}: {
  readonly readout: Readout;
  readonly currency: string;
  readonly banded: boolean;
}) {
  const { point, charges } = readout;
  return (
    <div className="tabular-nums">
      <div className="text-text-secondary">{formatDateOnly(point.date, 'EEE, MMM d')}</div>
      <div>
        <strong className="font-semibold">
          {moneyText(point.cumulativeExpectedMinor, currency)}
        </strong>{' '}
        <span className="text-text-secondary">running total</span>
      </div>
      {banded && point.cumulativeLowMinor !== point.cumulativeHighMinor && (
        <div className="text-text-secondary">
          band {moneyText(point.cumulativeLowMinor, currency)} to{' '}
          {moneyText(point.cumulativeHighMinor, currency)}
        </div>
      )}
      {charges.length > 0 && (
        <ul className="mt-1 border-t border-border-hairline pt-1" aria-label="Charges due this day">
          {charges.map((charge) => (
            <li
              key={`${charge.seriesId}-${String(charge.rank)}`}
              className="flex items-baseline gap-1.5"
            >
              <svg width={10} height={9} aria-hidden="true" className="shrink-0 self-center">
                <path
                  d={trianglePath(5, 4.5, charge.sign)}
                  fill={chartVar(charge.sign === 'OUTFLOW' ? 'outflow' : 'inflow')}
                />
              </svg>
              <strong className="font-semibold">{moneyText(charge.expectedMinor, currency)}</strong>{' '}
              <span className="text-text-secondary">{charge.name}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The charges due on one day, as the table cell reads them: "Spotify −$9.99; City Power −$85.00 (−$110.00 to −$70.00)", the band low to high. */
export function chargesCellText(charges: readonly ChargeMark[], currency: string): string {
  if (charges.length === 0) return '—';
  return charges
    .map((charge) => {
      const amount = `${charge.name} ${moneyText(charge.expectedMinor, currency)}`;
      return charge.worstMinor === charge.bestMinor
        ? amount
        : `${amount} (${moneyText(Math.min(charge.worstMinor, charge.bestMinor), currency)} to ${moneyText(Math.max(charge.worstMinor, charge.bestMinor), currency)})`;
    })
    .join('; ');
}

/** The legend: one entry per thing drawn, the key beside text in text ink (never text in the series colour). */
function ForecastLegend({
  banded,
  hasOut,
  hasIn,
}: {
  readonly banded: boolean;
  readonly hasOut: boolean;
  readonly hasIn: boolean;
}) {
  return (
    <ul
      aria-label="Chart key"
      className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary"
      data-testid="forecast-legend"
    >
      <li className="flex items-center gap-1.5">
        <svg width={16} height={10} aria-hidden="true">
          <line
            x1={1}
            x2={15}
            y1={5}
            y2={5}
            stroke={chartVar('line')}
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>
        Running total, expected
      </li>
      {banded && (
        <li className="flex items-center gap-1.5">
          <svg width={16} height={10} aria-hidden="true">
            <rect
              x={0}
              y={0}
              width={16}
              height={10}
              rx={2}
              fill={chartVar('band')}
              fillOpacity={0.2}
            />
          </svg>
          Uncertainty band
        </li>
      )}
      {hasOut && (
        <li className="flex items-center gap-1.5">
          <svg width={10} height={9} aria-hidden="true">
            <path d={trianglePath(5, 4.5, 'OUTFLOW')} fill={chartVar('outflow')} />
          </svg>
          Charge due (money out)
        </li>
      )}
      {hasIn && (
        <li className="flex items-center gap-1.5">
          <svg width={10} height={9} aria-hidden="true">
            <path d={trianglePath(5, 4.5, 'INFLOW')} fill={chartVar('inflow')} />
          </svg>
          Money due in
        </li>
      )}
    </ul>
  );
}

export interface ForecastBandChartProps {
  readonly data: readonly ForecastPoint[];
  readonly marks: readonly ChargeMark[];
  readonly currency: string;
  readonly banded: boolean;
  readonly height?: number;
  readonly className?: string;
}

export function ForecastBandChart({
  data,
  marks,
  currency,
  banded,
  height = 240,
  className,
}: ForecastBandChartProps) {
  const byDate = new Map<string, ChargeMark[]>();
  for (const mark of marks) byDate.set(mark.date, [...(byDate.get(mark.date) ?? []), mark]);
  return (
    <div className={className}>
      <ForecastLegend
        banded={banded}
        hasOut={marks.some((mark) => mark.sign === 'OUTFLOW')}
        hasIn={marks.some((mark) => mark.sign === 'INFLOW')}
      />
      <div className="mt-2" style={{ height }}>
        <ParentSize>
          {({ width, height: parentHeight }) => (
            <ChartInner
              width={width}
              height={parentHeight}
              data={data}
              marks={marks}
              currency={currency}
              banded={banded}
            />
          )}
        </ParentSize>
      </div>
      {/* 09 §5.6: the same figures for the reader the readout (pointer-only) and the marks cannot reach. */}
      <ChartDataTable
        className="mt-1"
        caption="Projected cash flow by day: the charges due, the running total, and the band around it"
        columns={['Date', 'Charges due', 'Running total', 'Band low', 'Band high']}
        rows={data.map((point) => [
          formatDateOnly(point.date, 'MMM d'),
          chargesCellText(byDate.get(point.date) ?? [], currency),
          moneyText(point.cumulativeExpectedMinor, currency),
          moneyText(point.cumulativeLowMinor, currency),
          moneyText(point.cumulativeHighMinor, currency),
        ])}
      />
    </div>
  );
}
