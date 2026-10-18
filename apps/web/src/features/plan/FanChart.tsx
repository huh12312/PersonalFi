// SPDX-License-Identifier: MIT
import { curveMonotoneX } from '@visx/curve';
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleLinear } from '@visx/scale';
import { Area, LinePath } from '@visx/shape';
import { defaultStyles, Tooltip, useTooltip } from '@visx/tooltip';
import { useMemo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { Money as MoneyJson } from '../../api/generated/types.gen.ts';
import { formatMoney, parseWireMoney } from '../../lib/money.ts';
import { BAND_FILL_OPACITY, BAND_STROKE_OPACITY } from './palette.ts';
import { useChartTooltipRules } from '../../components/patterns/chart-tooltip.ts';

/**
 * The Monte Carlo fan chart — `docs/plan/04-phase-4-dispatch.md` §3 "WP
 * 4.10" and `docs/research/05-frontend-architecture.md` §3.4's row for it.
 * Every number this component draws is one of `PlanPercentile`'s fields —
 * it computes pixel positions from them and formats them for display, and
 * nothing else (`docs/CONVENTIONS.md`: "no client-side money math beyond
 * formatting").
 */
export interface PlanPercentile {
  readonly index: number;
  readonly age: number;
  readonly calendarYear: number;
  readonly p5: MoneyJson | null;
  readonly p10: MoneyJson | null;
  readonly p25: MoneyJson | null;
  readonly p50: MoneyJson;
  readonly p75: MoneyJson | null;
  readonly p90: MoneyJson | null;
  readonly p95: MoneyJson | null;
}

export interface FanChartGoal {
  readonly targetMinor: string;
  readonly currency: string;
  readonly calendarYear: number;
}

export interface FanChartProps {
  readonly percentiles: readonly PlanPercentile[];
  readonly currency: string;
  readonly height?: number;
  readonly className?: string;
  /** The dashed goal line — omitted renders the fan alone with no goal/gap affordance. */
  readonly goal?: FanChartGoal | null;
  /** Fires when the dotted gap connector is activated by pointer or keyboard. */
  readonly onGapActivate?: () => void;
}

function minorToNumber(money: MoneyJson | null): number | null {
  return money === null ? null : Number(money.minor);
}

function moneyLabel(money: MoneyJson): string {
  return formatMoney(parseWireMoney(money), { compact: true });
}

const margin = { top: 16, right: 16, bottom: 28, left: 16 };

/** Exported so a unit test can drive `ChartInner` directly with an explicit width — `ParentSize`'s `ResizeObserver` never fires in the happy-dom test environment (`vitest.setup.ts`), so testing through the public `FanChart` component alone would always render nothing. */
export interface Row {
  readonly year: number;
  readonly p5: number | null;
  readonly p10: number | null;
  readonly p25: number | null;
  readonly p50: number;
  readonly p75: number | null;
  readonly p90: number | null;
  readonly p95: number | null;
}

function toRows(percentiles: readonly PlanPercentile[]): Row[] {
  return percentiles.map((p) => ({
    year: p.calendarYear,
    p5: minorToNumber(p.p5),
    p10: minorToNumber(p.p10),
    p25: minorToNumber(p.p25),
    p50: minorToNumber(p.p50) ?? 0,
    p75: minorToNumber(p.p75),
    p90: minorToNumber(p.p90),
    p95: minorToNumber(p.p95),
  }));
}

const ALL_COLUMNS: readonly { readonly key: keyof Omit<Row, 'year'>; readonly label: string }[] = [
  { key: 'p5', label: 'p5' },
  { key: 'p10', label: 'p10' },
  { key: 'p25', label: 'p25' },
  { key: 'p50', label: 'p50 (median)' },
  { key: 'p75', label: 'p75' },
  { key: 'p90', label: 'p90' },
  { key: 'p95', label: 'p95' },
];

/** A Monte Carlo run carries the outer bands; a deterministic run is one path and carries only the median. */
export function rowsHaveBands(rows: readonly Row[]): boolean {
  return rows.some(
    (r) =>
      r.p5 !== null ||
      r.p10 !== null ||
      r.p25 !== null ||
      r.p75 !== null ||
      r.p90 !== null ||
      r.p95 !== null,
  );
}

/** Linear interpolation of the year at which `series` crosses `target`, or `null` if it never does. */
function crossingYear(rows: readonly Row[], target: number): number | null {
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1]!;
    const curr = rows[i]!;
    const prevBelow = prev.p50 < target;
    const currBelow = curr.p50 < target;
    if (prevBelow !== currBelow) {
      const span = curr.p50 - prev.p50;
      const t = span === 0 ? 0 : (target - prev.p50) / span;
      return prev.year + t * (curr.year - prev.year);
    }
  }
  return null;
}

