// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import {
  listInsightsFeedQueryKey,
  reviewInsightMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import type { Insight } from '../../api/generated/types.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { SeverityBadge } from '../../components/finance/SeverityBadge.tsx';
import { cn } from '../../lib/cn.ts';
import { DismissReasonDialog } from './DismissReasonDialog.tsx';
import { EvidencePanel } from './EvidencePanel.tsx';
import { confidencePercentLabel, headlineImpactOf } from './severity.ts';

export interface InsightCardProps {
  insight: Insight;
  /** Reported to the parent after a successful accept/dismiss, so it can show the cooldown banner (05 §5.8's undo-toast equivalent). */
  onReviewed?: (
    action: 'accept' | 'dismiss',
    result: { dismissCount: number; permanent: boolean; suppressedUntil: string | null },
  ) => void;
}

/**
 * One row in the `/insights` feed (02-phase-2-dispatch.md §3): severity,
 * $-impact, confidence up front; "View evidence panel" expands the full
 * panel inline (05-frontend-architecture.md §5.8's disclosure pattern,
 * `InlineInsight.tsx`'s "Why?" shape generalised to a whole card) rather
 * than navigating away, so accept/dismiss stay one click from the number
 * that justified them.
 */
export function InsightCard({ insight, onReviewed }: InsightCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const queryClient = useQueryClient();

  const review = useMutation({
    ...reviewInsightMutation(),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: listInsightsFeedQueryKey() });
      const action = result.status === 'dismissed' ? 'dismiss' : 'accept';
      onReviewed?.(action, {
        dismissCount: result.dismissCount,
        permanent: result.permanent,
        suppressedUntil: result.suppressedUntil,
      });
    },
  });

  const impact = headlineImpactOf(insight);

  return (
    <li className="rounded-md border border-border-hairline bg-bg-surface p-3">
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
            <h2 className="text-body font-medium text-text-primary">{insight.title}</h2>
          </div>
          <p className="mt-1 text-small text-text-secondary">{insight.summaryMd}</p>
          <p className="mt-1 text-caption text-text-muted">
            {confidencePercentLabel(insight.confidence)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {impact !== null && (
            <Money value={impact.money} colorBySign={false} className="text-body font-medium" />
          )}
          <span className="text-caption text-text-muted">
            {impact?.kind === 'annualized'
              ? 'per year'
              : impact?.kind === 'one_time'
                ? 'one-time'
                : ''}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex items-center gap-1 rounded-sm text-small text-accent-text hover:underline focus-visible:outline-none"
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
        <div className="ml-auto flex items-center gap-2">
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
        onDismiss={(reason) => {
          review.mutate(
            { path: { insightId: insight.id }, body: { action: 'dismiss', reason } },
            { onSuccess: () => setDismissing(false) },
          );
        }}
      />
    </li>
  );
}
