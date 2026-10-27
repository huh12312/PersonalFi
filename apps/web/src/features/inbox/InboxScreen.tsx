// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, CheckCircle2, X } from 'lucide-react';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import type { KeyboardEvent } from 'react';

import {
  pairTransferMutation,
  rejectTransferMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { CategoryExplanation, Transaction } from '../../api/generated/types.gen.ts';
import { EmptyState } from '../../components/patterns/EmptyState.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { CategoryIcon } from '../../components/finance/CategoryIcon.tsx';
import { useCategories } from '../categories/useCategories.ts';
import { SuggestionChip } from '../category-suggestions/SuggestionChip.tsx';
import { suggestionOf } from '../category-suggestions/suggestion-api.ts';
import { CategoryPicker } from '../transactions/CategoryPicker.tsx';
import { orientPair } from '../transactions/transfer-candidates.ts';
import {
  invalidateTransactionQueries,
  useTransactionOverlayMutation,
} from '../transactions/useTransactionOverlay.ts';
import { AutoReviewSection } from './AutoReviewSection.tsx';
import { EMPTY_INBOX_STATE, inboxReducer } from './inbox-reducer.ts';
import { RuleSuggestionsSection } from './RuleSuggestions.tsx';
import { useInboxExplanations } from './useInboxExplanations.ts';
import { useInboxQueue } from './useInboxQueue.ts';

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
 *
 * WP 11.1: each uncategorised row carries the server's one-line "why" (`GET /transactions/explanations`, one batch
 * for the rows on screen, `useInboxExplanations.ts`) — rendered verbatim as a caption, never composed here — and a
 * "Rule suggestions" section lists the pending `spending.rule_suggestion` insights (`RuleSuggestions.tsx`): Create
 * rule opens the existing rule dialog pre-filled with the suggested category, Not now dismisses with a reason.
 *
 * WP 11.2b: "Uncategorised" now means tier 6 only (the automatic tiers' placements are effective, with a provenance
 * chip), so this queue shrinks to what the machine could not place; the rows it did place and the holder has not
 * looked at are the second queue, `AutoReviewSection` ("Auto-categorised, unreviewed"), with its own switch.
 *
 * WP 11.2: an abstained row whose explanation carries the model's `suggestion` shows it as a chip under the row
 * (`SuggestionChip`): Confirm is this row's normal pick with the suggested category (so the row resolves and focus
 * moves to its neighbour exactly as a manual pick does), Not this records a rejection and leaves the row
 * uncategorised. Nothing is filed without the holder's press.
 */
export function InboxScreen() {
  const [state, dispatch] = useReducer(inboxReducer, EMPTY_INBOX_STATE);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());

  const { items, isLoading } = useInboxQueue();
  // Asked once the whole queue has loaded: until the transfer pool arrives, a suggested transfer's legs are
  // still in the uncategorised list, and a batch asked for then would be a second, wider request.
  const uncategorizedIds = useMemo(
    () =>
      isLoading
        ? []
        : items.flatMap((item) => (item.kind === 'uncategorized' ? [item.transaction.id] : [])),
    [items, isLoading],
  );
  const explanations = useInboxExplanations(uncategorizedIds);

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
    // WP 11.1: nor when the holder is working a rule suggestion (or a dialog it opened) — a queue refetch
    // moving the focused row must not pull focus out of that section.
    if (active?.closest('[data-inbox-section="rule-suggestions"], [role="dialog"]')) return;
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

  if (isLoading) return <SkeletonText lines={6} />;

  if (state.items.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState
          icon={CheckCircle2}
          headline="You're all caught up"
          description="No uncategorized transactions or transfer suggestions need your attention."
        />
        <AutoReviewSection />
        <RuleSuggestionsSection />
      </div>
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
                explanation={explanations.get(item.transaction.id)}
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

      <AutoReviewSection />

      <RuleSuggestionsSection />

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
  /** WP 11.1: the server's explanation for this row; absent while loading, on error, or if it sent none. */
  explanation: CategoryExplanation | undefined;
  onResolved: () => void;
}

function UncategorizedRow({ transaction, explanation, onResolved }: UncategorizedRowProps) {
  const overlay = useTransactionOverlayMutation();
  // WP 10.14: the row's current category as its icon (uncategorised: ❔), beside the picker that changes it.
  const { byId } = useCategories();
  const current = transaction.categoryId === null ? undefined : byId.get(transaction.categoryId);
  const suggestion = transaction.categoryId === null ? suggestionOf(explanation) : null;

  function handleCategoryChange(categoryId: string | null): void {
    if (categoryId === null) return;
    overlay.mutate(
      { path: { transactionId: transaction.id }, body: { categoryId } },
      { onSuccess: onResolved },
    );
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 flex-1 basis-60 items-center gap-3">
        <CategoryIcon
          category={
            current ?? { id: null, key: 'uncategorised', label: 'Uncategorized', isSystem: true }
          }
          size="sm"
        />
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-text-primary">
            {transaction.merchantName ?? transaction.name}
          </p>
          <p className="text-small text-text-muted">
            {formatDateOnly(transaction.date)} · {current?.label ?? 'Uncategorized'}
          </p>
          {explanation !== undefined && (
            // The server's line, verbatim (WP 11.1): read from the decision working stored when the
            // decision was made. Never rebuilt from `explanation.tiers` on this side.
            <p
              className="mt-0.5 text-caption text-text-muted [overflow-wrap:anywhere]"
              data-testid="inbox-why"
              data-status={explanation.status}
            >
              <span className="sr-only">Why: </span>
              {explanation.line}
            </p>
          )}
        </div>
      </div>
      <Money value={transaction.amount} className="shrink-0" />
      <CategoryPicker
        value={transaction.categoryId}
        onChange={handleCategoryChange}
        disabled={overlay.isPending}
        className="shrink-0"
      />
      {suggestion !== null && (
        <div className="basis-full">
          <SuggestionChip
            transactionId={transaction.id}
            suggestion={suggestion}
            onConfirmed={onResolved}
          />
        </div>
      )}
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
