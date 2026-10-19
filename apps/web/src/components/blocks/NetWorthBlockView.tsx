// SPDX-License-Identifier: MIT
import { useState } from 'react';

import { NetWorthStackedChart } from '../../features/networth/NetWorthStackedChart.tsx';
import { fromWire } from '../../features/networth/stacked.ts';
import type { Block } from './schema.ts';

type NetWorthBlock = Extract<Block, { kind: 'net-worth' }>;

/**
 * `net-worth`: V6's stacked chart (`NetWorthStackedChart`, WP 10.13) over the block's buckets — V6's own
 * `NetWorthBucket` shape, so the block is exactly what `GET /net-worth/series?bucket=` returns. The chart brings
 * its scrub, its readout, its legend and its table; the block owns only the selection.
 */
export function NetWorthBlockView({ block }: { readonly block: NetWorthBlock }) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <div data-block-chart="net-worth">
      <NetWorthStackedChart
        buckets={fromWire(block.buckets)}
        bucketing={block.bucketing}
        currency={block.currency}
        title={block.title ?? 'Net worth by account type'}
        selected={selected}
        onSelect={setSelected}
      />
    </div>
  );
}
