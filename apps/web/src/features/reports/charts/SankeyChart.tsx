// SPDX-License-Identifier: MIT
import { Link, useNavigate } from '@tanstack/react-router';
import { pathHorizontalDiagonal } from '@visx/shape';
import { useMemo } from 'react';

import type { SankeyLink, SankeyNode } from '../../../api/generated/types.gen.ts';
import { categoryHue, chartFillVar, type FillHue } from '../../../components/finance/chart-hue.ts';
import { toTransactionsSearch } from '../drill-through.ts';
import { layoutSankey, type LaidOutLink, type LaidOutNode } from './sankey-layout.ts';
import { ChartDataTable } from '../../../components/patterns/ChartDataTable.tsx';
import { Money } from '../../../components/finance/Money.tsx';
import { ScrollRegion } from '../../../components/patterns/ScrollRegion.tsx';

interface LinkEndpoints {
  readonly source: [number, number];
  readonly target: [number, number];
}

/**
 * `@visx/shape`'s `pathHorizontalDiagonal` wraps `d3-shape`'s
 * `linkHorizontal` with its own typed API — used instead of importing
 * `d3-shape` directly because `d3-shape` ships no bundled types and
 * `@types/d3-shape` is not a declared dependency of `apps/web`
 * (`sankey-layout.ts`'s module header has the full dependency-gap note).
 */
const sankeyLinkPath = pathHorizontalDiagonal<LinkEndpoints, [number, number]>({
  source: (d) => d.source,
  target: (d) => d.target,
  x: (node) => node[0],
  y: (node) => node[1],
});

/**
 * A band as a filled ribbon: the top edge from source to target, down the target end, the bottom edge back, closed.
 * Drawn as an area rather than a thick stroke (WP 10.10) so its box *is* the band: a level band drawn as a stroke has
 * a zero-height geometry box, which a focus check (and a scroll-into-view) reads as nowhere on screen — the
 * keyboard sweep found exactly that on the Cash Flow hub, where this chart is on screen by default.
 */
function linkPath(
  l: LaidOutLink,
  nodeById: Map<string, LaidOutNode>,
  nodeRight: (n: LaidOutNode) => number,
): string {
  const source = nodeById.get(l.source);
  const target = nodeById.get(l.target);
  if (source === undefined || target === undefined) return '';
  const x0 = nodeRight(source);
  const x1 = target.x;
  const half = Math.max(l.width, 1) / 2;
  const top =
    sankeyLinkPath({ source: [x0, l.sourceY - half], target: [x1, l.targetY - half] }) ?? '';
  const bottom =
    sankeyLinkPath({ source: [x1, l.targetY + half], target: [x0, l.sourceY + half] }) ?? '';
  // `bottom` starts with its own move-to; continue the outline with a line-to instead.
  return `${top}L${bottom.replace(/^M/u, '')}Z`;
}

function nodeLabel(node: LaidOutNode): string {
  if (node.kind === 'income') return 'Income';
  if (node.kind === 'other') return 'Other';
  return node.refId ?? node.id;
}

export interface SankeyChartProps {
  nodes: readonly SankeyNode[];
  links: readonly SankeyLink[];
  currency: string;
  width?: number;
  height?: number;
  /** Resolves a node's `refId` to a display label (category name / merchant name) — the chart itself only knows ids. */
  labelFor?: (node: SankeyNode) => string | undefined;
  /**
   * A node's hue (WP 10.8): the caller passes the persisted category hue; the default is the server's seed for
   * the id, so the same category is the same colour here as on every other chart.
   */
  hueFor?: (refId: string | null) => FillHue;
}

const MARGIN = { top: 16, right: 100, bottom: 16, left: 100 };

/**
 * Income → category → merchant/other flow, drilling through to
 * `/transactions` on a click (the WP 2.9 exit test: "clicking a Sankey band
 * lands on the filtered list"). Layout in `sankey-layout.ts`; this component
 * only draws it and wires the click/keyboard handler. See that file's module
 * header for why this is hand-rolled rather than `@visx/sankey`.
 */
