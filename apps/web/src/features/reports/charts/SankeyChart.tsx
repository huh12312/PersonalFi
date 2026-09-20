// SPDX-License-Identifier: MIT
import { useNavigate } from '@tanstack/react-router';
import { pathHorizontalDiagonal } from '@visx/shape';
import { useMemo } from 'react';
import type { KeyboardEvent } from 'react';

import type { SankeyLink, SankeyNode } from '../../../api/generated/types.gen.ts';
import { categorySeriesVar } from '../../../components/finance/category-color.ts';
import { toTransactionsSearch } from '../drill-through.ts';
import { layoutSankey, type LaidOutLink, type LaidOutNode } from './sankey-layout.ts';

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

function linkPath(
  l: LaidOutLink,
  nodeById: Map<string, LaidOutNode>,
  nodeRight: (n: LaidOutNode) => number,
): string {
  const source = nodeById.get(l.source);
  const target = nodeById.get(l.target);
  if (source === undefined || target === undefined) return '';
  return (
    sankeyLinkPath({
      source: [nodeRight(source), l.sourceY],
      target: [target.x, l.targetY],
    }) ?? ''
  );
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

  return (
    // No `role="img"` — see `CategoryMonthBarChart.tsx`'s identical note:
    // this diagram's links and nodes are individually focusable drill-through
    // targets, which `role="img"` (an atomic, non-interactive picture)
    // forbids under axe's `nested-interactive` rule. `aria-label` alone still
    // names the `<svg>`.
    <svg width={width} height={height} aria-label={`Cash flow sankey diagram, ${currency}`}>
      <g transform={`translate(${String(MARGIN.left)}, ${String(MARGIN.top)})`}>
        {layout.links.map((l, index) => {
          const sourceNode = nodeById.get(l.source);
          const color =
            sourceNode !== undefined ? categorySeriesVar(sourceNode.refId) : 'var(--money-neutral)';
          return (
            <path
              // Links carry no stable id of their own on the wire; the index
              // disambiguates two links that happen to share source+target.
              key={`${l.source}->${l.target}-${String(index)}`}
              d={linkPath(l, nodeById, nodeRight)}
              fill="none"
              stroke={color}
              strokeOpacity={0.45}
              strokeWidth={l.width}
              role="link"
              tabIndex={0}
              aria-label={`Flow from ${l.source} to ${l.target}, view transactions`}
              className="cursor-pointer outline-none focus-visible:stroke-opacity-100 hover:stroke-opacity-80"
              onClick={() => goToDrillThrough(l.drillThrough)}
              onKeyDown={(event: KeyboardEvent<SVGPathElement>) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  goToDrillThrough(l.drillThrough);
                }
              }}
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
                fill={categorySeriesVar(node.refId)}
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
  );
}
