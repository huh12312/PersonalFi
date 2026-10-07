// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { Group } from '@visx/group';
import { scaleBand, scaleLinear } from '@visx/scale';
import { Bar } from '@visx/shape';
import { useMemo } from 'react';
import type { KeyboardEvent } from 'react';

import type { ReportCategoryMonthCell } from '../../../api/generated/types.gen.ts';
import { categorySeriesVar } from '../../../components/finance/category-color.ts';
import { toTransactionsSearch } from '../drill-through.ts';
import { ScrollRegion } from '../../../components/patterns/ScrollRegion.tsx';

export interface CategoryMonthBarChartProps {
  cells: readonly ReportCategoryMonthCell[];
  height?: number;
  className?: string;
  labelFor?: (categoryId: string | null) => string;
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
    // No `role="img"`: that role tells assistive tech "treat this as one
    // opaque picture," which is incompatible with the individually
    // focusable/clickable bar segments inside it (axe's `nested-interactive`
    // rule, caught while building this component — a real bug, fixed here,
    // not a deferral). `aria-label` alone still gives the `<svg>` an
    // accessible name (SVG-AAM), and each segment is its own reachable
    // `role="button"` drill-through target.
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
                      fill={categorySeriesVar(segment.categoryId)}
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
              fill="var(--text-muted)"
            >
              {bar.month}
            </text>
          ))}
        </Group>
      </svg>
    </ScrollRegion>
  );
}
