// SPDX-License-Identifier: MIT
import { ArrowLeftRight, EyeOff } from 'lucide-react';
import { memo } from 'react';
import type { CSSProperties } from 'react';

import { CategoryIcon } from '../../components/finance/CategoryIcon.tsx';
import type { CategoryIconSource } from '../../components/finance/category-icon.ts';
import { Money } from '../../components/finance/Money.tsx';
import { Badge } from '../../components/ui/badge.tsx';
import { formatDateOnlyShort } from '../../lib/date.ts';
import type { Transaction } from '../../api/generated/types.gen.ts';
import { cn } from '../../lib/cn.ts';
import { SuggestionChip } from '../category-suggestions/SuggestionChip.tsx';
import type { CategorySuggestion } from '../category-suggestions/suggestion-api.ts';

export interface TransactionRowProps {
  transaction: Transaction;
  accountName: string;
  /** WP 10.14: the row's category (icon + name); null = uncategorised. Undefined while the chart is loading. */
  category?: CategoryIconSource | null;
  /** WP 11.2: the model's suggestion for an uncategorised row (Confirm / Not this), or null. */
  suggestion?: CategorySuggestion | null;
  index: number;
  selected: boolean;
  isFocused: boolean;
  style: CSSProperties;
  measureRef: (node: HTMLElement | null) => void;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onFocusRow: (index: number) => void;
}

/**
 * One row of the virtualized grid (05-frontend-architecture.md §5.1). Amount
 * right-aligned, tabular; a hatch (`opacity-70` + dashed underline, cheaper
 * than an actual hatch pattern and equally colour-independent) marks a
 * pending row; `excluded` and `isTransfer` are glyph + label badges, never
 * colour alone (WCAG 1.4.1).
 *
 * `memo`'d on the props that change per row (05 §5.1: "memo'd with a
 * comparator on `(id, updatedAt, selected)`") — the default shallow
 * comparator already covers that plus `isFocused`/`index`/`style`, all of
 * which are primitives or a plain object recreated only when its own inputs
 * change.
 */
function TransactionRowImpl({
  transaction,
  accountName,
  category,
  suggestion = null,
  index,
  selected,
  isFocused,
  style,
  measureRef,
  onToggleSelect,
  onOpen,
  onFocusRow,
}: TransactionRowProps) {
  return (
    <div
      ref={measureRef}
      role="row"
      aria-rowindex={index + 1}
      aria-selected={selected}
      data-index={index}
      data-transaction-id={transaction.id}
      tabIndex={isFocused ? 0 : -1}
      style={style}
      className={cn(
        'absolute left-0 top-0 flex w-full items-center gap-3 border-b border-border-hairline px-3 py-2 outline-none focus-visible:bg-accent-wash data-[selected=true]:bg-accent-wash',
        suggestion !== null && 'flex-wrap gap-y-1.5',
      )}
      data-selected={selected}
      onFocus={() => onFocusRow(index)}
      onClick={() => onOpen(transaction.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onOpen(transaction.id);
      }}
    >
      <div role="gridcell" className="flex items-center">
        <input
          type="checkbox"
          aria-label={`Select ${transaction.name}`}
          checked={selected}
          onClick={(event) => event.stopPropagation()}
          onChange={() => onToggleSelect(transaction.id)}
          className="h-4 w-4"
        />
      </div>

      <div role="gridcell" className="w-20 shrink-0 text-small text-text-muted">
        {formatDateOnlyShort(transaction.date)}
      </div>

      <div role="gridcell" className="shrink-0">
        {category !== undefined && (
          <CategoryIcon
            category={
              category ?? { id: null, key: 'uncategorised', label: 'Uncategorized', isSystem: true }
            }
            size="sm"
          />
        )}
      </div>

      <div role="gridcell" className="min-w-0 flex-1">
        <div className="flex items-center gap-2 truncate text-body font-medium text-text-primary">
          <span className="truncate">{transaction.merchantName ?? transaction.name}</span>
          {transaction.pending && (
            <Badge variant="neutral" className="shrink-0">
              Pending
            </Badge>
          )}
          {transaction.excluded && (
            <Badge
              variant="warning"
              icon={<EyeOff size={11} aria-hidden="true" />}
              className="shrink-0"
            >
              Excluded
            </Badge>
          )}
          {transaction.isTransfer && (
            <Badge
              variant="accent"
              icon={<ArrowLeftRight size={11} aria-hidden="true" />}
              className="shrink-0"
            >
              Transfer
            </Badge>
          )}
        </div>
        <div className="truncate text-small text-text-muted">
          {category === undefined
            ? accountName
            : `${category?.label ?? 'Uncategorized'} · ${accountName}`}
        </div>
      </div>

      <div role="gridcell" className="shrink-0 text-right">
        <Money value={transaction.amount} className={transaction.pending ? 'opacity-70' : ''} />
      </div>

      {suggestion !== null && (
        <div role="gridcell" className="min-w-0 basis-full pl-7">
          <SuggestionChip transactionId={transaction.id} suggestion={suggestion} variant="list" />
        </div>
      )}
    </div>
  );
}

export const TransactionRow = memo(TransactionRowImpl);
