// SPDX-License-Identifier: MIT
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, Receipt } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';

import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { Skeleton } from '../../components/patterns/Skeleton.tsx';
import type { Transaction } from '../../api/generated/types.gen.ts';
import { useCategories } from '../categories/useCategories.ts';
import {
  MAX_EXPLANATION_IDS,
  suggestionOf,
  useCategoryExplanations,
} from '../category-suggestions/suggestion-api.ts';
import {
  suggestionFor,
  unavailableReasonFor,
  useMerchantNameIndex,
} from '../merchant-names/merchant-name-api.ts';
import { TransactionRow } from './TransactionRow.tsx';
import { autoPlacementOf } from './provenance.ts';
import { hasActiveFilters, type TransactionsSearch } from './filters.ts';
import { useTransactionsList } from './useTransactionsList.ts';

const ROW_HEIGHT = 60;
/** WP 11.2: a row carrying the model's suggestion chip starts at this estimate; its real height is measured. */
const SUGGESTION_ROW_ESTIMATE = 104;
/** WP 11.2b: a row carrying a provenance chip on its own line; its real height is measured too. */
const PROVENANCE_ROW_ESTIMATE = 92;
/** WP 11.6: a row carrying the merchant-name chip (or its note) on its own line; measured too. */
const MERCHANT_ROW_ESTIMATE = 96;
/** WP 11.6: at most this many rows carry the "why no name is suggested" note, so a long list stays quiet. */
const MAX_MERCHANT_NOTES = 3;

export interface TransactionsListProps {
  search: TransactionsSearch;
  accountName: (accountId: string) => string;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onClearFilters: () => void;
}

/**
 * The virtualized, keyset-paginated feed (deliverable 1). `@tanstack/react-virtual`
 * over `useTransactionsList`'s flattened pages; scrolling within
 * `overscan` rows of the bottom triggers `fetchNextPage`, same trigger a
 * "load more" button would use but without the extra click (05 §5.1).
 *
 * Arrow-key row focus: `role="grid"`/`role="row"` (already on `TransactionRow`)
 * plus a roving `tabIndex` driven by `focusedIndex` — the row itself owns
 * `aria-selected`/checkbox wiring, this component only owns which row is
 * the current stop and moves it on ArrowUp/ArrowDown/Enter.
 *
 * WP 11.2: the uncategorised rows loaded so far (the first `MAX_EXPLANATION_IDS`) are asked about in **one**
 * `GET /transactions/explanations` batch, as the Inbox does; a row whose explanation carries the model's suggestion
 * shows the compact chip (Confirm / Not this) under its cells, and is measured rather than given the fixed height.
 */
