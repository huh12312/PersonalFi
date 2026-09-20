// SPDX-License-Identifier: MIT
import { describe, expect, it } from 'vitest';

import type { SankeyLink, SankeyNode } from '../../../api/generated/types.gen.ts';
import { layoutSankey } from './sankey-layout.ts';

const NODES: SankeyNode[] = [
  { id: 'income', kind: 'income', refId: null },
  { id: 'groceries', kind: 'category', refId: 'cat_groceries' },
  { id: 'dining', kind: 'category', refId: 'cat_dining' },
];

const DT = { from: '2026-08-01', to: '2026-09-01' };

const LINKS: SankeyLink[] = [
  {
    source: 'income',
    target: 'groceries',
    amount: { minor: '-30000', currency: 'USD' },
    drillThrough: DT,
  },
  {
    source: 'income',
    target: 'dining',
    amount: { minor: '-10000', currency: 'USD' },
    drillThrough: DT,
  },
];

describe('layoutSankey', () => {
  it('places every node in a column and gives it a positive height proportional to its total flow', () => {
    const layout = layoutSankey(NODES, LINKS, 400, 200);
    expect(layout.nodes).toHaveLength(3);
    const income = layout.nodes.find((n) => n.id === 'income');
    const groceries = layout.nodes.find((n) => n.id === 'groceries');
    const dining = layout.nodes.find((n) => n.id === 'dining');
    expect(income?.column).toBe(0);
    expect(groceries?.column).toBe(1);
    expect(dining?.column).toBe(1);
    // income carries both links (40000 total) — twice groceries' flow (30000
    // vs... groceries alone is 30000, dining 10000) so income's own height
    // must be the largest node in the diagram.
    expect(income?.height).toBeGreaterThan(groceries?.height ?? 0);
    expect(groceries?.height).toBeGreaterThan(dining?.height ?? 0);
    for (const node of layout.nodes) expect(node.height).toBeGreaterThan(0);
  });

  it('produces one link per input link, each carrying its own drillThrough and a positive width', () => {
    const layout = layoutSankey(NODES, LINKS, 400, 200);
    expect(layout.links).toHaveLength(2);
    for (const link of layout.links) {
      expect(link.width).toBeGreaterThan(0);
      expect(link.drillThrough).toEqual(DT);
    }
    const groceriesLink = layout.links.find((l) => l.target === 'groceries');
    const diningLink = layout.links.find((l) => l.target === 'dining');
    // A 3x larger amount gets a 3x wider link (same global scale both ends).
    expect(groceriesLink?.width).toBeCloseTo((diningLink?.width ?? 0) * 3, 1);
  });

  it('never overflows the given height even with many nodes in one column', () => {
    const manyNodes: SankeyNode[] = [
      { id: 'income', kind: 'income', refId: null },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `cat_${String(i)}`,
        kind: 'category' as const,
        refId: `cat_${String(i)}`,
      })),
    ];
    const manyLinks: SankeyLink[] = manyNodes
      .filter((n) => n.kind === 'category')
      .map((n) => ({
        source: 'income',
        target: n.id,
        amount: { minor: '-1000', currency: 'USD' },
        drillThrough: DT,
      }));
    const layout = layoutSankey(manyNodes, manyLinks, 400, 200);
    const categoryNodes = layout.nodes.filter((n) => n.column === 1);
    const bottom = Math.max(...categoryNodes.map((n) => n.y + n.height));
    expect(bottom).toBeLessThanOrEqual(200 + 1e-6);
  });

  it('returns an empty layout for no nodes without throwing', () => {
    const layout = layoutSankey([], [], 400, 200);
    expect(layout.nodes).toEqual([]);
    expect(layout.links).toEqual([]);
  });
});
