// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, CheckCircle2, X } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import {
  listTransactionsOptions,
  pairTransferMutation,
  rejectTransferMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Transaction } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { CategoryPicker } from '../transactions/CategoryPicker.tsx';
import { orientPair } from '../transactions/transfer-candidates.ts';
import {
  invalidateTransactionQueries,
  useTransactionOverlayMutation,
} from '../transactions/useTransactionOverlay.ts';
import {
  EMPTY_INBOX_STATE,
  inboxReducer,
  transferItem,
  uncategorizedItem,
  type InboxItem,
} from './inbox-reducer.ts';
import { findTransferSuggestions } from './transfer-suggestions.ts';

const TRANSFER_POOL_LIMIT = 200;
const UNCATEGORIZED_LIMIT = 50;

/**
 * The review inbox (wp1.6-ui.md §7's carried-over item; rung v0.3's "clears
 * in under 2 minutes" target). Three queues combine into one keyboard-first
 * list: uncategorized transactions (`GET /transactions?uncategorized=true`,
 * real), pending transfer-pair suggestions (client-computed —
 * `findTransferSuggestions`, since there is no candidate-suggestion route;
 * see `TransferPairDialog.tsx`'s module comment for the same reasoning), and
 * low-confidence categorizations.
 *
 * **The third queue is empty today, and that is an API gap, not a bug in
 * this screen.** WP 2.6 built the `pending_review` table and the insights
 * platform (`packages/contexts/insights/**`), but no route exposes it
 * (`apps/api/src/routes/insights.ts` does not exist yet), and
 * `GET /transactions` carries no categorisation-confidence field a client
 * could threshold on. The section renders its own honest empty state rather
 * than silently vanishing, so the gap is visible instead of guessed away.
 *
 * Keyboard-first: every row is a roving-tabindex list item
 * (`TransactionsList`'s own pattern); resolving an item — picking a category,
 * accepting or rejecting a transfer — removes it and moves focus to its
 * neighbour (`inbox-reducer.ts#resolve`), so a whole queue clears without the
 * keyboard ever leaving the list.
 */
export function InboxScreen() {
  const [state, dispatch] = useReducer(inboxReducer, EMPTY_INBOX_STATE);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const uncategorizedQuery = useQuery(
    listTransactionsOptions({ query: { uncategorized: 'true', limit: UNCATEGORIZED_LIMIT } }),
  );
  const poolQuery = useQuery(
    listTransactionsOptions({ query: { transfers: 'exclude', limit: TRANSFER_POOL_LIMIT } }),
  );

  const items = useMemo<InboxItem[]>(() => {
    const rawSuggestions = findTransferSuggestions(poolQuery.data?.items ?? []);
    const suggestions = rawSuggestions.map((s) => transferItem(s.outflow, s.inflow));
    // A transaction offered as one leg of a transfer suggestion is not also
    // offered as a plain "needs a category" row — a transfer is not spend,
    // and showing both would ask the user to resolve the same two rows
    // twice in two different ways.
    const suggestedIds = new Set(rawSuggestions.flatMap((s) => [s.outflow.id, s.inflow.id]));
    const uncategorized = (uncategorizedQuery.data?.items ?? [])
      .filter((t) => !suggestedIds.has(t.id))
      .map(uncategorizedItem);
    return [...suggestions, ...uncategorized];
  }, [poolQuery.data, uncategorizedQuery.data]);

  useEffect(() => {
    dispatch({ type: 'set-items', items });
  }, [items]);

  useEffect(() => {
    if (state.focusedId === null) return;
    const node = rowRefs.current.get(state.focusedId);
    if (node === undefined) return;
    // Only take DOM focus over when it has fallen out of the list entirely
    // (the "resolving a row moves focus to its neighbour" case, once the DOM
    // node holding it is removed) — never when the user is already
    // interacting with a control *inside some row* (this one or another),
    // which would otherwise fight opening this row's own category combobox:
    // clicking it focuses the input, which bubbles an `onFocus` up to the
    // `<li>`, which would re-trigger this effect and yank focus straight
    // back to the row container mid-click.
    const active = document.activeElement;
    const focusIsInsideAnyRow =
      active !== null && [...rowRefs.current.values()].some((row) => row.contains(active));
    if (focusIsInsideAnyRow) return;
    node.focus();
  }, [state.focusedId]);

  function resolve(id: string): void {
    dispatch({ type: 'resolve', id });
  }

  function handleRowKeyDown(event: KeyboardEvent, id: string): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      dispatch({ type: 'focus-delta', delta: 1 });
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      dispatch({ type: 'focus-delta', delta: -1 });
    } else if (state.focusedId !== id) {
      dispatch({ type: 'focus', id });
    }
  }

  const isLoading = uncategorizedQuery.isLoading || poolQuery.isLoading;

  if (isLoading) return <SkeletonText lines={6} />;

  if (state.items.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        headline="You're all caught up"
        description="No uncategorized transactions or transfer suggestions need your attention."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-small text-text-muted">
        {state.items.length} item{state.items.length === 1 ? '' : 's'} to review
      </p>
      <ul aria-label="Review inbox" className="flex flex-col gap-2">
        {state.items.map((item) => (
          // `onFocus`/`onKeyDown` here are roving-tabindex plumbing for the
          // list as a whole (`TransactionRow.tsx`'s own pattern), not a
          // click/activation handler on this `<li>` itself — the actual
          // actions live on the real interactive descendants (the category
          // combobox, the Accept/Reject buttons).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <li
            key={item.id}
            ref={(node) => {
              if (node === null) rowRefs.current.delete(item.id);
              else rowRefs.current.set(item.id, node);
            }}
            tabIndex={state.focusedId === item.id ? 0 : -1}
            data-focused={state.focusedId === item.id}
            onFocus={() => dispatch({ type: 'focus', id: item.id })}
            onKeyDown={(event) => handleRowKeyDown(event, item.id)}
            className="rounded-md border border-border-hairline bg-bg-surface p-3 outline-none focus-visible:ring-2 focus-visible:ring-accent data-[focused=true]:border-accent"
          >
            {item.kind === 'uncategorized' ? (
              <UncategorizedRow
                transaction={item.transaction}
                onResolved={() => resolve(item.id)}
              />
            ) : (
              <TransferSuggestionRow
                outflow={item.outflow}
                inflow={item.inflow}
                onResolved={() => resolve(item.id)}
              />
            )}
          </li>
        ))}
      </ul>

      <section aria-labelledby="inbox-low-confidence-heading" className="mt-2">
        <h2 id="inbox-low-confidence-heading" className="text-small font-semibold text-text-muted">
          Needs review (low confidence)
        </h2>
        <p className="mt-1 text-caption text-text-muted">
          Coming once the insights review queue has a route to read it from.
        </p>
      </section>
    </div>
  );
}

