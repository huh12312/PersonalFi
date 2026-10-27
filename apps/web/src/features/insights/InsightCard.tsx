// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bookmark, ChevronDown, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState } from 'react';

import {
  bookmarkInsightMutation,
  listInsightsFeedQueryKey,
  reviewInsightMutation,
  setInsightFeedbackMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Insight, InsightTextSegment } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { SeverityBadge } from '../../components/finance/SeverityBadge.tsx';
import { cn } from '../../lib/cn.ts';
import { useAccountsLookup } from '../accounts/useAccountsLookup.ts';
import { TransactionDetailSheet } from '../transactions/TransactionDetailSheet.tsx';
import { CreateRuleFromInsight } from './CreateRuleFromInsight.tsx';
import { DISMISS_REASON_CODES, DismissReasonDialog } from './DismissReasonDialog.tsx';
import { EvidencePanel } from './EvidencePanel.tsx';
import { segmentsFor, valueLineOf, verifiedMentionOf } from './mentions.ts';
import { ruleDraftOf } from './rule-draft.ts';
import { confidencePercentLabel } from './severity.ts';

export interface InsightCardProps {
  insight: Insight;
  /** Reported to the parent after a successful accept/dismiss, so it can show the cooldown banner (05 §5.8's undo-toast equivalent). */
  onReviewed?: (
    action: 'accept' | 'dismiss',
    result: { dismissCount: number; permanent: boolean; suppressedUntil: string | null },
  ) => void;
}

/** "Not helpful" offers every reason but "Remind me later", which is a snooze, not a judgement. */
const FEEDBACK_REASON_CODES = DISMISS_REASON_CODES.filter((code) => code !== 'LATER');

const MENTION_LINK =
  'font-medium text-accent-text underline decoration-1 underline-offset-2 hover:decoration-2';

/**
 * A run of the card's text with its entity mentions as in-app links (WP 10.15). Each linked segment is first
 * re-verified against this insight's own evidence (`verifiedMentionOf`); one that is not backed is plain text.
 */
function MentionText({
  insight,
  segments,
  onOpenTransaction,
}: {
  readonly insight: Insight;
  readonly segments: readonly InsightTextSegment[];
  readonly onOpenTransaction: (transactionId: string) => void;
}) {
  return (
    <>
      {segments.map((segment, index) => {
        const key = `${String(index)}-${segment.text}`;
        const mention = verifiedMentionOf(insight, segment);
        if (mention === null) return <span key={key}>{segment.text}</span>;
        switch (mention.entityType) {
          case 'category':
            return (
              <Link
                key={key}
                to="/categories/$categoryId"
                params={{ categoryId: mention.entityId }}
                className={MENTION_LINK}
                data-mention="category"
              >
                {segment.text}
              </Link>
            );
          case 'account':
            return (
              <Link
                key={key}
                to="/accounts/$accountId"
                params={{ accountId: mention.entityId }}
                className={MENTION_LINK}
                data-mention="account"
              >
                {segment.text}
              </Link>
            );
          case 'merchant':
            return (
              <Link
                key={key}
                to="/transactions"
                search={{ merchantIds: [mention.entityId] }}
                className={MENTION_LINK}
                data-mention="merchant"
              >
                {segment.text}
              </Link>
            );
          case 'transaction':
            return (
              <button
                key={key}
                type="button"
                onClick={() => onOpenTransaction(mention.entityId)}
                className={cn('inline min-h-6 rounded-sm', MENTION_LINK)}
                data-mention="transaction"
              >
                {segment.text}
              </button>
            );
        }
      })}
    </>
  );
}

/** The transaction sheet, mounted only once a transaction mention is opened (it reads the accounts list). */
function MentionedTransactionSheet({
  transactionId,
  onClose,
}: {
  readonly transactionId: string;
  readonly onClose: () => void;
}) {
  const { nameOf } = useAccountsLookup();
  return (
    <TransactionDetailSheet
      transactionId={transactionId}
      accountName={nameOf}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    />
  );
}

