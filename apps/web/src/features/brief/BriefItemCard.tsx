// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';

import {
  getCurrentBriefQueryKey,
  reviewInsightMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Badge } from '../../components/ui/badge.tsx';
import { Button } from '../../components/ui/button.tsx';
import { Money } from '../../components/finance/Money.tsx';
import { SeverityBadge } from '../../components/finance/SeverityBadge.tsx';
import { cn } from '../../lib/cn.ts';
import { DismissReasonDialog } from '../insights/DismissReasonDialog.tsx';
import { EvidencePanel } from '../insights/EvidencePanel.tsx';
import { headlineImpactOf } from '../insights/severity.ts';
import { insightViewOf } from './evidence-adapter.ts';
import { NarratedSummary } from './NarrationBadge.tsx';
import { retirementEffectWording } from './retirement-effect.ts';
import { narrationOf, primaryActionOf, type BriefItemWithNarration } from './types.ts';

export interface BriefItemCardProps {
  item: BriefItemWithNarration;
}

/**
 * One of the Brief's at-most-five ranked cards (05-phase-5-dispatch.md §3
 * WP 5.11): headline, one dollar figure, the retirement effect in its three
 * wordings, the action the Brief recorded at publication (WP 9.6, CF-24 — a
 * snapshot, or "No action recorded" for a Brief published before it existed),
 * and Accept — the only action verb `POST /insights/{id}/review` defines, and the "Why am I seeing this?"
 * panel reusing `features/insights/EvidencePanel.tsx` unmodified over an
 * adapted view of this item's own snapshotted fields (never a live re-fetch
 * — `evidence-adapter.ts`'s header).
 */
export function BriefItemCard({ item }: BriefItemCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const queryClient = useQueryClient();
  const cardRef = useRef<HTMLLIElement>(null);

  const review = useMutation({
    ...reviewInsightMutation(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: getCurrentBriefQueryKey() }).then(() => {
        // A reviewed item may leave the Brief, and the control that had focus goes with it; focus would fall to
        // the top of the page. If that happened, hand it to the page's content region (the skip link's target).
        // The card is still here when it merely changed state, and then focus is already where it belongs.
        window.setTimeout(() => {
          const active = document.activeElement;
          const gone = cardRef.current === null || !cardRef.current.isConnected;
          if (gone && (active === null || active === document.body)) {
            document.getElementById('main-content')?.focus();
          }
        }, 300);
      });
    },
  });

  const impact = headlineImpactOf(item);
  const narration = narrationOf(item);
  const effect = retirementEffectWording(item.retirementEffect);
  const action = primaryActionOf(item);
  const canReview = item.insightId !== null;

  return (
    <li
      ref={cardRef}
      data-testid="brief-item-card"
      className="rounded-md border border-border-hairline bg-bg-surface p-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={item.severity} />
            {item.carried && <Badge variant="neutral">Carried from last week</Badge>}
            <h3 className="text-body font-medium text-text-primary">{item.title}</h3>
          </div>
          <NarratedSummary templateSummaryMd={item.summaryMd} narration={narration} />
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1" data-testid="brief-item-impact">
          {impact !== null ? (
            <Money
              value={impact.money}
              signDisplay="auto"
              colorBySign={false}
              className="text-body font-medium"
            />
          ) : (
            <span className="text-caption text-text-muted">No dollar figure</span>
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

      <div
        data-testid="retirement-effect"
        className="mt-2 rounded-md bg-bg-subtle px-2.5 py-1.5 text-small text-text-secondary"
      >
        {effect.text}
        {effect.assumption !== null && (
          <p className="mt-0.5 text-caption text-text-muted">{effect.assumption}</p>
        )}
      </div>

      <div className="mt-2 text-small" data-testid="brief-item-action">
        {action === null ? (
          <p className="text-text-muted">No action recorded</p>
        ) : (
          <>
            <p className="text-text-secondary">
              <span className="text-text-muted">Suggested next step: </span>
              {action.kind === 'open_url' && action.url !== null ? (
                <a
                  href={action.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-accent-text hover:underline"
                >
                  {action.label}
                </a>
              ) : (
                <span className="font-medium text-text-primary">{action.label}</span>
              )}
            </p>
            {action.rationaleMd !== '' && (
              <p className="text-caption text-text-muted">{action.rationaleMd}</p>
            )}
          </>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex min-h-6 items-center gap-1 rounded-sm text-small text-accent-text hover:underline focus-visible:outline-none"
        >
          {expanded ? 'Hide evidence panel' : 'Why am I seeing this?'}
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
          <Button
            variant="ghost"
            onClick={() => {
              if (!review.isPending) setDismissing(true);
            }}
            disabled={!canReview}
            aria-disabled={review.isPending || undefined}
            className="aria-disabled:opacity-60"
          >
            Dismiss
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              // `aria-disabled`, not `disabled`, while the request is in flight: a disabled button drops
              // keyboard focus to the page, and the next Tab starts again from the top.
              if (item.insightId === null || review.isPending) return;
              review.mutate({ path: { insightId: item.insightId }, body: { action: 'accept' } });
            }}
            disabled={!canReview}
            aria-disabled={review.isPending || undefined}
            className="aria-disabled:opacity-60"
          >
            Accept
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="mt-3">
          <EvidencePanel insight={insightViewOf(item)} />
        </div>
      )}

      <DismissReasonDialog
        open={dismissing}
        onOpenChange={setDismissing}
        busy={review.isPending}
        onDismiss={({ reasonCode, note }) => {
          if (item.insightId === null) return;
          review.mutate(
            {
              path: { insightId: item.insightId },
              body: { action: 'dismiss', reasonCode, reason: note },
            },
            { onSuccess: () => setDismissing(false) },
          );
        }}
      />
    </li>
  );
}
