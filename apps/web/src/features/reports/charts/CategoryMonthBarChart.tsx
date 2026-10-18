// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Bar } from '@visx/shape';
import { useMemo } from 'react';
import type { KeyboardEvent } from 'react';

import type { ReportCategoryMonthCell } from '../../../api/generated/types.gen.ts';
import { categoryHue, chartFillVar, type FillHue } from '../../../components/finance/chart-hue.ts';
import { toTransactionsSearch } from '../drill-through.ts';
import { ChartDataTable } from '../../../components/patterns/ChartDataTable.tsx';
import { Money } from '../../../components/finance/Money.tsx';
import { ScrollRegion } from '../../../components/patterns/ScrollRegion.tsx';

export interface CategoryMonthBarChartProps {
  cells: readonly ReportCategoryMonthCell[];
  height?: number;
  className?: string;
  labelFor?: (categoryId: string | null) => string;
  /** A category's hue (WP 10.8): the persisted one when the caller has it, else the server's seed for the id. */
  hueFor?: (categoryId: string | null) => FillHue;
  ariaLabel: string;
}

interface Segment {
  readonly categoryId: string | null;
  readonly amount: number;
  readonly cell: ReportCategoryMonthCell;
}

interface MonthBar {
  readonly month: string;
  readonly total: number;
  readonly segments: readonly Segment[];
}

const MARGIN = { top: 8, right: 8, bottom: 24, left: 40 };

/**
 * Category × month stacked bars, one bar per month, one coloured segment per
 * category (05-frontend-architecture.md §3.4's "Cash flow" spec: "Bars use
 * `--money-pos`/`--money-neg`" is for the *net* income-vs-spending chart;
 * this is the categorical breakdown, so segments use the categorical
 * series tokens instead — the two never share a legend). Every segment
 * carries its own cell's `drillThrough` and is a real, keyboard-reachable
 * click target (the WP 2.9 exit-test pattern, same technique as
 * `SankeyChart.tsx`'s links).
 */
export function CategoryMonthBarChart({
  cells,
  height = 280,
  className,
  labelFor,
  hueFor = (categoryId) => categoryHue(categoryId),
  ariaLabel,
}: CategoryMonthBarChartProps) {
  const navigate = useNavigate();

  const bars = useMemo<MonthBar[]>(() => {
    const byMonth = new Map<string, Segment[]>();
    for (const cell of cells) {
      const amount = Math.abs(Number(cell.amount.minor));
      if (amount === 0) continue;
      const bucket = byMonth.get(cell.month);
      const segment: Segment = { categoryId: cell.categoryId, amount, cell };
      if (bucket === undefined) byMonth.set(cell.month, [segment]);
      else bucket.push(segment);
    }
    return [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, segments]) => ({
        month,
        segments,
        total: segments.reduce((sum, s) => sum + s.amount, 0),
      }));
  }, [cells]);

  const innerWidth = 640 - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  const xScale = useMemo(
    () =>
      scaleBand<string>({
        domain: bars.map((b) => b.month),
        range: [0, innerWidth],
        padding: 0.25,
      }),
    [bars, innerWidth],
  );
  const yScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [0, Math.max(1, ...bars.map((b) => b.total))],
        range: [innerHeight, 0],
      }),
    [bars, innerHeight],
  );

  function goTo(cell: ReportCategoryMonthCell): void {
    void navigate({ to: '/transactions', search: toTransactionsSearch(cell.drillThrough) });
  }

  if (bars.length === 0) {
    return <p className="text-small text-text-muted">No activity in this window.</p>;
  }

  return (
    <>
      {/* No `role="img"`: that role tells assistive tech "treat this as one opaque picture," which is
          incompatible with the individually focusable/clickable bar segments inside it (axe's
          `nested-interactive` rule, caught while building this component — a real bug, fixed here, not a
          deferral). `aria-label` alone still gives the `<svg>` an accessible name (SVG-AAM), and each segment is
          its own reachable `role="button"` drill-through target. */}
      <ScrollRegion label={ariaLabel}>
        <svg
          width={innerWidth + MARGIN.left + MARGIN.right}
          height={height}
          aria-label={ariaLabel}
          className={className}
        >
          <Group left={MARGIN.left} top={MARGIN.top}>
            {bars.map((bar) => {
              let cumulative = 0;
              const x = xScale(bar.month) ?? 0;
              const barWidth = xScale.bandwidth();
              return (
                <Group key={bar.month} left={x}>
                  {bar.segments.map((segment) => {
                    const segmentTop = yScale(cumulative + segment.amount);
                    const segmentHeight = yScale(cumulative) - yScale(cumulative + segment.amount);
                    cumulative += segment.amount;
                    const label =
                      labelFor?.(segment.categoryId) ?? segment.categoryId ?? 'Uncategorised';
                    return (
                      <Bar
                        key={`${bar.month}-${segment.categoryId ?? 'uncategorised'}`}
                        x={0}
                        y={segmentTop}
                        width={barWidth}
                        height={Math.max(0, segmentHeight)}
                        fill={chartFillVar(hueFor(segment.categoryId))}
                        rx={2}
                        role="button"
                        tabIndex={0}
                        aria-label={`${label}, ${bar.month}, view transactions`}
                        className="cursor-pointer outline-none focus-visible:opacity-80 hover:opacity-80"
                        onClick={() => goTo(segment.cell)}
                        onKeyDown={(event: KeyboardEvent<SVGRectElement>) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            goTo(segment.cell);
                          }
                        }}
                      />
                    );
                  })}
                </Group>
              );
            })}
            {bars.map((bar) => (
              <text
                key={`label-${bar.month}`}
                x={(xScale(bar.month) ?? 0) + xScale.bandwidth() / 2}
                y={innerHeight + 16}
                textAnchor="middle"
                fontSize={11}
                fill="var(--chart-label)"
              >
                {bar.month}
              </text>
            ))}
          </Group>
        </svg>
      </ScrollRegion>
      {/* 09 §5.6: a bar's colour says which category it is and its height how much; this says both in words. */}
      <ChartDataTable
        className="mt-1"
        caption={ariaLabel}
        columns={['Month', 'Category', 'Amount', 'Transactions']}
        rows={cells
          .filter((cell) => Number(cell.amount.minor) !== 0)
          .slice()
          .sort((a, b) => a.month.localeCompare(b.month))
          .map((cell) => [
            cell.month,
            labelFor?.(cell.categoryId) ?? cell.categoryId ?? 'Uncategorised',
            <Money
              key={`${cell.month}-${cell.categoryId ?? 'none'}`}
              value={cell.amount}
              signDisplay="never"
              colorBySign={false}
            />,
            String(cell.transactionCount),
          ])}
      />
    </>
  );
}
