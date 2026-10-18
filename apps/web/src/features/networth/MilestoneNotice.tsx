// SPDX-License-Identifier: MIT
import { PartyPopper } from 'lucide-react';

import { Button } from '../../components/ui/button.tsx';
import { useDismissNetWorthMilestonesMutation, useNetWorthMilestonesQuery } from './api.ts';
import { noticeOf } from './milestones.ts';

/**
 * The net-worth milestone notice (WP 10.13, V6; Monarch's "You've reached a new net worth milestone", minus
 * the celebration screen): one line at the top of the dashboard the next time it loads after the snapshotter
 * recorded a crossing — "You crossed $50,000 in net worth on Oct 3" — with a Dismiss that the server remembers
 * (`dismissed_at`), so it never comes back. No confetti, no animation. A polite status, not an alert: it is
 * good news and must not interrupt.
 */
export function MilestoneNotice() {
  const query = useNetWorthMilestonesQuery();
  const dismiss = useDismissNetWorthMilestonesMutation();
  const notice = noticeOf(query.data?.milestones);
  if (notice === null || dismiss.isSuccess) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-status-info-border bg-status-info-bg px-4 py-2 text-small text-status-info-text"
      data-testid="net-worth-milestone"
    >
      <PartyPopper size={16} aria-hidden="true" className="shrink-0" />
      <p className="min-w-0 flex-1 font-medium">{notice.sentence}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={dismiss.isPending}
        onClick={() =>
          dismiss.mutate(
            { body: { ids: [...notice.ids] } },
            {
              // The button goes with the notice: focus moves to the top of the page's content, so the next
              // Tab continues from where the notice was rather than from the start of the document.
              onSuccess: () => document.getElementById('main-content')?.focus(),
            },
          )
        }
      >
        Dismiss
        <span className="sr-only">: {notice.sentence}</span>
      </Button>
    </div>
  );
}
