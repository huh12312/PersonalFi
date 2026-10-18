// SPDX-License-Identifier: MIT
import { Group } from '@visx/group';
import { ParentSize } from '@visx/responsive';
import { scaleBand, scaleLinear } from '@visx/scale';
import { LinePath } from '@visx/shape';
import { defaultStyles, TooltipWithBounds, useTooltip } from '@visx/tooltip';
import { useMemo } from 'react';
import type { KeyboardEvent } from 'react';

import type { CashFlow } from '../../../api/generated/types.gen.ts';
import { ChartDataTable } from '../../../components/patterns/ChartDataTable.tsx';
import { useChartTooltipRules } from '../../../components/patterns/chart-tooltip.ts';
import { formatMoney, parseWireMoney } from '../../../lib/money.ts';
import { periodLabel, periodTickLabel, type Timeframe } from '../view.ts';
import { cashFlowVar } from './cash-flow-chart-tokens.ts';

/**
 * Income and expenses per period, with net cash flow over them (WP 10.10; Monarch's Cash Flow "bars" mode), drawn
 * by the dataviz method.
 *
 * The question is "how did money in compare with money out, period by period?" — magnitude over time, two series
 * that belong side by side — so: paired columns per period on **one** money axis, income then expenses (always in
 * that order, so position carries identity as well as hue), and the net as a 2 px line with 8 px ringed dots on
 * the same axis (it is money too: never a second scale). Below zero the plot carries the negative-area wash.
 *
 *  - Columns ≤ 24 px, a 2 px surface gap between the pair, 4 px rounded data-end, square at the baseline.
 *  - Recessive solid hairline grid, compact tabular y ticks, the zero line in the axis role.
 *  - The selected period sits on a quiet band; every period is a button that selects it (Monarch's pressable
 *    bars) and shows the readout on hover or focus. A period with no ledger row draws nothing — never a zero
 *    column — and says "No data" in the readout and the table.
 *  - A legend names income / expenses / net (≥ 2 series); a single side (the Income or Spending tab) needs none,
 *    the title names it. **View as table** carries every value; the `aria-label` carries the selected period's.
 *
 * `--chart-income` / `--chart-expenses` / `--chart-line` pass `validate_palette.js --pairs all` in both themes
 * (light worst CVD ΔE 9.9, dark 8.8; recorded in the evidence). Nothing animates.
 */

export type BarsSeries = 'both' | 'income' | 'expenses';

type Bar = CashFlow['bars'][number];

function moneyText(minor: string | number | bigint, currency: string, compact = false): string {
  return formatMoney(parseWireMoney({ minor: String(minor), currency }), {
    signDisplay: 'auto',
    compact,
  });
}

/** Presentation only: a pixel position from minor units (08 §6.5's carve-out). */
function px(minor: string): number {
  return Number(minor);
}

const TICK_CHAR_PX = 7;
const X_LABEL_BAND = 22;
const MAX_COLUMN = 24;
const GAP = 2;
const RADIUS = 4;

/** A column from the baseline to `top`, its data-end rounded (4 px), square at the baseline; flips below zero. */
export function columnPath(x: number, width: number, baseline: number, end: number): string {
  const height = Math.abs(baseline - end);
  if (height < 0.5 || width <= 0) return '';
  const r = Math.min(RADIUS, width / 2, height);
  if (end < baseline) {
    // Grows up.
    return `M${x},${baseline}V${end + r}Q${x},${end} ${x + r},${end}H${x + width - r}Q${x + width},${end} ${x + width},${end + r}V${baseline}Z`;
  }
  return `M${x},${baseline}V${end - r}Q${x},${end} ${x + r},${end}H${x + width - r}Q${x + width},${end} ${x + width},${end - r}V${baseline}Z`;
}

export interface CashFlowBarsInnerProps {
  readonly width: number;
  readonly height: number;
  readonly bars: readonly Bar[];
  readonly timeframe: Timeframe;
  readonly currency: string;
  readonly series: BarsSeries;
  readonly selected: string;
  readonly onSelect?: (period: string) => void;
  readonly ariaLabel: string;
}

