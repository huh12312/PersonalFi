// SPDX-License-Identifier: MIT
import { useQuery } from '@tanstack/react-query';
import { Bot } from 'lucide-react';
import { useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';

import { listCategoryExplanationsOptions } from '../../api/generated/@tanstack/react-query.gen.ts';
import type {
  AutoCategory,
  CategoryExplanation,
  Transaction,
} from '../../api/generated/types.gen.ts';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover.tsx';
import { cn } from '../../lib/cn.ts';
import { autoPlacementOf, chipLabelOf, chipNameOf, revealHeadlineOf } from './provenance.ts';

export interface ProvenanceChipProps {
  readonly transactionId: string;
  readonly auto: AutoCategory;
  /**
   * The stored explanation, when the caller already has it (the Inbox reads one batch for its rows). Absent: the
   * chip reads it itself, for this one transaction, the first time it is revealed.
   */
  readonly explanation?: CategoryExplanation | undefined;
  readonly className?: string;
}

/** The row and the grid around a chip open the transaction on Enter and click; the chip's own keys and clicks stay here. */
function keepKeyHere(event: KeyboardEvent): void {
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Escape') event.stopPropagation();
}
function keepClickHere(event: MouseEvent): void {
  event.stopPropagation();
}

/**
 * WP 11.2b: the mark every automatic placement wears. A category the holder did not pick and no rule set is never
 * shown bare: "Plaid", "Learned" or "Classifier 92 %", with a dashed outline and a glyph so it reads as the
 * machine's, not as colour alone.
 *
 * The reveal is a popover on a real button: hover opens it for a pointer, Enter or Space (the button's press) opens
 * it for the keyboard, Escape closes it and returns focus. It shows the **stored** explanation - the server's line,
 * composed from the chain recorded when the pass decided - and says what to do about it. It never recomputes and
 * never composes a sentence of its own about why.
 */
export function ProvenanceChip({
  transactionId,
  auto,
  explanation,
  className,
}: ProvenanceChipProps) {
  const [open, setOpen] = useState(false);
  const stored = useQuery({
    ...listCategoryExplanationsOptions({ query: { ids: transactionId } }),
    enabled: open && explanation === undefined,
    staleTime: 30_000,
    retry: false,
  });
  const shown =
    explanation ?? stored.data?.items.find((item) => item.transactionId === transactionId);
  const label = chipLabelOf(auto);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={100}
        data-testid="provenance-chip"
        data-tier={auto.tier}
        aria-label={`${label}. ${chipNameOf(auto)}. Show why.`}
        onClick={keepClickHere}
        onKeyDown={keepKeyHere}
        className={cn(
          'inline-flex min-h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-border-strong bg-bg-subtle px-2 py-0.5 text-caption font-medium text-text-secondary',
          'hover:bg-bg-inset focus-visible:outline-none',
          className,
        )}
      >
        <Bot size={11} aria-hidden="true" />
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        aria-label="Why this category"
        data-testid="provenance-reveal"
        onClick={keepClickHere}
        onKeyDown={keepKeyHere}
        className="w-80 max-w-[calc(100vw-2rem)]"
      >
        <p className="text-small font-semibold text-text-primary">
          {revealHeadlineOf(auto, shown)}
        </p>
        <p
          className="mt-1 text-small text-text-secondary [overflow-wrap:anywhere]"
          data-testid="provenance-line"
        >
          {shown !== undefined
            ? shown.line
            : stored.isError
              ? 'The stored explanation could not be loaded.'
              : 'Loading the stored explanation…'}
        </p>
        <p className="mt-2 text-caption text-text-muted">
          Placed automatically. Nothing you did put it here; pick a category to confirm or change
          it.
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** The chip for a transaction, or nothing when its category was picked by the holder, set by a rule, or is absent. */
export function TransactionProvenanceChip({
  transaction,
  explanation,
  className,
}: {
  readonly transaction: Pick<Transaction, 'id' | 'categorySource' | 'autoCategory'>;
  readonly explanation?: CategoryExplanation | undefined;
  readonly className?: string;
}) {
  const auto = autoPlacementOf(transaction);
  if (auto === null) return null;
  return (
    <ProvenanceChip
      transactionId={transaction.id}
      auto={auto}
      explanation={explanation}
      {...(className === undefined ? {} : { className })}
    />
  );
}