export interface ChartInnerProps {
  readonly width: number;
  readonly height: number;
  readonly rows: readonly Row[];
  readonly currency: string;
  readonly goal?: FanChartGoal | null;
  readonly onGapActivate?: () => void;
}

/** Exported alongside `Row` for the same reason — see `Row`'s own doc comment. */
export function ChartInner({
  width,
  height,
  rows,
  currency,
  goal,
  onGapActivate,
}: ChartInnerProps) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<Row>();
  const tooltipRules = useChartTooltipRules(hideTooltip, tooltipOpen);

  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);

  const xScale = useMemo(() => {
    const years = rows.map((r) => r.year);
    const lo = years.length > 0 ? Math.min(...years) : 0;
    const hi = years.length > 0 ? Math.max(...years) : 1;
    return scaleLinear({ domain: [lo, hi === lo ? lo + 1 : hi], range: [0, innerWidth] });
  }, [rows, innerWidth]);

  const yScale = useMemo(() => {
    const values: number[] = [];
    for (const r of rows) {
      for (const v of [r.p5, r.p10, r.p25, r.p50, r.p75, r.p90, r.p95]) {
        if (v !== null) values.push(v);
      }
    }
    if (goal !== null && goal !== undefined) values.push(Number(goal.targetMinor));
    const lo = values.length > 0 ? Math.min(...values, 0) : 0;
    const hi = values.length > 0 ? Math.max(...values) : 1;
    const pad = (hi - lo) * 0.08 || 1;
    return scaleLinear({ domain: [lo - pad, hi + pad], range: [innerHeight, 0] });
  }, [rows, innerHeight, goal]);

  if (innerWidth <= 0 || innerHeight <= 0 || rows.length === 0) return null;

  const bandDefs: readonly [keyof Row, keyof Row, number][] = [
    ['p5', 'p95', BAND_FILL_OPACITY[0]],
    ['p10', 'p90', BAND_FILL_OPACITY[1]],
    ['p25', 'p75', BAND_FILL_OPACITY[2]],
  ];
  const boundaryKeys: readonly (keyof Row)[] = ['p5', 'p10', 'p25', 'p75', 'p90', 'p95'];

  const goalY = goal === null || goal === undefined ? null : yScale(Number(goal.targetMinor));
  const goalCrossYear =
    goal === null || goal === undefined ? null : crossingYear(rows, Number(goal.targetMinor));
  const lastRow = rows[rows.length - 1]!;
  const gapTargetRow =
    goal === null || goal === undefined
      ? undefined
      : (rows.find((r) => r.year >= goal.calendarYear) ?? lastRow);
  const gapX = gapTargetRow === undefined ? null : xScale(gapTargetRow.year);
  const gapMedianY = gapTargetRow === undefined ? null : yScale(gapTargetRow.p50);

  function handlePointerMove(event: ReactPointerEvent<SVGRectElement>): void {
    tooltipRules.keep();
    const localX = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const year = xScale.invert(localX);
    let nearest = rows[0]!;
    let bestDelta = Infinity;
    for (const row of rows) {
      const delta = Math.abs(row.year - year);
      if (delta < bestDelta) {
        bestDelta = delta;
        nearest = row;
      }
    }
    showTooltip({
      tooltipData: nearest,
      tooltipLeft: xScale(nearest.year),
      tooltipTop: yScale(nearest.p50),
    });
  }

  const HIT_WIDTH = 24; // WCAG 2.5.8, ≥24 CSS px

  return (
    <div className="relative">
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={
          rowsHaveBands(rows)
            ? 'Projected portfolio value over time, shown as overlapping confidence bands around a median path'
            : 'Projected portfolio value over time, shown as a single path'
        }
      >
        <Group left={margin.left} top={margin.top}>
          {bandDefs.map(([lowKey, highKey, opacity]) => (
            <Area<Row>
              key={String(lowKey)}
              data={rows as Row[]}
              x={(d) => xScale(d.year)}
              y0={(d) => {
                const v = d[lowKey] as number | null;
                return v === null ? yScale(d.p50) : yScale(v);
              }}
              y1={(d) => {
                const v = d[highKey] as number | null;
                return v === null ? yScale(d.p50) : yScale(v);
              }}
              defined={(d) => d[lowKey] !== null && d[highKey] !== null}
              curve={curveMonotoneX}
              fill="var(--chart-line)"
              fillOpacity={opacity}
              stroke="none"
            />
          ))}
          {boundaryKeys.map((key) => (
            <LinePath<Row>
              key={String(key)}
              data={rows as Row[]}
              x={(d) => xScale(d.year)}
              y={(d) => yScale((d[key] as number | null) ?? d.p50)}
              defined={(d) => d[key] !== null}
              curve={curveMonotoneX}
              stroke="var(--chart-line)"
              strokeOpacity={BAND_STROKE_OPACITY}
              strokeWidth={1}
            />
          ))}
          {/* The 2px accent median line, labelled "median" in words directly on the chart (05 §3.4 / dispatch §3 — never position alone). */}
          <LinePath<Row>
            data={rows as Row[]}
            x={(d) => xScale(d.year)}
            y={(d) => yScale(d.p50)}
            curve={curveMonotoneX}
            stroke="var(--chart-line)"
            strokeWidth={2}
          />
          <text
            x={xScale(lastRow.year)}
            y={yScale(lastRow.p50) - 8}
            textAnchor="end"
            fontSize={11}
            fontWeight={600}
            fill="var(--chart-line)"
          >
            {rowsHaveBands(rows) ? 'median' : 'projected path'}
          </text>

          {goal !== null && goal !== undefined && goalY !== null && (
            <>
              <line
                x1={0}
                x2={innerWidth}
                y1={goalY}
                y2={goalY}
                stroke="var(--chart-axis)"
                strokeDasharray="6,4"
                strokeWidth={1.5}
              />
              {goalCrossYear !== null && (
                <>
                  <circle
                    cx={xScale(goalCrossYear)}
                    cy={goalY}
                    r={4}
                    fill="var(--bg-primary)"
                    stroke="var(--chart-axis)"
                    strokeWidth={1.5}
                  />
                  <text
                    x={Math.min(xScale(goalCrossYear) + 6, innerWidth - 4)}
                    y={goalY - 8}
                    fontSize={11}
                    fill="var(--text-secondary)"
                  >
                    Goal reached ~{Math.round(goalCrossYear)}
                  </text>
                </>
              )}
            </>
          )}

          {xScale.ticks(width < 480 ? 3 : 6).map((year) => (
            <text
              key={year}
              x={xScale(year)}
              y={innerHeight + 18}
              fontSize={11}
              fill="var(--chart-label)"
              textAnchor="middle"
            >
              {Math.round(year)}
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
              background: 'var(--bg-overlay)',
              color: 'var(--text-primary)',
              boxShadow: 'var(--shadow-elev-2)',
              border: '1px solid var(--border-divider)',
              borderRadius: 8,
              fontSize: 12,
            }}
          >
            {tooltipData.p25 === null
              ? `By ${String(Math.round(tooltipData.year))}, the projected value on this path is ${moneyLabel({ minor: String(Math.round(tooltipData.p50)), currency })}.`
              : `By ${String(Math.round(tooltipData.year))} there's a 75% chance you have at least ${moneyLabel({ minor: String(Math.round(tooltipData.p25)), currency })}.`}
          </Tooltip>
        )}

      {goal !== null &&
        goal !== undefined &&
        gapX !== null &&
        gapMedianY !== null &&
        goalY !== null &&
        onGapActivate !== undefined && (
          <button
            type="button"
            onClick={onGapActivate}
            aria-label="Calculate the monthly saving required to close the gap between the projected path and your goal"
            className="absolute flex items-center justify-center rounded-sm focus-visible:outline-none"
            style={{
              left: margin.left + gapX - HIT_WIDTH / 2,
              top: margin.top + Math.min(gapMedianY, goalY),
              width: HIT_WIDTH,
              height: Math.max(Math.abs(goalY - gapMedianY), HIT_WIDTH),
            }}
            data-testid="fan-chart-gap-line"
          >
            <span
              aria-hidden="true"
              className="h-full"
              style={{ width: 0, borderLeft: '2px dotted var(--chart-axis)' }}
            />
          </button>
        )}
    </div>
  );
}

