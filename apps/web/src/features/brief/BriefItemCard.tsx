// SPDX-License-Identifier: MIT
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';

import {
  getCurrentBriefQueryKey,
  reviewInsightMutation,
} from '../../api/generated/@tanstack/react-query.gen.ts';
import { Button } from '../../components/ui/button.tsx';
import { SeverityBadge } from '../../components/finance/SeverityBadge.tsx';
import { cn } from '../../lib/cn.ts';
import { TalkThroughLink } from '../advisor/TalkThroughLink.tsx';
import { BriefProgressBox } from './BriefProgressBox.tsx';
import { DismissReasonDialog } from '../insights/DismissReasonDialog.tsx';
import { EvidencePanel } from '../insights/EvidencePanel.tsx';
import { insightViewOf } from './evidence-adapter.ts';
import { BlockRenderer } from '../../components/blocks/BlockRenderer.tsx';
import { retirementEffectWording } from './retirement-effect.ts';
import { primaryActionOf, type BriefItemWithNarration } from './types.ts';

function kindOf(block: unknown): string | null {
  return block !== null && typeof block === 'object' && 'kind' in block
    ? String((block as { readonly kind: unknown }).kind)
    : null;
}

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

  const effect = retirementEffectWording(item.retirementEffect);
  const action = primaryActionOf(item);
  const canReview = item.insightId !== null;
  // WP 10.15: the card's deterministic content arrives as blocks (`item.blocks`, built by the API from this
  // item's own fields): the wording — under the narration badge when there is one — on the left, the headline
  // figure or the reason there is none on the right, the carried badge beside the title. The chrome around them
  // (severity, title, retirement effect, action, review) stays the card's.
  const blocks = item.blocks.blocks as readonly unknown[];
  const badges = blocks.filter((block) => kindOf(block) === 'badge');
  const figures = blocks.filter((block) => kindOf(block) === 'money');
  const body = blocks.filter((block) => kindOf(block) !== 'badge' && kindOf(block) !== 'money');

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
            {badges.length > 0 && (
              <BlockRenderer blocks={badges} className="gap-1" testId="brief-item-badges" />
            )}
            <h3 className="text-body font-medium text-text-primary">{item.title}</h3>
          </div>
          <BlockRenderer
            blocks={body}
            className="mt-1 gap-1"
            testId="brief-item-body"
            headingLevel={4}
          />
        </div>
        <div
          className="flex shrink-0 flex-col items-end gap-1 text-right"
          data-testid="brief-item-impact"
        >
          <BlockRenderer blocks={figures} className="items-end gap-1" testId="brief-item-figures" />
        </div>
      </div>

      {item.progress !== null && <BriefProgressBox progress={item.progress} />}

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
        {item.talkThrough !== null && item.progress === null && (
          <TalkThroughLink
            insightId={item.talkThrough.insightId}
            briefWeek={item.talkThrough.briefWeek}
          />
        )}
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