export function TransactionsList({
  search,
  accountName,
  selected,
  onToggleSelect,
  onOpen,
  onClearFilters,
}: TransactionsListProps) {
  const {
    items,
    isLoading,
    isError,
    error,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useTransactionsList(search);
  // WP 10.14: each row shows its category's icon and name; the chart of categories is one cached query.
  const { byId: categoriesById, isLoading: categoriesLoading } = useCategories();
  const parentRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  const uncategorizedIds = useMemo(
    () =>
      items
        .filter((transaction) => transaction.categoryId === null)
        .slice(0, MAX_EXPLANATION_IDS)
        .map((transaction) => transaction.id),
    [items],
  );
  const explanations = useCategoryExplanations(uncategorizedIds);
  const suggestionAt = useCallback(
    (transaction: Transaction | undefined) =>
      transaction === undefined || transaction.categoryId !== null
        ? null
        : suggestionOf(explanations.get(transaction.id)),
    [explanations],
  );

  // WP 11.6: the local model's names for noise merchants, read once for the whole list. A row whose merchant has one
  // carries the chip; a row whose merchant could not be asked about carries a one-line note (the first rows only).
  const merchantNames = useMerchantNameIndex();
  const [merchantStatus, setMerchantStatus] = useState('');
  const noteRowIds = useMemo(() => {
    const seen = new Set<string>();
    const ids = new Set<string>();
    for (const transaction of items) {
      if (ids.size >= MAX_MERCHANT_NOTES) break;
      const merchantId = transaction.merchantId;
      if (merchantId === null || seen.has(merchantId)) continue;
      if (suggestionFor(merchantNames, transaction) !== null) continue;
      if (unavailableReasonFor(merchantNames, transaction) === null) continue;
      seen.add(merchantId);
      ids.add(transaction.id);
    }
    return ids;
  }, [items, merchantNames]);
  const merchantNoteAt = useCallback(
    (transaction: Transaction | undefined) =>
      transaction === undefined || !noteRowIds.has(transaction.id)
        ? null
        : unavailableReasonFor(merchantNames, transaction),
    [noteRowIds, merchantNames],
  );

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => {
      const item = items[index];
      if (suggestionAt(item) !== null) return SUGGESTION_ROW_ESTIMATE;
      if (
        item !== undefined &&
        (suggestionFor(merchantNames, item) !== null || merchantNoteAt(item) !== null)
      ) {
        return MERCHANT_ROW_ESTIMATE;
      }
      return item !== undefined && autoPlacementOf(item) !== null
        ? PROVENANCE_ROW_ESTIMATE
        : ROW_HEIGHT;
    },
    overscan: 8,
  });

  const virtualItems = virtualizer.getVirtualItems();

  useEffect(() => {
    const last = virtualItems.at(-1);
    if (last === undefined) return;
    if (last.index >= items.length - 5 && hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [virtualItems, items.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setFocusedIndex((prev) => Math.min(prev + 1, items.length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setFocusedIndex((prev) => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter') {
        const row = items[focusedIndex];
        if (row !== undefined) onOpen(row.id);
      }
    },
    [items, focusedIndex, onOpen],
  );

  useEffect(() => {
    if (focusedIndex < items.length) virtualizer.scrollToIndex(focusedIndex, { align: 'auto' });
  }, [focusedIndex, items.length, virtualizer]);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} height={ROW_HEIGHT - 8} variant="block" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        headline="Couldn't load transactions"
        description={error instanceof Error ? error.message : 'Something went wrong. Try again.'}
        action={{ label: 'Retry', onClick: () => void refetch() }}
      />
    );
  }

  if (items.length === 0) {
    const filtered = hasActiveFilters(search);
    return (
      <EmptyState
        icon={Receipt}
        headline={filtered ? 'No transactions match these filters' : 'No transactions yet'}
        description={
          filtered
            ? 'Try widening the date range or clearing a filter.'
            : 'Connect an account to start seeing transactions here, or import a CSV.'
        }
        {...(filtered ? { action: { label: 'Clear filters', onClick: onClearFilters } } : {})}
      />
    );
  }

  return (
    // One child for the parent's layout: a sibling status line would take the list's `space-y` gap and lengthen
    // the page even while it is empty.
    <div className="relative">
      {/* WP 11.6: what an Accept or a Dismiss did. Always mounted so the change is announced. */}
      <p
        // `role="status"` is polite on its own. No explicit `aria-live`: a dialog's `aria-hidden` sweep leaves any
        // `[aria-live]` element exposed, which kept `<main>` half-visible behind the detail sheet and made axe flag it
        // (`scrollable-region-focusable`).
        role="status"
        data-testid="merchant-name-status"
        className={merchantStatus === '' ? 'sr-only' : 'text-small text-text-secondary'}
      >
        {merchantStatus}
      </p>
      <div
        ref={parentRef}
        role="grid"
        aria-label="Transactions"
        aria-rowcount={items.length}
        // Composite-widget roving tabindex: the container itself is only
        // programmatically focusable (`-1`), and TransactionRow's own
        // `tabIndex={isFocused ? 0 : -1}` is the real tab stop — but
        // jsx-a11y/interactive-supports-focus requires the `grid` role itself
        // to carry a `tabIndex` regardless.
        tabIndex={-1}
        className="h-[70vh] min-h-[320px] overflow-y-auto rounded-xl border border-border-hairline bg-bg-surface"
        onKeyDown={onKeyDown}
      >
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualItems.map((virtualRow) => {
            const transaction = items[virtualRow.index] as Transaction;
            const suggestion = suggestionAt(transaction);
            const merchantSuggestion = suggestionFor(merchantNames, transaction);
            const merchantNote = merchantSuggestion === null ? merchantNoteAt(transaction) : null;
            return (
              <TransactionRow
                key={transaction.id}
                transaction={transaction}
                accountName={accountName(transaction.accountId)}
                {...(categoriesLoading
                  ? {}
                  : {
                      category:
                        transaction.categoryId === null
                          ? null
                          : (categoriesById.get(transaction.categoryId) ?? {
                              // Archived (the picker list omits it): its id still tints it, its name is unknown here.
                              id: transaction.categoryId,
                              label: 'Archived category',
                            }),
                    })}
                suggestion={suggestion}
                merchantSuggestion={merchantSuggestion}
                merchantNote={merchantNote}
                onMerchantResult={setMerchantStatus}
                index={virtualRow.index}
                selected={selected.has(transaction.id)}
                isFocused={focusedIndex === virtualRow.index}
                measureRef={virtualizer.measureElement}
                onToggleSelect={onToggleSelect}
                onOpen={onOpen}
                onFocusRow={setFocusedIndex}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  ...(suggestion === null &&
                  merchantSuggestion === null &&
                  merchantNote === null &&
                  autoPlacementOf(transaction) === null
                    ? { height: `${ROW_HEIGHT}px` }
                    : { minHeight: `${ROW_HEIGHT}px` }),
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