/** Exported so a unit test can drive it with an explicit size: `ParentSize` never measures in happy-dom. */
export function CashFlowBarsInner({
  width,
  height,
  bars,
  timeframe,
  currency,
  series,
  selected,
  onSelect,
  ariaLabel,
}: CashFlowBarsInnerProps) {
  const { tooltipData, tooltipLeft, tooltipOpen, showTooltip, hideTooltip } = useTooltip<Bar>();
  const tooltipRules = useChartTooltipRules(hideTooltip, tooltipOpen);

  const yDomain = useMemo((): [number, number] => {
    let lo = 0;
    let hi = 0;
    for (const bar of bars) {
      if (!bar.hasData) continue;
      const values =
        series === 'both'
          ? [px(bar.incomeMinor), px(bar.expensesMinor), px(bar.netMinor)]
          : [px(series === 'income' ? bar.incomeMinor : bar.expensesMinor)];
      for (const value of values) {
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    }
    if (hi === lo) hi = lo + 10_000;
    return scaleLinear<number>({ domain: [lo, hi], nice: 4 }).domain() as [number, number];
  }, [bars, series]);

  const yTicks = scaleLinear<number>({ domain: yDomain }).ticks(4);
  const yLabelWidth =
    Math.max(...yTicks.map((tick) => moneyText(tick, currency, true).length)) * TICK_CHAR_PX;
  const margin = { top: 12, right: 8, bottom: X_LABEL_BAND, left: yLabelWidth + 10 };
  const innerWidth = Math.max(width - margin.left - margin.right, 0);
  const innerHeight = Math.max(height - margin.top - margin.bottom, 0);

  const xScale = scaleBand<string>({
    domain: bars.map((bar) => bar.period),
    range: [0, innerWidth],
    paddingInner: 0.3,
    paddingOuter: 0.15,
  });
  const yScale = scaleLinear<number>({ domain: yDomain, range: [innerHeight, 0] });

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const band = xScale.bandwidth();
  const step = xScale.step();
  const pairs = series === 'both' ? 2 : 1;
  const column = Math.max(Math.min(MAX_COLUMN, (band - GAP * (pairs - 1)) / pairs), 1);
  const groupWidth = column * pairs + GAP * (pairs - 1);
  const baseline = yScale(0);
  // Narrow plots label every other period (and always the selected one) so ticks never collide.
  const labelEvery = step < 34 ? 2 : 1;
  const selectedIndex = bars.findIndex((bar) => bar.period === selected);

  function show(bar: Bar): void {
    tooltipRules.keep();
    showTooltip({
      tooltipData: bar,
      tooltipLeft: (xScale(bar.period) ?? 0) + band / 2,
      tooltipTop: 0,
    });
  }

  const netPoints = bars.filter((bar) => bar.hasData);

  return (
    <div className="relative">
      {/* No `role="img"`: each period is a focusable button inside (axe `nested-interactive`); the `aria-label`
          still names the graphic, as on Reports' charts. */}
      <svg width={width} height={height} aria-label={ariaLabel} data-testid="cash-flow-bars">
        <Group left={margin.left} top={margin.top}>
          {yDomain[0] < 0 && (
            <rect
              x={0}
              y={baseline}
              width={innerWidth}
              height={Math.max(innerHeight - baseline, 0)}
              fill={cashFlowVar('negativeArea')}
            />
          )}
          {selectedIndex >= 0 && (
            <rect
              x={(xScale(selected) ?? 0) - (step - band) / 2}
              y={0}
              width={step}
              height={innerHeight}
              rx={6}
              fill={cashFlowVar('selectedBand')}
              data-testid="cash-flow-selected-band"
            />
          )}
          {yTicks.map((tick) => (
            <g key={tick}>
              <line
                x1={0}
                x2={innerWidth}
                y1={yScale(tick)}
                y2={yScale(tick)}
                stroke={cashFlowVar(tick === 0 ? 'axis' : 'gridline')}
                strokeWidth={1}
              />
              <text
                data-axis="y"
                x={-8}
                y={yScale(tick)}
                dy="0.32em"
                fontSize={11}
                fill={cashFlowVar('axisInk')}
                textAnchor="end"
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {moneyText(tick, currency, true)}
              </text>
            </g>
          ))}

          {bars.map((bar, index) => {
            const left = (xScale(bar.period) ?? 0) + (band - groupWidth) / 2;
            const columns: { key: string; minor: string; role: 'income' | 'expenses' }[] = [];
            if (bar.hasData) {
              if (series !== 'expenses')
                columns.push({ key: 'income', minor: bar.incomeMinor, role: 'income' });
              if (series !== 'income')
                columns.push({ key: 'expenses', minor: bar.expensesMinor, role: 'expenses' });
            }
            const showLabel =
              index % labelEvery === (bars.length - 1) % labelEvery || bar.period === selected;
            return (
              <g key={bar.period} data-period={bar.period}>
                {columns.map((c, i) => (
                  <path
                    key={c.key}
                    d={columnPath(left + i * (column + GAP), column, baseline, yScale(px(c.minor)))}
                    fill={cashFlowVar(c.role)}
                    data-series={c.role}
                  />
                ))}
                {showLabel && (
                  <text
                    data-axis="x"
                    x={(xScale(bar.period) ?? 0) + band / 2}
                    y={innerHeight + 16}
                    fontSize={11}
                    fontWeight={bar.period === selected ? 600 : 400}
                    fill={cashFlowVar(bar.period === selected ? 'axisInkStrong' : 'axisInk')}
                    textAnchor="middle"
                  >
                    {periodTickLabel(timeframe, bar.period)}
                  </text>
                )}
              </g>
            );
          })}

          {series === 'both' && netPoints.length > 1 && (
            <LinePath<Bar>
              data={bars as Bar[]}
              defined={(bar) => bar.hasData}
              x={(bar) => (xScale(bar.period) ?? 0) + band / 2}
              y={(bar) => yScale(px(bar.netMinor))}
              stroke={cashFlowVar('net')}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              data-series="net"
            />
          )}
          {series === 'both' &&
            netPoints.map((bar) => (
              <circle
                key={`net-${bar.period}`}
                cx={(xScale(bar.period) ?? 0) + band / 2}
                cy={yScale(px(bar.netMinor))}
                r={4}
                fill={cashFlowVar('net')}
                stroke={cashFlowVar('ring')}
                strokeWidth={2}
                paintOrder="stroke"
                pointerEvents="none"
              />
            ))}

          {bars.map((bar) => (
            <rect
              key={`hit-${bar.period}`}
              x={(xScale(bar.period) ?? 0) - (step - band) / 2}
              y={0}
              width={step}
              height={innerHeight + X_LABEL_BAND}
              fill="transparent"
              role="button"
              tabIndex={0}
              aria-pressed={bar.period === selected}
              aria-label={`${periodLabel(timeframe, bar.period)}: ${readoutSentence(bar, series, currency)} Show this ${timeframe}.`}
              className="cursor-pointer outline-none focus-visible:stroke-[var(--focus-ring)] focus-visible:[stroke-width:2]"
              onPointerEnter={() => show(bar)}
              onPointerMove={() => show(bar)}
              onPointerLeave={tooltipRules.onChartLeave}
              onFocus={() => show(bar)}
              onBlur={tooltipRules.onChartLeave}
              onClick={() => onSelect?.(bar.period)}
              onKeyDown={(event: KeyboardEvent<SVGRectElement>) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect?.(bar.period);
                }
              }}
            />
          ))}
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
          <Readout bar={tooltipData} series={series} currency={currency} timeframe={timeframe} />
        </TooltipWithBounds>
      )}
    </div>
  );
}

