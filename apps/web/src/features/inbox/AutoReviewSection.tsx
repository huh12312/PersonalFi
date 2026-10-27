// SPDX-License-Identifier: MIT
import { CheckCircle2 } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';

import type { Transaction } from '../../api/generated/types.gen.ts';
import { CategoryIcon } from '../../components/finance/CategoryIcon.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { SkeletonText } from '../../components/patterns/Skeleton.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Label } from '../../components/ui/label.tsx';
import { Switch } from '../../components/ui/switch.tsx';
import { formatDateOnly } from '../../lib/date.ts';
import { useCategories } from '../categories/useCategories.ts';
import { useCategoryExplanations } from '../category-suggestions/suggestion-api.ts';
import { problemDetail } from '../narrator/narrator-api.ts';
import { CategoryPicker } from '../transactions/CategoryPicker.tsx';
import { TransactionProvenanceChip } from '../transactions/ProvenanceChip.tsx';
import { useTransactionOverlayMutation } from '../transactions/useTransactionOverlay.ts';
import {
  AUTO_REVIEW_LIMIT,
  useAutoReviewRows,
  useInboxPreferences,
  useSetInboxPreferences,
} from './auto-review-api.ts';

/**
 * WP 11.2b: "Auto-categorised, unreviewed".
 *
 * "Uncategorised" now means tier 6 only, so the queue above shrinks to what the machine could not place. This is the
 * second queue: the rows it did place in the last 30 days that the holder has not looked at, newest first, a page of
 * 50, each wearing its provenance chip. **Looks right** is the normal pick with the category already there (so it
 * teaches the learning tiers and the row leaves); **Change** reveals the normal picker. Nothing here is filed by
 * pressing nothing - the rows already count in budgets and reports, which is why they are offered for review at all.
 *
 * The holder who does not want to review automatic placements turns the section off with the switch in its header
 * (stored on their account, shown by default); the placements still count and still wear their chip elsewhere.
 */
