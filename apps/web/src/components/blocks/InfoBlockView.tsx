// SPDX-License-Identifier: MIT
import { BlockLabelText } from './BlockLabelText.tsx';
import type { Block } from './schema.ts';
import { Withheld } from './Withheld.tsx';

type InfoBlock = Extract<Block, { kind: 'info' }>;

/** `info`: a label and its value (words or money), or the reason the value is withheld. */
export function InfoBlockView({ block }: { readonly block: InfoBlock }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption text-text-muted">{block.label}</span>
      {block.value === null ? (
        <Withheld reason={block.withheld ?? 'Not available.'} />
      ) : (
        <BlockLabelText
          value={block.value}
          className="text-body font-medium text-text-primary tabular-nums"
        />
      )}
      {block.hint !== undefined && (
        <span className="text-caption text-text-secondary">{block.hint}</span>
      )}
    </div>
  );
}
