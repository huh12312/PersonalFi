// SPDX-License-Identifier: MIT
import type { SankeyLink, SankeyNode } from '../../../api/generated/types.gen.ts';

/**
 * A hand-rolled Sankey layout — position and per-link vertical offset/width
 * only, no rendering. `@visx/sankey` and `d3-sankey` are **not** installed
 * dependencies (`apps/web/package.json` ships `@visx/{axis,brush,curve,
 * event,gradient,group,responsive,scale,shape,tooltip}` and `d3-{array,
 * scale,shape,time-format}` only — verified 2026-09-20; `05-frontend-
 * architecture.md` §3.2/§3.4 specs `@visx/sankey` but it was never added to
 * the dependency batch, and this work package cannot edit `package.json` or
 * run `pnpm install`). This module reimplements the *layout* half of what
 * `d3-sankey` would give for free — column assignment, node height by total
 * flow, per-link vertical slot within each node — using only arithmetic;
 * `SankeyChart.tsx` draws the result with `@visx/shape`'s
 * `pathHorizontalDiagonal` (a typed wrapper over `d3-shape`'s
 * `linkHorizontal`, used instead of importing `d3-shape` directly because
 * `d3-shape` ships no bundled types and `@types/d3-shape` is not a declared
 * dependency here) for the curve, the same "single stroked path,
 * `stroke-width = link value"` technique the original d3 Sankey example
 * itself uses (not a filled ribbon polygon). Flagged in
 * `docs/evidence/phase-2/wp2.9-budget-ui.md` as an open item: swap this
 * module for `@visx/sankey` once it's added to the dependency batch.
 */

const COLUMN_OF_KIND: Record<SankeyNode['kind'], number> = {
  income: 0,
  category: 1,
  merchant: 2,
  other: 2,
};

const NODE_WIDTH = 14;
const NODE_GAP = 10;

export interface LaidOutNode {
  readonly id: string;
  readonly kind: SankeyNode['kind'];
  readonly refId: string | null;
  readonly column: number;
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly total: number;
}

export interface LaidOutLink {
  readonly source: string;
  readonly target: string;
  readonly sourceY: number;
  readonly targetY: number;
  readonly width: number;
  readonly amountMinor: bigint;
  readonly drillThrough: SankeyLink['drillThrough'];
}

export interface SankeyLayout {
  readonly nodes: readonly LaidOutNode[];
  readonly links: readonly LaidOutLink[];
  readonly columnCount: number;
}

/**
 * `width`/`height` are the inner plot area (caller has already subtracted
 * margins). Every amount is read as `Math.abs(Number(minor))` — a display
 * scale for pixel geometry only, never money arithmetic (docs/CONVENTIONS.md's
 * bigint rule governs stored/compared amounts, not a layout ratio — the same
 * exception `envelope-display.ts#goalProgressOf` documents).
 */
export function layoutSankey(
  nodes: readonly SankeyNode[],
  links: readonly SankeyLink[],
  width: number,
  height: number,
): SankeyLayout {
  const columnOf = new Map(nodes.map((n) => [n.id, COLUMN_OF_KIND[n.kind]]));
  const columnCount = Math.max(1, ...[...columnOf.values()].map((c) => c + 1));

  const totalByNode = new Map<string, number>();
  const linkAmounts = links.map((link) => Math.abs(Number(link.amount.minor)));
  for (const [index, link] of links.entries()) {
    const amount = linkAmounts[index] ?? 0;
    totalByNode.set(link.source, (totalByNode.get(link.source) ?? 0) + amount);
    totalByNode.set(link.target, (totalByNode.get(link.target) ?? 0) + amount);
  }

  const byColumn = new Map<number, SankeyNode[]>();
  for (const node of nodes) {
    const column = columnOf.get(node.id) ?? 0;
    const bucket = byColumn.get(column);
    if (bucket === undefined) byColumn.set(column, [node]);
    else bucket.push(node);
  }

  // One global value→pixel scale (not per column) so a link's width matches
  // at both ends — the same reason real `d3-sankey` uses one scale for the
  // whole diagram rather than one per column. Each column has its own gap
  // budget (more nodes ⇒ more `NODE_GAP`s eaten out of `height`), so the
  // binding constraint is the column whose *own* ideal scale is smallest,
  // not the column with the largest raw total — a column with many small
  // nodes can need a smaller scale than a column with one big one.
  let scale = Infinity;
  for (const bucket of byColumn.values()) {
    const total = bucket.reduce((sum, n) => sum + (totalByNode.get(n.id) ?? 0), 0);
    if (total <= 0) continue;
    const gapBudget = NODE_GAP * Math.max(0, bucket.length - 1);
    const columnScale = Math.max(0, height - gapBudget) / total;
    scale = Math.min(scale, columnScale);
  }
  if (!Number.isFinite(scale)) scale = 0;

  const columnX = (column: number): number =>
    columnCount <= 1 ? 0 : (column / (columnCount - 1)) * Math.max(0, width - NODE_WIDTH);

  const laidOutNodes: LaidOutNode[] = [];
  const nodeById = new Map<string, LaidOutNode>();
  for (const [column, bucket] of byColumn) {
    // Largest first reads better for a "top = biggest flow" sankey and gives
    // deterministic output for a fixed input order (stable sort).
    const sorted = [...bucket].sort(
      (a, b) => (totalByNode.get(b.id) ?? 0) - (totalByNode.get(a.id) ?? 0),
    );
    let cursor = 0;
    for (const node of sorted) {
      const total = totalByNode.get(node.id) ?? 0;
      const nodeHeight = Math.max(2, total * scale);
      const laidOut: LaidOutNode = {
        id: node.id,
        kind: node.kind,
        refId: node.refId,
        column,
        x: columnX(column),
        y: cursor,
        height: nodeHeight,
        total,
      };
      laidOutNodes.push(laidOut);
      nodeById.set(node.id, laidOut);
      cursor += nodeHeight + NODE_GAP;
    }
  }

  // Per-node cumulative offset for outgoing (as source) and incoming (as
  // target) link slots, in the links array's own order — deterministic and
  // testable without depending on object identity or a secondary sort key.
  const outgoingCursor = new Map<string, number>();
  const incomingCursor = new Map<string, number>();
  const laidOutLinks: LaidOutLink[] = [];
  for (const [index, link] of links.entries()) {
    const source = nodeById.get(link.source);
    const target = nodeById.get(link.target);
    if (source === undefined || target === undefined) continue;
    const linkWidth = Math.max(1, (linkAmounts[index] ?? 0) * scale);

    const sourceOffset = outgoingCursor.get(link.source) ?? 0;
    outgoingCursor.set(link.source, sourceOffset + linkWidth);
    const targetOffset = incomingCursor.get(link.target) ?? 0;
    incomingCursor.set(link.target, targetOffset + linkWidth);

    laidOutLinks.push({
      source: link.source,
      target: link.target,
      sourceY: source.y + sourceOffset + linkWidth / 2,
      targetY: target.y + targetOffset + linkWidth / 2,
      width: linkWidth,
      amountMinor: BigInt(link.amount.minor),
      drillThrough: link.drillThrough,
    });
  }

  return { nodes: laidOutNodes, links: laidOutLinks, columnCount };
}