function readoutSentence(bar: Bar, series: BarsSeries, currency: string): string {
  if (!bar.hasData) return 'no data.';
  const soFar = bar.complete ? '' : ' so far';
  const parts: string[] = [];
  if (series !== 'expenses') parts.push(`income ${moneyText(bar.incomeMinor, currency)}`);
  if (series !== 'income') parts.push(`expenses ${moneyText(bar.expensesMinor, currency)}`);
  if (series === 'both') parts.push(`net ${moneyText(bar.netMinor, currency)}`);
  return `${parts.join(', ')}${soFar}.`;
}

function Key({ series }: { readonly series: 'income' | 'expenses' | 'net' }) {
  return series === 'net' ? (
    <svg width={18} height={10} aria-hidden="true" className="shrink-0">
      <line
        x1={2}
        x2={16}
        y1={5}
        y2={5}
        stroke={cashFlowVar('net')}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <circle cx={9} cy={5} r={3} fill={cashFlowVar('net')} />
    </svg>
  ) : (
    <svg width={10} height={10} aria-hidden="true" className="shrink-0">
      <rect width={10} height={10} rx={2} fill={cashFlowVar(series)} />
    </svg>
  );
}

function Readout({
  bar,
  series,
  currency,
  timeframe,
}: {
  readonly bar: Bar;
  readonly series: BarsSeries;
  readonly currency: string;
  readonly timeframe: Timeframe;
}) {
  const line = (role: 'income' | 'expenses' | 'net', label: string, minor: string) => (
    <div className="flex items-center gap-1.5">
      <Key series={role} />
      <strong className="font-semibold">{moneyText(minor, currency)}</strong>
      <span className="text-text-secondary">{label}</span>
    </div>
  );
  return (
    <div className="tabular-nums">
      <div className="text-text-secondary">
        {periodLabel(timeframe, bar.period)}
        {bar.hasData && !bar.complete ? ' (so far)' : ''}
      </div>
      {!bar.hasData ? (
        <div>No data</div>
      ) : (
        <>
          {series !== 'expenses' && line('income', 'income', bar.incomeMinor)}
          {series !== 'income' && line('expenses', 'expenses', bar.expensesMinor)}
          {series === 'both' && line('net', 'net', bar.netMinor)}
        </>
      )}
    </div>
  );
}

