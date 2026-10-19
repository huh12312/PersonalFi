// SPDX-License-Identifier: MIT
import { Badge } from '../ui/badge.tsx';
import type { Block } from './schema.ts';

/** `badge`: the house `Badge`, its variant a role (the status quartets, accent, neutral) — always words, never colour alone. */
export function BadgeBlockView({ block }: { readonly block: Extract<Block, { kind: 'badge' }> }) {
  return (
    <div>
      <Badge variant={block.variant}>{block.label}</Badge>
    </div>
  );
}