export function AutoReviewSection() {
  const headingId = useId();
  const switchLabelId = useId();
  const preferences = useInboxPreferences();
  const setPreferences = useSetInboxPreferences();
  // An api without the route answers an error: the section stays shown (the default), as the preference says.
  const show = preferences.data?.showAutoReview ?? true;
  const preferencesReady = !preferences.isLoading;
  const rows = useAutoReviewRows(show && preferencesReady);
  const [resolved, setResolved] = useState<ReadonlySet<string>>(new Set());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const items = useMemo(
    () => (rows.data?.items ?? []).filter((item) => !resolved.has(item.id)),
    [rows.data, resolved],
  );
  const explanations = useCategoryExplanations(
    useMemo(() => items.map((item) => item.id), [items]),
  );

  /** After a row leaves: focus the next row's first button, else the one before, else the section heading. */
  function focusNeighbour(id: string): void {
    const rowsNow = [
      ...(listRef.current?.querySelectorAll<HTMLElement>('li[data-transaction-id]') ?? []),
    ];
    const index = rowsNow.findIndex((row) => row.dataset['transactionId'] === id);
    const neighbour = rowsNow[index + 1] ?? rowsNow[index - 1];
    const target = neighbour?.querySelector<HTMLElement>('button[data-action="looks-right"]');
    (target ?? headingRef.current)?.focus();
  }

  function leave(id: string): void {
    // Focus first, then drop the row: the button that had it is about to unmount.
    focusNeighbour(id);
    setResolved((current) => new Set(current).add(id));
  }

  const count = items.length;
  const more = (rows.data?.nextCursor ?? null) !== null;

  return (
    <section
      aria-labelledby={headingId}
      data-inbox-section="auto-review"
      data-testid="auto-review-section"
      className="mt-2 flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="text-small font-semibold text-text-muted outline-none"
        >
          Auto-categorised, unreviewed
          {show && rows.data !== undefined && (
            <span className="ml-2 font-normal" data-testid="auto-review-count">
              {more ? `${String(count)}+` : String(count)}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          <Label id={switchLabelId} className="text-small text-text-secondary">
            Review automatic placements
          </Label>
          <Switch
            aria-labelledby={switchLabelId}
            checked={show}
            disabled={!preferencesReady}
            onCheckedChange={(checked: boolean) =>
              setPreferences.mutate({ body: { showAutoReview: checked } })
            }
          />
        </div>
      </div>

      {!show ? (
        <p className="text-caption text-text-muted" data-testid="auto-review-off">
          Off. Automatic placements still count in your budgets and reports and still show where
          they came from; they just are not listed here.
        </p>
      ) : rows.data === undefined && !rows.isError ? (
        <SkeletonText lines={3} />
      ) : rows.isError ? (
        <p className="text-small text-status-danger-text" role="alert">
          Could not load the automatic placements. Nothing was changed.
        </p>
      ) : items.length === 0 ? (
        <p
          className="flex items-center gap-2 text-small text-text-muted"
          data-testid="auto-review-empty"
        >
          <CheckCircle2 size={14} aria-hidden="true" />
          Nothing automatic is waiting for a look.
        </p>
      ) : (
        <>
          <p className="text-caption text-text-muted">
            The last 30 days, newest first. These already count in your budgets and reports.
            {more ? ` Showing the first ${String(AUTO_REVIEW_LIMIT)}.` : ''}
          </p>
          <ul
            ref={listRef}
            aria-label="Auto-categorised, unreviewed"
            className="flex flex-col gap-2"
          >
            {items.map((transaction) => (
              <AutoReviewRow
                key={transaction.id}
                transaction={transaction}
                explanation={explanations.get(transaction.id)}
                onLeave={() => leave(transaction.id)}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface AutoReviewRowProps {
  readonly transaction: Transaction;
  readonly explanation: ReturnType<ReturnType<typeof useCategoryExplanations>['get']>;
  readonly onLeave: () => void;
}

function AutoReviewRow({ transaction, explanation, onLeave }: AutoReviewRowProps) {
  const overlay = useTransactionOverlayMutation();
  const { byId } = useCategories();
  const current = transaction.categoryId === null ? undefined : byId.get(transaction.categoryId);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const label = current?.label ?? 'this category';

  function pick(categoryId: string): void {
    setError(null);
    overlay.mutate(
      { path: { transactionId: transaction.id }, body: { categoryId } },
      {
        onSuccess: onLeave,
        onError: (cause) =>
          setError(problemDetail(cause, 'Could not save that. Nothing was changed.')),
      },
    );
  }

  return (
    <li
      data-testid="auto-review-row"
      data-transaction-id={transaction.id}
      className="rounded-md border border-border-hairline bg-bg-surface p-3"
    >
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
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-small text-text-muted">
              <span>
                {formatDateOnly(transaction.date)} · {current?.label ?? 'Archived category'}
              </span>
              <TransactionProvenanceChip transaction={transaction} explanation={explanation} />
            </p>
          </div>
        </div>
        <Money value={transaction.amount} className="shrink-0" />
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            data-action="looks-right"
            aria-label={`Looks right: ${transaction.merchantName ?? transaction.name} is ${label}`}
            aria-disabled={overlay.isPending}
            onClick={() => {
              if (overlay.isPending || transaction.categoryId === null) return;
              pick(transaction.categoryId);
            }}
          >
            Looks right
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={changing}
            aria-label={`Change the category of ${transaction.merchantName ?? transaction.name}`}
            onClick={() => {
              const next = !changing;
              setChanging(next);
              if (next) {
                requestAnimationFrame(() => pickerRef.current?.querySelector('input')?.focus());
              }
            }}
          >
            Change
          </Button>
        </div>
      </div>
      {changing && (
        <div ref={pickerRef} className="mt-2">
          <CategoryPicker
            value={transaction.categoryId}
            onChange={(categoryId) => {
              if (categoryId !== null) pick(categoryId);
            }}
            disabled={overlay.isPending}
            className="w-full"
          />
        </div>
      )}
      {error !== null && (
        <p className="mt-2 text-small text-status-danger-text" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