/**
 * One row in the `/insights` feed (02-phase-2-dispatch.md §3): severity,
 * $-impact, confidence up front; "View evidence panel" expands the full
 * panel inline (05-frontend-architecture.md §5.8's disclosure pattern,
 * `InlineInsight.tsx`'s "Why?" shape generalised to a whole card) rather
 * than navigating away, so accept/dismiss stay one click from the number
 * that justified them.
 *
 * WP 10.15 (V8; Monarch's equivalent): the title, the body and a context line ("About Groceries,
 * Checking · transaction 1") carry **entity mentions** as in-app links — category → its screen, account → its
 * screen, merchant → its transactions, transaction → its detail sheet here — each backed by this insight's own
 * evidence or drawn as plain words (`mentions.ts`). A **value line** says what the insight claims it is worth, from
 * its own impact fields ("Worth $36.00 / year", "Worth $120.00 one-time"), and is absent when it claims nothing;
 * there is no "saved so far" because no field records a captured value. **Bookmark** and **Helpful / Not helpful**
 * persist on the insight row (`POST /insights/{id}/bookmark|feedback`, migration 0051); "Not helpful" asks why
 * with the dismissal's own reason dialog. Neither moves the advisor's policy — dismissing does.
 *
 * WP 11.1: a `create_rule_draft` action becomes a real **Create rule** button only when this insight's own evidence
 * resolves both the category and the transaction the rule is drafted from (`rule-draft.ts`); it opens the existing
 * rule dialog pre-filled and accepts the insight once the rule exists. Otherwise it stays the inert suggestion the
 * evidence panel lists.
 */
