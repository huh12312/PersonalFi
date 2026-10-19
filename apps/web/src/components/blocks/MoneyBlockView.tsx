// SPDX-License-Identifier: MIT
import { Money } from '../finance/Money.tsx';
import type { Block } from './schema.ts';
import { Withheld } from './Withheld.tsx';

type MoneyBlock = Extract<Block, { kind: 'money' }>;

/**
 * `money`: a label and an amount through `Money`. `signColour: 'by-sign'` wears the CVD-safe income/expense pair by
 * the amount's sign (`Money`'s `colorBySign`); otherwise the text ink. A withheld amount (`amountMinor: null`) is its
 * reason in words — the one thing this component will not do is print a zero for it.
 */
export function MoneyBlockView({ block }: { readonly block: MoneyBlock }) {
  return (
    <div className="flex flex-col gap-0.5" data-money-block={block.id ?? ''}>
      <span className="text-caption text-text-muted">{block.label}</span>
      {block.amountMinor === null ? (
        <Withheld reason={block.withheld ?? 'Not available.'} />
      ) : (
        // The size sits on a wrapper: `cn` merges `text-body` with the sign colour as two `text-*` classes and
        // would drop the colour.
        <span className="text-body font-medium">
          <Money
            value={{ minor: block.amountMinor, currency: block.currency }}
            signDisplay={block.signColour === 'by-sign' ? 'exceptZero' : 'auto'}
            colorBySign={block.signColour === 'by-sign'}
            className="tabular-nums"
          />
        </span>
      )}
      {block.hint !== undefined && (
        <span className="text-caption text-text-secondary">{block.hint}</span>
      )}
    </div>
  );
}