interface UncategorizedRowProps {
  transaction: Transaction;
  onResolved: () => void;
}

function UncategorizedRow({ transaction, onResolved }: UncategorizedRowProps) {
  const overlay = useTransactionOverlayMutation();

  function handleCategoryChange(categoryId: string | null): void {
    if (categoryId === null) return;
    overlay.mutate(
      { path: { transactionId: transaction.id }, body: { categoryId } },
      { onSuccess: onResolved },
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-text-primary">
          {transaction.merchantName ?? transaction.name}
        </p>
        <p className="text-small text-text-muted">{formatDateOnly(transaction.date)}</p>
      </div>
      <Money value={transaction.amount} className="shrink-0" />
      <CategoryPicker
        value={transaction.categoryId}
        onChange={handleCategoryChange}
        disabled={overlay.isPending}
        className="shrink-0"
      />
    </div>
  );
}

interface TransferSuggestionRowProps {
  outflow: Transaction;
  inflow: Transaction;
  onResolved: () => void;
}

function TransferSuggestionRow({ outflow, inflow, onResolved }: TransferSuggestionRowProps) {
  const queryClient = useQueryClient();
  const pair = useMutation({
    ...pairTransferMutation(),
    onSuccess: () => {
      invalidateTransactionQueries(queryClient, outflow.id);
      invalidateTransactionQueries(queryClient, inflow.id);
      onResolved();
    },
  });
  const reject = useMutation({
    ...rejectTransferMutation(),
    onSuccess: () => {
      invalidateTransactionQueries(queryClient, outflow.id);
      onResolved();
    },
  });

  const busy = pair.isPending || reject.isPending;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-small text-text-secondary">
        <ArrowLeftRight size={14} aria-hidden="true" className="text-accent-text" />
        <div>
          <p className="text-body text-text-primary">
            {outflow.merchantName ?? outflow.name} ↔ {inflow.merchantName ?? inflow.name}
          </p>
          <p className="text-caption text-text-muted">
            {formatDateOnly(outflow.date)} · <Money value={outflow.amount} />
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => pair.mutate({ body: orientPair(outflow, inflow) })}
        >
          Accept
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          className="gap-1"
          onClick={() =>
            reject.mutate({
              path: { transactionId: outflow.id },
              body: { otherTransactionId: inflow.id },
            })
          }
        >
          <X size={14} aria-hidden="true" />
          Reject
        </Button>
      </div>
    </div>
  );
}