export function InsightCard({ insight, onReviewed }: InsightCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const [explainingNotHelpful, setExplainingNotHelpful] = useState(false);
  const [openTransactionId, setOpenTransactionId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const invalidateFeed = () =>
    queryClient.invalidateQueries({ queryKey: listInsightsFeedQueryKey() });

  const review = useMutation({
    ...reviewInsightMutation(),
    onSuccess: (result) => {
      void invalidateFeed();
      const action = result.status === 'dismissed' ? 'dismiss' : 'accept';
      onReviewed?.(action, {
        dismissCount: result.dismissCount,
        permanent: result.permanent,
        suppressedUntil: result.suppressedUntil,
      });
    },
  });
  const bookmark = useMutation({
    ...bookmarkInsightMutation(),
    onSuccess: () => void invalidateFeed(),
  });
  const feedback = useMutation({
    ...setInsightFeedbackMutation(),
    onSuccess: () => void invalidateFeed(),
  });

  // While a write is in flight the controls show what was asked for, then what the server returned. A response
  // from a server that predates WP 10.15 carries none of the card fields: read as "not bookmarked, no answer".
  const bookmarked =
    bookmark.isPending && bookmark.variables !== undefined
      ? bookmark.variables.body.bookmarked
      : (insight.bookmarkedAt ?? null) !== null;
  const answer =
    feedback.isPending && feedback.variables !== undefined
      ? feedback.variables.body.feedback
      : (insight.feedback ?? null);
  const contextLine = insight.contextLine ?? null;

  const value = valueLineOf(insight);
  const ruleDraft = ruleDraftOf(insight);
  const openTransaction = (id: string) => setOpenTransactionId(id);
  const sendFeedback = (
    next: 'helpful' | 'not_helpful' | null,
    reasonCode: (typeof FEEDBACK_REASON_CODES)[number] | null = null,
    onDone?: () => void,
  ) =>
    feedback.mutate(
      { path: { insightId: insight.id }, body: { feedback: next, reasonCode } },
      onDone === undefined ? undefined : { onSuccess: onDone },
    );

  return (
    <li
      className="rounded-md border border-border-hairline bg-bg-surface p-3"
      data-testid="insight-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={insight.severity} />
            {/* h2, not h3: this card is the first heading under the route's
                own `<h1>` (`app/shell/TopBar.tsx`'s page title) — nothing on
                `/insights` renders an intervening h2, and axe's
                `heading-order` rule caught the h1->h3 skip when this WP's
                own e2e suite was the first to axe-scan a real page using
                this card. */}
            <h2 className="text-body font-medium text-text-primary">
              <MentionText
                insight={insight}
                segments={segmentsFor(insight.titleSegments, insight.title)}
                onOpenTransaction={openTransaction}
              />
            </h2>
          </div>
          <p className="mt-1 text-small text-text-secondary">
            <MentionText
              insight={insight}
              segments={segmentsFor(insight.bodySegments, insight.summaryMd)}
              onOpenTransaction={openTransaction}
            />
          </p>
          {contextLine !== null && contextLine.length > 0 && (
            <p className="mt-1 text-caption text-text-muted" data-testid="insight-context-line">
              <MentionText
                insight={insight}
                segments={contextLine}
                onOpenTransaction={openTransaction}
              />
            </p>
          )}
          <p className="mt-1 text-caption text-text-muted">
            {confidencePercentLabel(insight.confidence)}
          </p>
        </div>
        {value !== null && (
          <p
            className="shrink-0 text-right text-small text-text-secondary tabular-nums"
            data-testid="insight-value-line"
          >
            Worth{' '}
            <Money
              value={value.money}
              signDisplay="auto"
              colorBySign={false}
              className="text-body font-medium text-text-primary"
            />{' '}
            {value.suffix}
          </p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex min-h-6 items-center gap-1 rounded-sm text-small text-accent-text hover:underline focus-visible:outline-none"
        >
          {expanded ? 'Hide evidence panel' : 'View evidence panel'}
          <ChevronDown
            size={14}
            aria-hidden="true"
            className={cn(
              'transition-transform duration-fast ease-standard',
              expanded && 'rotate-180',
            )}
          />
        </button>
        <div
          className="flex flex-wrap items-center gap-1"
          role="group"
          aria-label="Your view of this insight"
        >
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={bookmarked}
            onClick={() => {
              if (bookmark.isPending) return;
              bookmark.mutate({
                path: { insightId: insight.id },
                body: { bookmarked: !bookmarked },
              });
            }}
            className="gap-1"
          >
            <Bookmark size={14} aria-hidden="true" className={cn(bookmarked && 'fill-current')} />
            {bookmarked ? 'Bookmarked' : 'Bookmark'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={answer === 'helpful'}
            onClick={() => {
              if (feedback.isPending) return;
              sendFeedback(answer === 'helpful' ? null : 'helpful');
            }}
            className="gap-1"
          >
            <ThumbsUp
              size={14}
              aria-hidden="true"
              className={cn(answer === 'helpful' && 'fill-current')}
            />
            Helpful
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={answer === 'not_helpful'}
            onClick={() => {
              if (feedback.isPending) return;
              if (answer === 'not_helpful') sendFeedback(null);
              else setExplainingNotHelpful(true);
            }}
            className="gap-1"
          >
            <ThumbsDown
              size={14}
              aria-hidden="true"
              className={cn(answer === 'not_helpful' && 'fill-current')}
            />
            Not helpful
          </Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {ruleDraft !== null && (
            <CreateRuleFromInsight
              insightId={insight.id}
              draft={ruleDraft}
              variant="secondary"
              size="md"
            />
          )}
          <Button variant="ghost" onClick={() => setDismissing(true)} disabled={review.isPending}>
            Dismiss
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              review.mutate({ path: { insightId: insight.id }, body: { action: 'accept' } })
            }
            disabled={review.isPending}
          >
            Accept
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3">
          <EvidencePanel insight={insight} />
        </div>
      )}

      <DismissReasonDialog
        open={dismissing}
        onOpenChange={setDismissing}
        busy={review.isPending}
        onDismiss={({ reasonCode, note }) => {
          review.mutate(
            {
              path: { insightId: insight.id },
              body: { action: 'dismiss', reasonCode, reason: note },
            },
            { onSuccess: () => setDismissing(false) },
          );
        }}
      />

      <DismissReasonDialog
        open={explainingNotHelpful}
        onOpenChange={setExplainingNotHelpful}
        busy={feedback.isPending}
        title="Why wasn't this helpful?"
        description="Your answer is saved on this insight. It does not dismiss it or change what the advisor looks for — choosing a reason is optional."
        confirmLabel="Send"
        busyLabel="Sending…"
        reasonCodes={FEEDBACK_REASON_CODES}
        showNote={false}
        confirmVariant="primary"
        onDismiss={({ reasonCode }) => {
          sendFeedback('not_helpful', reasonCode === 'LATER' ? null : reasonCode, () =>
            setExplainingNotHelpful(false),
          );
        }}
      />

      {openTransactionId !== null && (
        <MentionedTransactionSheet
          transactionId={openTransactionId}
          onClose={() => setOpenTransactionId(null)}
        />
      )}
    </li>
  );
}