export interface CashFlowBarsChartProps {
  readonly bars: readonly Bar[];
  readonly timeframe: Timeframe;
  readonly currency: string;
  readonly series: BarsSeries;
  readonly selected: string;
  readonly onSelect?: (period: string) => void;
  readonly title: string;
  readonly height?: number;
  readonly className?: string;
}

export function CashFlowBarsChart({
  bars,
  timeframe,
  currency,
  series,
  selected,
  onSelect,
  title,
  height = 240,
  className,
}: CashFlowBarsChartProps) {
  const chosen = bars.find((bar) => bar.period === selected);
  const first = bars[0];
  const last = bars.at(-1);
  const ariaLabel =
    `${title}, ${first === undefined ? '' : periodLabel(timeframe, first.period)} to ` +
    `${last === undefined ? '' : periodLabel(timeframe, last.period)}. ` +
    (chosen === undefined
      ? ''
      : `${periodLabel(timeframe, chosen.period)}: ${readoutSentence(chosen, series, currency)}`);
  const cell = (bar: Bar, minor: string) => (bar.hasData ? moneyText(minor, currency) : 'No data');
  const columns =
    series === 'both'
      ? ['Period', 'Income', 'Expenses', 'Net']
      : ['Period', series === 'income' ? 'Income' : 'Expenses'];
  return (
    <div className={className}>
      {series === 'both' && (
        <ul
          aria-label="Chart key"
          className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-text-secondary"
          data-testid="cash-flow-legend"
        >
          <li className="flex items-center gap-1.5">
            <Key series="income" />
            Income
          </li>
          <li className="flex items-center gap-1.5">
            <Key series="expenses" />
            Expenses
          </li>
          <li className="flex items-center gap-1.5">
            <Key series="net" />
            Net cash flow
          </li>
        </ul>
      )}
      <div className="mt-2" style={{ height }}>
        <ParentSize>
          {({ width, height: parentHeight }) => (
            <CashFlowBarsInner
              width={width}
              height={parentHeight}
              bars={bars}
              timeframe={timeframe}
              currency={currency}
              series={series}
              selected={selected}
              {...(onSelect === undefined ? {} : { onSelect })}
              ariaLabel={ariaLabel}
            />
          )}
        </ParentSize>
      </div>
      {/* 09 §5.6: every value, for the reader the readout (pointer or focus) and the columns cannot reach. */}
      <ChartDataTable
        className="mt-1"
        caption={title}
        columns={columns}
        rows={bars.map((bar) => {
          const label = `${periodLabel(timeframe, bar.period)}${bar.hasData && !bar.complete ? ' (so far)' : ''}`;
          return series === 'both'
            ? [
                label,
                cell(bar, bar.incomeMinor),
                cell(bar, bar.expensesMinor),
                cell(bar, bar.netMinor),
              ]
            : [label, cell(bar, series === 'income' ? bar.incomeMinor : bar.expensesMinor)];
        })}
      />
    </div>
  );
}
