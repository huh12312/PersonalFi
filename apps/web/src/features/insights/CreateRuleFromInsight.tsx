// SPDX-License-Identifier: MIT
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';

import {
  getTransactionOptions,
  listInsightsFeedQueryKey,
  reviewInsightMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { RuleFromTransactionDialog } from '../rules/RuleFromTransactionDialog.tsx';
import type { RuleDraft } from './rule-draft.ts';

export interface CreateRuleFromInsightProps {
  readonly insightId: string;
  readonly draft: RuleDraft;
  /** Ids the button's description points at (the row's merchant line), so "Create rule" says for what. */
  readonly describedBy?: string;
  readonly variant?: 'primary' | 'secondary';
  readonly size?: 'sm' | 'md';
  /**
   * Where focus goes once the rule exists and this suggestion is about to leave the screen. Called when the dialog
   * closes; `null` falls back to the main region.
   */
  readonly focusAfterAccept?: (trigger: HTMLButtonElement | null) => HTMLElement | null;
}

/**
 * The next control a keyboard user lands on when the item holding `trigger` leaves the list: the neighbouring item's
 * "Create rule" (or its first button), the one before it, else the main region.
 */
export function neighbourFocusTarget(trigger: HTMLElement | null): HTMLElement | null {
  const item = trigger?.closest('li') ?? null;
  for (const neighbour of [item?.nextElementSibling, item?.previousElementSibling]) {
    if (neighbour === null || neighbour === undefined) continue;
    const target =
      neighbour.querySelector<HTMLElement>('[data-rule-draft-trigger]:not([disabled])') ??
      neighbour.querySelector<HTMLElement>('button:not([disabled])');
    if (target !== null) return target;
  }
  return document.getElementById('main-content');
}

/**
 * WP 11.1: "Create rule" for an insight that drafts one (`rule-draft.ts`). Opens the existing
 * `RuleFromTransactionDialog` for the cited transaction, **pre-filled with the suggested category** — the rule is
 * created only by the dialog's own Preview button, through the route the dialog has always used
 * (`POST /transactions/{id}/rule`), and nothing existing is recategorised unless the holder then presses Apply.
 *
 * Once the rule exists the insight is accepted (`POST /insights/{id}/review`, `action: 'accept'`) — at creation, so
 * the record is right however the dialog is then closed — and the insights queries are invalidated only when the
 * dialog closes, so the suggestion (and this dialog inside it) does not vanish mid-preview.
 */
export function CreateRuleFromInsight({
  insightId,
  draft,
  describedBy,
  variant = 'primary',
  size = 'sm',
  focusAfterAccept = neighbourFocusTarget,
}: CreateRuleFromInsightProps) {
  const [open, setOpen] = useState(false);
  const [acceptFailed, setAcceptFailed] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const accepted = useRef<Promise<unknown> | null>(null);
  const queryClient = useQueryClient();

  // The Inbox row reads the same query eagerly (for the merchant's name); the Insights card only once pressed.
  const transaction = useQuery({
    ...getTransactionOptions({ path: { transactionId: draft.transactionId } }),
    enabled: open,
  });
  const review = useMutation({ ...reviewInsightMutation() });

  function handleRuleCreated(): void {
    if (accepted.current !== null) return;
    setAcceptFailed(false);
    accepted.current = review
      .mutateAsync({ path: { insightId }, body: { action: 'accept' } })
      .catch(() => setAcceptFailed(true));
  }

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next || accepted.current === null) return;
    void accepted.current.finally(
      () => void queryClient.invalidateQueries({ queryKey: listInsightsFeedQueryKey() }),
    );
  }

  const loading = open && transaction.isLoading;

  return (
    <>
      <Button
        ref={triggerRef}
        variant={variant}
        size={size}
        data-rule-draft-trigger=""
        aria-describedby={describedBy}
        disabled={loading}
        onClick={() => setOpen(true)}
      >
        {loading ? 'Opening…' : 'Create rule'}
      </Button>
      {open && transaction.isError && (
        <p role="alert" className="text-caption text-status-danger-text">
          Could not open this transaction.
        </p>
      )}
      {acceptFailed && (
        <p role="alert" className="text-caption text-status-danger-text">
          The rule was saved, but this suggestion could not be marked done.
        </p>
      )}
      {transaction.data !== undefined && (
        <RuleFromTransactionDialog
          transaction={transaction.data}
          open={open}
          onOpenChange={handleOpenChange}
          initialCategoryId={draft.categoryId}
          onRuleCreated={handleRuleCreated}
          finalFocus={() =>
            accepted.current === null ? true : (focusAfterAccept(triggerRef.current) ?? true)
          }
        />
      )}
    </>
  );
}