export function SankeyChart({
  nodes,
  links,
  currency,
  width = 640,
  height = 360,
  labelFor,
  hueFor = (refId) => categoryHue(refId),
}: SankeyChartProps) {
  const navigate = useNavigate();
  const innerWidth = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerHeight = Math.max(0, height - MARGIN.top - MARGIN.bottom);

  const layout = useMemo(
    () => layoutSankey(nodes, links, innerWidth, innerHeight),
    [nodes, links, innerWidth, innerHeight],
  );
  const nodeById = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout.nodes]);
  const nodeRight = (n: LaidOutNode): number => n.x + 14;

  function goToDrillThrough(drillThrough: SankeyLink['drillThrough']): void {
    void navigate({ to: '/transactions', search: toTransactionsSearch(drillThrough) });
  }

  if (layout.nodes.length === 0) {
    return <p className="text-small text-text-muted">No cash flow in this window.</p>;
  }

  const labelOfId = (id: string): string => {
    const laid = nodeById.get(id);
    const wire = nodes.find((n) => n.id === id);
    if (laid === undefined) return id;
    return (wire !== undefined ? labelFor?.(wire) : undefined) ?? nodeLabel(laid);
  };

  return (
    <>
      {/* No `role="img"` — see `CategoryMonthBarChart.tsx`'s identical note: this diagram's links and nodes are
          individually focusable drill-through targets, which `role="img"` (an atomic, non-interactive picture)
          forbids under axe's `nested-interactive` rule. `aria-label` alone still names the `<svg>`. */}
      <ScrollRegion label={`Cash flow sankey diagram, ${currency}`}>
        <svg width={width} height={height} aria-label={`Cash flow sankey diagram, ${currency}`}>
          <g transform={`translate(${String(MARGIN.left)}, ${String(MARGIN.top)})`}>
            {layout.links.map((l, index) => {
              const sourceNode = nodeById.get(l.source);
              const color =
                sourceNode !== undefined
                  ? chartFillVar(hueFor(sourceNode.refId))
                  : chartFillVar('neutral');
              return (
                <path
                  // Links carry no stable id of their own on the wire; the index
                  // disambiguates two links that happen to share source+target.
                  key={`${l.source}->${l.target}-${String(index)}`}
                  d={linkPath(l, nodeById, nodeRight)}
                  fill={color}
                  fillOpacity={0.45}
                  stroke="none"
                  // Pointer only (WP 10.10): bands overlap by nature, so a focused band is always partly covered
                  // by its neighbour (2.4.11, found by the keyboard sweep on the Cash Flow hub). The keyboard and
                  // screen-reader route to the same drill-through is the table below, one link per flow.
                  aria-hidden="true"
                  data-flow={`${l.source}->${l.target}`}
                  className="cursor-pointer hover:fill-opacity-80"
                  onClick={() => goToDrillThrough(l.drillThrough)}
                />
              );
            })}
            {layout.nodes.map((node) => {
              const wireNode = nodes.find((n) => n.id === node.id);
              const label =
                (wireNode !== undefined ? labelFor?.(wireNode) : undefined) ?? nodeLabel(node);
              const isLeftColumn = node.column === 0;
              return (
                <g key={node.id}>
                  <rect
                    x={node.x}
                    y={node.y}
                    width={14}
                    height={node.height}
                    fill={chartFillVar(hueFor(node.refId))}
                    rx={2}
                  />
                  <text
                    x={isLeftColumn ? node.x - 6 : node.x + 20}
                    y={node.y + node.height / 2}
                    dy="0.32em"
                    textAnchor={isLeftColumn ? 'end' : 'start'}
                    fontSize={11}
                    fill="var(--text-secondary)"
                  >
                    {label}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </ScrollRegion>
      {/* 09 §5.6: the diagram's ribbons are colour and width; these are the same flows as figures, each a link to its
          transactions — the keyboard's way into the drill-through the ribbons give a pointer. */}
      <ChartDataTable
        className="mt-1"
        caption={`Cash flow, ${currency}: where each amount came from and went`}
        columns={['From', 'To', 'Amount']}
        rows={links.map((l) => [
          labelOfId(l.source),
          <Link
            key={`to-${l.source}-${l.target}`}
            to="/transactions"
            search={toTransactionsSearch(l.drillThrough)}
            className="text-accent-text underline-offset-4 hover:underline"
          >
            {labelOfId(l.target)}
            <span className="sr-only">, view transactions</span>
          </Link>,
          <Money
            key={`${l.source}-${l.target}`}
            value={l.amount}
            signDisplay="never"
            colorBySign={false}
          />,
        ])}
      />
    </>
  );
}