/**
 * Public component. `ParentSize` gives the responsive width the `ChartInner`
 * needs (05 §3.4's `ChartFrame`: "responsive sizing (`ResizeObserver`, not
 * window resize)") — the same shape `NetWorthAreaChart` uses.
 */
export function FanChart({
  percentiles,
  currency,
  height = 320,
  className,
  goal = null,
  onGapActivate,
}: FanChartProps) {
  const rows = useMemo(() => toRows(percentiles), [percentiles]);
  const [showTable, setShowTable] = useState(false);
  const hasBands = rowsHaveBands(rows);
  const tableColumns = hasBands ? ALL_COLUMNS : [{ key: 'p50' as const, label: 'Projected path' }];

  return (
    <div className={className}>
      <div style={{ height }}>
        <ParentSize>
          {({ width, height: parentHeight }) => (
            <ChartInner
              width={width}
              height={parentHeight}
              rows={rows}
              currency={currency}
              goal={goal}
              onGapActivate={onGapActivate}
            />
          )}
        </ParentSize>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="inline-block h-0.5 w-4"
            style={{ backgroundColor: 'var(--chart-line)' }}
          />
          {hasBands ? 'median' : 'projected path'}
        </span>
        {hasBands && (
          <>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-4"
                style={{ backgroundColor: 'var(--chart-line)', opacity: BAND_FILL_OPACITY[2] }}
              />
              p25–p75
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-4"
                style={{ backgroundColor: 'var(--chart-line)', opacity: BAND_FILL_OPACITY[1] }}
              />
              p10–p90
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-4"
                style={{ backgroundColor: 'var(--chart-line)', opacity: BAND_FILL_OPACITY[0] }}
              />
              p5–p95
            </span>
          </>
        )}
        {goal !== null && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-0.5 w-4"
              style={{
                backgroundImage:
                  'repeating-linear-gradient(to right, var(--chart-axis) 0 4px, transparent 4px 8px)',
              }}
            />
            Goal
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowTable((v) => !v)}
        className="mt-2 text-caption text-accent-text underline-offset-4 hover:underline"
        aria-expanded={showTable}
      >
        {showTable ? 'Hide table' : 'View as table'}
      </button>

      {showTable && (
        <table className="mt-2 w-full text-caption">
          <caption className="sr-only">
            {hasBands
              ? 'Projected portfolio value by year, at every percentile band'
              : 'Projected portfolio value by year, on a single path'}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="text-left">
                Year
              </th>
              {tableColumns.map((column) => (
                <th key={column.key} scope="col" className="text-right">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.year}>
                <th scope="row" className="text-left font-normal">
                  {Math.round(row.year)}
                </th>
                {tableColumns.map((column) => {
                  const v = row[column.key];
                  return (
                    <td key={column.key} className="text-right tabular-nums">
                      {v === null ? '—' : moneyLabel({ minor: String(Math.round(v)), currency })}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
